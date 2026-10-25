# ProHub

**Le hub qui centralise tout ce que vous lancez sur Windows** : sites, applications, scripts, fichiers, veilles et routines, dans une seule interface soignée.

<!-- Capture d'écran : remplacez par la vôtre -->
<!-- ![ProHub](docs/screenshot.png) -->

## Fonctionnalités

- **Sites** : chaque site s'ouvre dans le navigateur de votre choix (Brave, Chrome, Edge, Firefox…), avec le **profil** de votre choix, en fenêtre normale ou **privée**. Navigateur par défaut + exceptions site par site. Favicon détecté automatiquement.
- **Applications** : lancez vos exe avec arguments, dossier de travail et élévation admin. Icône extraite automatiquement de l'exécutable.
- **Scripts** : terminal ouvert dans le bon dossier, commande exécutée (console gardée ou fermée), commandes **paramétrables** `{champ}` demandées au lancement, variables d'environnement, confirmation optionnelle.
- **Raccourcis** : fichiers et dossiers ouverts en un clic.
- **Moniteurs** : surveillez n'importe quelle API JSON (vos services auto-hébergés, un script maison…) : pastille de nouveautés, **notifications Windows**, process lancé en arrière-plan sans fenêtre, page affichée dans un **panneau intégré** dont les liens externes s'ouvrent dans le navigateur/profil de votre choix. Pause et reprise à la demande.
- **Routines** : enchaînez plusieurs lancements en une seule action, avec délais et arrêt sur erreur.
- **Planification** : exécutez un script ou une routine tous les jours, certains jours ou à intervalle régulier, en arrière-plan.
- **Palette de commandes** : `Ctrl+K` dans l'app, `Ctrl+Espace` depuis n'importe où (recherche floue, récents).
- **Raccourcis clavier globaux** par élément (ex. `Ctrl+Alt+S` pour un site), avec détection de conflits.
- **Collections** : groupes transverses colorés, un élément peut appartenir à plusieurs.
- **Accueil personnalisable** : choisissez les sections, leur ordre et les panneaux (Récents, Favoris, Routines, Prochaine exécution).
- **Confort** : thème sombre/clair, densité, drag & drop, épinglage, zone de notification, lancement au démarrage, export/import de la configuration, sauvegarde automatique, mises à jour automatiques.

## Installation

Téléchargez le dernier installeur depuis les [Releases](../../releases/latest) et lancez-le. Windows 10/11, aucune dépendance.

Les mises à jour sont proposées automatiquement au démarrage de l'app.

## Compiler soi-même

Prérequis : [Rust](https://rustup.rs/), Visual Studio Build Tools (charge « Développement Desktop en C++ »), puis :

```bat
cargo install tauri-cli --locked
cargo tauri dev     # développement
cargo tauri build   # installeur NSIS dans src-tauri\target\release\bundle\nsis\
```

Pas de Node.js : le front est statique (`ui/`, HTML/CSS/JS vanilla).

## Architecture

```
prohub/
├── ui/                  # front statique (withGlobalTauri)
├── src-tauri/
│   ├── src/lib.rs       # commandes, tray, raccourcis globaux, updater
│   ├── tauri.conf.json
│   └── capabilities/
└── .github/workflows/   # build + release automatiques sur tag v*
```

Stack : [Tauri 2](https://tauri.app) (Rust + WebView2). Plugins : global-shortcut, autostart, notification, updater.

La configuration utilisateur vit dans `%APPDATA%\ProHub\config.json` (sauvegarde `.bak` avant chaque écriture).

## Licence

[MIT](LICENSE)
