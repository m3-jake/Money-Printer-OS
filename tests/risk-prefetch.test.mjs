// Run C1: mint-risk lookups run off the engine cycle. The cycle never waits; unknown risk is not tradable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RiskPrefetcher } from '../src/riskPrefetch.js';

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

test('request never blocks: risk is unknown until the background lookup answers', async () => {
  const d = deferred(); let calls = 0;
  const rp = new RiskPrefetcher({ lookup: async () => { calls++; return d.p; } });
  const t0 = performance.now(); rp.request(['A']); assert.ok(performance.now() - t0 < 50, 'returns at once even though the RPC hangs');
  assert.equal(rp.get('A'), null, 'unknown, so the cycle treats it as not tradable');
  rp.request(['A']); assert.equal(calls, 1, 'one lookup per mint while it is in flight');
  d.resolve({ score: 80, flags: [] }); await rp.drain();
  assert.deepEqual(rp.get('A'), { score: 80, flags: [] });
  rp.request(['A']); assert.equal(calls, 1, 'a fresh answer is served from the cache');
});

test('a failed or empty lookup stays unknown; answers expire after the TTL', async () => {
  let now = 1_000_000;
  const rp = new RiskPrefetcher({ now: () => now, ttlMs: 1000, lookup: async m => { if (m === 'bad') throw new Error('rpc 429'); if (m === 'empty') return null; return { score: 1 }; } });
  rp.request(['bad', 'empty', 'ok']); await rp.drain();
  assert.equal(rp.get('bad'), null); assert.equal(rp.get('empty'), null); assert.deepEqual(rp.get('ok'), { score: 1 });
  assert.equal(rp.stats().failed, 2); assert.match(rp.stats().lastError, /empty risk answer|rpc 429/);
  now += 1001; assert.equal(rp.get('ok'), null, 'expired answers are unknown again');
});

test('circuit breaker: three failures in a row pause lookups; nothing is guessed while it is open', async () => {
  let now = 0, calls = 0;
  const rp = new RiskPrefetcher({ now: () => now, concurrency: 1, breakerFailures: 3, breakerOpenMs: 60_000, lookup: async () => { calls++; throw new Error('timeout'); } });
  rp.request(['a', 'b', 'c', 'd', 'e']); await rp.drain();
  assert.equal(calls, 3); assert.equal(rp.stats().breakerOpen, true); assert.equal(rp.stats().breakerTrips, 1);
  assert.equal(rp.get('d'), null); assert.equal(rp.stats().queued, 2, 'the rest wait for the breaker');
  now += 60_001; rp.lookup = async m => ({ score: m.length }); rp.request([]); await rp.drain();
  assert.equal(rp.stats().breakerOpen, false); assert.deepEqual(rp.get('d'), { score: 1 }); assert.deepEqual(rp.get('e'), { score: 1 });
});

test('the queue is bounded and concurrency is respected', async () => {
  let live = 0, peak = 0;
  const rp = new RiskPrefetcher({ concurrency: 2, maxQueue: 3, lookup: async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return { score: 1 }; } });
  rp.request(['1', '2', '3', '4', '5', '6', '7']); await rp.drain();
  assert.equal(peak, 2); assert.equal(rp.stats().dropped, 2, '2 in flight + 3 queued; 2 dropped this cycle'); assert.equal(rp.stats().cached, 5);
  assert.ok(Number.isFinite(rp.stats().lookupMsP95));
});

test('the engine cycle no longer awaits mintRisk and fails closed on unknown risk', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /await mintRisk\(/, 'no risk lookup is awaited on the cycle');
  assert.match(src, /riskPrefetch\.request\(prelim\.map/);
  assert.match(src, /const riskVerifiedEnough = !!checkedRisk && \(cfg\.mode === 'paper' \|\| !checkedRisk\.holderDataUnavailable\);/);
});
