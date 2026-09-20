import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-edge-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
process.env.MONEY_PRINTER_DATA_DIR = root;

const {
  proveRows,
  compareClusterGroups,
  hypothesisStatus,
  summarizeValues
} = await import('../src/edgeProof.js');
const { evaluateSignal, summarizeDelayedEntry } = await import('../src/alphaInsights.js');

function hash(s = '') {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function takeIds(prefix, n, holdout) {
  const ids = [];
  for (let i = 0; ids.length < n; i++) {
    const id = `${prefix}${i}`;
    if ((hash(id) % 5 === 0) === holdout) ids.push(id);
  }
  return ids;
}

function row({ cluster, mint, edge, ret, ts = 0, regime = 'HOT', horizon = 30 }) {
  return {
    mint: mint || cluster,
    proof_cluster: cluster,
    cluster,
    cluster_id: cluster,
    horizon_min: horizon,
    entry_ts: ts,
    edge,
    adjusted_return: ret,
    regime
  };
}

function population({ holdoutHigh, holdoutLow, devHigh, devLow }) {
  const rows = [];
  let ts = 1;
  for (const x of holdoutHigh) rows.push(row({ cluster: x.cluster, edge: x.edge, ret: x.ret, ts: ts++, regime: ts % 2 ? 'HOT' : 'NORMAL' }));
  for (const x of holdoutLow) rows.push(row({ cluster: x.cluster, edge: x.edge, ret: x.ret, ts: ts++, regime: ts % 2 ? 'HOT' : 'NORMAL' }));
  for (const x of devHigh) rows.push(row({ cluster: x.cluster, edge: x.edge, ret: x.ret, ts: ts++, regime: 'HOT' }));
  for (const x of devLow) rows.push(row({ cluster: x.cluster, edge: x.edge, ret: x.ret, ts: ts++, regime: 'NORMAL' }));
  return rows;
}

function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }

test('winsorized cluster mean ignores a single pathological jump', () => {
  const xs = Array.from({ length: 19 }, () => -18).concat([12_000]);
  const s = summarizeValues(xs);
  assert.equal(s.median, -18);
  assert.ok(s.mean > 500, 'raw mean should be dominated by the jump');
  assert.ok(s.robustMean < 0, 'robust mean must stay with the negative bulk');
  assert.equal(s.contaminated, true);
  assert.ok(s.outlierN >= 1);
});

test('outlier contamination cannot produce positive hypothesis or proof evidence', () => {
  const holdoutHighIds = takeIds('HH', 80, true);
  const holdoutLowIds = takeIds('HL', 160, true);
  const devHighIds = takeIds('DH', 80, false);
  const devLowIds = takeIds('DL', 160, false);
  const holdoutHigh = holdoutHighIds.map((cluster, i) => ({
    cluster, edge: 95, ret: i < 5 ? 9000 : -20
  }));
  const holdoutLow = holdoutLowIds.map(cluster => ({ cluster, edge: 40, ret: -4 }));
  const devHigh = devHighIds.map(cluster => ({ cluster, edge: 95, ret: -20 }));
  const devLow = devLowIds.map(cluster => ({ cluster, edge: 40, ret: -4 }));
  const rows = population({ holdoutHigh, holdoutLow, devHigh, devLow });

  const rawHi = holdoutHigh.map(x => Math.max(-100, Math.min(500, x.ret)));
  assert.ok(mean(rawHi) > 5, 'fixture must be a raw-mean trap');
  assert.ok(rawHi.filter(x => x > 0).length / rawHi.length < 0.2);

  const proof = proveRows(rows, 30);
  assert.ok(proof.holdout >= 40);
  assert.ok(proof.topClusters >= 8);
  assert.ok(proof.topMedianAdjustedPct <= 0);
  assert.ok(proof.topPositivePct < 35);
  assert.equal(proof.contaminated, true);
  assert.ok(proof.deltaRawPct > 5, 'raw delta would have looked like an edge');
  assert.ok(proof.deltaPct < 1, 'robust delta must not follow the jumps');
  assert.equal(proof.evidence, false);

  const hi = holdoutHigh.map(x => row({ cluster: x.cluster, edge: x.edge, ret: x.ret }));
  const lo = holdoutLow.map(x => row({ cluster: x.cluster, edge: x.edge, ret: x.ret }));
  const scored = compareClusterGroups(hi, lo, 99, 300);
  assert.equal(scored.contaminated, true);
  assert.ok(scored.hi.median <= 0);
  assert.ok(scored.rawDelta > 5);
  assert.ok(scored.delta < 1);
  assert.equal(hypothesisStatus(scored), 'WEAK');

  const insight = evaluateSignal(rows.filter(r => hash(r.proof_cluster) % 5 === 0), {
    id: 'ALL:edge', title: 'edge top quartile vs rest', feature: 'edge', regime: 'ALL',
    payload_json: JSON.stringify({ cut: 95 }), status: 'POSITIVE EVIDENCE'
  });
  assert.ok(insight);
  assert.equal(insight.contaminated, true);
  assert.equal(insight.qualityScore, 0);
  assert.ok(insight.deltaPct < 1);
  assert.ok(insight.rawDeltaPct > 5);
});

test('broad moderate positive signal still passes proof, mining, and leaderboard', () => {
  const holdoutHighIds = takeIds('GH', 80, true);
  const holdoutLowIds = takeIds('GL', 160, true);
  const devHighIds = takeIds('GDH', 80, false);
  const devLowIds = takeIds('GDL', 160, false);
  const holdoutHigh = holdoutHighIds.map((cluster, i) => ({ cluster, edge: 95, ret: 8 + (i % 5) }));
  const holdoutLow = holdoutLowIds.map((cluster, i) => ({ cluster, edge: 40, ret: -2 + (i % 3) }));
  const devHigh = devHighIds.map((cluster, i) => ({ cluster, edge: 95, ret: 8 + (i % 5) }));
  const devLow = devLowIds.map((cluster, i) => ({ cluster, edge: 40, ret: -2 + (i % 3) }));
  const rows = population({ holdoutHigh, holdoutLow, devHigh, devLow });

  const proof = proveRows(rows, 30);
  assert.ok(proof.holdout >= 40);
  assert.ok(proof.deltaPct > 5);
  assert.ok(proof.ciLow > 0);
  assert.ok(proof.topMedianAdjustedPct > 0);
  assert.equal(proof.contaminated, false);
  assert.equal(proof.evidence, true);

  const hi = holdoutHigh.map(x => row({ cluster: x.cluster, edge: x.edge, ret: x.ret }));
  const lo = holdoutLow.map(x => row({ cluster: x.cluster, edge: x.edge, ret: x.ret }));
  const scored = compareClusterGroups(hi, lo, 7, 300);
  assert.equal(scored.contaminated, false);
  assert.ok(scored.delta > 5);
  assert.ok(scored.ci.lo > 0);
  assert.equal(hypothesisStatus(scored), 'POSITIVE EVIDENCE');

  const insight = evaluateSignal(rows.filter(r => hash(r.proof_cluster) % 5 === 0), {
    id: 'ALL:edge', title: 'edge top quartile vs rest', feature: 'edge', regime: 'ALL',
    payload_json: JSON.stringify({ cut: 95 }), status: 'POSITIVE EVIDENCE'
  });
  assert.ok(insight);
  assert.equal(insight.contaminated, false);
  assert.ok(insight.deltaPct > 5);
  assert.ok(insight.lowerCiPct > 0);
  assert.ok(insight.qualityScore > 0);
});

test('delayed-entry leaderboard does not pick a jump-contaminated delay', () => {
  const contaminated = [];
  for (let i = 0; i < 80; i++) {
    contaminated.push({
      mint: `M${i}`, cluster: `C${i}`,
      0: -3, 10: -1, 30: -2, 60: i === 0 ? 4000 : -8
    });
  }
  const jumped = summarizeDelayedEntry(contaminated);
  const bucket60 = jumped.rows.find(x => x.delaySec === 60);
  assert.ok(bucket60.rawAvgAdjustedPct > 20);
  assert.ok(bucket60.medianAdjustedPct < 0);
  assert.equal(bucket60.contaminated, true);
  assert.notEqual(jumped.bestDelaySec, 60);
  assert.equal(jumped.bestDelaySec, 10);
  assert.equal(jumped.status, 'MEASURED');

  const genuine = [];
  for (let i = 0; i < 80; i++) {
    genuine.push({
      mint: `G${i}`, cluster: `G${i}`,
      0: 1, 10: 4.5, 30: 2, 60: 1.2
    });
  }
  const clean = summarizeDelayedEntry(genuine);
  assert.equal(clean.rows.every(x => x.contaminated === false), true);
  assert.equal(clean.bestDelaySec, 10);
  assert.ok(clean.rows.find(x => x.delaySec === 10).avgAdjustedPct > 3);
});

test('computeEdgeProof does not quarantine outcomes out of the production-learning population', () => {
  const s = fs.readFileSync(new URL('../src/edgeProof.js', import.meta.url), 'utf8');
  const start = s.indexOf('export function computeEdgeProof');
  const end = s.indexOf('export function writeEdgeProof');
  const fn = s.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.equal(/isImpossibleOutcome/.test(fn), false);
  assert.equal(/quarantined/.test(fn), false);
  assert.match(fn, /productionLearningUnlocked:proven/);
});
