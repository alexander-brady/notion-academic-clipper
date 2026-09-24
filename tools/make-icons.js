// Generates the extension icons as real PNGs (no image deps).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const SS = 4; // supersampling factor for antialiasing

const ACCENT = [47, 111, 228];
const ACCENT_DARK = [30, 80, 180];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c;
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- shape tests, all in a 0..1 unit square -------------------------------

const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// A bookmark: rectangle with a notch cut out of the bottom edge.
function inBookmark(x, y) {
  const x0 = 0.3,
    x1 = 0.7,
    y0 = 0.2,
    y1 = 0.8;
  if (!inRoundedRect(x, y, x0, y0, x1, y1, 0.045)) return false;
  const notchTop = 0.575;
  if (y > notchTop) {
    const t = (y - notchTop) / (y1 - notchTop);
    const halfWidth = ((x1 - x0) / 2) * t;
    const cx = (x0 + x1) / 2;
    if (Math.abs(x - cx) < halfWidth) return false; // carved-out V
  }
  return true;
}

function render(size) {
  const w = size * SS;
  const px = Buffer.alloc(w * w * 4);

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / w;
      const i = (y * w + x) * 4;

      if (!inRoundedRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22)) continue;

      // Subtle vertical gradient on the tile.
      const g = v;
      const base = [
        Math.round(ACCENT[0] * (1 - g) + ACCENT_DARK[0] * g),
        Math.round(ACCENT[1] * (1 - g) + ACCENT_DARK[1] * g),
        Math.round(ACCENT[2] * (1 - g) + ACCENT_DARK[2] * g)
      ];
      const colour = inBookmark(u, v) ? WHITE : base;

      px[i] = colour[0];
      px[i + 1] = colour[1];
      px[i + 2] = colour[2];
      px[i + 3] = 255;
    }
  }

  // Box-filter down to the target size, which gives us antialiased edges.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * w + (x * SS + dx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha;
          g += px[i + 1] * alpha;
          b += px[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, size, out);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}
