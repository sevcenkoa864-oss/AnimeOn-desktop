import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  screen,
  session,
  shell,
  Tray,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
  type Session,
  type WebContents,
} from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setAdblock } from './adblock.js';
import { clampZoom, getSettings, sanitizeSetting, store, type Settings } from './store.js';
import { chromeUserAgent, HOME, isAppUrl, isAuthFlowUrl, isAuthPopupUrl, isWebUrl } from './urls.js';

const APP_NAME = 'AnimeOn Desktop (Unofficial)';
const BG = '#0a0a0a'; // site background (oklch 14.5% 0 0)
const SYMBOL = '#e5e5e5';
const TITLE_H = 32;
const ZOOM_STEP = 0.1;
const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';

const here = path.dirname(fileURLToPath(import.meta.url)); // dist/main
const RENDERER = path.join(here, '..', 'renderer');
const PRELOAD = path.join(here, '..', 'preload', 'local.cjs');
const ASSETS = path.join(app.getAppPath(), 'assets');
const ICON = path.join(ASSETS, isMac ? 'icon.png' : 'icon.ico');
const LOGIN_LABEL = isMac ? 'Open at Login' : 'Start with Windows';
// Windows/Linux: native buttons drawn over the right end of our bar. macOS: traffic lights inset at the left.
const WINDOW_CHROME: BrowserWindowConstructorOptions = isMac
  ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 10 } }
  : { titleBarStyle: 'hidden', titleBarOverlay: { color: BG, symbolColor: SYMBOL, height: TITLE_H } };
// Dev-only override, handy for testing the offline page (e.g. ANIMEON_URL=https://animeon.invalid/).
const START_URL = (isDev && process.env.ANIMEON_URL) || HOME;

// Hidden promo cards (by their stable semantic class names): "Путь к манге" (Premium manga promo) and
// "Боевой пропуск". The whole <section> goes, so no empty gap is left behind.
const HIDDEN_BLOCKS = ['.pm-sheet', '.bpp-shell'];

// Home hero slider: the site sizes the title by window width only, inside a slider of fixed height with the text
// bottom-aligned, so in wide-but-short windows (even a maximized 1080p window) long titles overflow under the
// header (on tall screens they end up flush against it). The title also gets a wider column than the site's 672px
// (up to 1280px / 55vw; never narrower than the site's), so long titles take fewer lines. Cap it by height too
// (a no-op on tall screens);
// "safe" alignment starts the text below the header (+24px) whenever it can't fit bottom-aligned; and in short
// windows clamp the title to 3 lines and trim the bottom padding.
const HERO_FIT_CSS =
  '.hero-slider-height h2 { font-size: min(4.7vw, 5.5vh, 3.75rem) !important;' +
  ' max-width: none !important; width: max(100%, min(80rem, 55vw)) !important; }' +
  '.hero-slider-height .items-end { align-items: safe flex-end !important; padding-top: 5.5rem !important; }' +
  // The slider's extra bottom fade is a sibling of the slides at the same z-index, so it paints over the slide's
  // text and dims the buttons when they sit low. Drop it under the slide (each slide has its own bottom gradient).
  '.hero-slider-height > .pointer-events-none.bottom-0 { z-index: 0 !important; }' +
  '@media (max-height: 1100px) {' +
  ' .hero-slider-height h2 { display: -webkit-box !important; -webkit-box-orient: vertical;' +
  ' -webkit-line-clamp: 3; overflow: hidden; }' +
  ' .hero-slider-height .items-end { padding-bottom: min(9rem, 7vh) !important; } }';

// CSS injected into the site's top frame on every page load:
// - Manrope everywhere. The page can't load file:// fonts, so the shared @font-face sheet is inlined as data: URIs.
// - The hidden blocks and the hero fix above. Player iframes are untouched.
let siteCssText: string | undefined;
function siteCss(): string {
  const dir = path.join(RENDERER, 'fonts');
  siteCssText ??=
    readFileSync(path.join(dir, 'manrope.css'), 'utf8').replace(
      /url\(([\w.-]+\.woff2)\)/g,
      (_, file: string) => `url(data:font/woff2;base64,${readFileSync(path.join(dir, file)).toString('base64')})`,
    ) +
    '*, *::before, *::after { font-family: Manrope, system-ui, sans-serif !important; }' +
    HIDDEN_BLOCKS.map((c) => `section:has(> ${c}), ${c}`).join(', ') +
    ' { display: none !important; }' +
    HERO_FIT_CSS;
  return siteCssText;
}

export type ShellState = { kind: 'loading' | 'ready' | 'error'; title: string; message?: string };

let win: BrowserWindow | undefined;
let view: WebContentsView | undefined;
let tray: Tray | undefined;
let settingsWin: BrowserWindow | undefined;
let siteSession: Session;
let quitting = false;
let htmlFullScreen = false;
let maximizedBeforeFullScreen = false;
let loadFailed = false;
let lastUrl = START_URL;
let shellState: ShellState = { kind: 'loading', title: 'AnimeOn' };
let sleepBlocker = -1;

// ---------- pre-ready setup ----------

if (!app.requestSingleInstanceLock()) {
  app.exit(0); // immediate: another instance owns the profile, so do not let Chromium touch it
} else {
  app.on('second-instance', showWindow);
  if (!store.get('hardwareAcceleration')) app.disableHardwareAcceleration();
  app.userAgentFallback = chromeUserAgent(process.platform, process.versions.chrome);
  app.setAppUserModelId('cc.animeon.desktop.unofficial');
  app.on('before-quit', () => {
    quitting = true;
    saveWindowState();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', showWindow); // macOS: Dock icon click
  app.on('web-contents-created', (_e, wc) => hardenContents(wc));
  void app.whenReady().then(start);
}

async function start(): Promise<void> {
  siteSession = session.fromPartition('persist:animeon');
  for (const ses of [siteSession, session.defaultSession]) lockDownPermissions(ses);
  registerIpc();
  // macOS needs a real app menu (Cmd+C/V, Cmd+Q…). Elsewhere drop Electron's default one: it carries
  // accelerators such as the DevTools toggle even in packaged builds, and our shortcuts are handled in onKey.
  Menu.setApplicationMenu(isMac ? macMenu() : null);
  createWindow();
  createTray();
  syncLoginItem();
  // With a cached engine this is instant; on first run it downloads the lists while the splash is up.
  await setAdblock(siteSession, store.get('adblock'), store.get('adblockExceptions'));
  view?.webContents.loadURL(START_URL).catch(() => {}); // failures are handled in did-fail-load
}

// ---------- security ----------

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

function lockDownPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/** Baseline for every webContents: no <webview>, no stray windows, no navigation off http(s)/our files. */
function hardenContents(wc: WebContents): void {
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // the site view and auth popups override this
  wc.on('will-navigate', (e) => {
    const isLocal = wc.getURL().startsWith('file:');
    if (isLocal || !isWebUrl(e.url)) e.preventDefault();
  });
}

function openExternal(url: string): void {
  if (isWebUrl(url)) shell.openExternal(url).catch((err: unknown) => console.error('openExternal failed', err));
}

const RENDERER_URL = pathToFileURL(RENDERER).href + '/';
const isLocalSender = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => !!e.senderFrame?.url.startsWith(RENDERER_URL);

// ---------- main window ----------

function initialBounds(): Partial<Rectangle> {
  const b = store.get('window').bounds;
  if (!b) return { width: 1280, height: 800 };
  const onScreen = screen
    .getAllDisplays()
    .some(
      ({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y,
    );
  return onScreen ? b : { width: b.width, height: b.height };
}

function saveWindowState(): void {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isFullScreen() ? maximizedBeforeFullScreen : win.isMaximized();
  store.set('window', { bounds: win.getNormalBounds(), maximized });
}

function createWindow(): void {
  const startedAtLogin = process.argv.includes('--autostart') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
  const startHidden = store.get('startMinimized') && startedAtLogin;
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: BG,
    ...WINDOW_CHROME,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // The window's own page is the title bar + splash/offline screen; the site lives in a view below the bar.
  win.loadFile(path.join(RENDERER, 'shell.html')).catch(() => {});
  win.once('ready-to-show', () => {
    if (store.get('window').maximized) win?.maximize();
    if (!startHidden) win?.show();
  });

  view = new WebContentsView({
    webPreferences: {
      session: siteSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  view.setBackgroundColor(BG);
  view.setVisible(false);
  win.contentView.addChildView(view);
  wireSiteView(view.webContents);

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(ev as 'resize', layout);
  }
  win.on('enter-full-screen', () => {
    // isMaximized() is already false here on some platforms, so remember it on the way in.
    maximizedBeforeFullScreen ||= win?.isMaximized() ?? false;
  });
  win.on('leave-full-screen', () => {
    if (maximizedBeforeFullScreen && !win?.isMaximized()) win?.maximize();
    maximizedBeforeFullScreen = false;
  });
  win.on('maximize', () => (maximizedBeforeFullScreen = false));
  win.on('close', (e) => {
    saveWindowState();
    if (!quitting && store.get('closeToTray')) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.on('before-input-event', onKey);
  layout();
}

function layout(): void {
  if (!win || !view) return;
  const { width, height } = win.getContentBounds();
  const top = htmlFullScreen || win.isFullScreen() ? 0 : TITLE_H;
  view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

function setShellState(patch: Partial<ShellState>): void {
  shellState = { ...shellState, ...patch };
  if (patch.kind !== 'error') delete shellState.message;
  win?.webContents.send('shell:state', shellState);
  view?.setVisible(shellState.kind === 'ready');
}

function retry(): void {
  setShellState({ kind: 'loading' });
  loadFailed = false;
  view?.webContents.loadURL(lastUrl).catch(() => {});
}

function wireSiteView(wc: WebContents): void {
  // ----- loading / offline -----
  wc.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) loadFailed = false;
  });
  wc.on('dom-ready', () => {
    if (loadFailed) return; // Chromium's own error page, keep ours on top
    lastUrl = wc.getURL();
    wc.setZoomFactor(store.get('zoom'));
    wc.insertCSS(siteCss()).catch(() => {});
    setShellState({ kind: 'ready' });
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (e.g. superseded by another navigation)
    loadFailed = true;
    lastUrl = url || lastUrl;
    setShellState({ kind: 'error', message: `${description} (${code})` });
  });
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    loadFailed = true;
    setShellState({ kind: 'error', message: `The page crashed (${d.reason}).` });
  });
  wc.on('page-title-updated', (_e, title) => {
    setShellState({ title });
    win?.setTitle(`${title} — AnimeOn Desktop`);
  });

  // ----- navigation & popups -----
  const guard = (e: Electron.Event<{ url: string; isMainFrame: boolean }>): void => {
    if (!e.isMainFrame || isAppUrl(e.url)) return;
    e.preventDefault();
    openExternal(e.url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url, referrer }) => {
    if (isAuthPopupUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: authPopupOptions() };
    if (isAppUrl(url)) {
      wc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    }
    // Links from the site itself (or noreferrer links) go to the browser; pop-ups from third-party
    // frames (e.g. ads inside a player iframe) are dropped. about:blank pop-ups are denied, which makes
    // the site fall back to a same-window navigation that the guard above routes correctly.
    const fromThirdParty = !!referrer.url && !isAppUrl(referrer.url);
    if (!fromThirdParty) openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => wireAuthPopup(child));

  // ----- video experience -----
  wc.on('enter-html-full-screen', () => {
    htmlFullScreen = true;
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    htmlFullScreen = false;
    layout();
  });
  // These fire for media in any frame (including the cross-origin player iframe), which a preload can't see.
  wc.on('media-started-playing', () => {
    if (sleepBlocker < 0) sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  });
  wc.on('media-paused', releaseSleepBlocker);
  wc.on('destroyed', releaseSleepBlocker);
  wc.on('zoom-changed', (_e, dir) => zoomBy(dir === 'in' ? ZOOM_STEP : -ZOOM_STEP));
  wc.on('before-input-event', onKey);
}

function releaseSleepBlocker(): void {
  // ponytail: one blocker for the whole view; a muted ad pausing while the episode plays would release it.
  if (sleepBlocker >= 0) powerSaveBlocker.stop(sleepBlocker);
  sleepBlocker = -1;
}

function authPopupOptions(): BrowserWindowConstructorOptions {
  return {
    width: 520,
    height: 680,
    parent: win,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { session: siteSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  };
}

function wireAuthPopup(child: BrowserWindow): void {
  child.setMenu(null);
  const wc = child.webContents;
  const guard = (e: Electron.Event<{ url: string; isMainFrame: boolean }>): void => {
    if (!e.isMainFrame || isAuthFlowUrl(e.url)) return;
    e.preventDefault();
    openExternal(e.url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url); // "Privacy policy" etc.
    return { action: 'deny' };
  });
}

// ---------- shortcuts & zoom ----------

function zoomBy(delta: number): void {
  setZoom(store.get('zoom') + delta);
}

function setZoom(z: number): void {
  const zoom = clampZoom(z);
  store.set('zoom', zoom);
  view?.webContents.setZoomFactor(zoom);
}

function reload(): void {
  if (shellState.kind === 'error') retry();
  else view?.webContents.reload();
}

function toggleFullScreen(): void {
  if (!win) return;
  if (htmlFullScreen) view?.webContents.executeJavaScript('document.exitFullscreen()', true).catch(() => {});
  else win.setFullScreen(!win.isFullScreen());
}

function goBack(): void {
  const nav = view?.webContents.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
}

function goForward(): void {
  const nav = view?.webContents.navigationHistory;
  if (nav?.canGoForward()) nav.goForward();
}

function onKey(e: Electron.Event, input: Electron.Input): void {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  let action: (() => void) | undefined;

  if (key === 'f11') action = toggleFullScreen;
  else if (key === 'escape' && win?.isFullScreen() && !htmlFullScreen) action = () => win?.setFullScreen(false);
  else if (key === 'f5' || (ctrl && key === 'r')) action = reload;
  else if ((input.alt && key === 'arrowleft') || (input.meta && key === '[')) action = goBack;
  else if ((input.alt && key === 'arrowright') || (input.meta && key === ']')) action = goForward;
  else if (ctrl && (key === '=' || key === '+')) action = () => zoomBy(ZOOM_STEP);
  else if (ctrl && key === '-') action = () => zoomBy(-ZOOM_STEP);
  else if (ctrl && key === '0') action = () => setZoom(store.get('defaultZoom'));
  else if (ctrl && key === ',') action = openSettings;
  else if (ctrl && key === 'q') action = quit;
  else if (isDev && ctrl && input.shift && key === 'i') action = () => view?.webContents.toggleDevTools();

  if (action) {
    e.preventDefault();
    action();
  }
}

// ---------- tray ----------

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (win?.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function createTray(): void {
  // The macOS menu bar wants a monochrome template image (the "Template" suffix lets it adapt to light/dark).
  tray = new Tray(isMac ? path.join(ASSETS, 'trayTemplate.png') : ICON);
  tray.setToolTip(APP_NAME);
  // Built on demand so checkbox states are always current.
  const popUp = (): void => tray?.popUpContextMenu(trayMenu());
  if (isMac) {
    tray.on('click', popUp); // macOS convention: clicking a menu bar item opens its menu
  } else {
    tray.on('click', toggleWindow);
    tray.on('right-click', popUp);
  }
}

function trayMenu(): Menu {
  const s = getSettings();
  return Menu.buildFromTemplate([
    { label: win?.isVisible() ? 'Hide' : 'Show', click: toggleWindow },
    { label: 'Reload', click: reload },
    { type: 'separator' },
    {
      label: 'Ad blocker',
      type: 'checkbox',
      checked: s.adblock,
      click: (m) => void applySetting('adblock', m.checked),
    },
    {
      label: LOGIN_LABEL,
      type: 'checkbox',
      checked: s.startWithWindows,
      click: (m) => void applySetting('startWithWindows', m.checked),
    },
    { label: 'Settings…', click: openSettings },
    { label: 'About', click: showAbout },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  ]);
}

function showAbout(): void {
  const opts = {
    type: 'info' as const,
    title: 'About',
    message: APP_NAME,
    detail: [
      `Version ${app.getVersion()}`,
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
      '',
      'Unofficial client, not affiliated with animeon.cc.',
      'All content belongs to its respective owners.',
    ].join('\n'),
    icon: nativeImage.createFromPath(ICON),
  };
  void (win?.isVisible() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

function macMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: 'About AnimeOn Desktop', click: showAbout },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit AnimeOn Desktop', accelerator: 'Cmd+Q', click: quit },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Cmd+R', click: reload },
        { label: 'Back', accelerator: 'Cmd+[', click: goBack },
        { label: 'Forward', accelerator: 'Cmd+]', click: goForward },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'Cmd+=', click: () => zoomBy(ZOOM_STEP) },
        { label: 'Zoom Out', accelerator: 'Cmd+-', click: () => zoomBy(-ZOOM_STEP) },
        { label: 'Actual Size', accelerator: 'Cmd+0', click: () => setZoom(store.get('defaultZoom')) },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'Ctrl+Cmd+F', click: toggleFullScreen },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

// ---------- settings ----------

function syncLoginItem(): void {
  if (!app.isPackaged) return; // in dev this would register electron.exe itself
  app.setLoginItemSettings({
    openAtLogin: store.get('startWithWindows'),
    // Windows only (ignored on macOS): the portable build runs from a temp dir, so register the real exe.
    path: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath,
    args: ['--autostart'],
  });
}

async function applySetting<K extends keyof Settings>(key: K, raw: unknown): Promise<Settings> {
  const value = sanitizeSetting(key, raw);
  store.set(key, value);
  switch (key) {
    case 'adblock':
    case 'adblockExceptions':
      await setAdblock(siteSession, store.get('adblock'), store.get('adblockExceptions'));
      break;
    case 'startWithWindows':
      syncLoginItem();
      break;
    case 'defaultZoom':
      setZoom(value as number);
      break;
  }
  settingsWin?.webContents.send('settings:changed', getSettings());
  return getSettings();
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 480,
    height: 780,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    title: 'Settings',
    icon: ICON,
    backgroundColor: BG,
    ...WINDOW_CHROME,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings.html')).catch(() => {});
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') settingsWin?.close();
  });
  settingsWin.on('closed', () => (settingsWin = undefined));
}

async function clearData(): Promise<boolean> {
  const parent = settingsWin ?? win;
  const opts = {
    type: 'warning' as const,
    buttons: ['Clear', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Clear cache and data',
    message: 'Clear cache, cookies and site data?',
    detail: 'You will be signed out of animeon.cc. Your app settings are kept.',
  };
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  if (response !== 0) return false;
  await siteSession.clearCache();
  await siteSession.clearStorageData();
  view?.webContents.loadURL(HOME).catch(() => {});
  return true;
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!isLocalSender(e)) throw new Error('Forbidden');
      return fn(...args);
    });
  };
  handle('shell:state', () => shellState);
  handle('settings:get', () => ({ settings: getSettings(), version: app.getVersion() }));
  handle('settings:set', (key, value) => applySetting(key as keyof Settings, value));
  handle('data:clear', clearData);
  handle('app:relaunch', () => {
    app.relaunch();
    quit();
  });
  ipcMain.on('shell:retry', (e) => {
    if (isLocalSender(e) && shellState.kind !== 'loading') retry();
  });
}
