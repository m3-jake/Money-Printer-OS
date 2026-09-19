// Generation-race contract: a completed generation can never be recomputed while the
// evolution-sync drain in index.js lags, and a restart recovers from the local loop file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-sync-'));
process.env.MONEY_PRINTER_DATA_DIR = DIR;
process.env.EVOLUTION_WORKERS = '2';
process.env.EVOLUTION_VARIANTS = '128';
process.env.EVOLUTION_SCORER = 'fast';
delete process.env.CLUSTER_HUB_URL;
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;
delete process.env.EVOLUTION_CHUNK;

const { FEATURES, BASE, mulberry32 } = await import('../src/evolutionScoring.js');
const {
  resolveLoopState, loadLocalLoop, saveLocalLoop, resetLoopMemory, runGeneration, closePool, LOOP_FILE,
} = await import('../src/evolutionEngine.js');

const STATE_FILE = path.join(DIR, 'state.json');
const ACTION_FILE = path.join(DIR, 'actions.ndjson');

function outcomes(n, seed) {
  const r = mulberry32(seed);
  const out = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    ts += 60_000 + Math.floor(r() * 30_000);
    const features = {};
    for (const k of FEATURES) features[k] = +r().toFixed(6);
    out.push({ ts, horizonMin: 5, returnPct: +(r() * 90 - 30).toFixed(4), features });
  }
  return out;
}
function writeState(extra = {}) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    cashSol: 1, paperStartSol: 1, positions: [], history: [],
    research: { learner: { outcomes: outcomes(140, 4), weights: {}, featureStats: {} } },
    ...extra,
  }));
}
const syncActions = () => (fs.existsSync(ACTION_FILE) ? fs.readFileSync(ACTION_FILE, 'utf8') : '')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(a => a.type === 'evolution-sync');

test('resolveLoopState always picks the most advanced loop state', () => {
  assert.equal(resolveLoopState({}), null);
  assert.equal(resolveLoopState({ disk: null, local: null, memory: null }), null);
  assert.equal(resolveLoopState({ disk: { generation: 3 }, local: { generation: 7 } }).generation, 7); // local ahead
  assert.equal(resolveLoopState({ disk: { generation: 9 }, local: { generation: 7 } }).generation, 9); // disk ahead
  assert.equal(resolveLoopState({ disk: { generation: 9 }, memory: { generation: 12 } }).generation, 12); // memory ahead
  assert.equal(resolveLoopState({ disk: { generation: 4, updatedAt: 500, champion: { id: 'OLD' } }, local: { generation: 4, updatedAt: 900, champion: { id: 'NEW' } } }).champion.id, 'NEW');
  assert.equal(resolveLoopState({ disk: { generation: 5 }, memory: { generation: 'abc' } }).generation, 5); // non-numeric => 0
  assert.equal(resolveLoopState({ memory: { generation: 'abc' } }).generation, 'abc'); // sole candidate survives
  // The winner is a detached copy; mutating it cannot corrupt the source.
  const source = { generation: 2, champion: { id: 'C' } };
  const resolved = resolveLoopState({ local: source });
  resolved.champion.id = 'MUTATED';
  assert.equal(source.champion.id, 'C');
});

test('local loop file round-trips atomically', () => {
  assert.equal(loadLocalLoop(), null);
  assert.equal(saveLocalLoop({ generation: 41, updatedAt: 7 }), true);
  assert.deepStrictEqual(loadLocalLoop(), { generation: 41, updatedAt: 7 });
  fs.writeFileSync(LOOP_FILE, '{ not json');
  assert.equal(loadLocalLoop(), null);
  fs.rmSync(LOOP_FILE, { force: true });
  assert.equal(loadLocalLoop(), null);
});

test('generations advance monotonically with no action draining and across restarts', async () => {
  writeState();
  try { fs.rmSync(ACTION_FILE, { force: true }); } catch {}
  resetLoopMemory();

  await runGeneration();
  assert.equal(loadLocalLoop().generation, 1);

  // No drain, no state.json write: the lagging consumer must not cost us a generation.
  await runGeneration();
  const loop = loadLocalLoop();
  assert.equal(loop.generation, 2);
  assert.equal(loop.variantsTested, 2 * 129);
  assert.deepStrictEqual(loop.history.map(h => h.generation), [2, 1]);
  assert.equal(loop.status, 'RUNNING');
  assert.equal(loop.currentBatchStatus, 'COMPLETE');
  assert.equal(loop.datasetSamples, 110);
  assert.equal(loop.sealedSamples, 30);
  assert.equal(loop.sealedSplit.selectionUse, false);
  assert.equal(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).evolutionLoop, undefined);

  const actions = syncActions();
  assert.equal(actions.at(-1).evolutionLoop.generation, 2);
  assert.ok(actions.length >= 4, `expected start+completion publishes, saw ${actions.length}`);
  // Throttling: progress publishes must not flood the queue with one action per chunk.
  assert.ok(actions.length < 40, `progress publishing is not throttled: ${actions.length} actions`);

  // Simulated restart: memory is gone, the local file is the authority.
  resetLoopMemory();
  await runGeneration();
  assert.equal(loadLocalLoop().generation, 3);

  // Disk state finally catches up (and overtakes): the newest source wins.
  writeState({ evolutionLoop: {
    generation: 10, updatedAt: Date.now(), variantsTested: 5000, history: [], events: [], challengers: [],
    champion: { id: 'DISK-CHAMP', stage: 'SHADOW', variant: { id: 'DISK-CHAMP', weights: BASE, threshold: 45, stopPct: 7, takePct: 22, maxHoldMin: 40, parentId: 'BASE' },
      metrics: { heldOutN: 20, samples: 90, activityPct: 35, monteCarloPassPct: 88, robustScore: 12, heldOutAvgPct: 2 } },
  } });
  await runGeneration();
  const after = loadLocalLoop();
  assert.equal(after.generation, 11);
  assert.equal(after.history[0].generation, 11);
  assert.equal(after.variantsTested, 5000 + 129);
  assert.ok(after.challengers.length > 0);
  assert.ok(after.challengers.every(c => c.id === 'DISK-CHAMP' || c.parentId === 'DISK-CHAMP'),
    'trusted disk champion must be the mutation base');
  await closePool();
});
