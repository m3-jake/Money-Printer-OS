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
  const version = html.match(/href="mobile\.css\?v=([a-f0-9]{12})"/)?.[1];
  assert.ok(version, 'phone layout is bundled with a versioned URL');
  for (const asset of ['css/mpo-mac.css', 'mobile.js', 'demo-shim.js', 'demo-data.js'])
    assert.ok(html.includes(`${asset}?v=${version}`), `${asset} refreshes when the demo changes`);
  assert.ok(fs.existsSync(path.join(out, 'mobile.css')) && fs.existsSync(path.join(out, 'mobile.js')));
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

// bangbowbing accounts (public/js/mpo-account.js) against scripts/web-demo/mock-hub.mjs, which mirrors the hub's API.
function accountFactory() {
  const window = {};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'mpo-account.js'), 'utf8'), vm.createContext({ window, URLSearchParams, JSON, Object, Array, Number, String, Math, Promise, Set, Error, setTimeout, clearTimeout }));
  return window.MPOAccountFactory;
}
const memoryStorage = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };

test('accounts follow the website\'s hub switch: off means no requests, and ?hub= only works on localhost', async () => {
  const create = accountFactory(); let calls = 0; const fetchImpl = async () => { calls++; throw new Error('no network'); };
  const off = create({ config: { siteOrigin: 'https://bangbowbing.net', hub: { enabled: false, base: '' } }, fetchImpl, storage: memoryStorage(), location: { hostname: 'moneyprinter.bangbowbing.net', search: '' } });
  assert.equal(off.enabled, false); await assert.rejects(off.signIn('a@b.co', 'x'), /not online yet/); assert.equal(await off.resume(), null); assert.equal(calls, 0);
  const on = create({ config: { siteOrigin: 'https://bangbowbing.net', hub: { enabled: true, base: '' } }, fetchImpl, storage: memoryStorage(), location: { hostname: 'moneyprinter.bangbowbing.net', search: '?hub=https://evil.example' } });
  assert.equal(on.base, 'https://bangbowbing.net', 'an empty base is the website origin; ?hub= is ignored off localhost');
  const dev = create({ config: null, fetchImpl, storage: memoryStorage(), location: { hostname: '127.0.0.1', search: '?hub=http://127.0.0.1:9' } });
  assert.equal(dev.enabled, true); assert.equal(dev.base, 'http://127.0.0.1:9');
  assert.ok(fs.readFileSync(path.join(build(), 'index.html'), 'utf8').includes('<script async src="https://bangbowbing.net/config/site-config.js"'), 'the demo reads the website\'s switch');
});

test('register, resume, cloud-saved desktop and sign-out against the hub API; a down hub never signs anyone out', async () => {
  const { createMockHub } = await import('../scripts/web-demo/mock-hub.mjs');
  const { server } = createMockHub(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, create = accountFactory(), storage = memoryStorage();
  const make = (fetchImpl = fetch) => create({ config: { hub: { enabled: true, base } }, fetchImpl, storage, location: { hostname: 'moneyprinter.bangbowbing.net', search: '' } });
  try {
    const a = make();
    await assert.rejects(a.register('x@y.co', 'no', 'longenough'), /3-20/);
    assert.equal((await a.register('tester@example.test', 'demo_tester', 'mockhub-test-0001')).displayName, 'demo_tester');
    assert.ok(storage.m.get('mpo-hub-auth').includes('refresh'), 'only the refresh token is stored');
    assert.equal(await a.loadDesktop(), null, 'no save yet');
    storage.setItem('mpo-display', '{"fullDetail":true}'); storage.setItem('unrelated', 'x');
    await a.saveDesktop(a.collectPrefs());
    const down = make(async () => ({ ok: false, status: 503, json: async () => ({ error: 'down' }) }));
    assert.equal(await down.resume(), null); assert.ok(storage.m.get('mpo-hub-auth'), 'a 5xx keeps the session');
    const b = make(); assert.equal((await b.resume()).displayName, 'demo_tester', 'a new page resumes the session');
    storage.removeItem('mpo-display');
    const save = await b.loadDesktop(); assert.deepEqual(Object.keys(save.prefs), ['mpo-display'], 'only desktop preferences are saved');
    assert.equal(b.applyPrefs(save.prefs), true); assert.equal(storage.getItem('mpo-display'), '{"fullDetail":true}'); assert.equal(b.applyPrefs(save.prefs), false, 'nothing to apply twice');
    await b.signOut(); assert.equal(b.user, null); assert.equal(storage.getItem('mpo-hub-auth'), null);
    const c = make(); assert.equal(await c.resume(), null, 'signed out stays signed out');
    await assert.rejects(c.signIn('tester@example.test', 'wrong-password'), /Wrong email or password/);
    assert.equal((await c.signIn('tester@example.test', 'mockhub-test-0001')).displayName, 'demo_tester');
  } finally { server.close(); }
});
