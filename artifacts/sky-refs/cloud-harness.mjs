// Node harness for cloud-gen.js: generates sprites, writes PNGs, times generation.
// Usage:
//   node cloud-harness.mjs layout <layout.json> <outDir>   (sprites for the Python composite)
//   node cloud-harness.mjs bench [screenCssWidth] [dpr]     (timing at the real sprite sizes)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Evaluate as a classic script in the main realm (a vm context makes global
// lookups like Math.* far slower than a browser would).
new Function(fs.readFileSync(path.join(here, 'cloud-gen.js'), 'utf8'))();
const { makeCumulus, makeCirrus } = globalThis.MPOClouds;

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gen(spec) {
  const fn = spec.type === 'cirrus' ? makeCirrus : makeCumulus;
  const t0 = performance.now();
  const img = fn(spec.seed, spec.w, spec.h, spec.opt || {});
  return { img, ms: performance.now() - t0 };
}

const [mode = 'bench', a1, a2] = process.argv.slice(2);
if (mode === 'layout') {
  const layout = JSON.parse(fs.readFileSync(a1, 'utf8'));
  fs.mkdirSync(a2, { recursive: true });
  for (const spec of layout) {
    const { img, ms } = gen(spec);
    fs.writeFileSync(path.join(a2, `${spec.name}.png`), encodePng(img.width, img.height, img.data));
    console.log(`${spec.name} ${spec.type} ${img.width}x${img.height} ${ms.toFixed(1)} ms`);
  }
} else {
  // Real app sizing: displayed width (vw) x screen CSS width x dpr x 0.5, cap 1024.
  const cssW = Number(a1) || 1920, dpr = Number(a2) || 1;
  const set = [
    ['cumulus', 32, 2.3], ['cumulus', 28, 2.2], ['cumulus', 22, 2.4],
    ['cumulus', 16, 2.4], ['cumulus', 13, 2.5], ['cumulus', 11, 2.5],
    ['cirrus', 40, 4.5], ['cirrus', 30, 4.5],
  ];
  // Pass 1 = cold (what the first launch pays: JIT not warmed); passes 2-6 = warm.
  const REPS = 6, times = set.map(() => []), sizes = [];
  for (let rep = 0; rep < REPS; rep++) {
    set.forEach(([type, vw, aspect], i) => {
      const w = Math.min(1024, Math.round(cssW * vw / 100 * dpr * 0.5));
      const h = Math.round(w / aspect);
      sizes[i] = `${w}x${h}`;
      times[i].push(gen({ type, seed: 1000 + i * 7919 + rep, w, h }).ms);
    });
  }
  const med = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];
  let cold = 0, warm = 0;
  set.forEach(([type, vw], i) => {
    const m = med(times[i].slice(1));
    cold += times[i][0]; warm += m;
    console.log(`${type.padEnd(7)} ${String(vw).padStart(2)}vw -> ${sizes[i].padEnd(8)} cold ${times[i][0].toFixed(1).padStart(6)} ms  warm ${m.toFixed(1).padStart(6)} ms`);
  });
  console.log(`total cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms @ ${cssW}css x dpr ${dpr}`);
}
