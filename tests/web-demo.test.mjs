// The browser-only web demo: the build makes the real HUD static, and the shim answers /api/* from fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECORDED = Date.parse('2026-10-01T12:00:00Z');

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-web-demo-test-'));
  const fixtures = path.join(dir, 'fixtures.json');
  fs.writeFileSync(fixtures, JSON.stringify({
    recordedAt: new Date(RECORDED).toISOString(),
    responses: {
      '/api/update': { status: 200, at: RECORDED, body: { ok: true, updatedAt: RECORDED, dataDir: path.join(ROOT, 'data'), price: 1800000000000 } },
      '/api/project-journal': { status: 200, at: RECORDED, body: { entries: [{ text: 'private commit message' }] } },
      '/api/robinhood/chart?symbol=BTC-USD&range=6h': { status: 200, at: RECORDED, body: { symbol: 'BTC-USD' } },
    },
    frames: { '/api/telemetry': [
      { at: RECORDED, body: { tick: 1, keep: 'a', gone: 1, series: [1, 2, 3], rows: [{ id: 1, v: 1 }, { id: 2, v: 1 }] } },
      { at: RECORDED + 15000, body: { tick: 2, keep: 'a', series: [2, 3, 4, 5], rows: [{ id: 1, v: 1 }, { id: 2, v: 9 }] } },
    ],
    // An array body that does not change between frames must stay an array.
    '/api/journal?limit=180': [{ at: RECORDED, body: [{ type: 'buy' }] }, { at: RECORDED + 15000, body: [{ type: 'buy' }] }] },
  }));
  const out = path.join(dir, 'dist');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'web-demo', 'build.mjs')], { env: { ...process.env, MPO_WEB_DEMO_FIXTURES: fixtures, MPO_WEB_DEMO_OUT: out }, stdio: 'pipe' });
  return out;
}

function loadShim(out, now) {
  const calls = [];
  const window = { fetch: (...a) => { calls.push(a); return Promise.resolve('native'); } };
  const context = vm.createContext({ window, location: { href: 'https://example.com/demo/', origin: 'https://example.com' }, URL, Response, Request, Date: class extends Date { static now() { return now(); } }, addEventListener() {}, JSON, Object, Array, Number, String, Math, Promise, Set, RegExp });
  vm.runInContext(fs.readFileSync(path.join(out, 'demo-data.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(out, 'demo-shim.js'), 'utf8'), context);
  return { fetch: window.fetch, calls };
}

test('the build is static: shim first, relative asset paths, /api/ left for the shim', () => {
  const out = build();
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(html.indexOf('demo-shim.js') < html.indexOf('mpo-hud-runtime.js'), 'shim loads before the HUD wraps fetch');
  assert.ok(!/["'`(]\/(assets|js|css)\//.test(html), 'no absolute asset paths in the page');
  for (const dir of ['js', 'css']) for (const f of fs.readdirSync(path.join(out, dir)))
    assert.ok(!/["'`(]\/(assets|js|css)\//.test(fs.readFileSync(path.join(out, dir, f), 'utf8')), `${dir}/${f} has no absolute asset paths`);
  assert.ok(html.includes("'/api/state'"), 'API calls stay absolute');
  assert.ok(html.includes('href="quant-research.html"'));
});

test('recorded data is scrubbed of local paths and the git-history journal', () => {
  const data = fs.readFileSync(path.join(build(), 'demo-data.js'), 'utf8');
  assert.ok(!data.includes('money-printer-os\\\\data') && !data.includes(os.userInfo().username), 'no machine paths or user name');
  assert.ok(!data.includes('private commit message'));
});

test('GETs replay fixtures with timestamps moved to now; writes get the read-only answer', async () => {
  const out = build();
  let clock = RECORDED + 3_600_000;
  const { fetch, calls } = loadShim(out, () => clock);
  const update = await (await fetch('/api/update')).json();
  assert.equal(update.updatedAt, clock, 'time-like keys shift to now');
  assert.equal(update.price, 1800000000000, 'other numbers are untouched');
  assert.equal((await (await fetch('/api/robinhood/chart?symbol=ETH-USD&range=1h')).json()).symbol, 'BTC-USD', 'unknown query falls back to a sibling');
  assert.equal((await (await fetch('/api/nope')).json()).ok, false);
  const post = await (await fetch('/api/pause', { method: 'POST', body: '{}' })).json();
  assert.equal(post.ok, false);
  assert.match(post.error, /web demo/);
  assert.equal(await fetch('https://cdn.example.org/lib.js'), 'native', 'non-API requests pass through');
  assert.equal(calls.length, 1);
});

test('every page load is a new session: the timeline starts at its first frame and holds at the last', async () => {
  let clock = RECORDED + 86_400_000;
  const { fetch } = loadShim(build(), () => clock);
  const telemetry = async () => (await fetch('/api/telemetry')).json();
  assert.deepEqual(await telemetry(), { tick: 1, keep: 'a', gone: 1, series: [1, 2, 3], rows: [{ id: 1, v: 1 }, { id: 2, v: 1 }] }, 'opens on the first frame, whenever the page loads');
  clock += 16_000;
  assert.deepEqual(await telemetry(), { tick: 2, keep: 'a', series: [2, 3, 4, 5], rows: [{ id: 1, v: 1 }, { id: 2, v: 9 }] }, 'object, appended-array and per-item diffs applied, deleted key removed');
  assert.deepEqual(await (await fetch('/api/journal?limit=180')).json(), [{ type: 'buy' }], 'an unchanged frame keeps the previous body');
  clock += 600_000;
  assert.equal((await telemetry()).tick, 2, 'holds at the end instead of jumping back to the start');
});
