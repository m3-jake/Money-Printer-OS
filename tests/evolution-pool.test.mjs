// Persistent pool contract: workers survive across generations, resize on demand, recover
// from a crashed worker with one chunk retry, and always return results in variant order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MONEY_PRINTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-pool-'));
delete process.env.CLUSTER_HUB_URL;
delete process.env.EVOLUTION_CHUNK;
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;

const { FEATURES, BASE, mulberry32, packDataset, scoreVariantPacked } = await import('../src/evolutionScoring.js');
const { EvolutionPool, chunkPlan } = await import('../src/evolutionPool.js');

function makeRows(n, seed) {
  const r = mulberry32(seed);
  const rows = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    ts += Math.floor(r() * 60_000) + 1;
    const f = {};
    for (const k of FEATURES) f[k] = +r().toFixed(6);
    rows.push({ ts, horizonMin: 5, returnPct: +(r() * 120 - 40).toFixed(4), features: f });
  }
  return rows;
}
const makeVariants = n => Array.from({ length: n }, (_, i) => ({
  id: `V${String(i).padStart(4, '0')}`, weights: BASE, threshold: 30 + (i % 40),
  stopPct: 4 + (i % 7), takePct: 10 + (i % 19), maxHoldMin: 5 + (i % 45),
}));

test('chunkPlan covers every index exactly once', () => {
  for (const [total, workers, size] of [[0, 4, 8], [1, 4, 8], [7, 3, 0], [240, 3, 8], [2048, 4, 0], [97, 5, 13]]) {
    const plan = chunkPlan(total, workers, size);
    const seen = [];
    for (const c of plan) { assert.ok(c.count > 0); for (let i = 0; i < c.count; i++) seen.push(c.startIndex + i); }
    assert.deepStrictEqual(seen, Array.from({ length: total }, (_, i) => i));
  }
  // Default sizing stays inside the documented clamp.
  const auto = chunkPlan(2048, 4, 0);
  assert.ok(auto[0].count >= 8 && auto[0].count <= 64, `unexpected default chunk ${auto[0].count}`);
});

test('workers are reused across score() calls instead of respawned', async () => {
  const rows = makeRows(300, 1);
  const ds = packDataset(rows);
  const pool = new EvolutionPool({ size: 3 });
  try {
    await pool.score(makeVariants(24), ds, { rounds: 16, seed: 1, chunkSize: 4 });
    const first = [...pool.threadIds];
    await pool.score(makeVariants(24), ds, { rounds: 16, seed: 1, chunkSize: 4 });
    assert.deepStrictEqual([...pool.threadIds], first);
    assert.equal(pool.stats().spawned, 3);
    assert.equal(pool.stats().terminated, 0);
    assert.equal(pool.stats().jobs, 2);
    assert.equal(first.length, 3);
  } finally { await pool.close(); }
});

test('a second generation reuses the same threads with a fresh dataset', async () => {
  const pool = new EvolutionPool({ size: 2 });
  try {
    const a = packDataset(makeRows(300, 2));
    const b = packDataset(makeRows(300, 3));
    assert.notEqual(a.id, b.id);
    const variants = makeVariants(16);
    const ra = await pool.score(variants, a, { rounds: 16, seed: 5, chunkSize: 4 });
    const threads = [...pool.threadIds];
    const rb = await pool.score(variants, b, { rounds: 16, seed: 5, chunkSize: 4 });
    assert.deepStrictEqual([...pool.threadIds], threads);
    assert.equal(pool.stats().spawned, 2);
    // Different dataset => different metrics, proving the worker swapped datasets.
    assert.notDeepStrictEqual(ra[0].metrics, rb[0].metrics);
    assert.deepStrictEqual(rb[0].metrics, scoreVariantPacked(variants[0], b, { rounds: 16, rng: mulberry32(5) }));
  } finally { await pool.close(); }
});

test('resize grows and shrinks the live worker set', async () => {
  const pool = new EvolutionPool({ size: 1 });
  try {
    const ds = packDataset(makeRows(300, 4));
    await pool.score(makeVariants(8), ds, { rounds: 8, chunkSize: 4 });
    assert.equal(pool.activeWorkers, 1);
    pool.resize(4);
    assert.equal(pool.size, 4);
    assert.equal(pool.activeWorkers, 4);
    pool.resize(2);
    assert.equal(pool.size, 2);
    assert.equal(pool.activeWorkers, 2);
    const out = await pool.score(makeVariants(16), ds, { rounds: 8, chunkSize: 4 });
    assert.equal(out.length, 16);
    assert.equal(pool.activeWorkers, 2);
    pool.resize(0);
    assert.equal(pool.size, 1);
  } finally { await pool.close(); }
});

test('a worker crash mid-chunk is retried once and results stay correct', async () => {
  const rows = makeRows(1200, 9);
  const ds = packDataset(rows);
  const variants = makeVariants(240);
  const pool = new EvolutionPool({ size: 3 });
  try {
    let killed = false;
    const seed = 7;
    const out = await pool.score(variants, ds, {
      rounds: 90, seed, chunkSize: 8,
      onProgress: p => { if (!killed && p.completed > 0 && p.completed < p.total / 2) { killed = true; pool.terminateWorker(0); } },
    });
    assert.ok(killed, 'expected the crash to be injected mid-job');
    assert.equal(pool.stats().retried, 1);
    assert.equal(out.length, variants.length);
    for (const [i, entry] of out.entries()) {
      assert.equal(entry.variant.id, variants[i].id, `result ${i} out of order`);
      assert.deepStrictEqual(entry.metrics, scoreVariantPacked(variants[i], ds, { rounds: 90, rng: mulberry32((seed + i) >>> 0) }));
    }
    assert.equal(pool.activeWorkers, 3, 'crashed worker should have been replaced');
    assert.equal(pool.stats().spawned, 4);
    // Pool stays usable after the crash.
    const again = await pool.score(makeVariants(8), ds, { rounds: 8, chunkSize: 4 });
    assert.equal(again.length, 8);
  } finally { await pool.close(); }
});

test('close() terminates every worker and rejects later score() calls', async () => {
  const pool = new EvolutionPool({ size: 2 });
  const ds = packDataset(makeRows(300, 6));
  await pool.score(makeVariants(8), ds, { rounds: 8, chunkSize: 4 });
  assert.equal(pool.activeWorkers, 2);
  await pool.close();
  assert.equal(pool.activeWorkers, 0);
  assert.equal(pool.stats().terminated, 2);
  await pool.close(); // idempotent
  assert.equal(pool.activeWorkers, 0);
  await assert.rejects(() => pool.score(makeVariants(4), ds, { rounds: 8 }), /closed/);
});
