import { app, Notification, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { isNewerVersion } from './version.js';

// Updates come from this repository's GitHub Releases (published by .github/workflows/build.yml on version tags).
// - Windows (installed): electron-updater downloads the new version in the background, differentially via the
//   release's .blockmap files, and installs it when the app quits (or right away from the tray).
// - macOS and the portable exe can't replace themselves (macOS requires a paid Apple signature for that), so they
//   only announce the new version and link to the release.
const REPO = 'sevcenkoa864-oss/AnimeOn-desktop';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY = 4 * 3600 * 1000;

export type UpdateState = { kind: 'none' } | { kind: 'ready' | 'available'; version: string };

let state: UpdateState = { kind: 'none' };
let icon = '';

const selfUpdating = (): boolean => process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;

export const updateState = (): UpdateState => state;

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon });
  if (onClick) n.on('click', onClick);
  n.show();
}

/** Starts background checks (packaged builds only). */
export function startUpdater(notificationIcon: string): void {
  if (!app.isPackaged) return;
  icon = notificationIcon;
  if (selfUpdating()) {
    const { autoUpdater } = electronUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', ({ version }) => {
      state = { kind: 'ready', version };
      notify(`Update ${version} is ready`, 'It installs when you quit the app, or now from the tray menu.');
    });
    autoUpdater.on('error', (err) => console.error('[updater]', err));
  }
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), CHECK_EVERY);
}

/** `manual`: started from a menu, so also say when there's nothing new. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) return;
  try {
    if (selfUpdating()) {
      const result = await electronUpdater.autoUpdater.checkForUpdates();
      const latest = result?.updateInfo.version;
      if (manual && !(latest && isNewerVersion(latest, app.getVersion()))) {
        notify('AnimeOn Desktop is up to date', `Version ${app.getVersion()}`);
      } else if (manual && state.kind !== 'ready') {
        notify(`Downloading update ${latest}`, 'You will be told when it is ready.');
      }
      return;
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const latest = ((await res.json()) as { tag_name: string }).tag_name.replace(/^v/, '');
    if (!isNewerVersion(latest, app.getVersion())) {
      if (manual) notify('AnimeOn Desktop is up to date', `Version ${app.getVersion()}`);
      return;
    }
    if (state.kind !== 'available' || state.version !== latest || manual) {
      state = { kind: 'available', version: latest };
      notify(`AnimeOn Desktop ${latest} is out`, 'Click to download it.', openReleasePage);
    }
  } catch (err) {
    console.error('[updater] check failed', err);
    if (manual) notify("Couldn't check for updates", 'Check your connection and try again.');
  }
}

/** Quits, installs the downloaded update silently and starts the new version. */
export function installUpdate(): void {
  electronUpdater.autoUpdater.quitAndInstall(true, true);
}

export function openReleasePage(): void {
  void shell.openExternal(RELEASES_URL);
}
