// Which src/ files can the shipped app actually load? Walks static imports, export-from, dynamic import('./x.js')
// with a literal path, and new URL('./x.js', import.meta.url) worker paths, starting from the runtime entry points.
// Used by tests/src-reachability.test.mjs (run C4): src/ must hold only what ships and runs.
import fs from 'node:fs';
import path from 'node:path';

export const RUNTIME_ENTRIES = Object.freeze(['src/index.js', 'src/researchCollector.js', 'src/networkMesh.js', 'desktop/main.cjs']);
const SPEC = [
  /\bimport\s+(?:[^'"()]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bexport\s+[^'"]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /new\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  // desktop/main.cjs names the scripts it spawns as path pieces: path.join(root, 'src', 'index.js').
  /['"]src['"]\s*,\s*['"]([A-Za-z0-9_./-]+\.m?js)['"]/g,
];

export function specifiers(source) {
  const out = new Set();
  for (const re of SPEC) for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

export function reachableFrom(root, entries = RUNTIME_ENTRIES) {
  const seen = new Set(), queue = entries.map(e => path.resolve(root, e)).filter(f => fs.existsSync(f));
  while (queue.length) {
    const file = queue.pop(); if (seen.has(file)) continue; seen.add(file);
    let src; try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const spec of specifiers(src)) {
      const base = /^[A-Za-z0-9_]/.test(spec) ? path.join(root, 'src', spec) : path.resolve(path.dirname(file), spec);
      for (const cand of [base, base + '.js', base + '.mjs']) if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { queue.push(cand); break; }
    }
  }
  return new Set([...seen].map(f => path.relative(root, f).split(path.sep).join('/')));
}

export function srcFiles(root) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) walk(p); else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p); } };
  walk('src');
  return out.sort();
}
