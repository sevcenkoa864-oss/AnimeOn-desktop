# AnimeOn Desktop (Unofficial)

A personal project: I made this for myself to make watching anime on [animeon.cc](https://animeon.cc/) more
comfortable. Instead of yet another browser tab, the site gets its own window, like the Discord or Spotify desktop
apps: no address bar or tabs, a dark native-looking frame, a tray icon, an ad blocker, and fullscreen that just works
while you watch. Runs on Windows and macOS.

> **Unofficial client, not affiliated with animeon.cc.** All content and trademarks belong to their owners.
>
> **Logo:** the app icon is animeon.cc's own app icon (the one its web manifest offers for "install as app"). It is
> not stored in this repository: `npm run icons` downloads it at build time into the git-ignored `assets/` folder. If
> the download fails, an original play-button icon is used instead.

## Features

- Manrope font throughout, in the app windows and on the site (bundled, works offline).
- Custom dark title bar matching the site, with native min/max/close buttons. Remembers size, position, maximized
  state and zoom.
- Splash screen with no white flash. An offline page with Retry, which also retries automatically when the network
  returns.
- Fullscreen from the embedded players (Esc to leave, maximized state restored), autoplay, Picture-in-Picture, media
  keys, and no screen sleep while a video plays.
- Ad and tracker blocking (EasyList + EasyPrivacy via Ghostery), with per-domain exceptions.
- Pop-ups blocked. External links open in your default browser. The Google Sign-In popup opens in a small in-app
  window. The login session persists across restarts.
- Tray: Show/Hide, Reload, Ad blocker, Start with Windows, Settings, About, Quit. Closing the window minimizes it to the
  tray (configurable).
- Single instance: launching again focuses the running window.

### Keyboard shortcuts

| Keys                            | Action                              |
| ------------------------------- | ----------------------------------- |
| F11                             | Toggle fullscreen (Esc also leaves) |
| Ctrl+R / F5                     | Reload                              |
| Alt+← / Alt+→                   | Back / Forward                      |
| Ctrl+Plus / Ctrl+Minus / Ctrl+0 | Zoom in / out / reset to default    |
| Ctrl+,                          | Settings                            |
| Ctrl+Q                          | Quit                                |
| Ctrl+Shift+I                    | DevTools (dev builds only)          |

On macOS use Cmd instead of Ctrl, Cmd+[ / Cmd+] for Back/Forward and Ctrl+Cmd+F for fullscreen. The standard app
menu (Edit, View, Window) is there too.

## Settings

Open from the tray or with Ctrl+,:

- **Close to tray**
- **Start with Windows**
- **Start minimized** (only when started by Windows)
- **Default zoom**
- **Hardware acceleration** (needs a restart)
- **Ad blocker** + **exceptions**
- **Load blocked images via proxy** (see below)
- **Clear cache and data** (signs you out)

## Development

Requires Node 20+.

```bash
npm install
npm run dev     # build + launch
npm run lint    # eslint + prettier check
npm test        # URL-policy unit test
```

If `npm install` warns that install scripts were skipped (npm's `allowScripts`), fetch the Electron binary once:

```bash
node node_modules/electron/install.js
```

For testing the offline page in dev, run with `ANIMEON_URL=https://animeon.invalid/` set.

## Building the installer

```bash
npm run dist
```

This regenerates the icons (`scripts/make-icons.mjs`, no dependencies), compiles, and writes to `release/`:

- `AnimeOnDesktop-Setup-<version>.exe`: per-user NSIS installer with desktop and Start-menu shortcuts and a choice of
  install folder
- `AnimeOnDesktop-Portable-<version>.exe`: portable build, no installation

The installer, shortcuts and the Apps list show the name **AnimeOn Desktop** (`build.productName`). Internally the
app keeps its original name, so the profile folder (login session, settings) stays
`%APPDATA%\AnimeOn Desktop (Unofficial)`.

The builds aren't code-signed, so Windows SmartScreen will warn on first run ("More info → Run anyway").

### macOS

electron-builder can only produce a `.dmg` **on a Mac**. Either run `npm run dist` on a Mac (it builds
`AnimeOnDesktop-<version>-mac.dmg`, a universal build for Intel and Apple Silicon, macOS 12+), or let GitHub build it:

1. Push this repository to GitHub (keep it **private**: build artifacts include the site's logo).
2. Open **Actions → Build → Run workflow** (or push a tag such as `v1.0.0`).
3. Download `AnimeOnDesktop-macOS` (and `AnimeOnDesktop-Windows`) from the run's **Artifacts**.

The Mac build is ad-hoc signed, not notarized, so the first launch is blocked by Gatekeeper. Open it once with
right-click → **Open**, or on macOS 15+ via **System Settings → Privacy & Security → Open Anyway**. Alternatively run:

```bash
xattr -dr com.apple.quarantine "/Applications/AnimeOn Desktop.app"
```

## Project layout

```
src/main/       main process: window, tray, navigation & popup policy, settings, ad blocker
src/preload/    preload for the app's own local pages only (the site gets no preload)
src/renderer/   title bar / splash / offline page, settings page
scripts/        icon generator (downloads the site logo), static file copy
assets/         generated icons (git-ignored)
.github/        CI workflow: build Windows + macOS and publish the release
NOTES.md        site research and the reasoning behind the allowlists
```

## Updates

New versions are published as [GitHub Releases](https://github.com/sevcenkoa864-oss/AnimeOn-desktop/releases).

- **Windows (installed with the Setup exe):** the app checks for updates at startup and every 4 hours, downloads
  them in the background (only the changed parts) and installs them when you quit. To update right away, use the tray
  menu item **Restart to Update**. If you installed into `C:\Program Files`, Windows asks for admin rights on each
  update. Installing into the default per-user folder avoids that.
- **macOS and the portable exe** can't replace themselves (macOS only allows that for apps signed with a paid Apple
  certificate). They show a notification when a new version is out. Click it, or use **Download Update…** in the menu.
- **Check for Updates…** in the tray (and the macOS app menu) checks right away.

To release a version: bump `version` in `package.json`, then push a tag like `v1.0.3`. The workflow builds both
platforms and publishes the release with the files the updater needs (`latest*.yml`, `*.blockmap`).

## Posters not loading? (Ukraine and other regions)

Most posters come from Russian CDNs (Selectel, Kinopoisk) that are blocked or unstable in some countries, e.g. in
Ukraine. The app notices when one of them fails and loads those images through [wsrv.nl](https://wsrv.nl), a free
open-source image proxy, instead. Nothing to set up. wsrv.nl only sees the public poster URLs. Turn it off in
Settings → Network if you don't want that. Video and everything else still connect directly.

## Known limitations

- **Google Sign-In:** Google sometimes rejects sign-in from embedded browsers ("This browser or app may not be
  secure"), even with a clean Chrome User-Agent. If that happens, use **Telegram** or **email** login. Telegram opens
  the Telegram app, and the desktop app picks up the session automatically.
- Pop-up filtering is heuristic. Electron doesn't say which frame opened a pop-up, so the app uses the referrer. A
  third-party pop-up sent with `noreferrer` would open in your browser instead of being dropped.
- The screen-sleep blocker is tracked per window. If a muted ad pauses while the episode keeps playing, sleep could be
  allowed again until the next play event.
- No DRM (Widevine). Not needed by the current players.
- No auto-update. Rebuild or reinstall to update.
- Windows is the only target that has been built and tested. The code avoids Windows-only APIs, except Start with
  Windows, where it relies on Electron's login-item support.
