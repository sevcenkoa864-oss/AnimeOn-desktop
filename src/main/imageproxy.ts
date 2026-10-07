import type { Session } from 'electron';

// Russian CDNs the site loads most posters from. From some countries they don't answer at all (Ukraine blocks
// Russian services) or only intermittently (seen with the Selectel CDN: DNS stalls, then works). Image requests to
// a host that has failed here get redirected to wsrv.nl, a free open-source image proxy/cache, which fetches them
// from outside. A host is marked by the startup probe or by a real failed image load, and the mark is kept
// (persisted by the caller): an extra hop is cheap, broken posters are not.
const CANDIDATES = ['ab18cf62-4b99-4613-a8c1-c801eda74545.selcdn.net', 'st.kp.yandex.net'];
const PROBE_TIMEOUT = 5000;

let enabled = true;
let blocked = new Set<string>();

export function configureImageProxy(on: boolean, blockedHosts: string[]): void {
  enabled = on;
  blocked = new Set(blockedHosts);
}

/** The wsrv.nl URL for an image on an unreachable host, otherwise undefined. */
export function imageRedirect(url: string, resourceType: string): string | undefined {
  if (!enabled || resourceType !== 'image' || blocked.size === 0) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return blocked.has(host) ? `https://wsrv.nl/?url=${encodeURIComponent(url)}` : undefined;
}

export const blockedHosts = (): string[] => [...blocked];

/** For a failed request: marks its host blocked and returns true if it's a candidate not marked before. */
export function noteFailure(url: string, resourceType: string, error: string): boolean {
  if (resourceType !== 'image' || /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(error)) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (!CANDIDATES.includes(host) || blocked.has(host)) return false;
  blocked.add(host);
  return true;
}

/** Candidate hosts that don't answer from this network (any HTTP response counts as reachable). */
export async function probeBlockedHosts(ses: Session): Promise<string[]> {
  const results = await Promise.all(
    CANDIDATES.map(async (host) => {
      try {
        await ses.fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT) });
        return null;
      } catch {
        return host;
      }
    }),
  );
  return results.filter((h): h is string => h !== null);
}
