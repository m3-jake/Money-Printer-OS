import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// P1.2: /api/state is persisted state and must be ETag-cacheable; the live readings it used to carry are
// served by /api/telemetry. Boots the real dashboard in-process against a temp data dir, like
// tests/robinhood-http.test.mjs, because the point is the HTTP contract, not a helper.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-state-split-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
Object.assign(process.env, { MONEY_PRINTER_DATA_DIR: dataDir, DASHBOARD_PORT: '0', DASHBOARD_HOST: '127.0.0.1', MODE: 'paper',
  POLYMARKET_AUTOSTART: 'false', POLYMARKET_AUTOPILOT: 'false', ROBINHOOD_AUTOSTART: 'false',
  ROBINHOOD_API_KEY: '', ROBINHOOD_PRIVATE_KEY: '', ROBINHOOD_REAL_ENABLED: 'false' });

const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return nativeFetch(url, ...rest);
  assert.fail('External requests are disabled in this test: ' + u.hostname);
};
const { startDashboard } = await import('../src/dashboard.js');
const { productEconomics } = await import('../src/productEconomics.js');
const store = await import('../src/store.js');
const server = startDashboard();
if (!server.listening) await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
test.after(async () => { await new Promise(resolve => server.close(resolve)); productEconomics().close(); globalThis.fetch = nativeFetch; fs.rmSync(root, { recursive: true, force: true }); });

test('the state endpoint carries persisted state only, with an exact ETag and no live samples', async () => {
  const r = await fetch(base + '/api/state');
  assert.equal(r.status, 200);
  const tag = r.headers.get('etag');
  assert.match(tag, /^".+"$/, 'an ETag is required for a 304 to be possible at all');
  assert.equal(r.headers.get('cache-control'), 'no-cache', 'stored but always revalidated');
  assert.equal(r.headers.get('x-state-cache'), 'MISS');
  const s = await r.json();
  for (const k of ['paperStartSol', 'cashSol', 'positions', 'system', 'stats', 'solanaBook', 'portfolio', 'build', 'config']) assert.ok(k in s, k);
  // The live readings are gone from the state: they cannot be tagged, so they cannot live here.
  assert.equal(s.system.resources, null);
  assert.equal(s.walletIntel.holderRpc, null);
  assert.equal(s.walletIntel.scorecard, null);
  assert.equal('cpuPct' in (s.system.metrics || {}), false);
  assert.equal('memoryPct' in (s.system.metrics || {}), false);
  // P1.3: the payload publishes which dial sizes the next entry (measured, not inferred).
  assert.ok(Array.isArray(s.effectiveControls.sizing.binding) && s.effectiveControls.sizing.binding.length > 0);
  assert.match(s.effectiveControls.sizing.statement, /is set by/);
  assert.equal(s.effectiveControls.sizing.dials.length, 4);
});

test('a matching If-None-Match is a real 304, and the tag covers every file the snapshot reads', async () => {
  const first = await fetch(base + '/api/state');
  const tag = first.headers.get('etag');
  const again = await fetch(base + '/api/state', { headers: { 'if-none-match': tag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  assert.equal(again.headers.get('etag'), tag);
  assert.equal(again.headers.get('x-state-cache'), 'HIT', 'the second poll did not rebuild the snapshot');
  assert.ok(Number(again.headers.get('x-payload-bytes')) > 0, 'the size of the body it did not resend');
  // research-state.json is merged into the state by loadState(), so a write to it alone must invalidate.
  // This is the case a state.json-only stamp (the pre-P1.2 tag) silently served stale.
  fs.writeFileSync(path.join(dataDir, 'research-state.json'), JSON.stringify({ learner: { samples: 1 }, note: 'written by this test' }), { flush: true });
  const afterResearch = await fetch(base + '/api/state', { headers: { 'if-none-match': tag } });
  assert.equal(afterResearch.status, 200);
  assert.notEqual(afterResearch.headers.get('etag'), tag);
  assert.equal(afterResearch.headers.get('x-state-cache'), 'MISS');
  // And a write to state.json invalidates too (the engine's own save path, not a hand-made file).
  const t2 = afterResearch.headers.get('etag');
  store.saveState(store.loadState());
  const afterState = await fetch(base + '/api/state', { headers: { 'if-none-match': t2 } });
  assert.equal(afterState.status, 200);
  assert.notEqual(afterState.headers.get('etag'), t2);
  // Polling again with the newest tag is a 304 again: nothing changed in between.
  const t3 = afterState.headers.get('etag');
  const settled = await fetch(base + '/api/state', { headers: { 'if-none-match': t3 } });
  assert.equal(settled.status, 304);
});

test('the telemetry endpoint carries the live readings, uncached and untagged', async () => {
  const r = await fetch(base + '/api/telemetry');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store', 'a live sample must never be cached');
  assert.equal(r.headers.get('etag'), null, 'no tag: the response changes every second by design');
  const t = await r.json();
  assert.equal(typeof t.at, 'number');
  assert.ok(Math.abs(Date.now() - t.at) < 10_000);
  assert.equal(typeof t.metrics.cpuPct, 'number');
  assert.equal(typeof t.metrics.memoryPct, 'number');
  assert.ok(Number(t.metrics.memoryTotalGB) > 0);
  assert.ok(t.resources && typeof t.resources === 'object');
  assert.ok('holderRpc' in t && 'walletScorecard' in t);
  assert.match(t.note, /live/i);
  const second = await fetch(base + '/api/telemetry');
  assert.equal(second.headers.get('x-state-cache'), null);
  assert.equal((await second.json()).note, t.note);
});

test('the operator health endpoint keeps the live sample it always reported', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(typeof h.metrics.cpuPct, 'number', '/api/health is not ETag-cached, so it keeps the live sample');
  assert.equal(typeof h.metrics.memoryPct, 'number');
});

test('the HUD merges telemetry into the state it may have received as a 304', () => {
  const html = fs.readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/api\/telemetry',\{cache:'no-store'\}\)/);
  assert.match(html, /fetch\('\/api\/state',\{cache:'no-cache'\}\)/, 'no-store would forbid the 304 the server now offers');
  assert.match(html, /state\.system\.metrics=\{\.\.\.\(state\.system\.metrics\|\|\{\}\),\.\.\.t\.metrics\}/);
  assert.match(html, /state\.walletIntel\.holderRpc=t\.holderRpc/);
  assert.match(html, /state\.walletIntel\.scorecard=t\.walletScorecard/);
  assert.match(html, /perf\.telemetryError/);
  assert.match(html, /LIVE READINGS STALE/);
});
