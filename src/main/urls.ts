// URL policy: what stays in the app, what opens as an auth popup, what goes to the system browser.
// Domain lists come from the site's CSP and the research in NOTES.md.

export const HOME = 'https://animeon.cc/';

/** Top-level pages that load inside the main window. */
const APP_HOSTS = ['animeon.cc'];
/** window.open() targets that open as an in-app child window (Google Sign-In popup). */
const AUTH_POPUP_HOSTS = ['accounts.google.com'];
/** Hosts the auth popup may navigate through (Google sets cookies via youtube.com redirects). */
const AUTH_FLOW_HOSTS = [...APP_HOSTS, 'google.com', 'youtube.com', 'gstatic.com'];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostIn(url: string, hosts: string[]): boolean {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

export const isAppUrl = (url: string): boolean => hostIn(url, APP_HOSTS);
export const isAuthPopupUrl = (url: string): boolean => hostIn(url, AUTH_POPUP_HOSTS);
export const isAuthFlowUrl = (url: string): boolean => hostIn(url, AUTH_FLOW_HOSTS);

/** Only plain web links may be handed to shell.openExternal. */
export function isWebUrl(url: string): boolean {
  const u = parse(url);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:');
}

/** Exactly what desktop Chrome sends (reduced UA), with no "Electron" or app name tokens. */
export function chromeUserAgent(platform: string, chromeVersion: string): string {
  const os =
    platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  const major = chromeVersion.split('.')[0];
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Normalises a user-typed ad-block exception ("https://x.com/a" or "x.com") to a bare hostname. */
export function toHostname(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const host = parse(s.includes('://') ? s : 'https://' + s)?.hostname;
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}
