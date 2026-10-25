use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::Shortcut;

/// Raccourcis globaux par élément : combinaison -> id d'item
pub struct Hotkeys(pub Mutex<HashMap<Shortcut, String>>);

/// Process d'arrière-plan suivis (moniteurs) : id -> Child
pub struct BgProcs(pub Mutex<HashMap<String, std::process::Child>>);

/// Découpe "programme args..." en gérant un programme entre guillemets.
fn split_command(command: &str) -> (String, String) {
    let c = command.trim();
    if let Some(rest) = c.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (rest[..end].to_string(), rest[end + 1..].trim().to_string());
        }
    }
    match c.split_once(' ') {
        Some((p, a)) => (p.to_string(), a.trim().to_string()),
        None => (c.to_string(), String::new()),
    }
}

#[derive(Deserialize)]
pub struct HotkeyDef {
    pub id: String,
    pub accel: String,
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

// ---------------------------------------------------------------------------
// Modèles
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct Browser {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct Profile {
    /// Valeur à passer au navigateur (--profile-directory=... ou -P ...)
    pub dir: String,
    /// Nom lisible affiché dans l'UI
    pub name: String,
}

// ---------------------------------------------------------------------------
// Détection des navigateurs installés (registre Windows)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn detect_browsers_impl() -> Vec<Browser> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut out: Vec<Browser> = Vec::new();

    let roots = [
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Clients\\StartMenuInternet"),
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet",
        ),
        (HKEY_CURRENT_USER, "SOFTWARE\\Clients\\StartMenuInternet"),
    ];

    for (hive, sub) in roots {
        let root = RegKey::predef(hive);
        let Ok(key) = root.open_subkey(sub) else {
            continue;
        };
        for name in key.enum_keys().flatten() {
            let Ok(cmd_key) = key.open_subkey(format!("{}\\shell\\open\\command", name)) else {
                continue;
            };
            let Ok(raw) = cmd_key.get_value::<String, _>("") else {
                continue;
            };
            let path = raw.trim().trim_matches('"').to_string();
            if !Path::new(&path).exists() {
                continue;
            }
            let display = key
                .open_subkey(&name)
                .ok()
                .and_then(|k| k.get_value::<String, _>("").ok())
                .unwrap_or_else(|| name.clone());
            let lp = path.to_lowercase();
            if !out.iter().any(|b| b.path.to_lowercase() == lp) {
                out.push(Browser {
                    name: display,
                    path,
                });
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(not(windows))]
fn detect_browsers_impl() -> Vec<Browser> {
    Vec::new()
}

#[tauri::command]
fn detect_browsers() -> Vec<Browser> {
    detect_browsers_impl()
}

// ---------------------------------------------------------------------------
// Profils de navigateur
// ---------------------------------------------------------------------------

fn exe_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn chromium_user_data_dir(exe: &str) -> Option<PathBuf> {
    let local = dirs::data_local_dir()?; // %LOCALAPPDATA%
    let rel: &str = match exe_name(exe).as_str() {
        "brave.exe" => "BraveSoftware\\Brave-Browser\\User Data",
        "chrome.exe" => "Google\\Chrome\\User Data",
        "msedge.exe" => "Microsoft\\Edge\\User Data",
        "vivaldi.exe" => "Vivaldi\\User Data",
        "chromium.exe" => "Chromium\\User Data",
        _ => return None,
    };
    let p = local.join(rel);
    p.exists().then_some(p)
}

fn is_firefox(exe: &str) -> bool {
    let f = exe_name(exe);
    f.contains("firefox") || f.contains("librewolf") || f.contains("waterfox")
}

/// Flag de navigation privée selon le navigateur.
fn private_flag(exe: &str) -> &'static str {
    let f = exe_name(exe);
    if f.contains("firefox") || f.contains("librewolf") || f.contains("waterfox") {
        "-private-window"
    } else if f == "msedge.exe" {
        "--inprivate"
    } else if f.contains("opera") {
        "--private"
    } else {
        "--incognito"
    }
}

fn chromium_profiles(user_data: &Path) -> Vec<Profile> {
    let mut out = Vec::new();
    let local_state = user_data.join("Local State");
    if let Ok(txt) = fs::read_to_string(&local_state) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&txt) {
            if let Some(cache) = json
                .get("profile")
                .and_then(|p| p.get("info_cache"))
                .and_then(|c| c.as_object())
            {
                for (dir, info) in cache {
                    let name = info
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(dir)
                        .to_string();
                    out.push(Profile {
                        dir: dir.clone(),
                        name,
                    });
                }
            }
        }
    }
    if out.is_empty() {
        if let Ok(rd) = fs::read_dir(user_data) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == "Default" || n.starts_with("Profile ") {
                    out.push(Profile {
                        dir: n.clone(),
                        name: n,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    out
}

fn firefox_profiles() -> Vec<Profile> {
    let mut out = Vec::new();
    let Some(roaming) = dirs::config_dir() else {
        return out;
    };
    let ini = roaming.join("Mozilla\\Firefox\\profiles.ini");
    if let Ok(txt) = fs::read_to_string(ini) {
        for line in txt.lines() {
            if let Some(name) = line.trim().strip_prefix("Name=") {
                out.push(Profile {
                    dir: name.to_string(),
                    name: name.to_string(),
                });
            }
        }
    }
    out
}

#[tauri::command]
fn list_profiles(browser_path: String) -> Vec<Profile> {
    if is_firefox(&browser_path) {
        return firefox_profiles();
    }
    match chromium_user_data_dir(&browser_path) {
        Some(dir) => chromium_profiles(&dir),
        None => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Lancements
// ---------------------------------------------------------------------------

#[tauri::command]
fn launch_site(
    browser: String,
    profile: Option<String>,
    url: String,
    incognito: bool,
    new_window: bool,
) -> Result<(), String> {
    if !Path::new(&browser).exists() {
        return Err(format!("Navigateur introuvable : {}", browser));
    }
    let mut cmd = Command::new(&browser);
    let firefox = is_firefox(&browser);

    if let Some(p) = profile.filter(|p| !p.is_empty()) {
        if firefox {
            cmd.args(["-P", &p]);
        } else {
            cmd.arg(format!("--profile-directory={}", p));
        }
    }
    if incognito {
        cmd.arg(private_flag(&browser));
    } else if new_window {
        // le mode privé ouvre déjà sa propre fenêtre
        cmd.arg(if firefox { "-new-window" } else { "--new-window" });
    }
    cmd.arg(&url);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn launch_app(
    path: String,
    args: Option<String>,
    workdir: Option<String>,
    admin: bool,
) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("Fichier introuvable : {}", path));
    }
    let args = args.unwrap_or_default();
    let workdir = workdir
        .filter(|w| !w.is_empty())
        .or_else(|| {
            Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
        })
        .unwrap_or_default();

    #[cfg(windows)]
    {
        if admin {
            let mut ps = format!(
                "Start-Process -FilePath '{}' -Verb RunAs",
                path.replace('\'', "''")
            );
            if !workdir.is_empty() {
                ps.push_str(&format!(
                    " -WorkingDirectory '{}'",
                    workdir.replace('\'', "''")
                ));
            }
            if !args.trim().is_empty() {
                ps.push_str(&format!(" -ArgumentList '{}'", args.replace('\'', "''")));
            }
            Command::new("powershell")
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }

        let mut cmd = Command::new(&path);
        if !workdir.is_empty() {
            cmd.current_dir(&workdir);
        }
        if !args.trim().is_empty() {
            cmd.raw_arg(&args);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = (admin, workdir, args);
        Command::new(&path).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// mode : "keep" (console reste ouverte) ou "close" (se ferme à la fin).
/// Sans commande, ouvre simplement un terminal dans le dossier.
#[tauri::command]
fn launch_script(
    dir: String,
    command: Option<String>,
    mode: Option<String>,
    env: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    if !Path::new(&dir).exists() {
        return Err(format!("Dossier introuvable : {}", dir));
    }

    #[cfg(windows)]
    {
        let command = command.filter(|c| !c.trim().is_empty());
        let flag = match (&command, mode.as_deref()) {
            (Some(_), Some("close")) => "/c",
            _ => "/k",
        };
        let inner = match &command {
            Some(c) => format!("cd /d \"{}\" && {}", dir, c),
            None => format!("cd /d \"{}\"", dir),
        };
        let mut cmd = Command::new("cmd");
        if let Some(vars) = env {
            for (k, v) in vars {
                if !k.trim().is_empty() {
                    cmd.env(k.trim(), v);
                }
            }
        }
        cmd.raw_arg(format!("{} {}", flag, inner));
        cmd.creation_flags(CREATE_NEW_CONSOLE);
        cmd.spawn().map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (command, mode, env);
        Err("Windows uniquement".into())
    }
}

/// Extrait l'icône intégrée d'un exécutable (ou fichier associé) en PNG base64.
#[tauri::command]
fn extract_exe_icon(path: String) -> Result<String, String> {
    if !Path::new(&path).exists() {
        return Err(format!("Fichier introuvable : {}", path));
    }

    #[cfg(windows)]
    {
        let ps = format!(
            "Add-Type -AssemblyName System.Drawing; \
             $i=[System.Drawing.Icon]::ExtractAssociatedIcon('{}'); \
             if($i -eq $null){{ exit 1 }}; \
             $b=$i.ToBitmap(); \
             $m=New-Object System.IO.MemoryStream; \
             $b.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); \
             [Convert]::ToBase64String($m.ToArray())",
            path.replace('\'', "''")
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| e.to_string())?;
        let b64 = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || b64.is_empty() {
            return Err("Aucune icône extraite".into());
        }
        Ok(format!("data:image/png;base64,{}", b64))
    }

    #[cfg(not(windows))]
    {
        Err("Windows uniquement".into())
    }
}

/// Remplace l'ensemble des raccourcis globaux par élément.
/// Renvoie la liste des combinaisons qui n'ont pas pu être enregistrées.
#[tauri::command]
fn apply_hotkeys(
    app: tauri::AppHandle,
    state: tauri::State<Hotkeys>,
    defs: Vec<HotkeyDef>,
) -> Vec<String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let mut map = state.0.lock().unwrap();
    let old: Vec<Shortcut> = map.keys().cloned().collect();
    map.clear();
    for sc in old {
        let _ = gs.unregister(sc);
    }
    let mut failed = Vec::new();
    for d in defs {
        match Shortcut::try_from(d.accel.as_str()) {
            Ok(sc) => {
                if gs.register(sc).is_ok() {
                    map.insert(sc, d.id);
                } else {
                    failed.push(d.accel);
                }
            }
            Err(_) => failed.push(d.accel),
        }
    }
    failed
}

/// Lance une commande en arrière-plan, sans aucune fenêtre (process de moniteur).
/// Le process est suivi par `id` pour pouvoir être stoppé précisément.
#[tauri::command]
fn launch_background(
    state: tauri::State<BgProcs>,
    id: String,
    dir: String,
    command: String,
    env: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    if !Path::new(&dir).exists() {
        return Err(format!("Dossier introuvable : {}", dir));
    }

    #[cfg(windows)]
    {
        // Stoppe l'éventuel process déjà suivi pour ce moniteur
        if let Some(mut old) = state.0.lock().unwrap().remove(&id) {
            let _ = old.kill();
            let _ = old.wait();
        }
        let (prog, args) = split_command(&command);
        if prog.is_empty() {
            return Err("Commande vide".into());
        }
        let mut cmd = Command::new(&prog);
        cmd.current_dir(&dir);
        if let Some(vars) = env {
            for (k, v) in vars {
                if !k.trim().is_empty() {
                    cmd.env(k.trim(), v);
                }
            }
        }
        if !args.is_empty() {
            cmd.raw_arg(&args);
        }
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let child = cmd
            .spawn()
            .map_err(|e| format!("{} (programme : {})", e, prog))?;
        state.0.lock().unwrap().insert(id, child);
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (command, env, id);
        Err("Windows uniquement".into())
    }
}

/// Stoppe le process suivi d'un moniteur. En secours (process d'une session
/// précédente), balaye les process dont la ligne de commande correspond.
#[tauri::command]
fn stop_background(
    state: tauri::State<BgProcs>,
    id: String,
    command: Option<String>,
) -> Result<(), String> {
    let mut killed = false;
    if let Some(mut child) = state.0.lock().unwrap().remove(&id) {
        killed = child.kill().is_ok();
        let _ = child.wait();
    }

    #[cfg(windows)]
    if !killed {
        if let Some(cmdline) = command.filter(|c| !c.trim().is_empty()) {
            let (prog, args) = split_command(&cmdline);
            let pattern = if args.is_empty() {
                Path::new(&prog)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or(prog)
            } else {
                args
            };
            let ps = format!(
                "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
                pattern.replace('\'', "''")
            );
            let _ = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
                .creation_flags(0x0800_0000)
                .output();
            killed = true;
        }
    }

    if killed {
        Ok(())
    } else {
        Err("Aucun process suivi pour ce moniteur".into())
    }
}

/// GET HTTP côté Rust (contourne le CORS du WebView pour les moniteurs).
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Vérifie si une mise à jour est disponible ; renvoie sa version le cas échéant.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(Some(u.version.clone())),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Télécharge, installe la mise à jour signée, puis redémarre ProHub.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

/// Notification Windows native.
#[tauri::command]
fn notify_user(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Ouvre (ou ramène) une fenêtre panneau affichant une page web (moniteurs).
/// Les liens sortant de l'hôte du panneau s'ouvrent dans le navigateur choisi
/// (ext_browser/ext_profile/ext_incognito), sinon le navigateur par défaut du système.
#[tauri::command]
async fn open_panel(
    app: tauri::AppHandle,
    label: String,
    url: String,
    title: String,
    ext_browser: Option<String>,
    ext_profile: Option<String>,
    ext_incognito: Option<bool>,
) -> Result<(), String> {
    let label: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if label.is_empty() || label == "main" {
        return Err("Libellé de panneau invalide".into());
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("URL invalide : {e}"))?;
    let allowed_host = parsed.host_str().map(|h| h.to_string());
    let allowed_port = parsed.port_or_known_default();
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(parsed))
        .title(&title)
        .inner_size(1120.0, 760.0)
        .center()
        .on_navigation({
            let ext_browser = ext_browser.filter(|s| !s.is_empty());
            let ext_profile = ext_profile.filter(|s| !s.is_empty());
            let ext_incognito = ext_incognito.unwrap_or(false);
            move |nav| {
                let same = nav.host_str().map(|h| h.to_string()) == allowed_host
                    && nav.port_or_known_default() == allowed_port;
                if !same {
                    // Lien externe : navigateur choisi (profil / privé), le panneau reste en place.
                    #[cfg(windows)]
                    {
                        let mut opened = false;
                        if let Some(browser) = &ext_browser {
                            if Path::new(browser).exists() {
                                let mut cmd = Command::new(browser);
                                let firefox = is_firefox(browser);
                                if let Some(p) = &ext_profile {
                                    if firefox {
                                        cmd.args(["-P", p]);
                                    } else {
                                        cmd.arg(format!("--profile-directory={}", p));
                                    }
                                }
                                if ext_incognito {
                                    cmd.arg(private_flag(browser));
                                }
                                cmd.arg(nav.as_str());
                                opened = cmd.spawn().is_ok();
                            }
                        }
                        if !opened {
                            let mut cmd = Command::new("cmd");
                            cmd.raw_arg(format!("/c start \"\" \"{}\"", nav));
                            cmd.creation_flags(0x0800_0000);
                            let _ = cmd.spawn();
                        }
                    }
                    return false;
                }
                true
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ouvre un fichier avec son application par défaut, ou un dossier dans l'Explorateur.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("Chemin introuvable : {}", path));
    }

    #[cfg(windows)]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("Windows uniquement".into())
    }
}

#[tauri::command]
fn check_paths(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

// ---------------------------------------------------------------------------
// Configuration (JSON dans %APPDATA%\ProHub, backup avant chaque écriture)
// ---------------------------------------------------------------------------

fn config_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("Dossier de configuration introuvable")?
        .join("ProHub");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn load_config() -> Result<String, String> {
    let p = config_path()?;
    if !p.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_config(content: String) -> Result<(), String> {
    let p = config_path()?;
    if p.exists() {
        let _ = fs::copy(&p, p.with_extension("json.bak"));
    }
    fs::write(p, content).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Fichiers : dialogues, lecture/écriture (export-import), icônes
// ---------------------------------------------------------------------------

#[tauri::command]
async fn pick_file(title: String, extensions: Vec<String>) -> Option<String> {
    let mut dlg = rfd::FileDialog::new().set_title(&title);
    if !extensions.is_empty() {
        let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
        dlg = dlg.add_filter("Fichiers", &exts);
    }
    dlg.pick_file().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_folder(title: String) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(&title)
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_save_file(title: String, file_name: String) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(&title)
        .set_file_name(&file_name)
        .add_filter("JSON", &["json"])
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_image_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 {
        return Err("Image trop lourde (max 2 Mo)".into());
    }
    let ext = Path::new(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => return Err("Format non supporté (png, jpg, gif, webp, svg, ico)".into()),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ---------------------------------------------------------------------------
// Fenêtre + tray
// ---------------------------------------------------------------------------

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    tauri::Builder::default()
        .manage(Hotkeys(Mutex::new(HashMap::new())))
        .manage(BgProcs(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let mapped = app
                            .state::<Hotkeys>()
                            .0
                            .lock()
                            .unwrap()
                            .get(shortcut)
                            .cloned();
                        if let Some(id) = mapped {
                            // Raccourci d'un élément : lancement sans ouvrir la fenêtre
                            let _ = app.emit("hotkey", id);
                        } else {
                            // Ctrl+Espace : fenêtre + palette
                            show_main(app);
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.emit("palette", ());
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Raccourci global : échec non bloquant (déjà pris par une autre app, etc.)
            if let Err(e) = app.global_shortcut().register("ctrl+space") {
                eprintln!("Raccourci global indisponible : {e}");
            }

            // Icône de zone de notification
            let open = MenuItem::with_id(app, "open", "Ouvrir ProHub", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ProHub")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fenêtre principale : fermer = réduire dans le tray.
            // Les panneaux (moniteurs) se ferment normalement.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            detect_browsers,
            list_profiles,
            launch_site,
            launch_app,
            launch_script,
            launch_background,
            stop_background,
            http_get,
            notify_user,
            check_update,
            install_update,
            open_panel,
            open_path,
            check_paths,
            extract_exe_icon,
            apply_hotkeys,
            load_config,
            save_config,
            pick_file,
            pick_folder,
            pick_save_file,
            read_text_file,
            write_text_file,
            read_image_base64
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de ProHub");
}
