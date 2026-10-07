# Development guide

Maintainer notes for AnimeOn Desktop (Unofficial): how the project is put together, how to build, test and release it,
what has and hasn't been verified, and the traps that cost time. `README.md` is for users, `NOTES.md` has the site
research behind the allowlists and workarounds; this file is the entry point for working on the code.

State at the time of writing: **v1.0.5** released (Windows, macOS, Android TV), `main` is clean and pushed.

## 1. What it is

An unofficial client for <https://animeon.cc/> (a Russian-language anime site). Three apps, one repository:

| App                              | Where                                     | Tech                                               |
| -------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| Desktop (Windows primary, macOS) | `src/`                                    | Electron 44, TypeScript (strict), electron-builder |
| Android TV                       | `tv/`                                     | Kotlin, one Activity with a WebView, no AndroidX   |
| (CI only) TV emulator test       | `tv/ci/`, `.github/workflows/tv-test.yml` | adb + DevTools protocol scripts                    |

The apps load the real site; nothing is mirrored or re-hosted. Everything we add is injected CSS, request filtering,
and window/remote-control behaviour. Personal-use project, so decisions favour "works smoothly for the owner" over
generality.

## 2. Repository map

```
src/main/main.ts        window, WebContentsView, navigation/popup policy, tray, mac menu, settings IPC, CSS injection
src/main/adblock.ts     Ghostery engine + the single combined onBeforeRequest handler
src/main/imageproxy.ts  poster proxy for blocked hosts (wsrv.nl), sticky host marks
src/main/updater.ts     electron-updater (Windows installs) / release notification (macOS, portable)
src/main/store.ts       electron-store schema, defaults, validation of values coming over IPC
src/main/urls.ts        URL policy (app host, auth popup hosts, http(s) check), UA builder, hostname parser
src/main/version.ts     numeric version comparison
src/main/*.test.ts      node:test unit tests (urls, imageproxy, version)
src/preload/local.cts   the only preload; exposes a small API to our own local pages (never to the site)
src/renderer/           shell.html/.mts (title bar + splash + offline page), settings.html/.mts, fonts/ (Manrope)
scripts/make-icons.mjs  dependency-free icon generator; downloads the site logo at build time
scripts/copy-static.mjs copies src/renderer (html, css, fonts) into dist
tv/                     Android project (Gradle Kotlin DSL); tv/ci has the emulator test driver
.github/workflows/      build.yml (release), tv-test.yml (manual emulator test)
```

`dist/`, `release/`, `assets/` (generated icons) and the TV launcher icons under `tv/app/src/main/res/` are
git-ignored build output. Never commit the site logo; the icon script fetches it from `https://animeon.cc/favicon-512.png`
and falls back to an original play-button icon if that fails.

## 3. Desktop architecture

**Window.** One `BrowserWindow` with `titleBarStyle: 'hidden'`. Windows/Linux use `titleBarOverlay` (native buttons
drawn over our 32 px bar), macOS uses `trafficLightPosition`. The window's own page (`shell.html`) is the title bar,
splash and "No connection" screen. The site lives in a `WebContentsView` placed below the bar
(`layout()`), hidden until `dom-ready`. HTML fullscreen (`enter-html-full-screen`) makes the view cover the whole
window; leaving restores the maximized state (`maximizedBeforeFullScreen`).

**Session.** Partition `persist:animeon` (login survives restarts). The site view gets no preload, sandbox on,
context isolation on. Permissions: only `fullscreen` and `clipboard-sanitized-write`.

**Navigation policy** (`urls.ts`, wired in `wireSiteView`):

- main frame stays on `https://animeon.cc` (+ subdomains); everything else goes to the default browser via
  `shell.openExternal` (http/https only). `file:` and other schemes are blocked.
- `window.open`: `accounts.google.com` opens as a child window (keeps `window.opener` for the Google Sign-In
  callback; it may navigate through google.com, youtube.com, gstatic.com); animeon.cc links load in the view; links
  from the site itself or `noreferrer` links open externally; pop-ups whose referrer is a third-party frame (player
  ads) are dropped; `about:blank` is denied (the site then falls back to a same-window navigation, which the guard
  routes correctly).
- Sub-frames are deliberately not filtered (the site's own CSP restricts frame origins; filtering would only break
  players).

**Request filtering.** Electron allows one `onBeforeRequest` listener per session and Ghostery installs/clears its
own when blocking is toggled. `adblock.ts` therefore owns a single combined listener (`installRequestHandler`, re-run
in a `finally` after every `setAdblock`): first image redirects from `imageproxy.ts`, then the ad blocker. Per-domain
exceptions are added to the engine as `@@||host^` and `@@*$domain=host`. Lists: Ghostery prebuilt ads+trackers,
cached in userData (`adblock-engine.bin`), refreshed weekly.

**Image proxy.** Most posters come from `ab18cf62-…selcdn.net` (Selectel, intermittently unreachable from Ukraine)
and some from `st.kp.yandex.net` (blocked in Ukraine). A host is marked by a startup probe or by a real failed
image load, the mark is sticky and persisted (`blockedImageHosts`), image requests to marked hosts are redirected to
`https://wsrv.nl/?url=…`, and already-broken images on the page are re-requested in place
(`RETRY_BROKEN_IMAGES`). Setting `imageProxy` turns it off.

**Injected CSS** (`siteCss()`, inserted on every `dom-ready` of the top frame): Manrope as a data-URI `@font-face` +
`font-family !important`, `HIDDEN_BLOCKS` (promo sections, Telegram banner, footer), and `HERO_FIT_CSS` (home hero
title width/size, bottom-fade z-index, keep text below the header). The reasoning for each rule is in the comments
next to the constants. Selectors target stable semantic classes (`.pm-sheet`, `.bpp-shell`, `.hero-slider-height`) or
the Telegram-blue arbitrary class; they will break if the site renames them.

**Video.** `autoplayPolicy: no-user-gesture-required`; `powerSaveBlocker` is started on `media-started-playing` and
stopped on `media-paused` (these events fire for media in any frame, including the cross-origin Kodik iframe, which a
preload could never see; known flaw: a paused ad can release the blocker). Media keys, PiP and fullscreen are
the browser's own behaviour.

**Settings** (`store.ts`): `closeToTray`, `startWithWindows`, `startMinimized`, `adblock`, `adblockExceptions`,
`hardwareAcceleration` (needs restart), `defaultZoom`, `imageProxy`; plus internal `zoom`, `window`,
`blockedImageHosts`. Config file: `%APPDATA%\AnimeOn Desktop (Unofficial)\config.json`. Every value from IPC goes
through `sanitizeSetting`; IPC handlers reject senders outside `dist/renderer`.

**Updates** (`updater.ts`): Windows NSIS installs use electron-updater against this repo's Releases (background
download, install on quit or from the tray); macOS (ad-hoc signed) and the portable exe can't self-replace, so they
poll the GitHub API and show a notification linking to the release page.

**Names.** The product name shown to users is `AnimeOn Desktop` (`build.productName`), but the runtime name stays
`AnimeOn Desktop (Unofficial)` (it decides the profile folder: renaming it would sign everyone out and reset
settings). `appId` is `cc.animeon.desktop.unofficial`; the installed exe is `AnimeOnDesktop.exe`
(per-user or `C:\Program Files\AnimeOnDesktop`, depending on how the owner installed it).

## 4. Android TV app (`tv/`)

- `MainActivity.kt`: WebView + splash. There is no pointer: arrows and OK go to the page as ordinary key events and
  `assets/tv-nav.js` (injected on every page) moves real focus between links and buttons, jumping block to block
  (`pickNext`, unit-tested in `tv/ci/nav.test.mjs`). Back = fullscreen off / close dialog / blur field / (on list
  pages) focus the header / page history / double-press to exit. Menu = fullscreen for the focused player, else reload.
- The video player is one virtual-focus block (outline via `.tv-focus`): real focus never enters the cross-origin Kodik
  iframe, or keys would stop reaching the page. OK = play/pause, Left/Right = seek 10 s (`window.__tv.cmd`, which
  posts `kodik_player_api` messages to the iframe). While a video is fullscreen the page can't see keys, so
  `MainActivity` handles OK/arrows itself. Kodik's own menus (quality, voice-over) are not reachable without a pointer.
- Title pages: below the site's 1024 px breakpoint the site stacks the page under a 2:3 poster 1.5 screens tall;
  `tv-site.css` forces the two-column desktop layout and hides the poster. Also in `tv-site.css`: focus ring, 48 px
  safe-area padding on `main`, no blur/shadow/animation for weak GPUs.
- `SiteFilter.kt`: serves our CSS and fonts under `https://animeon.cc/__tv/*` from assets, blocks the same ad hosts,
  proxies posters through wsrv.nl once a direct fetch failed (persisted in SharedPreferences).
- `tv/app/src/main/assets/tv-site.css` duplicates the desktop CSS rules: keep it in sync with
  `HIDDEN_BLOCKS`/`HERO_FIT_CSS` in `main.ts`. Fonts come from `src/renderer/fonts` through a Gradle asset dir.
- Natural scale is intentional (1080p at 320 dpi = 960 CSS px: big text for a couch). Forcing `width=1280` via the
  viewport meta was tried; the site rewrites that tag while hydrating.
- Toolchain: Gradle 8.10.2 (installed by the workflow, no wrapper), AGP 8.7.3, Kotlin 2.0.21, compileSdk/targetSdk 35,
  minSdk 24, JDK 17. `versionCode = major*1e6 + minor*1e3 + patch`, `-PversionName` from the tag.
- Signing: CI signs `assembleRelease` with the key from the `TV_KEYSTORE_*` secrets (see §6). Without them (forks, local)
  the debug key is used. Installing over an existing copy only works with the same key.
- No self-update on TV (Android needs "install unknown apps" + a user confirmation). Candidate feature.

## 5. Commands

```bash
npm install                # if install scripts were skipped: node node_modules/electron/install.js
npm run dev                # icons + build + launch (uses the real profile unless --user-data-dir is given)
npm run lint               # eslint (src, scripts) + prettier --check (everything except tv code)
npm test                   # build + node --test dist/main/*.test.js
npm run dist               # icons + build + electron-builder for the host OS -> release/
node scripts/make-icons.mjs [--refresh]
gradle -p tv assembleDebug # Android; needs JDK 17 + Android SDK (CI only so far, none on the owner's PC)
node --test tv/ci/nav.test.mjs  # D-pad focus picker, pure unit test
node tv/ci/layout.mjs        # TV layout at 960x540 css px (1080p/720p/4K TV viewports) in local Chrome/Edge; no emulator needed
```

Style: Prettier (single quotes, 120 columns), strict TypeScript, ESLint type-checked rules. `tv/` is excluded from
ESLint; Kotlin has no formatter configured.

## 6. CI and releases

**Release procedure**

1. Bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`), commit, push `main`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `build.yml` builds Windows (NSIS + portable + blockmap + `latest.yml`), macOS (universal dmg + `latest-mac.yml`),
   and the signed TV APK (it prints the signing certificate with `apksigner`; SHA-256 must start `00cd4e4c`), then the
   `release` job publishes one GitHub Release with everything.
4. If the `release` job doesn't start (happened once for v1.0.4; re-running failed jobs returned HTTP 500), download
   the three artifacts (`gh run download <id> -n AnimeOnDesktop-Windows -n AnimeOnDesktop-macOS -n AnimeOnDesktop-AndroidTV`)
   and run `gh release create vX.Y.Z <files> --notes-file …`. The updater needs `latest.yml` and the `.blockmap`
   files in the release.

Running `build.yml` manually (`workflow_dispatch`) builds everything but never publishes; useful as a dry run.

**Secrets** (repository settings): `TV_KEYSTORE_BASE64`, `TV_KEYSTORE_PASSWORD`, `TV_KEY_ALIAS`, `TV_KEY_PASSWORD`.
A backup of the keystore and its password is kept outside the repository on the owner's PC (folder
`animeon-tv-signing` in the home directory). If it is lost, a new key means users must uninstall the TV app first.

**Platform notes.** Windows and macOS builds are unsigned/ad-hoc (SmartScreen and Gatekeeper warn on first run;
this is reputation, not a malware verdict; Defender scans clean). Fixing it needs a paid certificate (Windows) /
Apple Developer ID (macOS, which would also enable macOS self-update). macOS runners are sometimes unavailable
("job not acquired by runner"): re-run later.

**TV emulator test** (`tv-test.yml`, manual): builds the debug APK, boots an Android 14 emulator (`tv_720p`, KVM,
software GPU), installs the app and runs `tv/ci/emulator-test.sh`, which "uses the remote" through `adb input
keyevent` and reads page state through the WebView DevTools port (`tv/ci/drive.mjs`: `eval`, `nav`, `move`, `point`).
Artifact `tv-emulator` has screenshots, `report.txt`, `problems.txt` (ANR/crash lines) and the full logcat. 1080p
overloads the runner's software rendering (ANR from CPU starvation), hence 720p.

## 7. Verifying changes without a screen

Desktop UI can be exercised and measured without any screen control:

```bash
npx electron . --user-data-dir=<temp dir> --inspect=9229 --remote-debugging-port=9222 \
  --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding
```

- Page targets: `http://127.0.0.1:9222/json/list` (the site view and `shell.html`); evaluate with
  `Runtime.evaluate` over the target's websocket. The main process is at `:9229`; evaluating there gives
  `require('electron')`, so windows, views, sessions and `powerSaveBlocker` can be inspected and driven
  (`wc.sendInputEvent`, `webRequest.onErrorOccurred`, `capturePage` for screenshots).
- **Use a separate `--user-data-dir`.** The default profile is the owner's real login/settings/zoom; tests earlier
  leaked a 120 % zoom into it. The single-instance lock is per profile, so a test copy runs next to the installed app.
- Kill test instances by path/PID, not `taskkill /IM electron.exe` blindly, and never touch the installed
  `AnimeOnDesktop.exe` (the owner may be using it; the Setup exe can't replace files that are in use).
- The occlusion/backgrounding flags above keep a covered window from throttling timers or reporting stale sizes.
- Mouse/keyboard events from CDP don't reach Electron's `before-input-event` shortcuts (F11, Ctrl+Q); test those by
  hand.
- A real Mac, a real TV and Google login were never exercised (see §9).

## 8. Gotchas (all of these happened)

- **Line endings.** On Windows, Python `Path.write_text` writes CRLF and a stray lone CR makes git treat a file as
  binary (no normalisation). `.gitattributes` forces LF (`*.sh` explicitly); check with `git ls-files --eol`. A CRLF
  shell script fails on the Linux runner with "unexpected end of file".
- **Escapes in generated edits.** A `\r` or `\\r` in an edit script can be collapsed to a real carriage return by the
  tooling; prefer the editor tools for files containing backslashes, and re-read the file afterwards.
- **`cmd | tail && next`** hides the first command's failure (exit code of `tail`). Lint errors slipped past that way.
- **`.gitignore` patterns.** `assets/` once ignored `tv/app/src/main/assets/`; the root-only form is `/assets/`.
- **electron-builder name rewrite.** Changing `build.productName` does not change the runtime name inside `app.asar`.
- **Electron 44 / TS.** TypeScript is pinned `~6.0` because typescript-eslint doesn't accept 7 yet. ESM main process
  (`"type": "module"`), preload and renderer scripts that run in the page are `.cts`/`.mts`.
- **Android WebView input.** Hand-built _mouse button_ touch events are ignored by the WebView; a _finger_ tap works.
  Hover and wheel as mouse generic events work.
- **Site quirks.** Next.js rewrites the viewport meta during hydration; the `h2` hero title is sized by width only
  inside a fixed-height slider (hence `HERO_FIT_CSS`); a bottom fade sibling at the same z-index dims hero buttons.
- **GitHub Actions.** `workflow_dispatch` only works for workflow files already on the default branch. The macOS
  arm64 runner can be unavailable. Emulator tests need KVM enabled (udev rule step) and a 720p profile.
- **CSP.** The site's CSP is report-only; the injected data-URI fonts trigger harmless violation reports.

## 9. Verified vs. not verified

Verified (headless, desktop): load without white flash, offline page + retry, login cookie persistence across
restarts, window bounds/zoom persistence, episode playback in the Kodik iframe, HTML fullscreen enter/exit with
Esc and restored maximize, wake lock on play/pause, pop-up/external-link/`file:` handling, Google Sign-In popup opens,
ad-block exceptions, image proxy end to end (selcdn made unresolvable), settings window and IPC validation,
single-instance behaviour, close-to-tray, packaged build starts, hidden promo blocks and hero layout.
Verified (TV emulator): see §6 and the list in `NOTES.md`.

Not verified: macOS in any form (layout was checked by faking `data-platform="darwin"`), a real Android TV, hardware
media keys, PiP, Start-with-Windows/Start-minimized after a real reboot, the auto-update download/install path
(needs a release newer than the installed one), Google login anywhere, the site's own "AnimeOn 2.0" player (needs a
logged-in account), and F11/Ctrl+Q from a physical keyboard.

## 10. Backlog / ideas

- Code signing (Windows certificate, Apple Developer ID) to remove SmartScreen/Gatekeeper warnings and enable
  macOS self-update.
- TV: in-app update check that downloads the APK and opens the package installer; leaving fullscreen seems to
  reset the page scroll; try on a real device; remote-friendly hint overlay for first launch.
- Desktop: confirm the auto-update flow on the first release after one that contains the updater (v1.0.4 → next).
- Move the shared CSS (hidden blocks, hero fix) into one file consumed by both desktop and TV.
- Per-site selector health check (a CI job that loads the home page and asserts the hidden blocks and hero rules
  still match something).
- Known flaws: a muted ad pausing can drop the wake lock; pop-up filtering relies on the referrer heuristic.

## 11. Conventions

- Commits are authored by the repository owner; subject in the imperative, no attribution trailers or generated-by
  footers anywhere in code, docs or history.
- The repository is public. Keep secrets, credentials and the keystore out of it, and keep the site's logo out of
  it (the build downloads it; published installers and APKs do contain it).
- Chat with the owner is in Russian; repository docs and code comments are in English.
