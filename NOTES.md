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

- At the user's request the app uses animeon.cc's own app icon (`/favicon-512.png`, identical to
  `/_next/static/media/logo.fd1904f7.png`, a cat-unicorn mark without text). It is the icon the site's web manifest
  offers for installing it as an app.
- `scripts/make-icons.mjs` downloads it at build time into `assets/` (git-ignored) and derives every icon from it.
  Nothing from the logo is committed. If the download fails, the original play-button icon is used instead.
- Windows/macOS icon: the mark on a dark rounded tile like the site's header. macOS menu bar: a template made of the
  logo's dark line-art. Title bar and splash: the transparent mark, no text.

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
