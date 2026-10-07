// Generates the app's own icons (an original play-button design) with no dependencies: rasterises signed-distance
// shapes, encodes PNG via node:zlib and packs a multi-size PNG-in-ICO.
// The site's logo is never bundled; the running app shows it like a favicon (src/main/siteicon.ts).
//
// Output (assets/): icon.ico (Windows, 16–256), icon.png (512), icon-mac.png (1024, Apple grid padding),
// trayTemplate(.png|@2x.png) (macOS menu bar), logo.png (splash fallback).
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const TOP = [0x9b, 0x7b, 0xff];
const BOTTOM = [0x5a, 0x2f, 0xd6];
const SS = 4; // supersamples per axis

const sdRoundRect = (x, y, half, r) => {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

// Signed distance to a triangle (negative inside).
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

// Play triangle in unit space (-0.5..0.5), nudged right for optical centring; corners rounded by R.
const R = 0.035;
const TRI = [
  [-0.14 + R, -0.21 + R * 1.2],
  [-0.14 + R, 0.21 - R * 1.2],
  [0.23 - R * 1.6, 0],
];

// inset: empty margin per side (macOS icons sit inside a 1024 canvas with ~10% padding).
// template: black play glyph only, for the macOS menu bar (the OS recolours it for light/dark).
function render(size, { inset = 0, template = false } = {}) {
  const scale = template ? 1.9 : 1 / (1 - 2 * inset);
  const shift = template ? 0.045 : 0; // the glyph's visual centre sits right of the tile's
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size - 0.5) * (template ? 1 / scale : scale) + shift;
          const v = ((y + (sy + 0.5) / SS) / size - 0.5) * (template ? 1 / scale : scale);
          if (sdRoundRect(u, v, 0.5, 0.22) <= 0) bg++;
          if (sdTriangle(u, v, TRI) - R <= 0) fg++;
        }
      }
      const a = bg / (SS * SS);
      const f = fg / (SS * SS);
      const i = (y * size + x) * 4;
      if (template) {
        px[i + 3] = Math.round(255 * f); // RGB stays 0 (black)
        continue;
      }
      const t = (x + y) / (2 * size); // diagonal gradient
      for (let c = 0; c < 3; c++) {
        const base = TOP[c] + (BOTTOM[c] - TOP[c]) * t;
        px[i + c] = Math.round(base + (255 - base) * f);
      }
      px[i + 3] = Math.round(255 * a);
    }
  }
  return encodePng(size, px);
}

function encodePng(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
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
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map((s) => render(s));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/icon.ico', ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
writeFileSync('assets/icon.png', render(512));
writeFileSync('assets/icon-mac.png', render(1024, { inset: 0.1 })); // electron-builder turns this into .icns
writeFileSync('assets/trayTemplate.png', render(16, { template: true }));
writeFileSync('assets/trayTemplate@2x.png', render(32, { template: true }));
writeFileSync('assets/logo.png', render(128));
console.log('icons written to assets/');
