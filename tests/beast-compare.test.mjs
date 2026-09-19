import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MONEY_PRINTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-beast-compare-test-'));
delete process.env.CLUSTER_HUB_URL;
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-beast-compare-out-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { FEATURES, BASE, packDataset, scoreVariant, scoreVariantPacked, mulberry32 } = await import('../src/evolutionScoring.js');
const { PROMOTION_GATES, promotionImproves, beastProfile } = await import('../src/evolutionEngine.js');
const { splitResearchRows, sealedAudit, searchCoverage } = await import('../src/evolutionSearch.js');
const { buildCorpus, corpusHash, evolutionPromotionGate } = await import('../scripts/beast-baseline-benchmark.mjs');
const { NUMERICAL_TOLERANCE, deterministicParity } = await import('../src/gpuFurnaceContract.js');

test('frozen corpus hash is stable and independent of scoring mode', () => {
  const a = buildCorpus({ seed: 45, rowCount: 80, variantCount: 12 });
  const b = buildCorpus({ seed: 45, rowCount: 80, variantCount: 12 });
  assert.equal(corpusHash(a), corpusHash(b));
  assert.equal(a.rows.length, 80);
  assert.equal(a.variants.length, 13);
  assert.equal(a.variants[0].id, 'BASE');
});

test('packed vs legacy scores match on the frozen builder within numerical tolerance', () => {
  const corpus = buildCorpus({ seed: 45, rowCount: 80, variantCount: 12 });
  const ds = packDataset(corpus.rows, { shared: false });
  let finite = 0, maxAbs = 0;
  for (const [i, v] of corpus.variants.entries()) {
    const rngA = mulberry32(9000 + i), rngB = mulberry32(9000 + i);
    const legacy = scoreVariant(v, corpus.rows, { rounds: 20, rng: rngA });
    const packed = scoreVariantPacked(v, ds, { rounds: 20, rng: rngB });
    const parity = deterministicParity(legacy, packed);
    if (parity.maxAbs > maxAbs) maxAbs = parity.maxAbs;
    assert.equal(parity.ok, true, `${v.id} ${parity.mismatches}`);
    if (Number.isFinite(legacy?.robustScore)) finite++;
  }
  assert.ok(finite === corpus.variants.length);
  assert.ok(maxAbs <= NUMERICAL_TOLERANCE);
});

test('BEAST promotion helper matches the frozen baseline gate and never implies live', () => {
  const parent = { variant: { id: 'BASE' }, metrics: { robustScore: 1, heldOutAvgPct: 0.4, heldOutN: 20, samples: 80, activityPct: 12, stressAvgPct: 0, monteCarloPassPct: 80, consistencyPct: 75 } };
  const strong = { variant: { id: 'BEAST-0002' }, metrics: { robustScore: 3.5, heldOutAvgPct: 1.2, heldOutN: 20, samples: 80, activityPct: 12, stressAvgPct: 0.1, monteCarloPassPct: 82, consistencyPct: 75 } };
  const gate = evolutionPromotionGate(strong, parent, 'BASE');
  assert.equal(gate.promoted, true);
  assert.equal(gate.stage, 'SHADOW');
  assert.equal(promotionImproves(strong, parent, 'BASE'), true);
  assert.equal(PROMOTION_GATES.minHeldOutN, 12);
  assert.equal(beastProfile().enabled, false);
  assert.equal(beastProfile().gpu, false);
});

test('sealed tail cannot change ranking rows used by BEAST scoring', () => {
  const corpus = buildCorpus({ seed: 45, rowCount: 200, variantCount: 4 });
  const original = corpus.rows;
  const mutated = structuredClone(original);
  const split = splitResearchRows(original, { sealedFraction: .15 });
  assert.equal(split.meta.selectionUse, false);
  for (let i = split.rankingRows.length; i < mutated.length; i++) mutated[i].returnPct = 99;
  const split2 = splitResearchRows(mutated, { sealedFraction: .15 });
  assert.deepEqual(split.rankingRows, split2.rankingRows);
  const audit = sealedAudit({ id: 'BASE', weights: BASE, threshold: 60, stopPct: 8, takePct: 16, maxHoldMin: 30 }, split.sealedRows);
  assert.equal(audit.selectionUse, false);
});

test('duplicate rate is recorded for the fixed candidate set', () => {
  const corpus = buildCorpus({ seed: 45, rowCount: 80, variantCount: 64 });
  const cov = searchCoverage(corpus.variants);
  assert.equal(cov.dimensions, 13);
  assert.equal(cov.duplicateRate, 0);
  assert.equal(cov.uniqueExact, corpus.variants.length);
});

test('CLI compare writes only to the requested out dir', () => {
  const outDir = path.join(tmp, 'cli');
  const dataDir = path.join(tmp, 'data-sentinel');
  fs.mkdirSync(dataDir);
  const before = fs.readdirSync(dataDir);
  const result = spawnSync(process.execPath, [
    path.join(repo, 'scripts', 'beast-compare-benchmark.mjs'),
    '--seed', '45', '--rows', '80', '--variants', '6',
    '--throughput-workers', '1', '--out', outDir,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CLUSTER_HUB_URL: '', MONEY_PRINTER_DATA_DIR: path.join(tmp, 'cli-data'), MPO_RESEARCH_BEAST: '', MPO_RESEARCH_GPU: '' },
    timeout: 90_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.researchOnly, true);
  assert.equal(summary.candidateCount, 7);
  assert.equal(summary.acceptGpuDefault, false);
  assert.equal(fs.existsSync(path.join(outDir, 'report.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'REPORT.md')), true);
  assert.deepEqual(fs.readdirSync(dataDir), before);
});
