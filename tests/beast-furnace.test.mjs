import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MONEY_PRINTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-beast-furnace-'));
process.env.EVOLUTION_SCORER = 'fast';
delete process.env.CLUSTER_HUB_URL;
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;
delete process.env.MPO_BEAST_VRAM_MB;
delete process.env.MPO_BEAST_RAM_GB;

const { FEATURES, BASE, packDataset, scoreVariantPacked, mulberry32 } = await import('../src/evolutionScoring.js');
const { beastProfile, PROMOTION_GATES, promotionImproves, scoreInWorkers, closePool } = await import('../src/evolutionEngine.js');
const { scoreBeastGpu, rescoreFinalistsCpu, resetGpuProbe } = await import('../src/evolutionGpu.js');
const { EvolutionPool } = await import('../src/evolutionPool.js');
const { deterministicParity, deterministicRobustScore, NUMERICAL_TOLERANCE } = await import('../src/gpuFurnaceContract.js');

const rows = (n = 300) => Array.from({ length: n }, (_, i) => ({
  ts: 1_700_000_000_000 + i * 60000,
  returnPct: Math.sin(i / 11) * 4 + .2,
  features: Object.fromEntries(FEATURES.map((k, j) => [k, ((i * (j + 3)) % 97) / 96])),
}));
const variant = (id = 'BASE', d = 0) => ({
  id,
  weights: Object.fromEntries(FEATURES.map((k, i) => [k, Math.max(.005, BASE[k] + d * ((i % 3) - 1))])),
  threshold: 60 + d * 20, stopPct: 8, takePct: 16, maxHoldMin: 30, parentId: 'BASE',
});

test.afterEach(() => {
  delete process.env.MPO_RESEARCH_BEAST;
  delete process.env.MPO_RESEARCH_GPU;
  delete process.env.MPO_BEAST_VRAM_MB;
  delete process.env.MPO_BEAST_RAM_GB;
  delete process.env.MPO_BEAST_REST_MS;
  delete process.env.MPO_BEAST_GPU_CPU_SHARE;
  resetGpuProbe();
});
test.after(async () => { await closePool(); });

test('BEAST is opt-in and bounded by resource/throughput caps', () => {
  assert.equal(beastProfile({ enabled: true, batchSize: 4096, workers: 24, throughputVerifiedBatchSize: 4096 }).enabled, false);
  process.env.MPO_RESEARCH_BEAST = '1';
  process.env.MPO_RESEARCH_GPU = '1';
  process.env.MPO_BEAST_VRAM_MB = '999999';
  const p = beastProfile({ enabled: true, batchSize: 50000, workers: 999, throughputVerifiedBatchSize: 4096 });
  assert.equal(p.enabled, true);
  assert.equal(p.gpu, true);
  assert.equal(p.cpuFallback, true);
  assert.ok(p.workers <= (os.cpus().length - 1 <= 6 ? 1 : Math.min(os.cpus().length - 1, 32)));
  assert.equal(p.gpuCpuShare, .30);
  process.env.MPO_BEAST_GPU_CPU_SHARE='0.5';
  assert.equal(beastProfile({enabled:true,batchSize:4096,workers:999,throughputVerifiedBatchSize:4096}).gpuCpuShare,.5);
  assert.equal(p.batchSize, 4096);
  assert.equal(p.gpuVramMb, 16384);
  process.env.MPO_BEAST_REST_MS='1'; assert.equal(beastProfile({enabled:true,batchSize:4096,workers:4,throughputVerifiedBatchSize:4096}).restMs,10);
  process.env.MPO_BEAST_REST_MS='99999'; assert.equal(beastProfile({enabled:true,batchSize:4096,workers:4,throughputVerifiedBatchSize:4096}).restMs,5000);
});

test('promotion constants are locked and helper preserves legacy thresholds', () => {
  assert.deepEqual(PROMOTION_GATES, {
    robustScoreMargin: 1, minHeldOutAvgPct: 0, minHeldOutN: 12, minSamples: 40,
    minActivityPct: 8, minStressAvgPct: -2, minMonteCarloPassPct: 70, minConsistencyPct: 50,
  });
  const parent = 'P', inc = { variant: { id: parent }, metrics: { robustScore: 10 } };
  const base = { robustScore: 11.01, heldOutAvgPct: .01, heldOutN: 12, samples: 40, activityPct: 8, stressAvgPct: -1.99, monteCarloPassPct: 70, consistencyPct: 50 };
  assert.equal(promotionImproves({ variant: { id: 'W' }, metrics: base }, inc, parent), true);
  for (const [k, v] of [['heldOutN', 11], ['samples', 39], ['activityPct', 7.99], ['stressAvgPct', -2], ['monteCarloPassPct', 69.9], ['consistencyPct', 49.9]]) {
    assert.equal(promotionImproves({ variant: { id: 'W' }, metrics: { ...base, [k]: v } }, inc, parent), false, k);
  }
});

test('deterministic parity rejects altered GPU metrics outside tolerance', () => {
  const a = { walkAvgPct: 1, geometricMeanPct: 2, compoundedMultiple: 1.1, maxDrawdownPct: 3, profitVelocityPctPerMin: .1, consistencyPct: 55, activityPct: 20, inactivityPenalty: 0, heldOutAvgPct: 1, heldOutN: 20, stressAvgPct: .5, worstPct: -2, samples: 100 };
  assert.equal(deterministicParity(a, { ...a, walkAvgPct: 1 + NUMERICAL_TOLERANCE / 10 }).ok, true);
  assert.equal(deterministicParity(a, { ...a, walkAvgPct: 1 + .01 }).ok, false);
  assert.equal(deterministicRobustScore({ robustScore: 25, monteCarloPassPct: 100 }), 15);
});

test('GPU dense results CPU-rescore anyone who can still win after MC', () => {
  const rs = rows(), ds = packDataset(rs);
  const vars = [variant('BASE'), variant('A', .01), variant('B', -.01), variant('C', .02), variant('D', -.02)];
  const scored = vars.map((v, i) => ({
    variant: v,
    metrics: { ...scoreVariantPacked(v, ds, { rounds: 2, rng: mulberry32(100 + i) }), robustScoreDeterministic: 100 - i * 20 },
  }));
  const out = rescoreFinalistsCpu(scored, ds, { finalists: 4, rounds: 2, seed: 100, parentId: 'BASE' });
  assert.equal(out.rescored, 4);
  assert.ok(out.recomputeRate > 0 && out.recomputeRate <= 1);
  assert.equal(out.scored.find(x => x.variant.id === 'BASE').source, 'cpu-finalist');
  assert.equal(out.scored.filter(x => x.source === 'cpu-finalist').length, 4);
  assert.equal(out.scored.filter(x => x.source === 'gpu-screened').length, 1);
});

test('GPU sidecar failure is a clean CPU fallback signal', async () => {
  const rs = rows(120), vars = [variant('BASE'), variant('A', .01)];
  const result = await scoreBeastGpu(vars, rs, {
    beast: { gpuTimeoutMs: 100, gpuVramMb: 512, gpuParitySample: 2 },
    sidecar: async () => ({ ok: false, reason: 'synthetic-failure' }),
    seed: 7,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'synthetic-failure');
  assert.equal(result.fallback, 'cpu');
});

test('mocked GPU with exact deterministic metrics passes parity and rescoring', async () => {
  const rs = rows(180), vars = [variant('BASE'), variant('A', .01), variant('B', -.01), variant('C', .02)];
  const ds = packDataset(rs), rounds = 2, seed = 11;
  const sidecar = async fixture => ({
    ok: true,
    result: {
      schema: 'mpo.gpu-furnace.scores.v1', device: 'cuda', deviceName: 'TEST', dtype: 'float64',
      vramBudgetMb: 512, peakMemoryMb: 10, chunkVariants: fixture.variants.length,
      metrics: vars.map((v, i) => scoreVariantPacked(v, ds, { rounds, rng: mulberry32((seed + i) >>> 0) })),
    },
  });
  const r = await scoreBeastGpu(vars, rs, {
    dataset: ds,
    beast: { gpuTimeoutMs: 100, gpuVramMb: 512, gpuParitySample: 4, gpuFinalists: 4, gpuRounds: rounds },
    sidecar, seed, cpuSeed: seed,
  });
  assert.equal(r.ok, true);
  assert.equal(r.parityMaxAbs, 0);
  assert.ok(r.rescored >= 4);
  assert.ok(r.scored.filter(x => x.metrics).every(x => x.source === 'cpu-finalist'));
});

test('GPU production finalist rescoring preserves normal CPU Monte Carlo randomness', async () => {
  const rs = rows(180), vars = [variant('BASE'), variant('A', .01), variant('B', -.01), variant('C', .02)];
  const ds = packDataset(rs), rounds = 12, gpuSeed = 17;
  const sidecar = async fixture => ({ ok: true, result: {
    schema: 'mpo.gpu-furnace.scores.v1', device: 'cuda', deviceName: 'TEST', dtype: 'float64',
    vramBudgetMb: 512, peakMemoryMb: 10, chunkVariants: fixture.variants.length,
    metrics: vars.map((v, i) => scoreVariantPacked(v, ds, { rounds, rng: mulberry32((gpuSeed + i) >>> 0) })),
  }});
  const a = await scoreBeastGpu(vars, rs, {dataset:ds,beast:{gpuParitySample:4,gpuFinalists:4,gpuRounds:rounds},sidecar,seed:gpuSeed,cpuSeed:123});
  const b = await scoreBeastGpu(vars, rs, {dataset:ds,beast:{gpuParitySample:4,gpuFinalists:4,gpuRounds:rounds},sidecar,seed:gpuSeed,cpuSeed:123});
  assert.deepEqual(a.scored.map(x=>x.metrics?.monteCarloPassPct), b.scored.map(x=>x.metrics?.monteCarloPassPct));
  const seeded = a.scored.map(x=>x.metrics?.monteCarloPassPct);
  const production = await scoreBeastGpu(vars, rs, {dataset:ds,beast:{gpuParitySample:4,gpuFinalists:4,gpuRounds:rounds},sidecar,seed:gpuSeed});
  assert.equal(production.ok,true);
  assert.ok(production.scored.every(x=>x.source==='cpu-finalist'||x.source==='gpu-screened'));
  assert.ok(production.scored.some((x,i)=>x.metrics && x.metrics.monteCarloPassPct !== seeded[i]));
});

test('scoreInWorkers uses the persistent pool for GPU finalists', async () => {
  const rs=rows(180), vars=[variant('BASE'),variant('A',.01),variant('B',-.01),variant('C',.02)];
  const ds=packDataset(rs), rounds=2, seed=17;
  const sidecar=async fixture=>({ok:true,result:{schema:'mpo.gpu-furnace.scores.v1',device:'cuda',deviceName:'TEST',dtype:'float64',vramBudgetMb:512,peakMemoryMb:10,chunkVariants:fixture.variants.length,
    metrics:vars.map((v,i)=>scoreVariantPacked(v,ds,{rounds,rng:mulberry32((seed+i)>>>0)}))}});
  const pool=new EvolutionPool({size:4});
  try{
    const scored=await scoreInWorkers(vars,rs,()=>{},{pool,dataset:ds,beast:{enabled:true,gpu:true,gpuTimeoutMs:100,gpuVramMb:512,gpuParitySample:4,gpuFinalists:4,gpuRounds:rounds,workers:4},gpuSidecar:sidecar,gpuSeed:seed,gpuCpuSeed:seed,parentId:'BASE'});
    assert.equal(scored.length,4);assert.ok(scored.every(x=>x.metrics));assert.ok(pool.stats().jobs>=1);
  } finally { await pool.close(); }
});

test('scoreInWorkers keeps CPU busy beside GPU screening on large BEAST batches', async () => {
  const rs=rows(80), ds=packDataset(rs), seed=23;
  const vars=Array.from({length:512},(_,i)=>variant(i===0?'BASE':`H${i}`,((i%17)-8)/1000));
  const progress=[];
  const sidecar=async fixture=>({ok:true,result:{schema:'mpo.gpu-furnace.scores.v1',device:'cuda',deviceName:'TEST',dtype:'float64',vramBudgetMb:512,peakMemoryMb:10,chunkVariants:fixture.variants.length,
    metrics:fixture.variants.map((v,i)=>scoreVariantPacked(v,ds,{rounds:1,rng:mulberry32((seed+i)>>>0)}))}});
  const pool=new EvolutionPool({size:2});
  try{
    const scored=await scoreInWorkers(vars,rs,x=>progress.push(x),{pool,dataset:ds,beast:{enabled:true,gpu:true,gpuCpuShare:.30,gpuTimeoutMs:100,gpuVramMb:512,gpuParitySample:2,gpuFinalists:4,gpuRounds:1,workers:2},gpuSidecar:sidecar,gpuSeed:seed,gpuCpuSeed:seed,parentId:'BASE'});
    assert.equal(scored.length,512);
    assert.ok(scored.every(x=>x.variant&&x.metrics));
    assert.ok(progress.some(x=>x.hybrid===true));
    assert.ok(pool.stats().jobs>=1);
  } finally { await pool.close(); }
});

test('scoreInWorkers falls back to CPU when GPU sidecar fails', async () => {
  const rs = rows(120), vars = [variant('BASE'), variant('A', .01), variant('B', -.02)];
  const scored = await scoreInWorkers(vars, rs, () => {}, {
    beast: { enabled: true, gpu: true, gpuTimeoutMs: 100, gpuVramMb: 512, gpuParitySample: 2, cpuFallback: true },
    gpuSidecar: async () => ({ ok: false, reason: 'synthetic-failure' }),
    gpuSeed: 3,
    gpuCpuSeed: 3,
  });
  assert.equal(scored.length, 3);
  assert.ok(scored.every(x => x.variant && x.metrics && Number.isFinite(x.metrics.robustScore)));
});
