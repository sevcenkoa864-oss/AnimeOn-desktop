# Research notes (Step 0)

Researched 2026-10-07 against the live site (curl, an automated browser, and the app itself via CDP).

## Site

- Next.js app behind Cloudflare. `<html class="dark">`, `color-scheme: dark`.
- Colors: background `oklch(14.5% 0 0)` = **#0a0a0a** (manifest `background_color` #09090b), accent violet
  `oklch(60.6% .25 292.7)` ≈ **#7c4dff** (manifest `theme_color`). Frame/title bar use #0a0a0a + #7c4dff.
- Sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so the site **cannot** be iframed. The app loads it
  top-level in a `WebContentsView`, which needs no header changes.
- Electron's default User-Agent is not blocked. The app still sends a plain Chrome UA (see below).

## Domains (from the site's own CSP + JS bundles + observed traffic)

| Purpose                        | Domains                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site                           | `animeon.cc`                                                                                                                                                                                    |
| Images / static                | `ab18cf62-…selcdn.net`, `*.animeon.cloud`, `animeon.su`, `shikimori.one/io`, `st.kp.yandex.net`, `img.youtube.com`                                                                              |
| Own HLS player ("AnimeOn 2.0") | `*.animeon.cloud` (nya, meow, mochi, tora, kuro, shiro, tama, momo), `cloud.solodcdn.com`, `pe./strontium.cloud.solodcdn.com`                                                                   |
| Embedded player (iframe)       | `kodikplayer.com`, `kodikonline.com`; the iframe then talks to `ls.kodikres.com` and Kodik's CDNs                                                                                               |
| Trailers                       | `www.youtube-nocookie.com`                                                                                                                                                                      |
| Auth                           | `accounts.google.com` (Google Identity Services button iframe + popup, FedCM flagged), Telegram (bot deep link `t.me/…?start=<code>` + polling `/api/auth/telegram/check-code`), email/password |
| Analytics                      | Google Tag Manager / GA, Yandex Metrika, Cloudflare Insights, `/api/analytics/events`                                                                                                           |

The player iframe is `<iframe allow="autoplay; fullscreen; picture-in-picture" allowfullscreen>`, so fullscreen and PiP
are allowed by the site itself.

## Ads / pop-ups

- The site itself showed no overlay ads or pop-ups during testing.
- The **Kodik player** requests pre-roll / VAST / VPAID ads (buzzoola, adfox, traffer, moviead55, vidalak, traffmovie…).
  The ad blocker blocks these, and the episode still starts and plays (verified).
- The site uses `window.open('about:blank')` and then navigates it (Telegram login, share links). Denying that pop-up
  makes the site fall back to `location.href = …`, which the navigation guard sends to the system browser. This is how
  the Telegram login reaches the Telegram app while the app keeps polling and gets the session cookie.

## Decisions based on this

- **In-app (main frame):** `animeon.cc` + subdomains, https only. Anything else goes to `shell.openExternal`
  (http/https only).
- **Sub-frames aren't navigation-filtered.** The players are iframes whose allowed origins are already restricted by the
  site's own CSP `frame-src`, and filtering them in the app would only add ways to break playback.
- **Pop-ups:** `accounts.google.com` opens as a child window (keeps `window.opener` for the GSI callback). The child
  window may move through `google.com`, `youtube.com` (Google's cookie redirects) and `gstatic.com`. animeon links open in
  the main view. Links from the site (or `noreferrer` links) go to the browser. Pop-ups whose referrer is a third-party
  frame (player ads) are dropped.
- **User-Agent:** exact desktop Chrome reduced UA (`… Chrome/<major>.0.0.0 Safari/537.36`), built from Electron's
  Chromium version. Gives Google Sign-In the best chance of accepting the popup.
- **Wake lock:** uses `webContents` `media-started-playing` / `media-paused`. These fire for media in _any_ frame,
  including the cross-origin Kodik iframe, which a main-frame preload script cannot observe. So the site view has no
  preload at all.

## Header / CSP exceptions

- The app does **not** modify the site's CSP or response headers.
- The ad blocker (`@ghostery/adblocker-electron`) can rewrite headers only for filter-list `$csp`/`$removeheader` rules
  (EasyList/EasyPrivacy). Turning the ad blocker off, or adding the domain as an exception in Settings, disables this.
- The only request-level change the app makes is the User-Agent string.

## Verified in this environment (Windows 11, Electron 44 / Chromium 152)

Checked via the Chrome DevTools Protocol and the main-process inspector (no screen control):

- The site loads into the view under a 32px custom title bar. The splash shows until `dom-ready`. No console errors
  come from the app's code.
- Episode page → Kodik player iframe loads; the episode plays (HLS `blob:` video, currentTime advancing).
- HTML fullscreen from inside the player iframe: the window goes fullscreen and the view covers the whole screen.
  **Esc** exits, and the previously maximized window is restored maximized.
- Wake lock is taken on play and released on pause.
- Pop-ups: third-party (player) pop-up dropped; first-party and `noreferrer` links → default browser; `about:blank`
  denied; main-frame navigation to an external site → browser, app stays; `file://` navigation blocked.
- Google Sign-In button opens a child window with `window.opener` and the clean UA; Google shows its normal
  "Sign in to continue to animeon.cc" page.
- Restart persists window bounds, maximized state, zoom and the site's cookies (`persist:animeon` partition).
- Close → hides to tray. Second launch exits and focuses the first. Settings window + IPC validation work. An ad-block
  exception really unblocks the domain. The offline page shows on DNS failure, with Retry and auto-retry.

## Font: Manrope everywhere

- Local pages load `src/renderer/fonts/manrope.css` (Manrope variable, SIL OFL 1.1, latin/latin-ext/cyrillic/
  cyrillic-ext subsets from `@fontsource-variable/manrope`, license in `fonts/OFL.txt`). The local CSP allows
  `font-src 'self'`.
- On the site, the main process injects the same `@font-face` rules on every `dom-ready` (`webContents.insertCSS`),
  with the fonts inlined as `data:` URIs (a web page can't load `file://`), plus
  `* { font-family: Manrope … !important }`. This works offline and needs no network request.
- Only the top frame is restyled. The Kodik player iframe keeps its own UI font.
- The site's CSP lists `font-src 'self'` but only in **Report-Only** mode, so the `data:` font still loads. The browser
  may send a CSP violation report to the site's `/api/csp-report` endpoint. This is harmless, and nothing is blocked.

## Logo

- The app icon is animeon.cc's own app icon (`/favicon-512.png`, the icon its web manifest offers for "install as
  app"). `scripts/make-icons.mjs` downloads it at build time into `assets/` (git-ignored) and derives every icon from
  it: Windows/macOS icon on a dark tile, macOS menu-bar template from its line-art, transparent mark for the splash.
  Nothing from the logo is committed. If the download fails, an original play-button icon is used instead.
- Title bar: no logo or text (user's choice).

## macOS

- Traffic lights inset at the left of the 32px bar (`trafficLightPosition`). The bar reserves 80px on the left instead
  of 140px on the right.
- Real app menu (Edit roles make Cmd+C/V work; View has reload/back/forward/zoom/fullscreen). On Windows the default
  Electron menu is removed, because it carries a DevTools accelerator even in packaged builds.
- Dock click (`activate`) shows the window. The menu bar item opens its menu on click.
- Build: universal `.dmg`, ad-hoc signed (`identity: "-"`) with `hardenedRuntime: false`. Hardened runtime with
  ad-hoc signing fails library validation on the Electron framework. Not notarized (needs an Apple Developer account).
- Can't be built or run on Windows. The layout was checked by switching the local pages to `data-platform="darwin"`.
  Native behaviour (traffic-light position, menu, tray, Gatekeeper) has not been verified on a real Mac.

## Blocked poster servers (image proxy)

Checked from a Ukrainian connection without VPN on 2026-10-07:

| Host                                                                    | Serves                                    | Result                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `ab18cf62-…selcdn.net` (Selectel, CNAME `trbcdn.net`)                   | most posters                              | **intermittent**: requests hang ~10 s (no DNS answer), then work |
| `st.kp.yandex.net` (Kinopoisk)                                          | some images                               | **blocked** (Ukraine blocks Russian services)                    |
| `shikimori.io/.one`, `*.animeon.cloud`, `img.youtube.com`, `animeon.cc` | posters, own player media, trailers, site | OK                                                               |
| `*.solodcdn.com`, `kodikplayer.com`, `kodikonline.com`                  | video                                     | OK                                                               |
| `animeon.su`                                                            | listed in the site's CSP only             | refused (looks like an old domain, nothing references it)        |

What the app does (`src/main/imageproxy.ts`):

- Image requests to a candidate host that is marked blocked get redirected to `https://wsrv.nl/?url=…`. wsrv.nl is
  a free, open-source image proxy/cache hosted outside Russia/Ukraine. It answered in ~0.6 s for both hosts.
- A host gets marked by a startup probe (HEAD, 5 s timeout) **or** by any real failed image load. Marks persist
  (`blockedImageHosts` in config.json), because an unstable host would otherwise slip through a probe that happens to
  catch it working. After a new mark, already-broken posters on the page are re-requested in place (no reload).
- Only image requests to those two hosts go through wsrv.nl, and only the public poster URL is sent (no cookies).
  Settings → Network → "Load blocked images via proxy" turns it off.
- Electron allows one `onBeforeRequest` listener per session, so it is combined with the ad blocker's listener in
  `adblock.ts` and reinstalled whenever the ad blocker is toggled.
- Verified: with selcdn made unresolvable (`--host-resolver-rules`) and a fresh profile, all 20 catalog posters
  loaded through wsrv.nl.

## Auto-update

- `electron-updater` with the GitHub provider (`build.publish` in package.json → `app-update.yml` inside the app).
  The repository is public, so no token is needed.
- Windows NSIS installs: background download (differential via `.blockmap`), install on quit or via the tray item
  **Restart to Update** (`quitAndInstall(true, true)`: silent, relaunch). Checks at startup and every 4 h.
- macOS (only ad-hoc signed; Squirrel.Mac needs a Developer ID signature) and the portable exe can't self-update. They
  read `releases/latest` from the GitHub API and show a notification linking to the release.
- The release job uploads `latest*.yml` and `*.blockmap` next to the installers. Releases before v1.0.2 don't have
  them and their apps have no updater: installing v1.0.2 by hand once is needed.

## Android TV app (`tv/`)

- Kotlin, no AndroidX: one `Activity` with a full-screen `WebView` and a pointer overlay (`CursorView`). The site needs
  a mouse (hover, nested iframes), which focus-based D-pad navigation can't reach, so the arrows move a pointer.
- Input: the D-pad moves the pointer (+ hover events); OK sends a **finger tap**. Hand-built mouse button events were
  tested first and are ignored by the WebView (the login button did nothing), taps work. Pushing the pointer against the
  top/bottom edge sends mouse-wheel events. Media keys post to a `<video>` or to the Kodik iframe through its
  `kodik_player_api` postMessage (play/pause/seek), tracking state from the `kodik_player_*` messages it sends.
- Fullscreen: `WebChromeClient.onShowCustomView`; Back leaves it.
- Layout is left at the TV's natural density (1080p at 320 dpi = 960 CSS px: big text, readable from a couch). Forcing
  a 1280px viewport through the meta tag was tried: the site rewrites that tag while hydrating, so it didn't stick.
- `SiteFilter.kt` answers some requests itself: our CSS + Manrope from assets (served under `animeon.cc/__tv/`),
  blocked ad/tracker hosts, and posters from the two flaky Russian CDNs via wsrv.nl (same logic as the desktop app).
  `assets/tv-site.css` mirrors `HIDDEN_BLOCKS`/`HERO_FIT_CSS` in `src/main/main.ts`: keep the two in sync.
- Debug builds enable WebView remote debugging. `tv/ci/drive.mjs` uses it plus `adb input keyevent` to play the part
  of a person with a remote; `.github/workflows/tv-test.yml` runs it on an emulator and saves screenshots.
- Emulator findings: 1080p software rendering overloads the CI runner (ANR from CPU starvation, not an app bug), so the
  test uses the 720p profile. Verified there: page + fonts + hidden blocks, pointer to the login button and OK (dialog
  opens), edge scrolling, opening a Kodik player by pointer, play/pause key, HTML fullscreen and Back.
- Signing: `TV_KEYSTORE_*` secrets (a key kept at `C:\Users\reyjen\animeon-tv-signing` on the author's PC). Without
  them (forks) the debug key is used. Losing the key means users must uninstall before installing a newer APK.
- No self-update (Android needs the "install unknown apps" permission and a confirmation for that). Not tested on real
  hardware, and old TVs with an outdated WebView may render the site badly.
