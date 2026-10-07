# Android TV: D-pad navigation, 10-foot details page, low-end performance

Date: 2026-10-07. Scope: `tv/` only (the desktop app is untouched).

## Goal

The TV app is a WebView around animeon.cc and today the remote drives an on-screen mouse pointer. The owner wants the
app to be usable on a TCL / Android TV with the remote alone: focus-based D-pad navigation, no pointer anywhere
(including the video player), a full-screen backdrop on the title page, and no heavy rendering or autoplaying media on
low-end TV chipsets.

## Constraints that shape the design

- We do not control the site's markup (Next.js, Tailwind). Everything is injected CSS and JS, so it can break when the
  site renames classes. Selectors should prefer semantic tags, roles and `href` patterns.
- The reference app (`anilibria/anilibria-app`) is a native Android UI. Nothing can be ported; only the ideas
  (focus rows, back behaviour) are reused.
- The Kodik player is a cross-origin iframe: page JS cannot focus or click inside it. It can only be driven through its
  `postMessage` API (`play`, `pause`, `seek`, already used for media keys) and through the Fullscreen API on the
  `<iframe>` element itself. Consequence of "no pointer": Kodik's own in-player menus (quality, voice-over) are not
  reachable. This is accepted by the owner.
- Site lists cannot be virtualised. The practical equivalents are `content-visibility`, lazy images and removing
  expensive effects.

## Observed on the live site (2026-10-07)

- Title page `/anime/<slug>`: no `<video>` and no `<iframe>` until the user acts; the trailer is a click-to-load
  thumbnail button; 41 buttons, 59 links, 29 images (below-the-fold ones are `loading=lazy`), 4 `backdrop-blur`
  elements, ~38 `shadow` elements, ~11 `animate-*` elements. The home page has no `<video>` at all. So today nothing
  autoplays; the autoplay rule is a guard, not a fix.
- Header is `.aon-glass.aon-glass-header` with links `/`, `/catalog`, `/together`, `/news`, `/premium`.
- Poster in the left column is 272x408 (portrait, low resolution).

## Design

### 1. Input: native passes keys through, page JS moves focus

- `MainActivity.dispatchKeyEvent` stops intercepting D-pad and OK. Arrow keys and Enter go to the WebView, which
  delivers ordinary `keydown` events. Pointer code is deleted: `CursorView.kt`, `moveCursor`, `click`, `tap`, `send`,
  `scroll`.
- New asset `tv/app/src/main/assets/tv-nav.js`, served by `SiteFilter` at `/__tv/tv-nav.js` and loaded by `PAGE_JS`
  next to the CSS (idempotent, survives SPA navigation). It owns all navigation:
  - a capture-phase `keydown` listener for arrows and Enter, calling `preventDefault` for keys it handles;
  - candidates: visible `a[href]`, `button`, `input`, `select`, `textarea`, `[role=button|link|tab|menuitem]`,
    `[tabindex>=0]`, and the player block (below). Hidden, `disabled`, `aria-hidden` and off-DOM nodes are skipped;
  - **groups** (the "blocks"): the nearest ancestor among `header`, `nav`, `[role=dialog]`, `section`, and any
    horizontally scrollable row, falling back to `main`. A move first looks for the nearest candidate in the same
    group in the pressed direction; only if there is none does it jump to another group, landing on the candidate
    nearest to the current element's centre on the cross axis. This gives row-to-row jumping instead of free flight;
  - the distance score is the usual spatial-navigation one: primary-axis gap plus weighted cross-axis offset, and
    candidates not strictly in the pressed direction are discarded;
  - the focused element is scrolled into view with `scrollIntoView({block: 'center', inline: 'center'})` (instant,
    not smooth);
  - open modals (`[role=dialog]`, `[aria-modal=true]`) trap focus: only their candidates are considered;
  - text fields: Left/Right move the caret, Up/Down leave the field, Enter keeps the field focused so Android shows the
    keyboard, Back blurs it;
  - Enter on a non-native clickable (a `div` with a handler) calls `el.click()`; natively clickable elements are left
    to the browser;
  - on first load and after route changes with no focus, focus goes to the page's primary action (`Смотреть` on a
    title page, first catalog card, otherwise the first `main` candidate).
- The pure geometry (`pickNext(current, candidates, direction)`) is separated from DOM access and exported for
  `node --test`, so the algorithm has a real test (`tv/ci/nav.test.mjs`) without an emulator.

### 2. Focus visuals

Set by `tv-site.css` on `:focus` of the candidate elements (the nav script always calls `el.focus()`):
`outline: 3px solid #7c4dff; outline-offset: 3px; transform: scale(1.05)` with a 120 ms transform transition, and a
raised `z-index` so a scaled card is not clipped by neighbours. No `box-shadow` glow (costly on low-end GPUs); the
outline is the contrast carrier. Default browser focus ring is removed only where ours applies.

### 3. Back button

`Back` is sent to the page first (`evaluateJavascript` with a result callback); the page answers with what it did, and
native handles the rest:

1. Fullscreen video open: leave fullscreen (existing).
2. Modal / menu / popover open: close it (click its close button or dispatch `Escape`).
3. Text field focused: blur it.
4. On list pages (`/`, `/catalog`, `/news`, ...) with focus in the content: focus moves to the header (current nav
   item) and the page scrolls to the top. A second Back goes to step 5.
5. Otherwise `history.back()`; at the history root, double-press to exit (existing toast).

Title pages and other deep routes skip step 4 so Back from a title goes straight to the previous list.

### 4. Player (no pointer)

The Kodik `<iframe>` (and any main-frame `<video>`, e.g. the site's own player) is a single focusable "player block"
with the same focus ring. Keys while it is focused:

| Key         | Action                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| OK          | play / pause (existing `__tv.cmd('toggle')`)                                                                 |
| Left, Right | seek -10 s / +10 s, hold repeats                                                                             |
| Up, Down    | leave the player block to the previous / next group                                                          |
| Menu        | toggle fullscreen (`iframe.requestFullscreen()` from the key gesture); outside the player Menu still reloads |
| Back        | exit fullscreen if on, otherwise step 2-5 above                                                              |
| media keys  | unchanged                                                                                                    |

Not reachable and documented as a known limitation: Kodik's quality and voice-over menus inside the iframe. The
site's own episode and voice selectors are page elements and stay reachable. The site's "AnimeOn 2.0" player needs a
login and is unverified; it gets the same block behaviour when it renders a `<video>`.

### 5. Title page layout (10-foot UI)

Applied only on `/anime/*` through a route attribute that `tv-nav.js` keeps on `<html data-tv-route="anime">`:

- A fixed full-screen backdrop `div#tv-backdrop` (`z-index: -1`, `pointer-events: none`) uses the title's poster
  (`meta[property="og:image"]`, falling back to the left-column poster) as `background-size: cover;
background-position: center 25%`, with a dark overlay: `linear-gradient(90deg, #0a0a0a 28%, rgba(10,10,10,.65) 60%,
rgba(10,10,10,.25))` over `linear-gradient(0deg, #0a0a0a, transparent 45%)`. The source is a low-resolution portrait
  image; the overlay hides the softness. If the site exposes a larger or landscape still, using it is an
  implementation-time improvement, not a requirement.
- The first content block gets `min-height: 100vh` so the first screen is the hero: large title, meta chips,
  clamped description (4 lines), and the action row (`Смотреть`, `В список`, `Поделиться`, `В подборку`) with a
  minimum 64 px height and a bigger font, left-aligned in the readable gradient area. Down scrolls to the rest
  (episodes, FAQ, frames, comments).
- Minimum text size on this route is raised so it reads from 2-3 m (the app already runs at natural 320 dpi scale).

### 6. Performance on low-end hardware

CSS in `tv-site.css`, applied on all routes:

- `backdrop-filter: none !important` on `[class*='backdrop-blur']` and `.aon-glass*`, replaced by a solid
  `rgba(10,10,10,.92)` background.
- `box-shadow: none` on `[class*='shadow']` (not on focused elements, which use the outline).
- `animation: none !important` and `transition: none !important` globally, then the focus transform transition is
  re-added. This also stops the continuous hero/backdrop animations.
- `content-visibility: auto` with `contain-intrinsic-size: auto 600px` on `main > *` and each `section`, so
  off-screen blocks are not laid out or painted.

JS in `tv-nav.js`:

- **No preview autoplay guard:** any `<video>` that is `muted` and `loop` (the preview pattern) or has no `controls`
  and is not the player block is paused and has `preload=none`. User-initiated trailers (click on `ТРЕЙЛЕР`) are
  unaffected because they are iframes created after a key press.
- **Lazy images:** every `<img>` outside the first screen gets `loading=lazy` and `decoding=async` (observed via
  `MutationObserver` for SPA content).
- **Release media on route change:** when the path leaves a watch view, remaining `<video>` elements are paused and
  their `src` released (`removeAttribute('src'); load()`).

Native: `onPause` already calls `web.onPause()`. No further native change.

## Files

- Add: `tv/app/src/main/assets/tv-nav.js`, `tv/ci/nav.test.mjs`.
- Edit: `MainActivity.kt` (key dispatch, Back flow, Menu key, remove pointer, `PAGE_JS` loads `tv-nav.js`),
  `SiteFilter.kt` (serve `tv-nav.js`), `tv-site.css` (focus, perf, title layout), `tv/ci/emulator-test.sh` and
  `tv/ci/drive.mjs` (key-driven focus checks), `docs/DEVELOPMENT.md` (section 4 and gotchas).
- Delete: `CursorView.kt`.

## Testing

1. `node --test tv/ci/nav.test.mjs`: `pickNext` on synthetic rects (grid, row-to-row jump, modal trap, nothing in
   direction returns null).
2. Emulator test (existing `tv-test.yml`): send `DPAD_*`/`ENTER`/`BACK` via `adb input keyevent`, read
   `document.activeElement` through DevTools and assert: initial focus on `Смотреть`; Right/Down change focus; Back
   from a title returns to the previous page; no `<video>` playing on home/title pages; `backdrop-filter` computed
   style is `none`.
3. Not verifiable without hardware or an account (to be listed in `docs/DEVELOPMENT.md` section 9): feel on a real TCL
   remote, Kodik playback keys, fullscreen on a real device, the logged-in player.

## Out of scope

Native rewrite, a self-update flow, hover-only site menus (if one exists it is reached by focus because it is
usually also a link), virtualising the site's own lists.
