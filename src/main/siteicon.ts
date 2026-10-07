import { app, nativeImage, type NativeImage, type Session } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// The site's own app icon (the one its web manifest offers for "install as app"). It is shown at runtime, the way
// a browser shows a favicon, and cached in the profile; it is never bundled into the published builds, which carry
// only the app's original icon.
const SITE_ICON_URL = 'https://animeon.cc/favicon-512.png';

export async function loadSiteIcon(ses: Session): Promise<NativeImage | undefined> {
  const file = path.join(app.getPath('userData'), 'site-icon.png');
  let buf = await fs.readFile(file).catch(() => undefined);
  if (!buf) {
    try {
      const res = await ses.fetch(SITE_ICON_URL, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(file, buf);
      }
    } catch {
      // offline or blocked: keep the app's own icon
    }
  }
  const img = buf ? nativeImage.createFromBuffer(buf) : undefined;
  return img && !img.isEmpty() ? img : undefined;
}
