// Exactness contract: the packed/fast scorer must be bit-identical to the legacy object-row
// scorer for the same rows and the same RNG stream, in-process and through the worker pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

process.env.MONEY_PRINTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-parity-'));
process.env.EVOLUTION_SCORER = 'fast';
delete process.env.CLUSTER_HUB_URL;
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;

const {
  FEATURES, BASE, mulberry32, packDataset, scoreVariant, scoreVariantPacked, folds,
  MC_ROUNDS_WORKER,
} = await import('../src/evolutionScoring.js');
const { EvolutionPool } = await import('../src/evolutionPool.js');
const { mutate } = await import('../src/evolutionEngine.js');
const { TEST_LANES } = await import('../src/resourcePolicy.js');

// Deliberately hostile rows: shuffled input, duplicate ts, missing feature keys,
// numeric-string features/returns, null features, zero-feature rows, 0 and -0 returns.
function makeRows(n, seed, { nanReturns = false } = {}) {
  const r = mulberry32(seed);
  const rows = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    if (i % 5 !== 0) ts += Math.floor(r() * 120_000) + 1; // every 5th row duplicates the previous ts
    const f = {};
    for (const k of FEATURES) f[k] = +r().toFixed(6);
    if (i % 7 === 0) delete f.flow;
    if (i % 11 === 0) f.edge = String(f.edge);
    if (i % 13 === 0) for (const k of Object.keys(f)) f[k] = 0;
    if (i % 19 === 0) f.momentum = 'n/a';
    if (i % 23 === 0) f.liquidity = null;
    let ret = +(r() < 0.65 ? r() * 40 - 20 : r() * 260 - 60).toFixed(4);
    const row = { ts, horizonMin: 5, returnPct: ret, features: f };
    if (i % 17 === 0) row.returnPct = String(ret);
    if (i % 37 === 0) row.returnPct = 0;
    if (i % 41 === 0) row.returnPct = -0;
    if (nanReturns && i % 29 === 0) row.returnPct = 'n/a';
    if (nanReturns && i % 53 === 0) row.returnPct = null;
    rows.push(row);
  }
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows;
}

const PARENT = { id: 'BASE', weights: BASE, threshold: 60, stopPct: 8, takePct: 16, maxHoldMin: 30 };
function variantSet(seed) {
  const r = mulberry32(seed);
  const mutants = Array.from({ length: 60 }, (_, i) => mutate(PARENT, TEST_LANES[i % TEST_LANES.length], r));
  return [
    PARENT,
    ...mutants,
    { id: 'SELECT_ALL', weights: BASE, threshold: 0, stopPct: 8, takePct: 16, maxHoldMin: 30 },
    { id: 'SELECT_NONE', weights: BASE, threshold: 100, stopPct: 8, takePct: 16, maxHoldMin: 30 },
    { id: 'TINY_STOP', weights: BASE, threshold: 40, stopPct: 0.5, takePct: 400, maxHoldMin: 1 },
    { id: 'HUGE_TAKE', weights: BASE, threshold: 35, stopPct: 20, takePct: 1000, maxHoldMin: 240 },
    { id: 'ZERO_WEIGHTS', weights: Object.fromEntries(FEATURES.map(k => [k, 0])), threshold: 0, stopPct: 8, takePct: 16, maxHoldMin: 30 },
  ];
}

for (const n of [400, 1200]) {
  test(`packed scorer is bit-identical to the legacy scorer (${n} rows)`, () => {
    const rows = makeRows(n, 1000 + n);
    const ds = packDataset(rows);
    const variants = variantSet(7);
    let finite = 0;
    for (const [i, v] of variants.entries()) {
      const legacy = scoreVariant(v, rows, { rounds: 90, rng: mulberry32(4242 + i) });
      const packed = scoreVariantPacked(v, ds, { rounds: 90, rng: mulberry32(4242 + i) });
      assert.deepStrictEqual(packed, legacy, `variant ${v.id} diverged`);
      if (Number.isFinite(legacy?.robustScore)) finite++;
    }
    // Guard against a trivially-passing comparison (all null / all NaN).
    assert.ok(finite > variants.length * 0.75, `expected mostly finite scores, got ${finite}/${variants.length}`);
  });
}

test('packed scorer keeps legacy NaN semantics for non-numeric returns', () => {
  const rows = makeRows(600, 77, { nanReturns: true });
  const ds = packDataset(rows);
  for (const [i, v] of variantSet(11).entries()) {
    assert.deepStrictEqual(
      scoreVariantPacked(v, ds, { rounds: 32, rng: mulberry32(99 + i) }),
      scoreVariant(v, rows, { rounds: 32, rng: mulberry32(99 + i) }),
      `variant ${v.id} diverged on NaN-bearing rows`,
    );
  }
});

test('packed fold ranges match legacy fold test slices', () => {
  for (const n of [75, 400, 1201]) {
    const rows = makeRows(n, 5150 + n);
    const ds = packDataset(rows);
    const legacy = folds(rows, 4);
    assert.equal(ds.folds.length, legacy.length);
    for (const [i, range] of ds.folds.entries()) {
      const packedTs = ds.sorted.slice(range.start, range.end).map(r => r.ts);
      assert.deepStrictEqual(packedTs, legacy[i].test.map(r => r.ts));
    }
  }
});

test('datasets below the fold floor score null on both paths', () => {
  const small = makeRows(70, 3);
  assert.equal(packDataset(small).folds.length, 0);
  assert.equal(scoreVariant(PARENT, small, { rounds: 20, rng: mulberry32(1) }), null);
  assert.equal(scoreVariantPacked(PARENT, packDataset(small), { rounds: 20, rng: mulberry32(1) }), null);

  const ok = makeRows(75, 3);
  const legacy = scoreVariant(PARENT, ok, { rounds: 20, rng: mulberry32(1) });
  const packed = scoreVariantPacked(PARENT, packDataset(ok), { rounds: 20, rng: mulberry32(1) });
  assert.notEqual(legacy, null);
  assert.deepStrictEqual(packed, legacy);
});

test('pool/worker results equal in-process packed results and stay in variant order', async () => {
  const rows = makeRows(800, 21);
  const ds = packDataset(rows);
  const variants = variantSet(13);
  const pool = new EvolutionPool({ size: 3 });
  try {
    const seed = 12345;
    const out = await pool.score(variants, ds, { rounds: 90, seed, chunkSize: 7 });
    assert.equal(out.length, variants.length);
    for (const [i, entry] of out.entries()) {
      assert.equal(entry.variant.id, variants[i].id, `result ${i} out of order`);
      const expected = scoreVariantPacked(variants[i], ds, { rounds: 90, rng: mulberry32((seed + i) >>> 0) });
      assert.deepStrictEqual(entry.metrics, expected, `variant ${variants[i].id} diverged in the worker`);
    }
  } finally {
    await pool.close();
  }
});

test('legacy {variants, rows} worker protocol still replies with the legacy array shape', async () => {
  const rows = makeRows(500, 33);
  const variants = variantSet(17).slice(0, 12);
  const reply = await new Promise((resolve, reject) => {
    const w = new Worker(new URL('../src/evolutionWorker.js', import.meta.url));
    w.once('message', x => { resolve(x); w.terminate(); });
    w.once('error', reject);
    w.postMessage({ variants, rows });
  });
  assert.ok(Array.isArray(reply));
  assert.equal(reply.length, variants.length);
  for (const [i, entry] of reply.entries()) {
    assert.deepStrictEqual(entry.variant, variants[i]);
    // Monte Carlo uses Math.random on this path, so compare everything else exactly.
    const local = scoreVariant(variants[i], rows, { rounds: MC_ROUNDS_WORKER });
    const { monteCarloPassPct: mcA, robustScore: rsA, ...restA } = entry.metrics;
    const { monteCarloPassPct: mcB, robustScore: rsB, ...restB } = local;
    assert.deepStrictEqual(restA, restB, `variant ${variants[i].id} diverged on the legacy protocol`);
    assert.ok(mcA >= 0 && mcA <= 100, `monteCarloPassPct out of range: ${mcA}`);
    assert.ok(Number.isFinite(rsA) || Number.isNaN(rsA));
  }
});
