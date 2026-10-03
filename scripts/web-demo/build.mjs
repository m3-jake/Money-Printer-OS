// Builds the browser-only Money Printer OS web demo into web-demo/dist/ (plain static files, any host).
//
//   node scripts/web-demo/build.mjs        (MPO_WEB_DEMO_FIXTURES / MPO_WEB_DEMO_OUT override the paths, for tests)
//
// It copies the real HUD (public/), makes its asset paths relative so it works from any sub-folder,
// and loads web-demo/demo-shim.js first, which answers /api/* from web-demo/fixtures.json (recorded by
// record.mjs). Fixtures are scrubbed of local paths, and the project journal (git history) is left out.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.resolve(process.env.MPO_WEB_DEMO_OUT || path.join(ROOT, 'web-demo', 'dist'));
const fixtures = JSON.parse(fs.readFileSync(process.env.MPO_WEB_DEMO_FIXTURES || path.join(ROOT, 'web-demo', 'fixtures.json'), 'utf8'));

fs.rmSync(OUT, { recursive: true, force: true });
for (const dir of ['assets', 'js', 'css']) fs.cpSync(path.join(PUBLIC, dir), path.join(OUT, dir), { recursive: true });
// Top-level assets no page, script or stylesheet names (desktop-only art, the 4K wallpaper) stay out of the upload.
const source = ['dashboard.html', 'quant-research.html'].map(f => path.join(PUBLIC, f))
  .concat(...['js', 'css'].map(d => fs.readdirSync(path.join(PUBLIC, d)).map(f => path.join(PUBLIC, d, f))))
  .map(f => fs.readFileSync(f, 'utf8')).join('\n');
// Pages serves static CSS/JS with a browser cache. Change their URLs whenever the demo changes.
const assetVersion = createHash('sha256').update(source)
  .update(fs.readFileSync(path.join(ROOT, 'web-demo', 'mobile.css')))
  .update(fs.readFileSync(path.join(ROOT, 'web-demo', 'mobile.js')))
  .update(fs.readFileSync(path.join(ROOT, 'web-demo', 'demo-shim.js')))
  .update(JSON.stringify(fixtures)).digest('hex').slice(0, 12);
for (const e of fs.readdirSync(path.join(OUT, 'assets'), { withFileTypes: true }))
  if (e.isFile() && !source.includes(e.name)) fs.rmSync(path.join(OUT, 'assets', e.name));

// Absolute /assets/, /js/ and /css/ paths become relative; /api/ stays absolute because the shim keys on it.
const relative = (text, prefix) => text.replace(/(["'`(])\/(assets|js|css)\//g, `$1${prefix}$2/`);
const shimTags = '<script src="demo-data.js"></script>\n<script src="demo-shim.js"></script>\n';
const page = (file, edit) => {
  let html = relative(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), '');
  html = edit(html).replace('<title>', shimTags + '<title>');
  if (file === 'dashboard.html') {
    html = html.replace('</head>', '<link rel="stylesheet" href="mobile.css">\n</head>');
    html = html.replace('</body>', '<script src="mobile.js"></script>\n</body>');
  }
  if (!html.includes(shimTags)) throw new Error(`${file}: no <title> to inject the demo shim before`);
  html = html.replace(/\b(href|src)="((?:css|js)\/[^"?]+|(?:mobile|demo-data|demo-shim)\.(?:css|js))"/g,
    (_, attr, url) => `${attr}="${url}?v=${assetVersion}"`);
  return html;
};
fs.writeFileSync(path.join(OUT, 'index.html'), page('dashboard.html', h => h.split('href="/quant-research"').join('href="quant-research.html"')));
fs.writeFileSync(path.join(OUT, 'quant-research.html'), page('quant-research.html', h => h.split('href="/"').join('href="index.html"')));
for (const file of fs.readdirSync(path.join(OUT, 'js'))) {
  const f = path.join(OUT, 'js', file);
  fs.writeFileSync(f, relative(fs.readFileSync(f, 'utf8'), ''));
}
for (const file of fs.readdirSync(path.join(OUT, 'css'))) {
  const f = path.join(OUT, 'css', file);
  fs.writeFileSync(f, relative(fs.readFileSync(f, 'utf8'), '../'));
}
fs.copyFileSync(path.join(ROOT, 'web-demo', 'demo-shim.js'), path.join(OUT, 'demo-shim.js'));
fs.copyFileSync(path.join(ROOT, 'web-demo', 'mobile.css'), path.join(OUT, 'mobile.css'));
fs.copyFileSync(path.join(ROOT, 'web-demo', 'mobile.js'), path.join(OUT, 'mobile.js'));

// Scrub machine paths and the user name out of every recorded body.
const secrets = [ROOT, os.homedir(), os.tmpdir(), os.userInfo().username]
  .flatMap(p => [p, p.split('\\').join('\\\\'), p.split('\\').join('/')]).filter(p => p && p.length > 2)
  .sort((a, b) => b.length - a.length);
const scrub = value => {
  let text = JSON.stringify(value);
  for (const s of secrets) text = text.split(JSON.stringify(s).slice(1, -1)).join('demo');
  return JSON.parse(text);
};
const responses = {};
for (const [key, r] of Object.entries(fixtures.responses)) {
  if (key.startsWith('/api/project-journal')) continue;
  responses[key] = { status: r.status, at: r.at, body: scrub(r.body) };
}
responses['/api/project-journal'] = { status: 200, at: Date.parse(fixtures.recordedAt), body: { ok: true, entries: [], demo: true } };

// Frames: the first body in full, then only what changed, so a long timeline stays small. demo-shim.js
// applyDiff() reads this format: {key: diff} with {$del: 1} for a removed key, {$replace: value},
// {$arr: n, add: [...]} for "drop n from the front, append these", and {$len, $set: {index: diff}}.
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const enc = v => JSON.stringify(v);
function diff(a, b) {
  if (enc(a) === enc(b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) return arrayDiff(a, b);
  if (!isObj(a) || !isObj(b)) return b && typeof b === 'object' ? { $replace: b } : b;
  const out = {};
  for (const k of Object.keys(b)) { const d = diff(a[k], b[k]); if (d !== undefined) out[k] = d; }
  for (const k of Object.keys(a)) if (!(k in b)) out[k] = { $del: 1 };
  return out;
}
function arrayDiff(a, b) {
  const sa = a.map(enc), sb = b.map(enc), options = [{ $replace: b }];
  for (let from = Math.max(0, sa.length - sb.length); from < sa.length; from++) {
    if (sa.slice(from).every((s, i) => s === sb[i])) { options.push({ $arr: from, add: b.slice(sa.length - from) }); break; }
  }
  const set = {};
  sb.forEach((s, i) => { if (s !== sa[i]) set[i] = diff(a[i], b[i]); });
  options.push({ $len: b.length, $set: set });
  return options.reduce((best, o) => enc(o).length < enc(best).length ? o : best);
}
// Same as applyDiff() in demo-shim.js; used to prove every frame round-trips before anything is written.
function apply(base, d) {
  if (d === undefined) return base;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return d;
  if ('$replace' in d) return d.$replace;
  if ('$arr' in d) return (Array.isArray(base) ? base.slice(d.$arr) : []).concat(d.add);
  if ('$len' in d) { const out = (Array.isArray(base) ? base : []).slice(0, d.$len); for (const i in d.$set) out[i] = apply(out[i], d.$set[i]); return out; }
  const out = isObj(base) ? { ...base } : {};
  for (const k in d) { if (d[k] && d[k].$del === 1) delete out[k]; else out[k] = apply(out[k], d[k]); }
  return out;
}
// Key order can differ after a merge; values may not.
const canon = v => Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const same = (x, y) => enc(canon(x)) === enc(canon(y));
const firstDifference = (x, y, at = '') => {
  if (same(x, y)) return null;
  if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return `${at || '(root)'}: ${enc(x)?.slice(0, 120)} vs ${enc(y)?.slice(0, 120)}`;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = firstDifference(x[k], y[k], `${at}.${k}`); if (d) return d; }
  return `${at}: key order or type`;
};
// The session opens one second before the engine first prices its book: the boot seconds before that
// are dead air. Each timeline keeps its last frame from before that moment as its opening value.
const stateFrames = fixtures.frames?.['/api/state'] || [];
const priced = stateFrames.findIndex(f => Number.isFinite(f.body?.portfolio?.equitySol));
const opensAt = priced > 0 ? stateFrames[priced - 1].at : -Infinity;
const trim = list => list.filter((f, i) => f.at >= opensAt || !(list[i + 1]?.at <= opensAt));
const frames = {};
for (const [p, all] of Object.entries(fixtures.frames || {})) {
  const list = trim(all);
  if (list.length < 2) continue;
  const bodies = list.map(f => scrub(f.body));
  // An unchanged frame has no diff (the key is dropped from the JSON), which means "keep the previous body".
  frames[p] = { base: {}, frames: bodies.map((b, i) => ({ at: list[i].at, diff: diff(i ? bodies[i - 1] : {}, b) })) };
  let body = {};
  frames[p].frames.forEach((f, i) => { body = apply(body, f.diff); if (!same(body, bodies[i])) throw new Error(`${p} frame ${i} does not round-trip at ${firstDifference(body, bodies[i])}`); });
}

const data = { recordedAt: fixtures.recordedAt, responses, frames };
const leaked = secrets.find(s => JSON.stringify(data).includes(JSON.stringify(s).slice(1, -1)));
if (leaked) throw new Error('A local path or user name is still in the demo data; refusing to write it.');
fs.writeFileSync(path.join(OUT, 'demo-data.js'), `window.__MPO_DEMO__=${JSON.stringify(data)};\n`);

const size = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Web demo built: ${path.relative(ROOT, OUT)} (${(size(OUT) / 1e6).toFixed(1)} MB, ${Object.keys(responses).length} responses, ${Object.values(frames).reduce((n, f) => n + f.frames.length, 0)} frames, data ${(fs.statSync(path.join(OUT, 'demo-data.js')).size / 1e6).toFixed(2)} MB)`);
