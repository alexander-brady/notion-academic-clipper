/**
 * Packs the extension into dist/notion-academic-clipper.zip, ready to upload
 * to the Chrome Web Store dashboard. Only the files Chrome needs are included;
 * no dependencies, so this works on a clean checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'notion-academic-clipper.zip');

// Everything the packed extension needs, and nothing else.
const INCLUDE_FILES = [
  'manifest.json',
  'src/background.js',
  'src/popup/index.html',
  'src/popup/popup.js',
  'src/options/index.html',
  'src/options/options.js',
  'src/styles/app.css'
];
const INCLUDE_DIRS = ['src/lib', 'icons'];

function crc32(buf) {
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** MS-DOS timestamp, as the ZIP local header expects. */
function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

function collect() {
  const files = [];
  for (const f of INCLUDE_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) files.push(f);
    else throw new Error(`Missing required file: ${f}`);
  }
  for (const dir of INCLUDE_DIRS) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isFile()) files.push(`${dir}/${entry.name}`);
    }
  }
  return files.sort();
}

function build(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of files) {
    const data = fs.readFileSync(path.join(ROOT, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Only use compression when it actually helps; tiny files can grow.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, day } = dosTime(fs.statSync(path.join(ROOT, name)).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

const files = collect();
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, build(files));

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
console.log(`Packed ${files.length} files (v${version}) -> ${path.relative(ROOT, OUT_FILE)}`);
console.log(`${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
