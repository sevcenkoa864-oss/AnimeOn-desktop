import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { app, type Session } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { imageRedirect } from './imageproxy.js';

const CACHE_MAX_AGE = 7 * 24 * 3600 * 1000;
let blocker: Promise<ElectronBlocker> | undefined;
let active: ElectronBlocker | undefined; // the loaded engine, for the synchronous request hook
let appliedFilters: string[] = [];

/** A per-domain exception: never block requests to the host, nor anything a page/frame on that host loads. */
const exceptionFilters = (hosts: string[]): string[] => hosts.flatMap((h) => [`@@||${h}^`, `@@*$domain=${h}`]);

async function load(): Promise<ElectronBlocker> {
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  // Refresh the prebuilt EasyList/EasyPrivacy engine weekly.
  const stat = await fs.stat(cache).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs > CACHE_MAX_AGE) await fs.rm(cache, { force: true });
  return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: cache,
    read: fs.readFile,
    write: fs.writeFile,
  });
}

function setExceptions(b: ElectronBlocker, hosts: string[]): void {
  const next = exceptionFilters(hosts);
  const added = next.filter((f) => !appliedFilters.includes(f));
  const removed = appliedFilters.filter((f) => !next.includes(f));
  if (added.length || removed.length) b.updateFromDiff({ added, removed });
  appliedFilters = next;
}

/**
 * Electron allows a single onBeforeRequest listener per session. Ghostery installs its own when blocking is
 * enabled and clears it when disabled, so after every change we install one combined listener: image
 * redirects for blocked hosts (see imageproxy.ts) first, then the ad blocker.
 */
function installRequestHandler(ses: Session): void {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const redirectURL = imageRedirect(details.url, details.resourceType);
    if (redirectURL) callback({ redirectURL });
    else if (active?.isBlockingEnabled(ses)) active.onBeforeRequest(details, callback);
    else callback({});
  });
}

/** Turns blocking on/off for a session. Never throws: a failed list download just leaves blocking off. */
export async function setAdblock(ses: Session, enabled: boolean, exceptions: string[]): Promise<void> {
  try {
    if (!enabled) {
      if (active?.isBlockingEnabled(ses)) active.disableBlockingInSession(ses);
      return;
    }
    blocker ??= load();
    active = await blocker;
    setExceptions(active, exceptions);
    if (!active.isBlockingEnabled(ses)) active.enableBlockingInSession(ses);
  } catch (err) {
    blocker = undefined; // retry the download next time
    console.error('[adblock] unavailable:', err);
  } finally {
    installRequestHandler(ses);
  }
}
