// Generates every app icon with no dependencies (PNG decode/encode via node:zlib, PNG-in-ICO packing).
//
// Artwork: the site's own app icon (the one its web manifest offers for "install as app"), downloaded at build
// time and cached in assets/ (git-ignored), so the repository never contains animeon.cc's logo. If the
// download fails, an original play-button design is used instead. `--refresh` re-downloads the logo.
//
// Output (assets/): icon.ico (Windows, 16–256), icon.png (512), icon-mac.png (1024, Apple grid padding),
// trayTemplate(.png|@2x.png) (macOS menu bar), logo.png (transparent mark for the title bar and splash).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const LOGO_URL = 'https://animeon.cc/favicon-512.png';
const LOGO_CACHE = 'assets/.site-logo.png';
const SS = 4; // supersamples per axis for shape edges

// ---------- PNG ----------

function encodePng(size, rgba, height = size) {
  const rows = Buffer.alloc((size * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes an 8-bit RGBA, non-interlaced PNG (what the site serves) to premultiplied floats. */
function decodePng(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA, non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (raw[line + x] + p) & 255;
    }
  }
  const f = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const al = px[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) f[i * 4 + c] = (px[i * 4 + c] / 255) * al;
    f[i * 4 + 3] = al;
  }
  return { w, h, f };
}

/** Premultiplied RGBA of the logo over the square [u0,u1)×[v0,v1) (0..1 logo space): box filter when
 *  shrinking, bilinear when enlarging. Transparent outside the logo. */
function sampleLogo(logo, u0, v0, u1, v1) {
  const { w, h, f } = logo;
  const out = [0, 0, 0, 0];
  const x0 = u0 * w;
  const x1 = u1 * w;
  const y0 = v0 * h;
  const y1 = v1 * h;
  if (x1 - x0 >= 1.5) {
    let n = 0;
    for (let y = Math.ceil(y0 - 0.5); y < y1 - 0.5; y++) {
      for (let x = Math.ceil(x0 - 0.5); x < x1 - 0.5; x++) {
        n++;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        for (let c = 0; c < 4; c++) out[c] += f[(y * w + x) * 4 + c];
      }
    }
    return out.map((v) => v / Math.max(n, 1));
  }
  const cx = (x0 + x1) / 2 - 0.5;
  const cy = (y0 + y1) / 2 - 0.5;
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const x = ix + dx;
    const y = iy + dy;
    const wt = (1 - Math.abs(cx - x)) * (1 - Math.abs(cy - y));
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    for (let c = 0; c < 4; c++) out[c] += f[(y * w + x) * 4 + c] * wt;
  }
  return out;
}

// ---------- shapes ----------

const sdRoundRect = (x, y, half, r) => {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

function sdTriangle(px, py, pts) {
  let d = Infinity;
  let inside = true;
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % 3];
    const ex = bx - ax;
    const ey = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    if (ex * wy - ey * wx > 0) inside = false; // vertices are listed clockwise (y down)
  }
  return inside ? -d : d;
}

// Fallback play glyph in unit space (-0.5..0.5), corners rounded by R.
const R = 0.035;
const TRI = [
  [-0.14 + R, -0.21 + R * 1.2],
  [-0.14 + R, 0.21 - R * 1.2],
  [0.23 - R * 1.6, 0],
];
const playGlyph = (u, v) => (sdTriangle(u, v, TRI) - R <= 0 ? 1 : 0);

// ---------- compositions ----------

/**
 * Rounded tile with the mark on it.
 * inset: empty margin per side (macOS icons sit in a 1024 canvas with ~10% padding).
 * tile=false: the mark alone on transparency. template=true: black-only mark (macOS menu bar).
 */
function render(size, logo, { inset = 0, tile = true, template = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const span = 1 - 2 * inset; // tile size as a fraction of the canvas
  const markPad = tile ? 0.06 : 0; // breathing room between tile edge and the logo
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // tile coverage + fallback glyph coverage via supersampling
      let cover = 0;
      let glyph = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size - 0.5) / span;
          const v = ((y + (sy + 0.5) / SS) / size - 0.5) / span;
          if (sdRoundRect(u, v, 0.5, 0.22) <= 0) cover++;
          if (!logo) glyph += template ? playGlyph(u / 1.9 + 0.045, v / 1.9) : playGlyph(u, v);
        }
      }
      cover /= SS * SS;
      glyph /= SS * SS;

      // the mark, premultiplied
      let m;
      if (logo) {
        const toLogo = (p) => (p / size - 0.5) / span / (1 - 2 * markPad) + 0.5;
        m = sampleLogo(logo, toLogo(x), toLogo(y), toLogo(x + 1), toLogo(y + 1));
      } else {
        m = [glyph, glyph, glyph, glyph]; // white glyph
      }

      const i = (y * size + x) * 4;
      if (template) {
        // keep the dark line-art (outlines, face), drop the light fill: the OS tints it for light/dark bars
        const lum = m[3] > 0 ? (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / m[3] : 1;
        const a = logo ? Math.min(1, m[3] * (1 - lum) * 1.4) : m[3];
        px[i + 3] = Math.round(255 * a);
        continue;
      }
      if (!tile) {
        const a = m[3];
        for (let c = 0; c < 3; c++) px[i + c] = a > 0 ? Math.round((255 * m[c]) / a) : 0;
        px[i + 3] = Math.round(255 * a);
        continue;
      }
      // tile: the site's dark surface for the logo, violet gradient for the fallback glyph
      const t = (x + y) / (2 * size);
      const top = logo ? [0x24, 0x20, 0x2e] : [0x9b, 0x7b, 0xff];
      const bottom = logo ? [0x0a, 0x0a, 0x0c] : [0x5a, 0x2f, 0xd6];
      for (let c = 0; c < 3; c++) {
        const base = (top[c] + (bottom[c] - top[c]) * t) / 255;
        px[i + c] = Math.round(255 * (m[c] + base * (1 - m[3])));
      }
      px[i + 3] = Math.round(255 * cover);
    }
  }
  return encodePng(size, px);
}

/** Android TV launcher banner (16:9): the logo centred on the site's dark surface. */
function renderBanner(w, h, logo) {
  const px = Buffer.alloc(w * h * 4);
  const side = h * 0.78;
  const left = (w - side) / 2;
  const top = (h - side) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const bg = [0x1c, 0x19, 0x26].map((c, i) => c + ([0x0a, 0x0a, 0x0c][i] - c) * t);
      const g = playGlyph((x - w / 2) / side, (y - h / 2) / side);
      const m = logo
        ? sampleLogo(logo, (x - left) / side, (y - top) / side, (x + 1 - left) / side, (y + 1 - top) / side)
        : [g, g, g, g];
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(m[c] * 255 + bg[c] * (1 - m[3]));
      px[i + 3] = 255;
    }
  }
  return encodePng(w, px, h);
}

function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([s, data], i) => {
    const e = 6 + i * 16;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(([, d]) => d)]);
}

// ---------- main ----------

async function loadLogo() {
  if (!existsSync(LOGO_CACHE) || process.argv.includes('--refresh')) {
    try {
      const res = await fetch(LOGO_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(LOGO_CACHE, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`could not download ${LOGO_URL} (${err.message}); using the built-in play icon`);
      return null;
    }
  }
  try {
    return decodePng(readFileSync(LOGO_CACHE));
  } catch (err) {
    console.warn(`unusable logo (${err.message}); using the built-in play icon`);
    return null;
  }
}

mkdirSync('assets', { recursive: true });
const logo = await loadLogo();
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
writeFileSync('assets/icon.ico', ico(icoSizes.map((s) => [s, render(s, logo)])));
writeFileSync('assets/icon.png', render(512, logo));
writeFileSync('assets/icon-mac.png', render(1024, logo, { inset: 0.1 })); // electron-builder turns this into .icns
writeFileSync('assets/trayTemplate.png', render(16, logo, { tile: false, template: true }));
writeFileSync('assets/trayTemplate@2x.png', render(32, logo, { tile: false, template: true }));
writeFileSync('assets/logo.png', logo ? render(128, logo, { tile: false }) : render(128, null));
// Android TV app (tv/): generated into its res folder, git-ignored like the rest of the logo-based output.
const res = 'tv/app/src/main/res';
mkdirSync(`${res}/mipmap-xxxhdpi`, { recursive: true });
mkdirSync(`${res}/drawable-xhdpi`, { recursive: true });
writeFileSync(`${res}/mipmap-xxxhdpi/ic_launcher.png`, render(192, logo));
writeFileSync(`${res}/drawable-xhdpi/banner.png`, renderBanner(640, 360, logo));
console.log(`icons written to assets/ (${logo ? 'site logo' : 'built-in play icon'})`);
