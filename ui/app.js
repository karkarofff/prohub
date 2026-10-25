/* ProHub v0.4 — logique front (vanilla, pas de framework) */

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

/* ------------------------------------------------------------------------ */
/* État                                                                      */
/* ------------------------------------------------------------------------ */

let state = {
  settings: {
    defaultBrowser: null, // { name, path }
    defaultProfile: null,
    theme: "dark",        // dark | light
    density: "comfy",     // comfy | compact
    view: "grid",         // grid | list
    accent: "",           // "" = selon la vue, sinon clé de ACCENTS
    showRecents: true,    // panneau « Récents » sur l'accueil
    heroImage: null,      // photo perso du bandeau d'accueil (data URL)
    defaultScriptMode: "keep", // console par défaut des nouveaux scripts
  },
  collections: [],        // { id, name, color }
  items: [],              // voir modèle par type
  routines: [],           // { id, name, description, pinned, steps:[{itemId, delay}], stopOnError }
  vault: null,            // { salt, check, data } — coffre chiffré (AES-GCM, PIN)
};

const APP_VERSION = "1.0.0";

let detectedBrowsers = [];
let missing = new Set();
let currentView = { kind: "home" }; // home | {kind:"tab",tab} | {kind:"collection",id}

const ACCENTS = {
  bleu: "#4f8df9",
  violet: "#8b5cf6",
  vert: "#22c55e",
  ambre: "#f59e0b",
  rose: "#ec4899",
  turquoise: "#38bdf8",
};

const COLPALETTE = ["#4f8df9", "#8b5cf6", "#22c55e", "#f59e0b", "#ec4899", "#38bdf8", "#f87171", "#a3e635"];

const TABS = {
  sites: {
    title: "Sites", type: "site", color: "sites",
    sub: "Vos sites favoris, chacun dans le navigateur et le profil de votre choix.",
    add: "Ajouter un site", emptyGlyph: "🌐",
    emptyTitle: "Aucun site pour l'instant",
    emptyText: "Ajoutez votre premier site pour commencer.",
  },
  scripts: {
    title: "Scripts", type: "script", color: "scripts",
    sub: "Vos scripts et commandes rapides, dans le bon dossier, avec vos paramètres.",
    add: "Ajouter un script", emptyGlyph: "❯_",
    emptyTitle: "Aucun script pour l'instant",
    emptyText: "Ajoutez un dossier de travail et, si vous voulez, une commande.",
  },
  apps: {
    title: "Applications", type: "app", color: "apps",
    sub: "Vos exécutables, lancés en un clic, avec arguments et mode admin si besoin.",
    add: "Ajouter une application", emptyGlyph: "▦",
    emptyTitle: "Aucune application pour l'instant",
    emptyText: "Ajoutez un .exe pour le lancer directement depuis ProHub.",
  },
  shortcuts: {
    title: "Raccourcis", type: "shortcut", color: "shortcuts",
    sub: "Fichiers et dossiers, ouverts avec leur application par défaut.",
    add: "Ajouter un raccourci", emptyGlyph: "⇱",
    emptyTitle: "Aucun raccourci pour l'instant",
    emptyText: "Ajoutez un fichier ou un dossier à ouvrir en un clic.",
  },
  monitors: {
    title: "Moniteurs", type: "monitor", color: "monitors",
    sub: "Veilles en arrière-plan : compteur de nouveautés, notifications, panneau intégré.",
    add: "Ajouter un moniteur", emptyGlyph: "〰",
    emptyTitle: "Aucun moniteur pour l'instant",
    emptyText: "Surveillez une URL de statut JSON et soyez notifié des nouveautés.",
  },
  routines: {
    title: "Routines", type: "routine", color: "routines",
    sub: "Enchaînez plusieurs lancements en une seule action.",
    add: "Ajouter une routine", emptyGlyph: "⟳",
    emptyTitle: "Aucune routine pour l'instant",
    emptyText: "Créez une routine qui ouvre vos sites, scripts et apps d'un coup.",
  },
};

const TYPE_LABEL = { site: "Site web", script: "Script", app: "Application", shortcut: "Raccourci", monitor: "Moniteur", routine: "Routine" };
const TYPE_COLOR = { site: "sites", script: "scripts", app: "apps", shortcut: "shortcuts", monitor: "monitors", routine: "routines" };

/* Sections disponibles sur l'accueil (ordre par défaut) */
const HOME_SECTION_DEFS = ["sites", "scripts", "apps", "shortcuts", "monitors", "routines"];

function homeConfig() { return state.settings.home; }

/* ------------------------------------------------------------------------ */
/* Utilitaires                                                               */
/* ------------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isError ? 5000 : 2600);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function faviconUrl(url) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=64`;
}

/* Favicon servi par le site lui-même (fonctionne pour les instances perso) */
function faviconDirect(url) {
  try {
    const u = /^[a-z]+:\/\//i.test(url) ? url : "https://" + url;
    return new URL(u).origin + "/favicon.ico";
  } catch { return faviconUrl(url); }
}

/* <img> avec chaîne de secours : favicon du site → service Google → masqué */
function siteImgTag(url) {
  return `<img src="${esc(faviconDirect(url))}" alt="" data-fb="${esc(faviconUrl(url))}" onerror="if(this.dataset.fb&&!this.dataset.done){this.dataset.done=1;this.src=this.dataset.fb}else{this.style.display='none'}">`;
}

function fileName(p) {
  return (p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
}

function hexToSoft(hex, a = 0.14) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function hasExtension(p) {
  return /\.[^\\/.]+$/.test(p || "");
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

function fuzzyScore(query, text) {
  query = query.toLowerCase();
  text = (text || "").toLowerCase();
  if (!query) return 1;
  let qi = 0, score = 0, streak = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      score += 1 + streak * 2 + (i === 0 ? 3 : 0);
      streak++; qi++;
    } else streak = 0;
  }
  return qi === query.length ? score : -1;
}

function itemSearchText(item) {
  const d = item.description || "";
  if (item.type === "site") return `${item.name} ${d} ${item.url}`;
  if (item.type === "script") return `${item.name} ${d} ${item.command || ""} ${item.dir}`;
  if (item.type === "shortcut") return `${item.name} ${d} ${item.path}`;
  if (item.type === "monitor") return `${item.name} ${d} ${item.statusUrl || ""}`;
  return `${item.name} ${d} ${item.path || ""}`;
}

async function saveState() {
  try {
    const persisted = {
      settings: state.settings,
      collections: state.collections,
      items: state.items.filter((i) => !i._vaulted),
      routines: state.routines.filter((r) => !r._vaulted),
      vault: state.vault,
    };
    // Coffre déverrouillé : re-chiffrer les éléments masqués avec leur état courant
    if (state.vault && vaultUnlocked && vaultKey) {
      const strip = ({ _vaulted, ...rest }) => rest;
      const data = await vEncrypt(vaultKey, {
        items: state.items.filter((i) => i._vaulted).map(strip),
        routines: state.routines.filter((r) => r._vaulted).map(strip),
      });
      persisted.vault = { ...state.vault, data };
      state.vault = persisted.vault;
    }
    await invoke("save_config", { content: JSON.stringify(persisted, null, 2) });
  } catch (e) {
    toast("Impossible d'enregistrer la configuration : " + e, true);
  }
}

async function ensureVisible() {
  try {
    const w = window.__TAURI__.window.getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch { /* permissions fenêtre indisponibles */ }
}

async function tryExtractIcon(path) {
  try { return await invoke("extract_exe_icon", { path }); }
  catch { return null; }
}

/* ------------------------------------------------------------------------ */
/* Raccourcis clavier par élément                                            */
/* ------------------------------------------------------------------------ */

function hotkeyTaken(hotkey, selfId) {
  return [...state.items, ...state.routines].some((e) => e.hotkey === hotkey && e.id !== selfId);
}

async function applyHotkeys() {
  const defs = [...state.items, ...state.routines]
    .filter((e) => e.hotkey)
    .map((e) => ({ id: e.id, accel: e.hotkey }));
  try {
    const failed = await invoke("apply_hotkeys", { defs });
    if (failed.length) {
      toast(`Raccourci(s) indisponible(s) : ${failed.join(", ")} (déjà pris par Windows ou une autre app)`, true);
    }
  } catch { /* plugin indisponible */ }
}

/* ------------------------------------------------------------------------ */
/* Chargement initial                                                        */
/* ------------------------------------------------------------------------ */

function normalizeState(parsed) {
  state.settings = {
    defaultBrowser: null, defaultProfile: null,
    theme: "dark", density: "comfy", view: "grid", accent: "", showRecents: true, heroImage: null,
    defaultScriptMode: "keep",
    ...(parsed.settings || {}),
  };
  // Configuration de l'accueil (sections, ordre, panneaux)
  const ph = (parsed.settings && parsed.settings.home) || {};
  const sections = Array.isArray(ph.sections)
    ? ph.sections.filter((s) => s && HOME_SECTION_DEFS.includes(s.id))
    : [];
  for (const id of HOME_SECTION_DEFS) {
    if (!sections.some((s) => s.id === id)) {
      sections.push({ id, on: id === "sites" || id === "scripts" });
    }
  }
  const legacyRecents = state.settings.showRecents !== false;
  state.settings.home = {
    hero: ph.hero !== false,
    stats: ph.stats !== false,
    sections,
    rail: {
      recents: ph.rail ? ph.rail.recents !== false : legacyRecents,
      pinned: !ph.rail || ph.rail.pinned !== false,
      routines: !ph.rail || ph.rail.routines !== false,
      next: !ph.rail || ph.rail.next !== false,
    },
  };
  state.collections = (Array.isArray(parsed.collections) ? parsed.collections : []).map((c, i) => ({
    color: COLPALETTE[i % COLPALETTE.length], ...c,
  }));
  state.items = (Array.isArray(parsed.items) ? parsed.items : []).map((i) => ({
    pinned: false, collections: [], ...i,
  }));
  state.routines = (Array.isArray(parsed.routines) ? parsed.routines : []).map((r) => ({
    pinned: false, stopOnError: true, steps: [], ...r,
  }));
  state.vault = parsed.vault || null;
}

function applyAppearance() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.density = state.settings.density;
}

async function checkAllPaths() {
  const checks = [];
  for (const i of state.items) {
    if (i.type === "script") checks.push([i.id, i.dir]);
    else if (i.type === "app") checks.push([i.id, i.path]);
    else if (i.type === "shortcut") checks.push([i.id, i.path]);
  }
  if (!checks.length) { missing = new Set(); return; }
  try {
    const results = await invoke("check_paths", { paths: checks.map(c => c[1]) });
    missing = new Set(checks.filter((_, idx) => !results[idx]).map(c => c[0]));
  } catch { missing = new Set(); }
}

async function migrateIcons() {
  let changed = false;
  for (const i of state.items) {
    const eligible = (i.type === "app" || (i.type === "shortcut" && hasExtension(i.path)))
      && !i.iconData && !i.iconTried && !missing.has(i.id);
    if (!eligible) continue;
    const data = await tryExtractIcon(i.path);
    if (data) i.iconData = data;
    else i.iconTried = true;
    changed = true;
  }
  if (changed) { await saveState(); render(); }
}

async function init() {
  try {
    const raw = await invoke("load_config");
    normalizeState(raw ? JSON.parse(raw) : {});
  } catch {
    normalizeState({});
    toast("Configuration illisible, repartie de zéro.", true);
  }
  applyAppearance();

  try { detectedBrowsers = await invoke("detect_browsers"); }
  catch { detectedBrowsers = []; }

  if (!state.settings.defaultBrowser && detectedBrowsers.length) {
    const brave = detectedBrowsers.find((b) => /brave/i.test(b.name));
    state.settings.defaultBrowser = brave || detectedBrowsers[0];
    await saveState();
  }

  await checkAllPaths();

  listen("palette", () => openPalette());
  listen("hotkey", (e) => {
    const entry = findEntry(e.payload);
    if (entry) runEntry(entry);
  });

  setInterval(() => {
    const el = $("#hero-time");
    if (el) el.textContent = timeStr();
  }, 30000);

  render();
  applyHotkeys();
  migrateIcons();

  // Moniteurs : démarrage des process puis boucle de fond (planification + polling)
  startMonitorProcesses();
  setTimeout(schedulerTick, 4000);
  setInterval(schedulerTick, 30000);

  // Vérification de mise à jour au démarrage (silencieuse si indisponible)
  setTimeout(async () => {
    try {
      const v = await invoke("check_update");
      if (!v) return;
      if (document.hidden) {
        invoke("notify_user", { title: "ProHub", body: `Mise à jour ${v} disponible — ouvrez ProHub pour l'installer.` }).catch(() => {});
        return;
      }
      if (await askConfirm(`ProHub ${v} est disponible. Installer et redémarrer maintenant ?`)) {
        toast("Téléchargement de la mise à jour…");
        await invoke("install_update");
      }
    } catch { /* hors ligne ou updater non configuré */ }
  }, 10000);
}

/* ------------------------------------------------------------------------ */
/* Icônes SVG                                                                */
/* ------------------------------------------------------------------------ */

const SVG = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l4 4-4 4M11 17h8"/></svg>',
  app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>',
  routine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M16 3a1 1 0 0 1 .97 1.24l-1.1 4.42 3.84 3.84a1 1 0 0 1-.46 1.68l-4.75 1.19-1.19 4.75a1 1 0 0 1-1.68.46l-3.84-3.84-4.42 1.1A1 1 0 0 1 2.4 16.4l13-13A1 1 0 0 1 16 3z" transform="rotate(45 12 12)"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.3.8-4.6 4.3 1.2 6.1L12 16.9 6.4 19.8l1.2-6.1L3 9.4l6.3-.8z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  listview: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  gridview: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.8 4.8l1.8 1.8M17.4 17.4l1.8 1.8M19.2 4.8l-1.8 1.8M6.6 17.4l-1.8 1.8"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.02z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>',
};

SVG.monitor = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-7 4.5 14 2.5-7H21"/></svg>';

const TYPE_SVG = { site: SVG.globe, script: SVG.terminal, app: SVG.app, shortcut: SVG.bolt, monitor: SVG.monitor, routine: SVG.routine };

/* Image par défaut du bandeau : ui/assets/hero.jpg (embarquée, hors ligne) */
const HERO_DEFAULT = "assets/hero.jpg";
/* ------------------------------------------------------------------------ */
/* Rendu : racine                                                            */
/* ------------------------------------------------------------------------ */

function viewAccentHex() {
  const s = state.settings.accent;
  if (s && ACCENTS[s]) return ACCENTS[s];
  if (currentView.kind === "collection") {
    const col = state.collections.find((c) => c.id === currentView.id);
    return col?.color || "#38bdf8";
  }
  if (currentView.kind === "tab") {
    return getComputedStyle(document.documentElement).getPropertyValue(`--c-${TABS[currentView.tab].color}`).trim() || "#4f8df9";
  }
  return "#4f8df9";
}

function render() {
  const hex = viewAccentHex();
  document.documentElement.style.setProperty("--accent", hex);
  document.documentElement.style.setProperty("--accent-soft", hexToSoft(hex));

  $$(".nav-item[data-nav]").forEach((b) => b.classList.toggle("active", currentView.kind === "home"));
  $$(".nav-item[data-tab]").forEach((b) => {
    b.classList.toggle("active", currentView.kind === "tab" && b.dataset.tab === currentView.tab);
  });

  for (const tab of Object.keys(TABS)) {
    const n = tab === "routines"
      ? state.routines.length
      : state.items.filter((i) => i.type === TABS[tab].type).length;
    $(`#count-${tab}`).textContent = n || "";
  }
  renderCollectionsNav();
  updateBell();

  const content = $("#content");
  content.innerHTML = "";
  if (currentView.kind === "home") renderHome(content);
  else renderCategory(content);
}

function updateBell() {
  const b = $("#bell-badge");
  b.hidden = missing.size === 0;
  b.textContent = missing.size;
}

function renderCollectionsNav() {
  const nav = $("#nav-collections");
  nav.innerHTML = "";
  for (const col of state.collections) {
    const n = state.items.filter((i) => (i.collections || []).includes(col.id)).length
      + state.routines.filter((r) => (r.collections || []).includes(col.id)).length;
    const b = document.createElement("button");
    b.className = "nav-item" + (currentView.kind === "collection" && currentView.id === col.id ? " active" : "");
    b.innerHTML = `<span class="nav-dot" style="background:${col.color || "#38bdf8"}"></span><span>${esc(col.name)}</span><span class="nav-count">${n || ""}</span>`;
    b.addEventListener("click", () => { currentView = { kind: "collection", id: col.id }; render(); });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, [
        { label: "Renommer / couleur", action: () => openCollectionEditor(col) },
        { label: "Supprimer", danger: true, action: async () => {
          if (!(await askConfirm(`Supprimer la collection « ${col.name} » ? Les éléments ne seront pas supprimés.`))) return;
          state.collections = state.collections.filter((c) => c.id !== col.id);
          for (const i of [...state.items, ...state.routines]) {
            i.collections = (i.collections || []).filter((id) => id !== col.id);
          }
          if (currentView.kind === "collection" && currentView.id === col.id) currentView = { kind: "home" };
          await saveState(); render();
        } },
      ]);
    });
    nav.appendChild(b);
  }
}

/* ------------------------------------------------------------------------ */
/* Accueil                                                                   */
/* ------------------------------------------------------------------------ */

function timeStr() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function dateStr() {
  const s = new Date().toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderHome(root) {
  const cfg = homeConfig();
  const h = new Date().getHours();
  const night = h >= 18 || h < 5;
  const greeting = night ? "Bonsoir !" : "Bonjour !";
  const railOn = cfg.rail.recents || cfg.rail.pinned || cfg.rail.routines || cfg.rail.next;

  const heroBg = `<div class="hero-photo" style="background-image:url('${state.settings.heroImage || HERO_DEFAULT}')"></div><div class="hero-shade"></div>`;
  const heroHtml = `
      <div class="hero">
        ${heroBg}
        <div class="hero-text">
          <div class="hero-title"><span class="sun">${night ? SVG.moon : SVG.sun}</span>${greeting}</div>
          <p class="hero-sub">Accédez rapidement à vos sites, applications, scripts et bien plus encore.</p>
        </div>
        <div class="hero-meta">
          <span class="hero-chip">${dateStr()}</span>
          <span class="hero-chip">${SVG.clock.replace('<svg ', '<svg width="13" height="13" ')} <span id="hero-time">${timeStr()}</span></span>
          <button class="hero-chip" id="btn-home-edit" type="button" title="Choisir ce qui s'affiche sur l'accueil">Personnaliser</button>
        </div>
      </div>`;

  const home = document.createElement("div");
  home.className = "home" + (railOn ? "" : " no-rail");
  home.innerHTML = `
    <div class="home-main" id="home-main">
      ${cfg.hero ? heroHtml : `<div style="display:flex; justify-content:flex-end"><button class="link-more" id="btn-home-edit" type="button">Personnaliser l'accueil</button></div>`}
      ${cfg.stats ? `<div class="stats" id="stats"></div>` : ""}
    </div>
    ${railOn ? `
    <div class="home-rail">
      ${cfg.rail.recents ? `<div class="rail-card">
        <div class="rail-head">${SVG.clock.replace('<svg ', '<svg width="16" height="16" ')}<span class="rail-title">Récents</span></div>
        <div class="rail-list" id="rail-recent"></div>
      </div>` : ""}
      ${cfg.rail.pinned ? `<div class="rail-card">
        <div class="rail-head">${SVG.star.replace('<svg ', '<svg width="16" height="16" ')}<span class="rail-title">Favoris</span></div>
        <div class="rail-list" id="rail-pinned"></div>
      </div>` : ""}
      ${cfg.rail.routines ? `<div class="rail-card">
        <div class="rail-head">${SVG.routine.replace('<svg ', '<svg width="16" height="16" ')}<span class="rail-title">Routines</span><button class="link-more" id="rail-routines-more">Voir tout →</button></div>
        <div class="rail-list" id="rail-routines"></div>
      </div>` : ""}
      ${cfg.rail.next ? `<div class="rail-card">
        <div class="rail-head">${SVG.clock.replace('<svg ', '<svg width="16" height="16" ')}<span class="rail-title">Prochaine exécution</span></div>
        <div class="rail-list" id="rail-next"></div>
      </div>` : ""}
    </div>` : ""}`;
  root.appendChild(home);

  $("#btn-home-edit").addEventListener("click", openHomeEditor);

  // Cartes de statistiques
  if (cfg.stats) {
    const stats = $("#stats");
    const statDefs = [
      ["sites", "Sites", SVG.globe], ["scripts", "Scripts", SVG.terminal],
      ["apps", "Applications", SVG.app], ["shortcuts", "Raccourcis", SVG.bolt],
      ["monitors", "Moniteurs", SVG.monitor],
    ];
    for (const [tab, label, svg] of statDefs) {
      const n = state.items.filter((i) => i.type === TABS[tab].type).length;
      const b = document.createElement("button");
      b.className = "stat-card";
      b.innerHTML = `
        <span class="stat-ico g-${TABS[tab].color}">${svg}</span>
        <span><span class="stat-label">${label}</span><br><span class="stat-value">${n}</span></span>
        <span class="arrow">${SVG.arrow}</span>`;
      b.addEventListener("click", () => { currentView = { kind: "tab", tab }; render(); });
      stats.appendChild(b);
    }
  }

  // Sections choisies, dans l'ordre choisi
  const main = $("#home-main");
  for (const s of cfg.sections.filter((x) => x.on)) {
    const sec = document.createElement("section");
    sec.className = "section";
    main.appendChild(sec);
    homeSection(sec, s.id, s.id === "sites" ? 8 : 4);
  }

  // Panneaux latéraux
  if (cfg.rail.recents) {
    const recents = [...state.items, ...state.routines.map((r) => ({ ...r, type: "routine" }))]
      .filter((e) => e.lastUsed)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, 6);
    fillRail($("#rail-recent"), recents, (e) => relTime(e.lastUsed), "Rien de lancé pour l'instant.");
  }
  if (cfg.rail.pinned) {
    const pinned = [...state.items, ...state.routines.map((r) => ({ ...r, type: "routine" }))]
      .filter((e) => e.pinned)
      .slice(0, 6);
    fillRail($("#rail-pinned"), pinned, () => "", "Épinglez vos essentiels (clic droit).");
  }
  if (cfg.rail.routines) {
    const routines = state.routines.slice(0, 5).map((r) => ({ ...r, type: "routine" }));
    fillRail($("#rail-routines"), routines, (e) => `${(e.steps || []).length} ét.`, "Aucune routine pour l'instant.");
    $("#rail-routines-more").addEventListener("click", () => { currentView = { kind: "tab", tab: "routines" }; render(); });
  }
  if (cfg.rail.next) {
    const upcoming = [...state.items, ...state.routines.map((r) => ({ ...r, type: "routine" }))]
      .filter((e) => e.type !== "monitor" && e.schedule && e.schedule.kind && e.schedule.kind !== "none")
      .map((e) => ({ e, at: nextRunOf(e) }))
      .filter((x) => x.at)
      .sort((a, b) => a.at - b.at)
      .slice(0, 4);
    fillRail($("#rail-next"), upcoming.map((x) => x.e),
      (e) => fmtNext(nextRunOf(e)), "Planifiez un script ou une routine depuis sa fiche.");
  }
}

/* Modale « Personnaliser l'accueil » */
function openHomeEditor() {
  const cfg = JSON.parse(JSON.stringify(homeConfig()));

  const body = `
    <div class="field">
      <label class="check"><input type="checkbox" id="f-h-hero" ${cfg.hero ? "checked" : ""}> Bandeau de bienvenue</label>
      <label class="check"><input type="checkbox" id="f-h-stats" ${cfg.stats ? "checked" : ""}> Cartes de statistiques</label>
    </div>
    <div class="field"><label>Sections (cochées = affichées, flèches = ordre)</label>
      <div class="steps" id="hs"></div></div>
    <div class="field"><label>Panneau latéral</label>
      <div class="checks">
        <label class="check"><input type="checkbox" id="f-h-recents" ${cfg.rail.recents ? "checked" : ""}> Récents</label>
        <label class="check"><input type="checkbox" id="f-h-pinned" ${cfg.rail.pinned ? "checked" : ""}> Favoris</label>
        <label class="check"><input type="checkbox" id="f-h-routines" ${cfg.rail.routines ? "checked" : ""}> Routines</label>
        <label class="check"><input type="checkbox" id="f-h-next" ${cfg.rail.next ? "checked" : ""}> Prochaine exécution</label>
      </div>
      <p class="hint">Tout décocher masque le panneau et élargit la page.</p></div>`;

  openModal("Personnaliser l'accueil", body, async () => {
    cfg.hero = $("#f-h-hero").checked;
    cfg.stats = $("#f-h-stats").checked;
    cfg.rail = {
      recents: $("#f-h-recents").checked,
      pinned: $("#f-h-pinned").checked,
      routines: $("#f-h-routines").checked,
      next: $("#f-h-next").checked,
    };
    state.settings.home = cfg;
    await saveState();
    closeModal();
    if (currentView.kind === "home") render();
    toast("Accueil mis à jour");
  });

  function renderRows() {
    const wrap = $("#hs");
    wrap.innerHTML = "";
    cfg.sections.forEach((s, idx) => {
      const meta = TABS[s.id];
      const row = document.createElement("div");
      row.className = "step";
      row.innerHTML = `
        <input type="checkbox" class="hs-on" ${s.on ? "checked" : ""} style="accent-color: var(--accent); width:15px; height:15px; cursor:pointer">
        <span class="step-dot" style="background: var(--c-${meta.color})"></span>
        <span class="step-name">${meta.title}</span>
        <button class="btn-icon s-up" title="Monter">▲</button>
        <button class="btn-icon s-down" title="Descendre">▼</button>`;
      row.querySelector(".hs-on").addEventListener("change", (e) => (s.on = e.target.checked));
      row.querySelector(".s-up").addEventListener("click", () => {
        if (idx === 0) return;
        [cfg.sections[idx - 1], cfg.sections[idx]] = [cfg.sections[idx], cfg.sections[idx - 1]];
        renderRows();
      });
      row.querySelector(".s-down").addEventListener("click", () => {
        if (idx === cfg.sections.length - 1) return;
        [cfg.sections[idx + 1], cfg.sections[idx]] = [cfg.sections[idx], cfg.sections[idx + 1]];
        renderRows();
      });
      wrap.appendChild(row);
    });
  }
  renderRows();
}

function homeSection(root, tab, limit) {
  const meta = TABS[tab];
  const all = tab === "routines"
    ? state.routines.map((r) => ({ ...r, type: "routine" }))
    : state.items.filter((i) => i.type === meta.type);
  const shown = [...all.filter((e) => e.pinned), ...all.filter((e) => !e.pinned)].slice(0, limit);

  root.innerHTML = `
    <div class="section-head">
      <span class="section-ico g-${meta.color}">${TYPE_SVG[meta.type]}</span>
      <div class="section-titles">
        <div class="section-title">${meta.title}</div>
        <div class="section-sub">${meta.sub}</div>
      </div>
      <div class="section-tools">
        <button class="link-more sec-more">Voir tout →</button>
        <button class="btn btn-accent sec-add">${SVG.plus}<span>${meta.add}</span></button>
      </div>
    </div>
    <div class="grid sec-grid"></div>`;

  const grid = root.querySelector(".sec-grid");
  if (!shown.length) {
    grid.innerHTML = `<div class="rail-empty">${meta.emptyText}</div>`;
  } else {
    for (const e of shown) grid.appendChild(cardFor(e, { noDrag: true }));
  }
  root.querySelector(".sec-more").addEventListener("click", () => { currentView = { kind: "tab", tab }; render(); });
  root.querySelector(".sec-add").addEventListener("click", () => openAddFor(tab));
}

function fillRail(root, entries, sideFn, emptyText) {
  root.innerHTML = "";
  if (!entries.length) {
    root.innerHTML = `<div class="rail-empty">${esc(emptyText)}</div>`;
    return;
  }
  for (const e of entries) {
    const b = document.createElement("button");
    b.className = "rail-item";
    b.innerHTML = `
      <span class="rail-ico">${railIcon(e)}</span>
      <span class="rail-main">
        <span class="rail-name">${esc(e.name)}</span>
        <span class="rail-sub">${TYPE_LABEL[e.type]}</span>
      </span>
      <span class="rail-side">${esc(sideFn(e))}</span>`;
    b.addEventListener("click", () => runEntry(e));
    b.addEventListener("contextmenu", (ev) => { ev.preventDefault(); openEntryCtx(ev.clientX, ev.clientY, e); });
    root.appendChild(b);
  }
}

function railIcon(entry) {
  if (entry.type === "site") {
    if (entry.iconData) return `<img src="${esc(entry.iconData)}" alt="">`;
    return siteImgTag(entry.url);
  }
  if (entry.iconData) return `<img src="${esc(entry.iconData)}" alt="">`;
  const svg = TYPE_SVG[entry.type] || SVG.app;
  return svg.replace("<svg ", `<svg style="color: var(--c-${TYPE_COLOR[entry.type]})" `);
}

/* ------------------------------------------------------------------------ */
/* Pages catégories et collections                                           */
/* ------------------------------------------------------------------------ */

function renderCategory(root) {
  let meta, entries, icoClass = "", icoSvg, colColor = null;
  if (currentView.kind === "collection") {
    const col = state.collections.find((c) => c.id === currentView.id);
    colColor = col?.color || "#38bdf8";
    meta = {
      title: col ? col.name : "Collection",
      sub: "Tous les éléments de cette collection, tous types confondus.",
      add: "Ajouter à la collection",
      emptyGlyph: "◫", emptyTitle: "Collection vide",
      emptyText: "Ajoutez des éléments via leur fiche d'édition ou le bouton ci-dessus.",
    };
    icoSvg = SVG.folder;
    entries = [
      ...state.items.filter((i) => (i.collections || []).includes(currentView.id)),
      ...state.routines
        .filter((r) => (r.collections || []).includes(currentView.id))
        .map((r) => ({ ...r, type: "routine" })),
    ];
  } else {
    meta = TABS[currentView.tab];
    icoClass = `g-${meta.color}`;
    icoSvg = currentView.tab === "sites" ? SVG.globe
      : currentView.tab === "scripts" ? SVG.terminal
      : currentView.tab === "apps" ? SVG.app
      : currentView.tab === "shortcuts" ? SVG.bolt
      : currentView.tab === "monitors" ? SVG.monitor
      : SVG.routine;
    entries = currentView.tab === "routines"
      ? state.routines.map((r) => ({ ...r, type: "routine" }))
      : state.items.filter((i) => i.type === meta.type);
  }
  entries = [...entries.filter((e) => e.pinned), ...entries.filter((e) => !e.pinned)];

  const page = document.createElement("div");
  page.innerHTML = `
    <div class="page-head">
      <span class="section-ico ${icoClass}" ${colColor ? `style="background:${colColor}"` : ""}>${icoSvg}</span>
      <div class="page-titles">
        <h1 class="page-title">${esc(meta.title)}</h1>
        <p class="page-sub">${esc(meta.sub)}</p>
      </div>
      <div class="page-tools">
        <button class="btn-icon" id="btn-view" title="Grille / liste">${state.settings.view === "list" ? SVG.gridview : SVG.listview}</button>
        <button class="btn btn-accent" id="btn-add">${SVG.plus}<span>${esc(meta.add)}</span></button>
      </div>
    </div>
    <div class="grid${state.settings.view === "list" ? " list" : ""}" id="grid"></div>
    <div class="empty" id="empty" hidden>
      <div class="empty-glyph">${meta.emptyGlyph}</div>
      <p class="empty-title">${esc(meta.emptyTitle)}</p>
      <p class="empty-text">${esc(meta.emptyText)}</p>
    </div>`;
  root.appendChild(page);

  const grid = $("#grid");
  $("#empty").hidden = entries.length > 0;
  for (const e of entries) grid.appendChild(cardFor(e));

  $("#btn-view").addEventListener("click", async () => {
    state.settings.view = state.settings.view === "list" ? "grid" : "list";
    await saveState();
    render();
  });
  $("#btn-add").addEventListener("click", () => {
    if (currentView.kind === "collection") return openTypeChooser(currentView.id);
    openAddFor(currentView.tab);
  });
}

function openAddFor(tab) {
  if (tab === "sites") openSiteEditor(null);
  else if (tab === "scripts") openScriptEditor(null);
  else if (tab === "apps") openAppEditor(null);
  else if (tab === "shortcuts") openShortcutEditor(null);
  else if (tab === "monitors") openMonitorEditor(null);
  else openRoutineEditor(null);
}

/* ------------------------------------------------------------------------ */
/* Cartes                                                                    */
/* ------------------------------------------------------------------------ */

let draggedId = null;

function cardIcon(entry) {
  if (entry.type === "site") {
    if (entry.iconData) return `<img src="${esc(entry.iconData)}" alt="">`;
    return siteImgTag(entry.url);
  }
  if (entry.iconData) return `<img src="${esc(entry.iconData)}" alt="">`;
  return TYPE_SVG[entry.type] || SVG.app;
}

function techSub(item) {
  if (item.type === "site") return hostOf(item.url);
  if (item.type === "script") return item.command || item.dir;
  if (item.type === "shortcut") return item.path;
  if (item.type === "monitor") return hostOf(item.statusUrl || "");
  if (item.type === "routine") return `${(item.steps || []).length} étape(s)`;
  return fileName(item.path);
}

function cardBadges(item) {
  const b = [];
  if (missing.has(item.id)) b.push(`<span class="badge missing">introuvable</span>`);
  if (item.type === "site") {
    const bPath = item.browserPath || state.settings.defaultBrowser?.path;
    if (bPath) {
      const bn = fileName(bPath).replace(/\.exe$/i, "");
      const label = bn.charAt(0).toUpperCase() + bn.slice(1);
      b.push(`<span class="badge">${esc(label)}</span>`);
    }
    if (item.profileName) b.push(`<span class="badge">${esc(item.profileName)}</span>`);
    if (item.private) b.push(`<span class="badge">privé</span>`);
  }
  if (item.type === "app" && item.admin) b.push(`<span class="badge">admin</span>`);
  if (item.type === "script") {
    b.push(`<span class="badge">CMD</span>`);
    if (item.confirm) b.push(`<span class="badge">confirmation</span>`);
    if (/\{[a-zA-Z0-9_]+\}/.test(item.command || "")) b.push(`<span class="badge">paramétrable</span>`);
  }
  if (item.type === "routine") b.push(`<span class="badge">${(item.steps || []).length} étapes</span>`);
  if (item.type === "monitor") {
    if (item.disabled) {
      b.push(`<span class="badge">en pause</span>`);
    } else {
      if (item.monError) b.push(`<span class="badge missing">hors ligne</span>`);
      b.push(`<span class="badge">toutes les ${Math.max(1, item.checkMinutes || 5)} min</span>`);
      if (item.monLastCheck) b.push(`<span class="badge">vérifié ${relTime(item.monLastCheck)}</span>`);
    }
    if (item.extPrivate) b.push(`<span class="badge">liens privés</span>`);
  }
  if (item.schedule && item.schedule.kind && item.schedule.kind !== "none") {
    b.push(`<span class="badge">planifié</span>`);
  }
  if (item.hotkey) b.push(`<span class="badge">${esc(item.hotkey)}</span>`);
  return b.join("");
}

function cardFor(entry, opts = {}) {
  const card = document.createElement("div");
  card.className = "card " + entry.type;
  card.tabIndex = 0;
  card.dataset.id = entry.id;

  const hasImg = entry.type === "site" || !!entry.iconData;
  const desc = entry.description || "";
  const tech = techSub(entry);
  // Pas de description : les sites ne montrent pas leur URL (visible au survol),
  // les autres types gardent leur info technique.
  const subHtml = desc
    ? `<div class="card-desc" title="${esc(tech)}">${esc(desc)}</div>`
    : (entry.type === "site" ? "" : `<div class="card-desc mono" title="${esc(tech)}">${esc(tech)}</div>`);
  if (entry.type === "monitor" && entry.disabled) card.classList.add("paused");
  const count = entry.type === "monitor" && entry.monCount > 0 && !entry.disabled
    ? `<span class="count-badge">${entry.monCount > 99 ? "99+" : entry.monCount}</span>` : "";
  card.innerHTML = `
    <div class="card-top">
      <div class="card-ico${!hasImg && entry.type === "app" ? " generic" : ""}">${cardIcon(entry)}${count}</div>
      <button class="btn-icon card-menu" title="Options">${SVG.dots}</button>
    </div>
    <div class="card-body">
      <div class="card-name" title="${esc(tech)}">${entry.pinned ? `<span class="pin">${SVG.pin}</span>` : ""}<span>${esc(entry.name)}</span></div>
      ${subHtml}
      <div class="card-badges">${cardBadges(entry)}</div>
    </div>`;

  card.addEventListener("click", (e) => {
    if (e.target.closest(".card-menu")) return;
    runEntry(entry);
  });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") runEntry(entry); });
  card.querySelector(".card-menu").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openEntryCtx(r.left, r.bottom + 4, entry);
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openEntryCtx(e.clientX, e.clientY, entry);
  });

  if (!opts.noDrag) {
    card.draggable = true;
    card.addEventListener("dragstart", () => { draggedId = entry.id; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { draggedId = null; card.classList.remove("dragging"); $$(".card").forEach(t => t.classList.remove("drop-target")); });
    card.addEventListener("dragover", (e) => { e.preventDefault(); if (draggedId && draggedId !== entry.id) card.classList.add("drop-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      card.classList.remove("drop-target");
      if (!draggedId || draggedId === entry.id) return;
      reorder(draggedId, entry.id, entry.type === "routine");
      await saveState();
      render();
    });
  }

  return card;
}

function openEntryCtx(x, y, entry) {
  const isRoutine = entry.type === "routine" || state.routines.some((r) => r.id === entry.id);
  const menu = [
    { label: isRoutine ? "Exécuter" : "Ouvrir", action: () => runEntry(entry) },
    { label: "Modifier", action: () => openEditor(entry) },
  ];
  if (entry.type === "monitor") {
    const extra = [];
    if (entry.disabled) {
      extra.push({ label: "Reprendre la veille", action: () => resumeMonitor(entry) });
    } else {
      extra.push({ label: "Vérifier maintenant", action: () => checkMonitor(findEntry(entry.id), true) });
      if (entry.startCommand) {
        extra.push({ label: "Relancer le process", action: () => startMonitorProcess(findEntry(entry.id), true) });
        extra.push({ label: "Stopper le process", action: () => stopMonitorProcess(findEntry(entry.id), true) });
      }
      extra.push({ label: "Mettre en pause", action: () => pauseMonitor(entry) });
    }
    menu.splice(1, 0, ...extra);
  }
  if (missing.has(entry.id)) {
    menu.push({ label: "Localiser le chemin…", action: () => relocate(entry) });
  }
  menu.push(
    { label: "Dupliquer", action: () => duplicateEntry(entry) },
    { label: entry.pinned ? "Désépingler" : "Épingler", action: () => togglePin(entry) },
  );
  if (vaultUnlocked) {
    const real = findEntry(entry.id);
    if (real?._vaulted) menu.push({ label: "Sortir du coffre", action: () => unvaultEntry(entry) });
    else menu.push({ label: "Masquer dans le coffre", action: () => vaultEntry(entry) });
  }
  menu.push(
    { sep: true },
    { label: "Supprimer", danger: true, action: () => deleteEntry(entry) },
  );
  openCtx(x, y, menu);
}

function reorder(movedId, targetId, isRoutineList) {
  const arr = isRoutineList ? state.routines : state.items;
  const from = arr.findIndex((x) => x.id === movedId);
  const to = arr.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
}

async function togglePin(entry) {
  const real = findEntry(entry.id);
  if (!real) return;
  real.pinned = !real.pinned;
  await saveState();
  render();
}

function findEntry(id) {
  return state.items.find((i) => i.id === id) || state.routines.find((r) => r.id === id);
}

async function deleteEntry(entry) {
  if (!(await askConfirm(`Supprimer « ${entry.name} » ?`))) return;
  state.items = state.items.filter((i) => i.id !== entry.id);
  state.routines = state.routines.filter((r) => r.id !== entry.id);
  for (const r of state.routines) {
    r.steps = (r.steps || []).filter((s) => s.itemId !== entry.id);
  }
  await saveState();
  await applyHotkeys();
  render();
  toast(`« ${entry.name} » supprimé`);
}

async function duplicateEntry(entry) {
  const real = findEntry(entry.id);
  if (!real) return;
  const copy = JSON.parse(JSON.stringify(real));
  copy.id = uid();
  copy.name = real.name + " (copie)";
  copy.pinned = false;
  copy.hotkey = null;
  if (state.routines.some((r) => r.id === real.id)) state.routines.push(copy);
  else state.items.push(copy);
  await saveState();
  render();
}

async function relocate(entry) {
  const real = findEntry(entry.id);
  if (!real) return;
  let picked = null;
  if (real.type === "script") {
    picked = await invoke("pick_folder", { title: "Localiser le dossier du script" });
  } else if (real.type === "app") {
    picked = await invoke("pick_file", { title: "Localiser l'exécutable", extensions: ["exe", "bat", "cmd", "msi", "lnk"] });
  } else if (real.type === "shortcut") {
    picked = hasExtension(real.path)
      ? await invoke("pick_file", { title: "Localiser le fichier", extensions: [] })
      : await invoke("pick_folder", { title: "Localiser le dossier" });
  }
  if (!picked) return;
  if (real.type === "script") real.dir = picked;
  else real.path = picked;
  await saveState();
  await checkAllPaths();
  render();
  toast("Chemin mis à jour");
}

/* ------------------------------------------------------------------------ */
/* Lancement                                                                 */
/* ------------------------------------------------------------------------ */

async function runEntry(entry) {
  try {
    const real = findEntry(entry.id) || entry;
    if (entry.type === "routine" || state.routines.some((r) => r.id === entry.id)) {
      await runRoutine(real);
    } else {
      await launchItem(real);
    }
  } catch (e) {
    if (e !== "cancelled") toast(String(e), true);
  }
}

async function launchItem(item, opts = {}) {
  if (item.type === "site") {
    const browser = item.browserPath || state.settings.defaultBrowser?.path;
    if (!browser) throw "Aucun navigateur par défaut. Configurez-le dans Paramètres.";
    const profile = item.browserPath
      ? item.profileDir || null
      : item.profileDir || state.settings.defaultProfile || null;
    await invoke("launch_site", {
      browser, profile, url: item.url,
      incognito: !!item.private, newWindow: !!item.newWindow,
    });
  } else if (item.type === "script") {
    if (item.confirm && !opts.scheduled) {
      await ensureVisible();
      if (!(await askConfirm(`Exécuter « ${item.name} » ?`))) throw "cancelled";
    }
    let command = item.command || null;
    if (command) {
      const params = [...new Set([...command.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]))];
      if (params.length) {
        if (opts.scheduled) throw "commande paramétrable, exécution planifiée impossible";
        await ensureVisible();
        const vals = await askParams(item.name, params);
        if (!vals) throw "cancelled";
        for (const p of params) command = command.split(`{${p}}`).join(vals[p]);
      }
    }
    await invoke("launch_script", {
      dir: item.dir, command, mode: item.mode || "keep",
      env: item.env && item.env.length ? item.env : null,
    });
  } else if (item.type === "shortcut") {
    await invoke("open_path", { path: item.path });
  } else if (item.type === "monitor") {
    const url = item.openUrl || item.statusUrl;
    if (!url) throw "Aucune URL configurée pour ce moniteur.";
    const extBrowser = item.extBrowserPath || state.settings.defaultBrowser?.path || null;
    const extProfile = item.extBrowserPath
      ? item.extProfileDir || null
      : item.extProfileDir || state.settings.defaultProfile || null;
    await invoke("open_panel", {
      label: "mon-" + item.id, url, title: item.name,
      extBrowser, extProfile, extIncognito: !!item.extPrivate,
    });
  } else {
    await invoke("launch_app", {
      path: item.path, args: item.args || null,
      workdir: item.workdir || null, admin: !!item.admin,
    });
  }
  const real = findEntry(item.id);
  if (real) {
    real.lastUsed = Date.now();
    saveState();
    if (currentView.kind === "home") render();
  }
}

async function runRoutine(routine, opts = {}) {
  const steps = routine.steps || [];
  if (!steps.length) { toast("Routine vide : ajoutez des étapes.", true); return; }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const item = state.items.find((x) => x.id === step.itemId);
    if (!item) {
      toast(`Étape ${i + 1} : élément introuvable, ignoré`, true);
      if (routine.stopOnError) return;
      continue;
    }
    try {
      await launchItem(item, opts);
    } catch (e) {
      if (e === "cancelled") return;
      toast(`Étape ${i + 1} (${item.name}) : ${e}`, true);
      if (routine.stopOnError) return;
    }
    if (i < steps.length - 1) {
      await new Promise((r) => setTimeout(r, Math.max(0, (step.delay ?? 1) * 1000)));
    }
  }
  const real = state.routines.find((r) => r.id === routine.id);
  if (real) { real.lastUsed = Date.now(); saveState(); }
  toast(`Routine « ${routine.name} » terminée`);
}

/* ------------------------------------------------------------------------ */
/* Modale générique + confirmation                                           */
/* ------------------------------------------------------------------------ */

let modalSaveHandler = null;
let modalCancelHandler = null;

function openModal(title, bodyHtml, onSave) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyHtml;
  modalSaveHandler = onSave;
  modalCancelHandler = null;
  $("#modal").hidden = false;
  const first = $("#modal-body input, #modal-body select");
  if (first) first.focus();
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modal-body").innerHTML = "";
  modalSaveHandler = null;
  if (modalCancelHandler) { const h = modalCancelHandler; modalCancelHandler = null; h(); }
}

let confirmResolve = null;
function askConfirm(message) {
  return new Promise((res) => {
    confirmResolve = res;
    $("#confirm-msg").textContent = message;
    $("#confirm").hidden = false;
    $("#confirm-yes").focus();
  });
}
function settleConfirm(v) {
  $("#confirm").hidden = true;
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(v); }
}

function askParams(title, params) {
  return new Promise((res) => {
    const body = params.map((p) => `
      <div class="field">
        <label>${esc(p)}</label>
        <input class="input mono f-param" data-p="${esc(p)}">
      </div>`).join("");
    openModal(`Paramètres — ${title}`, body, () => {
      const out = {};
      $$(".f-param").forEach((i) => (out[i.dataset.p] = i.value));
      modalCancelHandler = null;
      closeModal();
      res(out);
    });
    modalCancelHandler = () => res(null);
  });
}

/* ------------------------------------------------------------------------ */
/* Briques de formulaire                                                     */
/* ------------------------------------------------------------------------ */

function browserOptions(selectedPath, withDefault) {
  let html = "";
  if (withDefault) {
    const d = state.settings.defaultBrowser;
    html += `<option value="">Par défaut${d ? ` (${esc(d.name)})` : ""}</option>`;
  }
  for (const b of detectedBrowsers) {
    const sel = b.path === selectedPath ? " selected" : "";
    html += `<option value="${esc(b.path)}"${sel}>${esc(b.name)}</option>`;
  }
  if (selectedPath && !detectedBrowsers.some((b) => b.path === selectedPath)) {
    html += `<option value="${esc(selectedPath)}" selected>${esc(fileName(selectedPath))}</option>`;
  }
  html += `<option value="__browse__">Autre… (parcourir)</option>`;
  return html;
}

async function fillProfiles(selectEl, browserPath, selectedDir) {
  selectEl.innerHTML = `<option value="">Profil par défaut du navigateur</option>`;
  selectEl.disabled = true;
  if (!browserPath) return;
  try {
    const profiles = await invoke("list_profiles", { browserPath });
    if (!profiles.length) return;
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.dir;
      opt.textContent = p.name + (p.name !== p.dir ? ` (${p.dir})` : "");
      if (p.dir === selectedDir) opt.selected = true;
      selectEl.appendChild(opt);
    }
    selectEl.disabled = false;
  } catch { /* pas de profils */ }
}

function wireBrowserSelect(browserSel, profileSel, getEffectivePath) {
  browserSel.addEventListener("change", async () => {
    if (browserSel.value === "__browse__") {
      const picked = await invoke("pick_file", {
        title: "Choisir l'exécutable du navigateur", extensions: ["exe"],
      });
      if (picked) {
        const opt = document.createElement("option");
        opt.value = picked;
        opt.textContent = fileName(picked);
        browserSel.insertBefore(opt, browserSel.querySelector('[value="__browse__"]'));
        browserSel.value = picked;
      } else {
        browserSel.value = "";
      }
    }
    await fillProfiles(profileSel, getEffectivePath(), null);
  });
}

function descField(entry) {
  return `
    <div class="field"><label>Description (optionnel)</label>
      <input class="input" id="f-desc" placeholder="Gestionnaire de demandes" value="${esc(entry.description || "")}"></div>`;
}

function readDesc(data) {
  data.description = $("#f-desc") ? $("#f-desc").value.trim() || null : data.description;
}

function collectionsField(entry) {
  if (!state.collections.length) return "";
  const boxes = state.collections.map((c) => `
    <label class="check"><input type="checkbox" class="f-col" value="${c.id}"
      ${(entry.collections || []).includes(c.id) ? "checked" : ""}> ${esc(c.name)}</label>`).join("");
  return `<hr class="form-sep"><div class="field"><label>Collections</label><div class="checks">${boxes}</div></div>`;
}

function readCollections() {
  return $$(".f-col:checked").map((i) => i.value);
}

function hotkeyField(entry) {
  return `
    <div class="field"><label>Raccourci clavier global (optionnel)</label>
      <div class="row">
        <input class="input mono" id="f-hotkey" placeholder="Cliquez ici puis tapez la combinaison…" value="${esc(entry.hotkey || "")}" readonly>
        <button class="btn" id="f-hotkey-clear" type="button">Effacer</button>
      </div>
      <p class="hint">Exemple : Ctrl+Alt+S. Fonctionne même quand ProHub est en arrière-plan.</p>
    </div>`;
}

function wireHotkeyField() {
  const inp = $("#f-hotkey");
  if (!inp) return;
  inp.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey) mods.push("super");
    let key = e.key === " " ? "space" : e.key;
    if (key.length === 1) key = key.toLowerCase();
    key = key.toLowerCase()
      .replace("arrowup", "up").replace("arrowdown", "down")
      .replace("arrowleft", "left").replace("arrowright", "right");
    if (!/^[a-z0-9]$|^f\d{1,2}$|^space$|^enter$|^tab$|^(up|down|left|right)$/.test(key)) return;
    if (!mods.length && !/^f\d/.test(key)) {
      toast("Ajoutez un modificateur (Ctrl, Alt ou Shift).", true);
      return;
    }
    inp.value = [...mods, key].join("+");
  });
  $("#f-hotkey-clear").addEventListener("click", () => (inp.value = ""));
}

function readHotkey(data) {
  const inp = $("#f-hotkey");
  if (!inp) return true;
  const hotkey = inp.value.trim() || null;
  if (hotkey && hotkeyTaken(hotkey, data.id)) {
    toast("Ce raccourci est déjà utilisé par un autre élément.", true);
    return false;
  }
  data.hotkey = hotkey;
  return true;
}

function iconField(entry, withReset, extraBtn = "") {
  const site = entry.type === "site" && entry.url;
  const src = entry.iconData || (site ? faviconDirect(entry.url) : "");
  const fb = !entry.iconData && site ? faviconUrl(entry.url) : "";
  return `
    <div class="field">
      <label>Icône</label>
      <div class="icon-preview">
        <div class="card-ico"><img id="f-icon-img" src="${esc(src)}" alt="" data-fb="${esc(fb)}" ${src ? "" : 'style="display:none"'} onerror="if(this.dataset.fb&&!this.dataset.done){this.dataset.done=1;this.src=this.dataset.fb}else{this.style.display='none'}"></div>
        <button class="btn" id="f-icon-pick" type="button">Choisir une image…</button>
        ${extraBtn}
        ${withReset ? '<button class="btn" id="f-icon-reset" type="button">Favicon auto</button>' : ""}
      </div>
    </div>`;
}

function setIconPreview(data) {
  const img = $("#f-icon-img");
  if (!img) return;
  img.style.display = data ? "" : "none";
  if (data) img.src = data;
}

function wireIconField(setIcon, resetSrc) {
  $("#f-icon-pick")?.addEventListener("click", async () => {
    const picked = await invoke("pick_file", {
      title: "Choisir une icône",
      extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"],
    });
    if (!picked) return;
    try {
      const data = await invoke("read_image_base64", { path: picked });
      setIcon(data);
      setIconPreview(data);
    } catch (e) { toast(String(e), true); }
  });
  $("#f-icon-reset")?.addEventListener("click", () => {
    setIcon(null);
    const src = resetSrc();
    setIconPreview(src || null);
    if (src) { const img = $("#f-icon-img"); img.style.display = ""; img.src = src; }
  });
}

async function upsertItem(data, editing) {
  if (editing) state.items = state.items.map((i) => (i.id === data.id ? data : i));
  else state.items.push(data);
  await saveState();
  await applyHotkeys();
  await checkAllPaths();
  closeModal();
  render();
}

async function checkDuplicate(data, keyFn, label) {
  const key = keyFn(data);
  if (!key) return true;
  const dup = state.items.find((i) => i.id !== data.id && i.type === data.type && keyFn(i) === key);
  if (!dup) return true;
  return askConfirm(`${label} déjà présent sous « ${dup.name} ». Ajouter quand même ?`);
}

/* ------------------------------------------------------------------------ */
/* Éditeurs                                                                  */
/* ------------------------------------------------------------------------ */

function openEditor(entry) {
  if (entry.type === "routine" || state.routines.some((r) => r.id === entry.id)) return openRoutineEditor(findEntry(entry.id));
  const real = findEntry(entry.id);
  if (entry.type === "site") openSiteEditor(real);
  else if (entry.type === "script") openScriptEditor(real);
  else if (entry.type === "shortcut") openShortcutEditor(real);
  else if (entry.type === "monitor") openMonitorEditor(real);
  else openAppEditor(real);
}

/* ----- Site -------------------------------------------------------------- */

function openSiteEditor(item, presetCollection) {
  const editing = !!item;
  const data = item ? { ...item } : { id: uid(), type: "site", pinned: false, collections: presetCollection ? [presetCollection] : [] };
  let iconData = data.iconData || null;

  const body = `
    <div class="field"><label>Nom</label>
      <input class="input" id="f-name" placeholder="Jellyseerr" value="${esc(data.name || "")}"></div>
    ${descField(data)}
    <div class="field"><label>URL</label>
      <input class="input mono" id="f-url" placeholder="https://seerr.mondomaine.fr" value="${esc(data.url || "")}"></div>
    <div class="field"><label>Navigateur</label>
      <select class="input" id="f-browser">${browserOptions(data.browserPath || "", true)}</select>
      <p class="hint">« Par défaut » suit le navigateur choisi dans Paramètres.</p></div>
    <div class="field"><label>Profil</label>
      <select class="input" id="f-profile" disabled></select></div>
    <div class="field">
      <label class="check"><input type="checkbox" id="f-private" ${data.private ? "checked" : ""}> Fenêtre privée</label>
      <label class="check"><input type="checkbox" id="f-newwin" ${data.newWindow ? "checked" : ""}> Toujours ouvrir dans une nouvelle fenêtre</label>
    </div>
    ${iconField(data, true)}
    ${hotkeyField(data)}
    ${collectionsField(data)}`;

  openModal(editing ? "Modifier le site" : "Ajouter un site", body, async () => {
    const name = $("#f-name").value.trim();
    let url = $("#f-url").value.trim();
    if (!name || !url) return toast("Nom et URL obligatoires.", true);
    if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
    if (!readHotkey(data)) return;
    readDesc(data);

    const browserPath = $("#f-browser").value || null;
    const profileSel = $("#f-profile");
    const profileDir = profileSel.value || null;
    const profileName = profileDir
      ? profileSel.options[profileSel.selectedIndex].textContent.replace(/\s\(.+\)$/, "")
      : null;

    Object.assign(data, {
      name, url, browserPath, profileDir, profileName, iconData,
      private: $("#f-private").checked,
      newWindow: $("#f-newwin").checked,
      collections: readCollections(),
    });
    if (!(await checkDuplicate(data, (i) => (i.url || "").replace(/\/+$/, "").toLowerCase(), "Site"))) return;
    await upsertItem(data, editing);
  });

  const browserSel = $("#f-browser");
  const profileSel = $("#f-profile");
  const effective = () => browserSel.value || state.settings.defaultBrowser?.path || "";
  wireBrowserSelect(browserSel, profileSel, effective);
  fillProfiles(profileSel, effective(), data.profileDir);

  const refreshFavicon = () => {
    const u = $("#f-url").value.trim();
    const img = $("#f-icon-img");
    img.style.display = "";
    delete img.dataset.done;
    img.dataset.fb = faviconUrl(u);
    img.src = faviconDirect(u);
  };
  $("#f-url").addEventListener("change", () => { if (!iconData) refreshFavicon(); });
  wireIconField((v) => (iconData = v), () => "");
  $("#f-icon-reset").addEventListener("click", refreshFavicon);
  wireHotkeyField();
}

/* ----- Script ------------------------------------------------------------ */

function openScriptEditor(item, presetCollection) {
  const editing = !!item;
  const data = item ? { ...item } : { id: uid(), type: "script", pinned: false, mode: state.settings.defaultScriptMode || "keep", collections: presetCollection ? [presetCollection] : [] };
  let iconData = data.iconData || null;

  const envText = (data.env || []).map(([k, v]) => `${k}=${v}`).join("\n");
  const body = `
    <div class="field"><label>Nom</label>
      <input class="input" id="f-name" placeholder="Backup Unraid" value="${esc(data.name || "")}"></div>
    ${descField(data)}
    <div class="field"><label>Dossier de travail</label>
      <div class="row">
        <input class="input mono" id="f-dir" placeholder="C:\\Scripts\\backup" value="${esc(data.dir || "")}">
        <button class="btn" id="f-dir-pick" type="button">Parcourir…</button>
      </div></div>
    <div class="field"><label>Commande (optionnel)</label>
      <input class="input mono" id="f-cmd" placeholder="python backup.py --cible {dossier}" value="${esc(data.command || "")}">
      <p class="hint">Vide : ouvre simplement un terminal dans le dossier. Les champs entre accolades, comme {dossier}, seront demandés à chaque lancement.</p></div>
    <div class="field"><label>Après l'exécution</label>
      <select class="input" id="f-mode">
        <option value="keep" ${data.mode !== "close" ? "selected" : ""}>Garder la console ouverte</option>
        <option value="close" ${data.mode === "close" ? "selected" : ""}>Fermer la console à la fin</option>
      </select></div>
    <div class="field">
      <label class="check"><input type="checkbox" id="f-confirm" ${data.confirm ? "checked" : ""}> Demander confirmation avant l'exécution</label>
    </div>
    <div class="field"><label>Variables d'environnement (optionnel)</label>
      <textarea class="input mono" id="f-env" rows="3" placeholder="API_KEY=xxxx&#10;MODE=prod">${esc(envText)}</textarea>
      <p class="hint">Une variable par ligne, au format NOM=valeur.</p></div>
    ${scheduleField(data)}
    ${iconField(data, false)}
    ${hotkeyField(data)}
    ${collectionsField(data)}`;

  openModal(editing ? "Modifier le script" : "Ajouter un script", body, async () => {
    const name = $("#f-name").value.trim();
    const dir = $("#f-dir").value.trim();
    if (!name || !dir) return toast("Nom et dossier obligatoires.", true);
    if (!readHotkey(data)) return;
    readDesc(data);

    const env = [];
    for (const line of $("#f-env").value.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) return toast(`Variable invalide : « ${t} » (format NOM=valeur)`, true);
      env.push([t.slice(0, eq).trim(), t.slice(eq + 1)]);
    }
    if (!readSchedule(data, $("#f-cmd").value.trim())) return;

    Object.assign(data, {
      name, dir,
      command: $("#f-cmd").value.trim() || null,
      mode: $("#f-mode").value,
      confirm: $("#f-confirm").checked,
      env,
      iconData,
      collections: readCollections(),
    });
    if (!(await checkDuplicate(data, (i) => `${(i.dir || "").toLowerCase()}|${(i.command || "").toLowerCase()}`, "Script"))) return;
    await upsertItem(data, editing);
  });

  $("#f-dir-pick").addEventListener("click", async () => {
    const picked = await invoke("pick_folder", { title: "Choisir le dossier du script" });
    if (picked) $("#f-dir").value = picked;
  });
  wireIconField((v) => (iconData = v), () => "");
  wireHotkeyField();
  wireScheduleField();
}

/* ----- Application ------------------------------------------------------- */

function openAppEditor(item, presetCollection) {
  const editing = !!item;
  const data = item ? { ...item } : { id: uid(), type: "app", pinned: false, collections: presetCollection ? [presetCollection] : [] };
  let iconData = data.iconData || null;

  const body = `
    <div class="field"><label>Nom</label>
      <input class="input" id="f-name" placeholder="ProKill" value="${esc(data.name || "")}"></div>
    ${descField(data)}
    <div class="field"><label>Exécutable</label>
      <div class="row">
        <input class="input mono" id="f-path" placeholder="C:\\Tools\\prokill.exe" value="${esc(data.path || "")}">
        <button class="btn" id="f-path-pick" type="button">Parcourir…</button>
      </div></div>
    <div class="field"><label>Arguments (optionnel)</label>
      <input class="input mono" id="f-args" placeholder="--minimized" value="${esc(data.args || "")}"></div>
    <div class="field"><label>Dossier de travail (optionnel)</label>
      <div class="row">
        <input class="input mono" id="f-workdir" placeholder="Par défaut : dossier de l'exe" value="${esc(data.workdir || "")}">
        <button class="btn" id="f-workdir-pick" type="button">Parcourir…</button>
      </div></div>
    <div class="field">
      <label class="check"><input type="checkbox" id="f-admin" ${data.admin ? "checked" : ""}> Lancer en administrateur (UAC)</label>
    </div>
    ${iconField(data, false, '<button class="btn" id="f-icon-exe" type="button">Icône de l\'exe</button>')}
    ${hotkeyField(data)}
    ${collectionsField(data)}`;

  openModal(editing ? "Modifier l'application" : "Ajouter une application", body, async () => {
    const name = $("#f-name").value.trim();
    const path = $("#f-path").value.trim();
    if (!name || !path) return toast("Nom et exécutable obligatoires.", true);
    if (!readHotkey(data)) return;
    readDesc(data);
    Object.assign(data, {
      name, path,
      args: $("#f-args").value.trim() || null,
      workdir: $("#f-workdir").value.trim() || null,
      admin: $("#f-admin").checked,
      iconData,
      collections: readCollections(),
    });
    if (!(await checkDuplicate(data, (i) => (i.path || "").toLowerCase(), "Exécutable"))) return;
    await upsertItem(data, editing);
  });

  $("#f-path-pick").addEventListener("click", async () => {
    const picked = await invoke("pick_file", {
      title: "Choisir l'exécutable", extensions: ["exe", "bat", "cmd", "msi", "lnk"],
    });
    if (picked) {
      $("#f-path").value = picked;
      if (!$("#f-name").value.trim()) {
        $("#f-name").value = fileName(picked).replace(/\.(exe|bat|cmd|msi|lnk)$/i, "");
      }
      if (!iconData) {
        const d = await tryExtractIcon(picked);
        if (d) { iconData = d; setIconPreview(d); }
      }
    }
  });
  $("#f-workdir-pick").addEventListener("click", async () => {
    const picked = await invoke("pick_folder", { title: "Choisir le dossier de travail" });
    if (picked) $("#f-workdir").value = picked;
  });
  $("#f-icon-exe").addEventListener("click", async () => {
    const p = $("#f-path").value.trim();
    if (!p) return toast("Renseignez d'abord l'exécutable.", true);
    const d = await tryExtractIcon(p);
    if (!d) return toast("Impossible d'extraire une icône de ce fichier.", true);
    iconData = d;
    setIconPreview(d);
  });
  wireIconField((v) => (iconData = v), () => "");
  wireHotkeyField();
}

/* ----- Raccourci (fichier ou dossier) ------------------------------------ */

function openShortcutEditor(item, presetCollection) {
  const editing = !!item;
  const data = item ? { ...item } : { id: uid(), type: "shortcut", pinned: false, collections: presetCollection ? [presetCollection] : [] };
  let iconData = data.iconData || null;

  const body = `
    <div class="field"><label>Nom</label>
      <input class="input" id="f-name" placeholder="Dossier Projets" value="${esc(data.name || "")}"></div>
    ${descField(data)}
    <div class="field"><label>Fichier ou dossier</label>
      <div class="row">
        <input class="input mono" id="f-path" placeholder="C:\\Users\\moi\\Documents\\projets" value="${esc(data.path || "")}">
        <button class="btn" id="f-pick-file" type="button">Fichier…</button>
        <button class="btn" id="f-pick-folder" type="button">Dossier…</button>
      </div>
      <p class="hint">Un fichier s'ouvre avec son application par défaut, un dossier dans l'Explorateur.</p></div>
    ${iconField(data, false)}
    ${hotkeyField(data)}
    ${collectionsField(data)}`;

  openModal(editing ? "Modifier le raccourci" : "Ajouter un raccourci", body, async () => {
    const name = $("#f-name").value.trim();
    const path = $("#f-path").value.trim();
    if (!name || !path) return toast("Nom et chemin obligatoires.", true);
    if (!readHotkey(data)) return;
    readDesc(data);
    Object.assign(data, { name, path, iconData, collections: readCollections() });
    if (!(await checkDuplicate(data, (i) => (i.path || "").toLowerCase(), "Raccourci"))) return;
    await upsertItem(data, editing);
  });

  $("#f-pick-file").addEventListener("click", async () => {
    const picked = await invoke("pick_file", { title: "Choisir un fichier", extensions: [] });
    if (picked) {
      $("#f-path").value = picked;
      if (!$("#f-name").value.trim()) $("#f-name").value = fileName(picked);
      if (!iconData) {
        const d = await tryExtractIcon(picked);
        if (d) { iconData = d; setIconPreview(d); }
      }
    }
  });
  $("#f-pick-folder").addEventListener("click", async () => {
    const picked = await invoke("pick_folder", { title: "Choisir un dossier" });
    if (picked) {
      $("#f-path").value = picked;
      if (!$("#f-name").value.trim()) $("#f-name").value = fileName(picked);
    }
  });
  wireIconField((v) => (iconData = v), () => "");
  wireHotkeyField();
}

/* ----- Routine ------------------------------------------------------------ */

function openRoutineEditor(routine, presetCollection) {
  const editing = !!routine;
  const data = routine
    ? JSON.parse(JSON.stringify(routine))
    : { id: uid(), name: "", pinned: false, steps: [], stopOnError: true, collections: presetCollection ? [presetCollection] : [] };

  const itemOptions = () => {
    const groups = { site: [], script: [], app: [], shortcut: [] };
    for (const i of state.items) groups[i.type]?.push(i);
    let html = `<option value="">Ajouter une étape…</option>`;
    for (const [t, arr] of Object.entries(groups)) {
      if (!arr.length) continue;
      html += `<optgroup label="${TYPE_LABEL[t]}s">`;
      for (const i of arr) html += `<option value="${i.id}">${esc(i.name)}</option>`;
      html += `</optgroup>`;
    }
    return html;
  };

  const body = `
    <div class="field"><label>Nom</label>
      <input class="input" id="f-name" placeholder="Session de travail" value="${esc(data.name || "")}"></div>
    ${descField(data)}
    <div class="field"><label>Étapes (exécutées dans l'ordre)</label>
      <div class="steps" id="steps"></div>
      <select class="input" id="f-add-step">${itemOptions()}</select>
      <p class="hint">Le délai (en secondes) est appliqué après chaque étape.</p></div>
    <div class="field">
      <label class="check"><input type="checkbox" id="f-stop" ${data.stopOnError !== false ? "checked" : ""}> Arrêter la routine si une étape échoue</label>
    </div>
    ${scheduleField(data)}
    ${hotkeyField(data)}
    ${collectionsField(data)}`;

  openModal(editing ? "Modifier la routine" : "Ajouter une routine", body, async () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Nom obligatoire.", true);
    if (!data.steps.length) return toast("Ajoutez au moins une étape.", true);
    if (!readHotkey(data)) return;
    if (!readSchedule(data, "")) return;
    readDesc(data);
    syncDelays();
    Object.assign(data, {
      name,
      stopOnError: $("#f-stop").checked,
      collections: readCollections(),
    });
    if (editing) state.routines = state.routines.map((r) => (r.id === data.id ? data : r));
    else state.routines.push(data);
    await saveState();
    await applyHotkeys();
    closeModal();
    render();
  });

  function syncDelays() {
    $$("#steps .step").forEach((row, idx) => {
      const v = parseFloat(row.querySelector(".step-delay").value);
      data.steps[idx].delay = isNaN(v) || v < 0 ? 1 : v;
    });
  }

  function renderSteps() {
    const wrap = $("#steps");
    wrap.innerHTML = "";
    data.steps.forEach((step, idx) => {
      const item = state.items.find((i) => i.id === step.itemId);
      const row = document.createElement("div");
      row.className = "step";
      row.innerHTML = `
        <span class="step-dot" style="background: var(--c-${item ? TYPE_COLOR[item.type] : "collections"})"></span>
        <span class="step-name">${item ? esc(item.name) : "(élément supprimé)"}</span>
        <input class="input mono step-delay" type="number" min="0" step="0.5" value="${step.delay ?? 1}" title="Délai après l'étape (s)">
        <button class="btn-icon s-up" title="Monter">▲</button>
        <button class="btn-icon s-down" title="Descendre">▼</button>
        <button class="btn-icon danger s-del" title="Retirer">✕</button>`;
      row.querySelector(".s-up").addEventListener("click", () => {
        if (idx === 0) return;
        syncDelays();
        [data.steps[idx - 1], data.steps[idx]] = [data.steps[idx], data.steps[idx - 1]];
        renderSteps();
      });
      row.querySelector(".s-down").addEventListener("click", () => {
        if (idx === data.steps.length - 1) return;
        syncDelays();
        [data.steps[idx + 1], data.steps[idx]] = [data.steps[idx], data.steps[idx + 1]];
        renderSteps();
      });
      row.querySelector(".s-del").addEventListener("click", () => {
        syncDelays();
        data.steps.splice(idx, 1);
        renderSteps();
      });
      wrap.appendChild(row);
    });
  }

  renderSteps();
  $("#f-add-step").addEventListener("change", () => {
    const id = $("#f-add-step").value;
    if (!id) return;
    syncDelays();
    data.steps.push({ itemId: id, delay: 1 });
    $("#f-add-step").value = "";
    renderSteps();
  });
  wireHotkeyField();
  wireScheduleField();
}

/* ----- Collection ---------------------------------------------------------- */

function openCollectionEditor(col) {
  const editing = !!col;
  let color = col?.color || COLPALETTE[state.collections.length % COLPALETTE.length];
  const body = `
    <div class="field"><label>Nom de la collection</label>
      <input class="input" id="f-name" placeholder="Serveur maison" value="${esc(col?.name || "")}"></div>
    <div class="field"><label>Couleur</label>
      <div class="color-dots" id="f-colors">
        ${COLPALETTE.map((c) => `<button type="button" class="color-dot${c === color ? " selected" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}
      </div></div>`;
  openModal(editing ? "Modifier la collection" : "Nouvelle collection", body, async () => {
    const name = $("#f-name").value.trim();
    if (!name) return toast("Nom obligatoire.", true);
    if (editing) {
      const real = state.collections.find((c) => c.id === col.id);
      if (real) { real.name = name; real.color = color; }
    } else {
      state.collections.push({ id: uid(), name, color });
    }
    await saveState();
    closeModal();
    render();
  });
  $$("#f-colors .color-dot").forEach((b) => {
    b.addEventListener("click", () => {
      color = b.dataset.c;
      $$("#f-colors .color-dot").forEach((x) => x.classList.toggle("selected", x === b));
    });
  });
}

/* ----- Choix du type (ajout depuis une collection) ------------------------- */

function openTypeChooser(collectionId) {
  const body = `
    <div class="field"><div class="checks" id="type-choices">
      ${["site", "script", "app", "shortcut", "monitor"].map((t) => `
        <button class="btn" data-type="${t}" style="justify-content:flex-start; margin-bottom:6px;">
          <span class="nav-dot" style="background: var(--c-${TYPE_COLOR[t]})"></span> ${TYPE_LABEL[t]}
        </button>`).join("")}
    </div></div>`;
  openModal("Ajouter à la collection", body, null);
  $("#modal-save").style.display = "none";
  modalCancelHandler = () => { $("#modal-save").style.display = ""; };
  $$("#type-choices .btn").forEach((b) => {
    b.addEventListener("click", () => {
      $("#modal-save").style.display = "";
      modalCancelHandler = null;
      closeModal();
      const t = b.dataset.type;
      if (t === "site") openSiteEditor(null, collectionId);
      else if (t === "script") openScriptEditor(null, collectionId);
      else if (t === "shortcut") openShortcutEditor(null, collectionId);
      else if (t === "monitor") openMonitorEditor(null, collectionId);
      else openAppEditor(null, collectionId);
    });
  });
}

/* ----- Paramètres ---------------------------------------------------------- */

/* --- Fenêtre Paramètres : navigation + sections + brouillon --------------- */

const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Apparence", icon: () => SVG.moon,
    desc: "Thème, densité, couleur d'accent et bandeau d'accueil." },
  { id: "browsers", label: "Navigateurs", icon: () => SVG.globe,
    desc: "Navigateur et profil utilisés par défaut pour vos sites." },
  { id: "scripts", label: "Scripts", icon: () => SVG.terminal,
    desc: "Comportement par défaut des scripts. Chaque script peut le surcharger dans sa fiche." },
  { id: "hotkeys", label: "Raccourcis", icon: () => SVG.bolt,
    desc: "Raccourci global de la palette et raccourcis clavier par élément." },
  { id: "behavior", label: "Comportement", icon: () => SVG.gear,
    desc: "Démarrage, zone de notification et accueil." },
  { id: "data", label: "Données", icon: () => SVG.folder,
    desc: "Export, import, sauvegardes et historique." },
  { id: "about", label: "À propos", icon: () => SVG.info,
    desc: "Version, mises à jour et licences." },
];

let settingsDraft = null;
let settingsDirty = false;
let settingsSection = "appearance";

function markSettingsDirty() { settingsDirty = true; }

async function openSettings() {
  const s = state.settings;
  settingsDraft = {
    theme: s.theme, density: s.density, accent: s.accent || "",
    heroImage: s.heroImage || null,
    browserPath: s.defaultBrowser?.path || "",
    profileDir: s.defaultProfile || "",
    defaultScriptMode: s.defaultScriptMode || "keep",
    autostart: null, autostartInitial: null,
  };
  settingsDirty = false;
  settingsSection = "appearance";
  renderSettingsNav();
  renderSettingsSection();
  $("#settings").hidden = false;

  try {
    const v = !!(await invoke("plugin:autostart|is_enabled"));
    settingsDraft.autostart = v;
    settingsDraft.autostartInitial = v;
    if (settingsSection === "behavior") renderSettingsSection();
  } catch { /* autostart indisponible */ }
}

async function closeSettings(force) {
  if (!force && settingsDirty) {
    if (!(await askConfirm("Fermer sans enregistrer les modifications ?"))) return;
  }
  $("#settings").hidden = true;
  settingsDraft = null;
}

function renderSettingsNav() {
  const nav = $("#settings-nav");
  nav.innerHTML = "";
  for (const sec of SETTINGS_SECTIONS) {
    const b = document.createElement("button");
    b.className = "snav-item" + (sec.id === settingsSection ? " active" : "");
    b.innerHTML = `${sec.icon()}<span>${sec.label}</span>`;
    b.addEventListener("click", () => {
      settingsSection = sec.id;
      renderSettingsNav();
      renderSettingsSection();
    });
    nav.appendChild(b);
  }
}

/* Briques de rendu d'une ligne de réglage */
function srow(label, desc, ctlHtml) {
  return `
    <div class="setting-row">
      <div class="sr-main">
        <div class="sr-label">${label}</div>
        ${desc ? `<div class="sr-desc">${desc}</div>` : ""}
      </div>
      <div class="sr-ctl">${ctlHtml}</div>
    </div>`;
}
function sgroup(rows) { return `<div class="sgroup">${rows.join("")}</div>`; }

function renderSettingsSection() {
  const sec = SETTINGS_SECTIONS.find((x) => x.id === settingsSection);
  const root = $("#settings-content");
  const d = settingsDraft;
  let html = `<div class="settings-head"><h3>${sec.label}</h3><p>${sec.desc}</p></div>`;

  if (sec.id === "appearance") {
    html += sgroup([
      srow("Thème", "Sombre par défaut, clair pour les environnements lumineux.", `
        <select class="input" id="st-theme">
          <option value="dark" ${d.theme === "dark" ? "selected" : ""}>Sombre</option>
          <option value="light" ${d.theme === "light" ? "selected" : ""}>Clair</option>
        </select>`),
      srow("Densité", "Taille des cartes et des espacements.", `
        <select class="input" id="st-density">
          <option value="comfy" ${d.density !== "compact" ? "selected" : ""}>Confortable</option>
          <option value="compact" ${d.density === "compact" ? "selected" : ""}>Compacte</option>
        </select>`),
      srow("Couleur d'accent", "Boutons et sélections. Les catégories gardent leurs couleurs.", `
        <select class="input" id="st-accent">
          <option value="">Selon la vue affichée</option>
          ${Object.keys(ACCENTS).map((k) => `<option value="${k}" ${d.accent === k ? "selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}
        </select>`),
    ]);
    html += sgroup([
      srow("Image du bandeau d'accueil", `<span id="st-hero-state">${d.heroImage ? "Photo personnalisée active." : "Image par défaut (montagnes)."}</span> Formats jpg/png/webp, 2 Mo max.`, `
        <button class="btn" id="st-hero-pick" type="button">Choisir…</button>
        <button class="btn" id="st-hero-remove" type="button" ${d.heroImage ? "" : "disabled"}>Retirer</button>`),
    ]);
  }

  if (sec.id === "browsers") {
    html += sgroup([
      srow("Navigateur par défaut", "Utilisé pour tous les sites sans navigateur spécifique.", `
        <select class="input" id="st-browser">${browserOptions(d.browserPath, false)}</select>`),
      srow("Profil par défaut", "Profil ouvert quand un site n'en précise pas.", `
        <select class="input" id="st-profile" disabled></select>`),
    ]);
    const detected = detectedBrowsers.length
      ? detectedBrowsers.map((b) => srow(esc(b.name), `<span class="sr-list-sub">${esc(b.path)}</span>`, "")).join("")
      : srow("Aucun navigateur détecté", "La détection lit le registre Windows.", "");
    html += `<div class="sgroup">${detected}${srow("Détection", "Relance la lecture du registre Windows.", `<button class="btn" id="st-rescan" type="button">Actualiser</button>`)}</div>`;
  }

  if (sec.id === "scripts") {
    html += sgroup([
      srow("Console par défaut", "Appliqué aux nouveaux scripts. Modifiable ensuite script par script.", `
        <select class="input" id="st-scriptmode">
          <option value="keep" ${d.defaultScriptMode !== "close" ? "selected" : ""}>Garder la console ouverte</option>
          <option value="close" ${d.defaultScriptMode === "close" ? "selected" : ""}>Fermer la console à la fin</option>
        </select>`),
      srow("Confirmation et paramètres", "La confirmation avant exécution et les champs {paramètre} se règlent dans la fiche de chaque script.", ""),
    ]);
  }

  if (sec.id === "hotkeys") {
    html += sgroup([
      srow("Palette de commandes", "Ramène ProHub et ouvre la recherche, depuis n'importe quelle application.", `<kbd>Ctrl + Espace</kbd>`),
    ]);
    const withHotkey = [...state.items, ...state.routines].filter((e) => e.hotkey);
    const rows = withHotkey.length
      ? withHotkey.map((e) => srow(esc(e.name), TYPE_LABEL[e.type] || "Routine", `
          <span class="badge">${esc(e.hotkey)}</span>
          <button class="btn st-hk-clear" data-id="${e.id}" type="button">Retirer</button>`)).join("")
      : srow("Aucun raccourci personnalisé", "Ajoutez-en depuis la fiche d'un site, script, application ou routine.", "");
    html += `<div class="sgroup">${rows}</div>`;
    html += sgroup([
      srow("Conflits", "Un raccourci refusé au démarrage est déjà pris par Windows ou une autre application ; un message le signale. Deux éléments ne peuvent pas partager la même combinaison.", ""),
    ]);
  }

  if (sec.id === "behavior") {
    const auto = d.autostart;
    html += sgroup([
      srow("Lancer au démarrage de Windows", auto === null ? "Réglage indisponible sur cette session." : "ProHub démarre réduit dans la zone de notification.", `
        <label class="switch"><input type="checkbox" id="st-autostart" ${auto ? "checked" : ""} ${auto === null ? "disabled" : ""}><span class="sl"></span></label>`),
      srow("Fermeture de la fenêtre", "Fermer réduit ProHub dans la zone de notification. « Quitter » se trouve dans le menu de l'icône de notification.", ""),
    ]);
    html += sgroup([
      srow("Page d'accueil", "Sections affichées, ordre et panneaux latéraux.", `<button class="btn" id="st-home" type="button">Personnaliser…</button>`),
    ]);
  }

  if (sec.id === "data") {
    html += sgroup([
      srow("Exporter la configuration", "Sites, scripts, applications, raccourcis, routines, collections et préférences dans un fichier JSON.", `<button class="btn" id="st-export" type="button">Exporter…</button>`),
      srow("Importer une configuration", "Remplace la configuration actuelle par celle du fichier.", `<button class="btn" id="st-import" type="button">Importer…</button>`),
    ]);
    html += sgroup([
      srow("Sauvegarde automatique", `Configuration dans <span class="sr-list-sub">%APPDATA%\\ProHub\\config.json</span>, copie <span class="sr-list-sub">.bak</span> avant chaque écriture.`, ""),
      srow("Historique des lancements", "Alimente le panneau « Récents » et la palette.", `<button class="btn" id="st-clear-history" type="button">Effacer</button>`),
    ]);
  }

  if (sec.id === "about") {
    html += sgroup([
      srow("ProHub", "Launcher centralisé : sites, scripts, applications, raccourcis et routines.", `<span class="badge">v${APP_VERSION}</span>`),
      srow("Mises à jour", "Vérifiées au démarrage, installées depuis GitHub Releases.", `<button class="btn" id="st-update" type="button">Vérifier…</button>`),
      srow("Technologies", "Tauri 2 (Rust + WebView2), plugins global-shortcut et autostart. Licences MIT / Apache-2.0.", ""),
    ]);
  }

  root.innerHTML = html;
  root.scrollTop = 0;
  wireSettingsSection(sec.id);
}

function wireSettingsSection(id) {
  const d = settingsDraft;

  if (id === "appearance") {
    $("#st-theme").addEventListener("change", (e) => { d.theme = e.target.value; markSettingsDirty(); });
    $("#st-density").addEventListener("change", (e) => { d.density = e.target.value; markSettingsDirty(); });
    $("#st-accent").addEventListener("change", (e) => { d.accent = e.target.value; markSettingsDirty(); });
    $("#st-hero-pick").addEventListener("click", async () => {
      const picked = await invoke("pick_file", {
        title: "Choisir la photo du bandeau",
        extensions: ["png", "jpg", "jpeg", "webp"],
      });
      if (!picked) return;
      try {
        d.heroImage = await invoke("read_image_base64", { path: picked });
        markSettingsDirty();
        $("#st-hero-remove").disabled = false;
        $("#st-hero-state").textContent = "Photo personnalisée (enregistrez pour appliquer).";
      } catch (e) { toast(String(e), true); }
    });
    $("#st-hero-remove").addEventListener("click", () => {
      d.heroImage = null;
      markSettingsDirty();
      $("#st-hero-remove").disabled = true;
      $("#st-hero-state").textContent = "Image par défaut (montagnes).";
    });
  }

  if (id === "browsers") {
    const browserSel = $("#st-browser");
    const profileSel = $("#st-profile");
    browserSel.addEventListener("change", async () => {
      if (browserSel.value === "__browse__") {
        const picked = await invoke("pick_file", {
          title: "Choisir l'exécutable du navigateur", extensions: ["exe"],
        });
        if (picked) {
          const opt = document.createElement("option");
          opt.value = picked;
          opt.textContent = fileName(picked);
          browserSel.insertBefore(opt, browserSel.querySelector('[value="__browse__"]'));
          browserSel.value = picked;
        } else {
          browserSel.value = d.browserPath || "";
          return;
        }
      }
      d.browserPath = browserSel.value;
      d.profileDir = "";
      markSettingsDirty();
      await fillProfiles(profileSel, d.browserPath, null);
    });
    profileSel.addEventListener("change", () => { d.profileDir = profileSel.value; markSettingsDirty(); });
    fillProfiles(profileSel, d.browserPath, d.profileDir || null);
    $("#st-rescan").addEventListener("click", async () => {
      try { detectedBrowsers = await invoke("detect_browsers"); } catch { }
      renderSettingsSection();
      toast(`${detectedBrowsers.length} navigateur(s) détecté(s)`);
    });
  }

  if (id === "scripts") {
    $("#st-scriptmode").addEventListener("change", (e) => { d.defaultScriptMode = e.target.value; markSettingsDirty(); });
  }

  if (id === "hotkeys") {
    $$(".st-hk-clear").forEach((b) => {
      b.addEventListener("click", async () => {
        const real = findEntry(b.dataset.id);
        if (!real) return;
        real.hotkey = null;
        await saveState();
        await applyHotkeys();
        renderSettingsSection();
        toast("Raccourci retiré");
      });
    });
  }

  if (id === "behavior") {
    $("#st-autostart")?.addEventListener("change", (e) => { d.autostart = e.target.checked; markSettingsDirty(); });
    $("#st-home").addEventListener("click", openHomeEditor);
  }

  if (id === "data") {
    $("#st-export").addEventListener("click", async () => {
      const dest = await invoke("pick_save_file", {
        title: "Exporter la configuration ProHub",
        fileName: "prohub-config.json",
      });
      if (!dest) return;
      try {
        await invoke("write_text_file", { path: dest, content: JSON.stringify(state, null, 2) });
        toast("Configuration exportée");
      } catch (e) { toast(String(e), true); }
    });
    $("#st-import").addEventListener("click", async () => {
      const src = await invoke("pick_file", { title: "Importer une configuration ProHub", extensions: ["json"] });
      if (!src) return;
      try {
        const raw = await invoke("read_text_file", { path: src });
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
          return toast("Fichier invalide : ce n'est pas un export ProHub.", true);
        }
        if (!(await askConfirm("Remplacer toute la configuration actuelle par celle du fichier ?"))) return;
        await closeSettings(true);
        normalizeState(parsed);
        applyAppearance();
        await saveState();
        await applyHotkeys();
        await checkAllPaths();
        render();
        toast(missing.size
          ? `Import terminé — ${missing.size} chemin(s) introuvable(s) sur ce PC`
          : "Import terminé");
      } catch (e) { toast("Import impossible : " + e, true); }
    });
    $("#st-clear-history").addEventListener("click", async () => {
      if (!(await askConfirm("Effacer l'historique des lancements ? Le panneau Récents sera vidé."))) return;
      for (const e of [...state.items, ...state.routines]) delete e.lastUsed;
      await saveState();
      toast("Historique effacé");
    });
  }

  if (id === "about") {
    $("#st-update").addEventListener("click", async () => {
      try {
        const v = await invoke("check_update");
        if (!v) return toast(`ProHub est à jour (v${APP_VERSION})`);
        if (await askConfirm(`Version ${v} disponible. Installer et redémarrer ?`)) {
          toast("Téléchargement de la mise à jour…");
          await invoke("install_update");
        }
      } catch (e) {
        toast("Vérification impossible : " + e, true);
      }
    });
  }
}

async function saveSettings() {
  const d = settingsDraft;
  if (!d.browserPath) {
    settingsSection = "browsers";
    renderSettingsNav();
    renderSettingsSection();
    return toast("Choisissez un navigateur par défaut.", true);
  }
  const known = detectedBrowsers.find((b) => b.path === d.browserPath);
  state.settings.defaultBrowser = known || { name: fileName(d.browserPath), path: d.browserPath };
  state.settings.defaultProfile = d.profileDir || null;
  state.settings.theme = d.theme;
  state.settings.density = d.density;
  state.settings.accent = d.accent;
  state.settings.heroImage = d.heroImage;
  state.settings.defaultScriptMode = d.defaultScriptMode;
  applyAppearance();

  if (d.autostart !== null && d.autostart !== d.autostartInitial) {
    try {
      await invoke(d.autostart ? "plugin:autostart|enable" : "plugin:autostart|disable");
    } catch { /* autostart indisponible */ }
  }

  await saveState();
  settingsDirty = false;
  await closeSettings(true);
  render();
  toast("Paramètres enregistrés");
}

/* ------------------------------------------------------------------------ */
/* Menu contextuel + cloche                                                  */
/* ------------------------------------------------------------------------ */

function openCtx(x, y, entries) {
  const ctx = $("#ctx");
  ctx.innerHTML = "";
  for (const e of entries) {
    if (e.sep) { ctx.appendChild(document.createElement("hr")); continue; }
    if (e.note) {
      const n = document.createElement("div");
      n.className = "ctx-note";
      n.textContent = e.note;
      ctx.appendChild(n);
      continue;
    }
    const b = document.createElement("button");
    b.innerHTML = `<span>${esc(e.label)}</span>`;
    if (e.danger) b.className = "danger";
    b.addEventListener("click", () => { closeCtx(); e.action(); });
    ctx.appendChild(b);
  }
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  ctx.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
}

function closeCtx() { $("#ctx").hidden = true; }

function openBell() {
  if (!missing.size) { toast("Aucune alerte : tous les chemins sont valides."); return; }
  const entries = [{ note: "Chemins introuvables — cliquez pour localiser :" }];
  for (const id of [...missing].slice(0, 8)) {
    const item = findEntry(id);
    if (item) entries.push({ label: item.name, action: () => relocate(item) });
  }
  const r = $("#btn-bell").getBoundingClientRect();
  openCtx(r.right - 200, r.bottom + 6, entries);
}

/* ------------------------------------------------------------------------ */
/* Palette de commandes                                                      */
/* ------------------------------------------------------------------------ */

let paletteResults = [];
let paletteIndex = 0;

function allLaunchables() {
  return [
    ...state.items,
    ...state.routines.map((r) => ({ ...r, type: "routine" })),
  ];
}

function openPalette() {
  closeModal(); settleConfirm(false); closeCtx();
  $("#palette").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  renderPalette("");
  input.focus();
}

function closePalette() { $("#palette").hidden = true; }

function renderPalette(query) {
  const list = $("#palette-list");
  const all = allLaunchables();
  if (query.trim()) {
    paletteResults = all
      .map((e) => ({ e, s: fuzzyScore(query.trim(), itemSearchText(e)) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.e);
  } else {
    paletteResults = all
      .filter((e) => e.lastUsed)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, 8);
    if (!paletteResults.length) paletteResults = all.slice(0, 8);
  }
  paletteIndex = 0;
  list.innerHTML = "";
  if (!paletteResults.length) {
    list.innerHTML = `<div class="palette-empty">Rien à lancer pour l'instant.</div>`;
    return;
  }
  paletteResults.forEach((e, idx) => {
    const row = document.createElement("div");
    row.className = "palette-item" + (idx === 0 ? " selected" : "");
    row.innerHTML = `
      <span class="p-dot" style="background: var(--c-${TYPE_COLOR[e.type]})"></span>
      <span class="p-name">${esc(e.name)}</span>
      <span class="p-sub">${esc(e.description || techSub(e))}</span>`;
    row.addEventListener("click", () => { closePalette(); runEntry(e); });
    row.addEventListener("mousemove", () => setPaletteIndex(idx));
    list.appendChild(row);
  });
}

function setPaletteIndex(idx) {
  paletteIndex = idx;
  $$("#palette-list .palette-item").forEach((el, i) => el.classList.toggle("selected", i === idx));
  const sel = $$("#palette-list .palette-item")[idx];
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------------------ */
/* Planification (scripts et routines)                                       */
/* ------------------------------------------------------------------------ */

const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function scheduleField(e) {
  const s = e.schedule || { kind: "none" };
  const days = s.days || [];
  return `
  <hr class="form-sep">
  <div class="field"><label>Planification</label>
    <select class="input" id="f-sch-kind">
      <option value="none" ${!s.kind || s.kind === "none" ? "selected" : ""}>Aucune</option>
      <option value="daily" ${s.kind === "daily" ? "selected" : ""}>Tous les jours</option>
      <option value="weekly" ${s.kind === "weekly" ? "selected" : ""}>Certains jours</option>
      <option value="interval" ${s.kind === "interval" ? "selected" : ""}>À intervalle régulier</option>
    </select>
    <div class="row" id="f-sch-time-row" style="margin-top:8px" ${s.kind === "daily" || s.kind === "weekly" ? "" : "hidden"}>
      <input class="input mono" id="f-sch-time" type="time" value="${esc(s.time || "09:00")}" style="max-width:130px">
    </div>
    <div class="row" id="f-sch-days-row" style="margin-top:8px; gap:4px; flex-wrap:wrap" ${s.kind === "weekly" ? "" : "hidden"}>
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" class="btn btn-day f-sch-day${days.includes(d) ? " btn-accent" : ""}" data-d="${d}">${DAY_LABELS[d]}</button>`).join("")}
    </div>
    <div class="row" id="f-sch-int-row" style="margin-top:8px; align-items:center" ${s.kind === "interval" ? "" : "hidden"}>
      <input class="input mono" id="f-sch-every" type="number" min="1" value="${s.every || 60}" style="max-width:110px">
      <span class="hint" style="margin:0">minutes</span>
    </div>
    <p class="hint">Exécution en arrière-plan (ProHub ouvert ou dans la zone de notification), sans confirmation. Les commandes avec {paramètres} ne sont pas planifiables.</p>
  </div>`;
}

function wireScheduleField() {
  const kind = $("#f-sch-kind");
  if (!kind) return;
  kind.addEventListener("change", () => {
    $("#f-sch-time-row").hidden = !(kind.value === "daily" || kind.value === "weekly");
    $("#f-sch-days-row").hidden = kind.value !== "weekly";
    $("#f-sch-int-row").hidden = kind.value !== "interval";
  });
  $$(".f-sch-day").forEach((b) => {
    b.addEventListener("click", () => b.classList.toggle("btn-accent"));
  });
}

/* Lit la planification du formulaire dans data ; false si invalide. */
function readSchedule(data, command) {
  const kindEl = $("#f-sch-kind");
  if (!kindEl) return true;
  const kind = kindEl.value;
  if (kind === "none") { data.schedule = null; return true; }
  if (/\{[a-zA-Z0-9_]+\}/.test(command || "")) {
    toast("Impossible de planifier une commande avec {paramètres}.", true);
    return false;
  }
  const s = { kind };
  if (kind === "daily" || kind === "weekly") {
    s.time = $("#f-sch-time").value || "09:00";
  }
  if (kind === "weekly") {
    s.days = $$(".f-sch-day.btn-accent").map((b) => Number(b.dataset.d));
    if (!s.days.length) { toast("Choisissez au moins un jour.", true); return false; }
  }
  if (kind === "interval") {
    s.every = Math.max(1, parseInt($("#f-sch-every").value, 10) || 60);
  }
  data.schedule = s;
  return true;
}

function parseHM(t) {
  const [h, m] = (t || "0:0").split(":").map(Number);
  return { h: h || 0, m: m || 0 };
}

function nextRunOf(e, from = Date.now()) {
  const s = e.schedule;
  if (!s || s.kind === "none") return null;
  if (s.kind === "interval") {
    const base = e.scheduleLastRun || from;
    return Math.max(base + Math.max(1, s.every) * 60000, from + 30000);
  }
  const { h, m } = parseHM(s.time);
  const d = new Date(from);
  if (s.kind === "daily") {
    const c = new Date(d); c.setHours(h, m, 0, 0);
    if (c.getTime() <= from) c.setDate(c.getDate() + 1);
    return c.getTime();
  }
  if (s.kind === "weekly") {
    const days = s.days && s.days.length ? s.days : [1];
    for (let i = 0; i < 8; i++) {
      const c = new Date(d); c.setDate(d.getDate() + i); c.setHours(h, m, 0, 0);
      if (c.getTime() > from && days.includes(c.getDay())) return c.getTime();
    }
  }
  return null;
}

function scheduleDue(e, now) {
  const s = e.schedule;
  if (!s || s.kind === "none") return false;
  if (s.kind === "interval") {
    return !e.scheduleLastRun || now - e.scheduleLastRun >= Math.max(1, s.every) * 60000;
  }
  const { h, m } = parseHM(s.time);
  const d = new Date(now);
  if (d.getHours() !== h || d.getMinutes() !== m) return false;
  if (s.kind === "weekly") {
    const days = s.days && s.days.length ? s.days : [1];
    if (!days.includes(d.getDay())) return false;
  }
  return !e.scheduleLastRun || now - e.scheduleLastRun > 90000; // pas deux fois la même minute
}

function fmtNext(ts) {
  if (!ts) return "";
  const diff = ts - Date.now();
  if (diff < 3600000) return `dans ${Math.max(1, Math.round(diff / 60000))} min`;
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const day = d.toDateString() === new Date().toDateString()
    ? "auj."
    : d.toLocaleDateString("fr-FR", { weekday: "short" });
  return `${day} ${hm}`;
}

async function runScheduled(e) {
  try {
    if (state.routines.some((r) => r.id === e.id)) await runRoutine(e, { scheduled: true });
    else await launchItem(e, { scheduled: true });
  } catch (err) {
    if (err !== "cancelled") {
      invoke("notify_user", { title: "ProHub — échec planifié", body: `${e.name} : ${err}` }).catch(() => {});
    }
  }
}

let tickRunning = false;
async function schedulerTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const now = Date.now();
    let dirty = false;

    for (const e of [...state.items, ...state.routines]) {
      if (e.type === "monitor") continue;
      if (scheduleDue(e, now)) {
        e.scheduleLastRun = now;
        dirty = true;
        runScheduled(e);
      }
    }

    let checked = false;
    for (const m of state.items.filter((i) => i.type === "monitor" && !i.disabled)) {
      const every = Math.max(1, m.checkMinutes || 5) * 60000;
      if (!m.monLastCheck || now - m.monLastCheck >= every) {
        await checkMonitor(m, false, true);
        checked = true;
      }
    }

    if (dirty || checked) {
      await saveState();
      if (!document.hidden) render();
    }
  } finally {
    tickRunning = false;
  }
}

/* ------------------------------------------------------------------------ */
/* Moniteurs                                                                 */
/* ------------------------------------------------------------------------ */

async function checkMonitor(m, manual, deferSave) {
  if (!m || !m.statusUrl) return;
  m.monLastCheck = Date.now();
  try {
    const raw = await invoke("http_get", { url: m.statusUrl });
    const data = JSON.parse(raw);
    let count = 0;
    try {
      count = Number(new Function("data", "return (" + (m.countExpr || "data.count") + ")")(data));
      if (isNaN(count)) count = 0;
    } catch (e) {
      throw "expression du compteur invalide : " + (e.message || e);
    }
    m.monError = null;
    const prev = m.monNotified || 0;
    m.monCount = count;
    if (count > prev) {
      invoke("notify_user", {
        title: m.name,
        body: `${count} nouveauté${count > 1 ? "s" : ""} en attente`,
      }).catch(() => {});
    }
    m.monNotified = count;
    if (manual) toast(`${m.name} : ${count} nouveauté(s)`);
  } catch (e) {
    m.monError = String(e);
    if (manual) toast(`${m.name} : ${e}`, true);
  }
  if (!deferSave) {
    await saveState();
    if (!document.hidden) render();
  }
}

async function startMonitorProcess(m, manual) {
  if (!m || !m.startCommand || !m.startDir) return;
  try {
    await invoke("launch_background", {
      id: m.id,
      dir: m.startDir,
      command: m.startCommand,
      env: m.env && m.env.length ? m.env : null,
    });
    if (manual) toast(`Process de « ${m.name} » relancé`);
  } catch (e) {
    if (manual) toast(String(e), true);
  }
}

async function stopMonitorProcess(m, manual) {
  if (!m) return;
  try {
    await invoke("stop_background", { id: m.id, command: m.startCommand || null });
    if (manual) toast(`Process de « ${m.name} » stoppé`);
  } catch (e) {
    if (manual) toast(String(e), true);
  }
}

async function pauseMonitor(m) {
  const real = findEntry(m.id);
  if (!real) return;
  real.disabled = true;
  if (real.startCommand) await stopMonitorProcess(real, false);
  await saveState();
  render();
  toast(`« ${real.name} » en pause : plus de vérifications ni de notifications`);
}

async function resumeMonitor(m) {
  const real = findEntry(m.id);
  if (!real) return;
  real.disabled = false;
  if (real.autoStart && real.startCommand) await startMonitorProcess(real, false);
  await saveState();
  render();
  setTimeout(() => checkMonitor(real, false), 2500);
  toast(`« ${real.name} » repris`);
}

function startMonitorProcesses() {
  for (const m of state.items.filter((i) => i.type === "monitor" && !i.disabled && i.autoStart && i.startCommand)) {
    startMonitorProcess(m, false);
  }
}

function openMonitorEditor(item, presetCollection) {
  const editing = !!item;
  const data = item ? { ...item } : {
    id: uid(), type: "monitor", pinned: false,
    checkMinutes: 5, countExpr: "data.count",
    collections: presetCollection ? [presetCollection] : [],
  };
  let iconData = data.iconData || null;

  const body = `
    <div class="field"><label>Nom</label>
      <input class="input" id="f-name" placeholder="Veille" value="${esc(data.name || "")}"></div>
    ${descField(data)}
    <div class="field"><label>URL de statut (JSON)</label>
      <input class="input mono" id="f-status" placeholder="http://127.0.0.1:5017/api/state" value="${esc(data.statusUrl || "")}">
      <p class="hint">Interrogée régulièrement en arrière-plan, même fenêtre fermée (zone de notification).</p></div>
    <div class="field"><label>Expression du compteur</label>
      <input class="input mono" id="f-expr" placeholder="data.count" value="${esc(data.countExpr || "data.count")}">
      <p class="hint">JavaScript appliqué au JSON reçu, doit renvoyer un nombre. Exemple : Object.values(data.tags).reduce((n,t)=>n+t.new.length,0)</p></div>
    <div class="row2">
      <div class="field"><label>Vérifier toutes les</label>
        <div class="row" style="align-items:center">
          <input class="input mono" id="f-minutes" type="number" min="1" value="${Math.max(1, data.checkMinutes || 5)}" style="max-width:100px">
          <span class="hint" style="margin:0">minutes</span>
        </div></div>
      <div class="field"><label>&nbsp;</label>
        <button class="btn" id="f-test" type="button" style="width:100%">Tester maintenant</button></div>
    </div>
    <div class="field"><label>Page à ouvrir au clic (optionnel)</label>
      <input class="input mono" id="f-open" placeholder="http://127.0.0.1:5017" value="${esc(data.openUrl || "")}">
      <p class="hint">Affichée dans un panneau ProHub, sans navigateur. Vide : l'URL de statut.</p></div>
    <div class="field"><label>Liens externes du panneau</label>
      <select class="input" id="f-ext-browser">${browserOptions(data.extBrowserPath || "", true)}</select>
      <p class="hint">Navigateur utilisé quand un clic sort du panneau (un album, un site…).</p></div>
    <div class="field"><label>Profil pour ces liens</label>
      <select class="input" id="f-ext-profile" disabled></select></div>
    <div class="field">
      <label class="check"><input type="checkbox" id="f-ext-private" ${data.extPrivate ? "checked" : ""}> Ouvrir ces liens en fenêtre privée</label>
    </div>
    <hr class="form-sep">
    <div class="field"><label>Process à lancer avec ProHub (optionnel)</label>
      <div class="row">
        <input class="input mono" id="f-pdir" placeholder="C:\\Scripts\\veille" value="${esc(data.startDir || "")}">
        <button class="btn" id="f-pdir-pick" type="button">Parcourir…</button>
      </div>
      <input class="input mono" id="f-pcmd" placeholder="pythonw app.py" value="${esc(data.startCommand || "")}" style="margin-top:8px">
      <label class="check" style="margin-top:8px"><input type="checkbox" id="f-pauto" ${data.autoStart ? "checked" : ""}> Lancer automatiquement au démarrage de ProHub</label>
      <p class="hint">Lancé sans aucune fenêtre. Utilisez pythonw plutôt que python pour les scripts Python.</p></div>
    ${iconField(data, false)}
    ${hotkeyField(data)}
    ${collectionsField(data)}`;

  openModal(editing ? "Modifier le moniteur" : "Ajouter un moniteur", body, async () => {
    const name = $("#f-name").value.trim();
    const statusUrl = $("#f-status").value.trim();
    if (!name || !statusUrl) return toast("Nom et URL de statut obligatoires.", true);
    const startCommand = $("#f-pcmd").value.trim() || null;
    const startDir = $("#f-pdir").value.trim() || null;
    if (startCommand && !startDir) return toast("Indiquez le dossier du process.", true);
    if (!readHotkey(data)) return;
    readDesc(data);
    const extProfileSel = $("#f-ext-profile");
    Object.assign(data, {
      name, statusUrl,
      countExpr: $("#f-expr").value.trim() || "data.count",
      checkMinutes: Math.max(1, parseInt($("#f-minutes").value, 10) || 5),
      openUrl: $("#f-open").value.trim() || null,
      extBrowserPath: $("#f-ext-browser").value || null,
      extProfileDir: extProfileSel.value || null,
      extPrivate: $("#f-ext-private").checked,
      startDir, startCommand,
      autoStart: $("#f-pauto").checked,
      iconData,
      collections: readCollections(),
      monLastCheck: null, // re-vérifié au prochain tick
    });
    if (!(await checkDuplicate(data, (i) => (i.statusUrl || "").toLowerCase(), "Moniteur"))) return;
    await upsertItem(data, editing);
    const real = findEntry(data.id);
    if (real) {
      if (real.autoStart && real.startCommand) startMonitorProcess(real, false);
      setTimeout(() => checkMonitor(real, false), 2500);
    }
  });

  $("#f-pdir-pick").addEventListener("click", async () => {
    const picked = await invoke("pick_folder", { title: "Choisir le dossier du process" });
    if (picked) $("#f-pdir").value = picked;
  });
  const extBrowserSel = $("#f-ext-browser");
  const extProfileSel = $("#f-ext-profile");
  const extEffective = () => extBrowserSel.value || state.settings.defaultBrowser?.path || "";
  wireBrowserSelect(extBrowserSel, extProfileSel, extEffective);
  fillProfiles(extProfileSel, extEffective(), data.extProfileDir);
  $("#f-test").addEventListener("click", async () => {
    const url = $("#f-status").value.trim();
    if (!url) return toast("Renseignez d'abord l'URL de statut.", true);
    try {
      const raw = await invoke("http_get", { url });
      const json = JSON.parse(raw);
      const expr = $("#f-expr").value.trim() || "data.count";
      const count = Number(new Function("data", "return (" + expr + ")")(json));
      if (isNaN(count)) return toast("L'expression ne renvoie pas un nombre.", true);
      toast(`OK — compteur actuel : ${count}`);
    } catch (e) {
      toast("Test échoué : " + (e.message || e), true);
    }
  });
  wireIconField((v) => (iconData = v), () => "");
  wireHotkeyField();
}

/* ------------------------------------------------------------------------ */
/* Coffre chiffré (AES-GCM, clé dérivée du PIN par PBKDF2)                   */
/* ------------------------------------------------------------------------ */

let vaultKey = null;
let vaultUnlocked = false;

const _te = new TextEncoder();
const _td = new TextDecoder();
const b64e = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function vaultDeriveKey(pin, saltB64) {
  const km = await crypto.subtle.importKey("raw", _te.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64d(saltB64), iterations: 310000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

async function vEncrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, _te.encode(JSON.stringify(obj)));
  return { iv: b64e(iv), ct: b64e(ct) };
}

async function vDecrypt(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
  return JSON.parse(_td.decode(pt));
}

function openVaultSetup() {
  const body = `
    <div class="field"><label>Code PIN du coffre</label>
      <input class="input mono" id="f-pin1" type="password" autocomplete="off"></div>
    <div class="field"><label>Confirmez le code</label>
      <input class="input mono" id="f-pin2" type="password" autocomplete="off">
      <p class="hint">Les éléments masqués seront chiffrés avec ce code et invisibles partout tant que le coffre est verrouillé. Déverrouillage : 5 clics sur le logo ProHub. Code perdu = contenu du coffre irrécupérable.</p></div>`;
  openModal("Créer le coffre", body, async () => {
    const p1 = $("#f-pin1").value, p2 = $("#f-pin2").value;
    if (p1.length < 4) return toast("4 caractères minimum.", true);
    if (p1 !== p2) return toast("Les deux codes ne correspondent pas.", true);
    const salt = b64e(crypto.getRandomValues(new Uint8Array(16)));
    const key = await vaultDeriveKey(p1, salt);
    state.vault = {
      salt,
      check: await vEncrypt(key, "prohub-vault"),
      data: await vEncrypt(key, { items: [], routines: [] }),
    };
    vaultKey = key;
    vaultUnlocked = true;
    await saveState();
    closeModal();
    render();
    toast("Coffre créé et déverrouillé. Clic droit sur un élément → « Masquer dans le coffre ».");
  });
}

function openVaultUnlock() {
  const body = `
    <div class="field"><label>Code PIN</label>
      <input class="input mono" id="f-pin1" type="password" autocomplete="off"></div>`;
  openModal("Coffre", body, async () => {
    const pin = $("#f-pin1").value;
    try {
      const key = await vaultDeriveKey(pin, state.vault.salt);
      const check = await vDecrypt(key, state.vault.check);
      if (check !== "prohub-vault") throw 0;
      const data = await vDecrypt(key, state.vault.data);
      vaultKey = key;
      vaultUnlocked = true;
      for (const i of data.items || []) state.items.push({ ...i, _vaulted: true });
      for (const r of data.routines || []) state.routines.push({ ...r, _vaulted: true });
      closeModal();
      await applyHotkeys();
      render();
      toast("Coffre déverrouillé");
      // rattrapage immédiat des moniteurs masqués
      for (const m of state.items.filter((i) => i._vaulted && i.type === "monitor")) {
        if (m.autoStart && m.startCommand) startMonitorProcess(m, false);
        checkMonitor(m, false);
      }
    } catch {
      toast("Code incorrect.", true);
    }
  });
}

async function lockVault() {
  if (!vaultUnlocked) return;
  await saveState(); // chiffre l'état courant des éléments masqués
  state.items = state.items.filter((i) => !i._vaulted);
  state.routines = state.routines.filter((r) => !r._vaulted);
  vaultKey = null;
  vaultUnlocked = false;
  await applyHotkeys();
  render();
}

function vaultManage() {
  const n = state.items.filter((i) => i._vaulted).length + state.routines.filter((r) => r._vaulted).length;
  const body = `
    <div class="field">
      <p class="hint" style="font-size:12.5px">Coffre déverrouillé — ${n} élément(s) masqué(s).</p>
    </div>
    <div class="field"><div class="checks">
      <button class="btn" id="f-v-lock" style="justify-content:flex-start; margin-bottom:6px">Verrouiller maintenant</button>
      <button class="btn" id="f-v-pin" style="justify-content:flex-start; margin-bottom:6px">Changer le code PIN</button>
      <button class="btn" id="f-v-out" style="justify-content:flex-start">Sortir tous les éléments du coffre</button>
    </div></div>`;
  openModal("Coffre", body, null);
  $("#modal-save").style.display = "none";
  modalCancelHandler = () => { $("#modal-save").style.display = ""; };
  const done = () => { $("#modal-save").style.display = ""; modalCancelHandler = null; closeModal(); };
  $("#f-v-lock").addEventListener("click", async () => { done(); await lockVault(); toast("Coffre verrouillé"); });
  $("#f-v-pin").addEventListener("click", () => { done(); openVaultChangePin(); });
  $("#f-v-out").addEventListener("click", async () => {
    done();
    if (!(await askConfirm("Rendre visibles tous les éléments du coffre ?"))) return;
    for (const e of [...state.items, ...state.routines]) delete e._vaulted;
    await saveState();
    render();
    toast("Coffre vidé, éléments visibles");
  });
}

function openVaultChangePin() {
  const body = `
    <div class="field"><label>Nouveau code PIN</label>
      <input class="input mono" id="f-pin1" type="password" autocomplete="off"></div>
    <div class="field"><label>Confirmez le code</label>
      <input class="input mono" id="f-pin2" type="password" autocomplete="off"></div>`;
  openModal("Changer le code du coffre", body, async () => {
    const p1 = $("#f-pin1").value, p2 = $("#f-pin2").value;
    if (p1.length < 4) return toast("4 caractères minimum.", true);
    if (p1 !== p2) return toast("Les deux codes ne correspondent pas.", true);
    const salt = b64e(crypto.getRandomValues(new Uint8Array(16)));
    const key = await vaultDeriveKey(p1, salt);
    state.vault = { salt, check: await vEncrypt(key, "prohub-vault"), data: state.vault.data };
    vaultKey = key;
    await saveState(); // re-chiffre les données avec la nouvelle clé
    closeModal();
    toast("Code du coffre modifié");
  });
}

async function vaultEntry(entry) {
  const real = findEntry(entry.id);
  if (!real) return;
  real._vaulted = true;
  await saveState();
  render();
  toast(`« ${real.name} » masqué dans le coffre`);
}

async function unvaultEntry(entry) {
  const real = findEntry(entry.id);
  if (!real) return;
  delete real._vaulted;
  await saveState();
  render();
  toast(`« ${real.name} » visible à nouveau`);
}

/* ------------------------------------------------------------------------ */
/* Événements globaux                                                        */
/* ------------------------------------------------------------------------ */

$$(".nav-item[data-nav]").forEach((b) => {
  b.addEventListener("click", () => { currentView = { kind: "home" }; render(); });
});
$$(".nav-item[data-tab]").forEach((b) => {
  b.addEventListener("click", () => { currentView = { kind: "tab", tab: b.dataset.tab }; render(); });
});

// Coffre : 5 clics sur le logo en moins de 2,5 s (aucune trace visible dans l'UI)
let logoClicks = 0, logoTimer = null;
$("#brand").addEventListener("click", () => {
  logoClicks++;
  clearTimeout(logoTimer);
  logoTimer = setTimeout(() => (logoClicks = 0), 2500);
  if (logoClicks >= 5) {
    logoClicks = 0;
    if (!state.vault) openVaultSetup();
    else if (vaultUnlocked) vaultManage();
    else openVaultUnlock();
  }
});

// Verrouillage auto quand la fenêtre part dans la zone de notification
document.addEventListener("visibilitychange", () => {
  if (document.hidden) lockVault();
});

$("#btn-add-collection").addEventListener("click", () => openCollectionEditor(null));
$("#btn-settings").addEventListener("click", openSettings);
$("#search-trigger").addEventListener("click", openPalette);
$("#btn-bell").addEventListener("click", (e) => { e.stopPropagation(); openBell(); });

$("#btn-theme").addEventListener("click", async () => {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  applyAppearance();
  await saveState();
  render();
});

$("#settings-close").addEventListener("click", () => closeSettings(false));
$("#settings-cancel").addEventListener("click", () => closeSettings(false));
$("#settings-save").addEventListener("click", saveSettings);
$("#settings").addEventListener("mousedown", (e) => { if (e.target === $("#settings")) closeSettings(false); });

$("#modal-close").addEventListener("click", closeModal);
$("#modal-cancel").addEventListener("click", closeModal);
$("#modal-save").addEventListener("click", () => modalSaveHandler && modalSaveHandler());
$("#modal").addEventListener("mousedown", (e) => { if (e.target === $("#modal")) closeModal(); });

$("#confirm-no").addEventListener("click", () => settleConfirm(false));
$("#confirm-yes").addEventListener("click", () => settleConfirm(true));
$("#confirm").addEventListener("mousedown", (e) => { if (e.target === $("#confirm")) settleConfirm(false); });

$("#palette").addEventListener("mousedown", (e) => { if (e.target === $("#palette")) closePalette(); });
$("#palette-input").addEventListener("input", (e) => renderPalette(e.target.value));
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIndex(Math.min(paletteIndex + 1, paletteResults.length - 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIndex(Math.max(paletteIndex - 1, 0)); }
  else if (e.key === "Enter") {
    const sel = paletteResults[paletteIndex];
    if (sel) { closePalette(); runEntry(sel); }
  }
});

document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctx")) closeCtx(); });
window.addEventListener("blur", closeCtx);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#ctx").hidden) return closeCtx();
    if (!$("#palette").hidden) return closePalette();
    if (!$("#confirm").hidden) return settleConfirm(false);
    if (!$("#modal").hidden) return closeModal();
    if (!$("#settings").hidden) return closeSettings(false);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if ($("#palette").hidden) openPalette();
    else closePalette();
  }
});

init();
