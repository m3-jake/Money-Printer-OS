import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-beast-baseline-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const {
  buildCorpus,
  corpusHash,
  evolutionPromotionGate,
  rankingFingerprint,
  runBaseline,
  championTrusted,
} = await import('../scripts/beast-baseline-benchmark.mjs');

test('seeded corpus is identical across builds and has fold-legal row counts', () => {
  const a = buildCorpus({ seed: 45, rowCount: 80, variantCount: 12 });
  const b = buildCorpus({ seed: 45, rowCount: 80, variantCount: 12 });
  assert.equal(a.variants.length, 13);
  assert.equal(a.rows.length, 80);
  assert.equal(a.variants[0].id, 'BASE');
  assert.equal(corpusHash(a), corpusHash(b));
  assert.deepEqual(a.rows[0], b.rows[0]);
  assert.deepEqual(a.variants[7], b.variants[7]);
  assert.notEqual(corpusHash(a), corpusHash(buildCorpus({ seed: 46, rowCount: 80, variantCount: 12 })));
});

test('evolution promotion gate matches loop thresholds and never implies live', () => {
  const parent = { variant: { id: 'BASE' }, metrics: { robustScore: 1, heldOutAvgPct: 0.4, heldOutN: 20, samples: 80, activityPct: 12, stressAvgPct: 0, monteCarloPassPct: 80, consistencyPct: 75 } };
  const weak = { variant: { id: 'BEAST-0001' }, metrics: { robustScore: 1.2, heldOutAvgPct: 0.1, heldOutN: 20, samples: 80, activityPct: 12, stressAvgPct: 0, monteCarloPassPct: 80, consistencyPct: 75 } };
  const strong = { variant: { id: 'BEAST-0002' }, metrics: { robustScore: 3.5, heldOutAvgPct: 1.2, heldOutN: 20, samples: 80, activityPct: 12, stressAvgPct: 0.1, monteCarloPassPct: 82, consistencyPct: 75 } };
  const retain = evolutionPromotionGate(weak, parent, 'BASE');
  const promote = evolutionPromotionGate(strong, parent, 'BASE');
  assert.equal(retain.promoted, false);
  assert.ok(retain.missing.includes('robustScore-margin'));
  assert.equal(promote.ok, true);
  assert.equal(promote.stage, 'SHADOW');
  assert.equal(promote.promoted, true);
  assert.equal(evolutionPromotionGate(parent, parent, 'BASE').missing.includes('winner-is-parent'), true);
  assert.equal(championTrusted(strong), true);
  assert.equal(championTrusted({ variant: { id: 'X' }, metrics: { heldOutN: 3, samples: 80, activityPct: 12, monteCarloPassPct: 90 } }), false);
});

test('seeded production worker ranking fingerprints are deterministic', async () => {
  const a = await runBaseline({ seed: 45, rows: 80, variants: 12, workers: 1, throughputWorkers: 0, write: false, timeoutMs: 60_000 });
  const b = await runBaseline({ seed: 45, rows: 80, variants: 12, workers: 1, throughputWorkers: 0, write: false, timeoutMs: 60_000 });
  assert.equal(a.researchOnly, true);
  assert.equal(a.liveAppTouched, false);
  assert.equal(a.candidateCount, 13);
  assert.equal(a.datasetRows, 80);
  assert.equal(a.workerCount, 1);
  assert.equal(a.scoredWithMetrics, 13);
  assert.equal(a.rankingFingerprint, b.rankingFingerprint);
  assert.equal(a.rankingOrderHash, b.rankingOrderHash);
  assert.equal(a.corpusHash, b.corpusHash);
  assert.equal(a.topN[0].id, b.topN[0].id);
  assert.equal(typeof a.variantsPerSec, 'number');
  assert.ok(a.generationWallMs >= 0);
  assert.ok(a.process.rssPeakBytes >= a.process.rssBeforeBytes);
  assert.ok(a.promotionGate.stage === 'SHADOW' || a.promotionGate.stage === 'RETAIN');
  assert.equal(rankingFingerprint(a.topN.map(x => ({ variant: { id: x.id, ...x }, metrics: x.metrics }))).topN[0].id, a.topN[0].id);
});

test('harness writes only to the requested out dir and not default data/', async () => {
  const outDir = path.join(tmp, 'out');
  const dataDir = path.join(tmp, 'data-sentinel');
  fs.mkdirSync(dataDir);
  const before = fs.readdirSync(dataDir);
  const report = await runBaseline({ seed: 45, rows: 80, variants: 8, workers: 1, throughputWorkers: 0, write: true, outDir, timeoutMs: 60_000 });
  assert.equal(fs.existsSync(path.join(outDir, 'report.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'corpus.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'ranking.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'REPORT.md')), true);
  const written = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  assert.equal(written.rankingFingerprint, report.rankingFingerprint);
  assert.deepEqual(fs.readdirSync(dataDir), before);
  assert.equal(fs.existsSync(path.join(repo, 'data', 'beast-baseline.json')), false);
});

test('committed alpha45 baseline fingerprints stay locked on the frozen corpus', async () => {
  const locked = JSON.parse(fs.readFileSync(path.join(repo, 'artifacts', 'beast-baseline', 'report.json'), 'utf8'));
  assert.equal(locked.schema, 1);
  assert.equal(locked.researchOnly, true);
  assert.equal(locked.candidateCount, 513);
  assert.equal(locked.datasetRows, 250);
  assert.equal(locked.workerCount, 1);
  assert.equal(locked.seed, 45);
  const live = await runBaseline({ seed: 45, rows: 250, variants: 512, workers: 1, throughputWorkers: 0, write: false, timeoutMs: 120_000 });
  assert.equal(live.corpusHash, locked.corpusHash);
  assert.equal(live.rankingFingerprint, locked.rankingFingerprint);
  assert.equal(live.rankingOrderHash, locked.rankingOrderHash);
  assert.equal(live.promotionGate.winnerId, locked.promotionGate.winnerId);
  assert.equal(live.promotionGate.stage, locked.promotionGate.stage);
  assert.deepEqual(live.promotionGate.missing, locked.promotionGate.missing);
});

test('CLI capture is research-only and prints the required summary fields', () => {
  const outDir = path.join(tmp, 'cli');
  const result = spawnSync(process.execPath, [
    path.join(repo, 'scripts', 'beast-baseline-benchmark.mjs'),
    '--seed', '45',
    '--rows', '80',
    '--variants', '6',
    '--workers', '1',
    '--throughput-workers', '0',
    '--out', outDir,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CLUSTER_HUB_URL: '', MONEY_PRINTER_DATA_DIR: path.join(tmp, 'cli-data') },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.researchOnly, true);
  assert.equal(summary.candidateCount, 7);
  assert.equal(summary.datasetRows, 80);
  assert.equal(summary.workerCount, 1);
  assert.ok(summary.rankingFingerprint);
  assert.ok(summary.corpusHash);
  assert.ok(summary.generationWallMs >= 0);
  assert.ok(Number(summary.variantsPerSec) >= 0);
  assert.ok(summary.rssPeakBytes > 0);
  assert.ok(summary.promotionGate === 'SHADOW' || summary.promotionGate === 'RETAIN');
});
