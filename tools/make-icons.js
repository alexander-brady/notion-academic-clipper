// Generates the extension icons from icons/clip.svg as real PNGs, with no
// image dependencies.
//
// Chrome will not accept an SVG for a manifest or toolbar icon, so the SVG is
// the source and these PNGs are the build output. Only the subset of path
// syntax that file actually uses is understood; anything else raises rather
// than quietly drawing the wrong shape.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const SS = 4; // supersampling factor for antialiasing

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

// --- the path, read from the SVG ------------------------------------------

const SVG = fs.readFileSync(new URL('../icons/clip.svg', import.meta.url), 'utf8');

function attr(name) {
  const found = SVG.match(new RegExp(name + '="([^"]+)"'));
  if (!found) throw new Error(`icons/clip.svg has no ${name}`);
  return found[1];
}

const STROKE = parseFloat(attr('stroke-width'));
const VIEWBOX = parseFloat(attr('viewBox').split(/[\s,]+/)[2]);

/** The clip alone on a transparent background: no tile, no border. */
const INK = (() => {
  const hex = attr('stroke').replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`unsupported stroke colour "${attr('stroke')}"`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
})();

/**
 * Parses the `m` / `l` / `a` subset of SVG path data into segments and arcs.
 * Everything in this icon is a straight run or a circular arc, so that is all
 * that is supported.
 */
function parsePath(d) {
  // Numbers first, so the `e` of an exponent is never taken for a command.
  const tokens = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?|[a-z]/gi) || [];
  const nodes = [];
  const segments = [];
  const arcs = [];

  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  const next = () => parseFloat(tokens[i++]);
  const push = (nx, ny) => nodes.push([nx, ny]) - 1;

  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    const relative = cmd === cmd.toLowerCase();
    const step = (dx, dy) => {
      x = relative ? x + dx : dx;
      y = relative ? y + dy : dy;
    };

    switch (cmd.toLowerCase()) {
      case 'm': {
        step(next(), next());
        push(x, y);
        // Further pairs after a moveto are an implicit lineto.
        cmd = relative ? 'l' : 'L';
        break;
      }
      case 'l': {
        const from = nodes.length - 1;
        step(next(), next());
        segments.push([from, push(x, y)]);
        break;
      }
      case 'a': {
        const rx = next();
        const ry = next();
        next(); // x-axis rotation, always 0 here
        next(); // large-arc flag
        const sweep = next();
        const from = nodes.length - 1;
        step(next(), next());
        if (Math.abs(rx - ry) > 1e-6) throw new Error('only circular arcs are supported');
        arcs.push({ from, to: push(x, y), r: rx, sweep });
        break;
      }
      default:
        throw new Error(`unsupported path command "${cmd}"`);
    }
  }
  return { nodes, segments, arcs };
}

const { nodes: NODES, segments: SEGMENTS, arcs: ARCS } = parsePath(attr('d'));

/*
 * Every arc in this path has a chord equal to its diameter, so each one is a
 * plain semicircle centred on the midpoint of its endpoints. That is what lets
 * the wire be built from two primitives instead of a general path rasteriser,
 * so it is checked rather than assumed.
 */
const SWEEPS = ARCS.map(({ from, to, r, sweep }) => {
  const [ax, ay] = NODES[from];
  const [bx, by] = NODES[to];
  const chord = Math.hypot(bx - ax, by - ay);
  if (Math.abs(chord - 2 * r) > 0.05) {
    throw new Error(`an arc of radius ${r} spans ${chord.toFixed(2)}, so it is not a semicircle`);
  }

  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const start = Math.atan2(ay - cy, ax - cx);
  // With y pointing down, sweep-flag 1 is the increasing direction.
  return sweep
    ? { cx, cy, r, a0: start, a1: start + Math.PI }
    : { cx, cy, r, a0: start - Math.PI, a1: start };
});

// --- rasterising ----------------------------------------------------------

/** Distance from a point to a line segment. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance to an arc, measured to the nearer endpoint outside the sweep. */
function distToArc(px, py, cx, cy, r, a0, a1) {
  const TAU = Math.PI * 2;
  let offset = Math.atan2(py - cy, px - cx) - a0;
  while (offset < 0) offset += TAU;
  while (offset >= TAU) offset -= TAU;
  if (offset <= a1 - a0) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  return Math.min(
    Math.hypot(px - (cx + r * Math.cos(a0)), py - (cy + r * Math.sin(a0))),
    Math.hypot(px - (cx + r * Math.cos(a1)), py - (cy + r * Math.sin(a1)))
  );
}

/** Distance to the wire, in SVG units. Round caps come free from the metric. */
function distToClip(u, v) {
  let d = Infinity;
  for (const [a, b] of SEGMENTS) {
    d = Math.min(d, distToSegment(u, v, NODES[a][0], NODES[a][1], NODES[b][0], NODES[b][1]));
  }
  for (const arc of SWEEPS) {
    d = Math.min(d, distToArc(u, v, arc.cx, arc.cy, arc.r, arc.a0, arc.a1));
  }
  return d;
}

/*
 * Fit the stroked path to the canvas. The path is not centred in its own
 * viewBox, so the bounds are measured rather than assumed.
 */
const FIT = (() => {
  const STEPS = 240;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < STEPS; i++) {
    for (let j = 0; j < STEPS; j++) {
      const u = ((i + 0.5) / STEPS) * VIEWBOX;
      const v = ((j + 0.5) / STEPS) * VIEWBOX;
      if (distToClip(u, v) > STROKE / 2) continue;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const EXTENT = 0.88; // of the canvas; there is no tile to inset from
  const scale = EXTENT / Math.max(maxU - minU, maxV - minV);
  return { scale, cu: (minU + maxU) / 2, cv: (minV + maxV) / 2 };
})();

function inPaperclip(x, y) {
  const u = (x - 0.5) / FIT.scale + FIT.cu;
  const v = (y - 0.5) / FIT.scale + FIT.cv;
  return distToClip(u, v) <= STROKE / 2;
}

function render(size) {
  const w = size * SS;
  const px = Buffer.alloc(w * w * 4);

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / w;
      const i = (y * w + x) * 4;

      // Everything that is not wire stays fully transparent.
      if (!inPaperclip(u, v)) continue;

      px[i] = INK[0];
      px[i + 1] = INK[1];
      px[i + 2] = INK[2];
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
