import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint } from '../src/core/model.js';
import { CoreDatabase } from '../src/core/database.js';
import { StrategyRegistry, promotionCheck } from '../src/core/strategies.js';
import { verifyLabProvenance, syncLabChampion, LAB_CHAMPION_SOURCES } from '../src/core/labSync.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const lab = path.resolve(root, '../money-printer-evolution-lab');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-provenance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const publisher = await import(pathToFileURL(path.join(lab, 'src/labProvenance.js')));
  const doc = { schema: 'mpo.lab-robinhood-champion.v1', candidate: { id: 'real-publisher-contract-test', params: { lookback: 20 },
    holdout: { trades: 40, netReturnPct: 2, maxDrawdownPct: 10 } }, evidence: { feesModeled: true }, qualificationStage: 'PAPER', paperPromotionAllowed: true };
  doc.provenance = publisher.buildProvenance('robinhood', doc, { traderDataDir: dir, evaluatorVersion: 'robinhood-backtest.v1', datasetInput: { symbol: 'BTC-USD', records: [], fixture: true } });
  return { dir, doc, publisher };
}

test('actual Lab publisher transports frozen dataset/code/output receipts to the trader; common gate stays intact', async t => {
  const { dir, doc } = await fixture(t);
  const verified = verifyLabProvenance(doc, { dataDir: dir });
  assert.equal(verified.status, 'VERIFIED', verified.blockers.join(','));
  assert.equal(verified.evaluatorOutput.sampleSize, 40); assert.equal(verified.receipts.length, 3);
  assert.equal(fs.existsSync(path.join(dir, doc.provenance.dataset.path)), true);
  const store = new CoreDatabase(':memory:'); t.after(() => store.close());
  const registry = new StrategyRegistry(store), source = LAB_CHAMPION_SOURCES.find(x => x.id === 'lab-robinhood');
  const receipt = syncLabChampion(registry, source, doc, { dataDir: dir });
  const s = registry.get(source.id);
  assert.deepEqual(s.params, doc.candidate.params); assert.equal(receipt.provenance.status, 'VERIFIED');
  assert.equal(s.evidence.verifiedEvaluatorOutput, true); assert.equal(s.state, 'BACKTESTING');
  assert.ok(promotionCheck('PAPER', s.evidence).blockers.includes('EVALUATOR_VERSION_UNVERIFIED'));
  assert.equal(s.allocationUsd, 0); assert.equal(s.executionMode, 'PAPER');
});

test('dataset corruption, output disagreement and missing freeze receipt fail closed', async t => {
  const { dir, doc } = await fixture(t);
  const noReceipt = structuredClone(doc); noReceipt.provenance.receipts = [];
  assert.equal(verifyLabProvenance(noReceipt, { dataDir: dir }).status, 'UNVERIFIED');
  const modified = structuredClone(doc); modified.provenance.evaluatorOutput.sampleSize = 41;
  modified.provenance.evaluatorOutputHash = fingerprint(modified.provenance.evaluatorOutput);
  assert.ok(verifyLabProvenance(modified, { dataDir: dir }).blockers.includes('EVALUATOR_OUTPUT_DISAGREES_WITH_SUMMARY'));
  fs.writeFileSync(path.join(dir, doc.provenance.dataset.path), '{"corrupt":true}');
  assert.equal(verifyLabProvenance(doc, { dataDir: dir }).status, 'REJECTED');
});

test('registry refuses output fields altered after verification and preserves operator pauses', async t => {
  const { dir, doc } = await fixture(t), store = new CoreDatabase(':memory:'); t.after(() => store.close());
  const registry = new StrategyRegistry(store), source = LAB_CHAMPION_SOURCES.find(x => x.id === 'lab-robinhood');
  syncLabChampion(registry, source, doc, { dataDir: dir });
  const s = registry.get(source.id), verification = verifyLabProvenance(doc, { dataDir: dir });
  registry.attachLabEvidence(s.id, { ...s.evidence, sampleSize: 100000 }, verification, 'test altered evaluator output');
  assert.equal(registry.get(s.id).evidence.verifiedEvaluatorOutput, false);
  registry.transition(s.id, 'PAUSED', { reason: 'Operator hold' });
  const receipt = syncLabChampion(registry, source, doc, { dataDir: dir });
  assert.equal(receipt.state, 'PAUSED'); assert.match(receipt.skipped, /user decision/);
});

test('publisher without explicit evaluated inputs cannot create verified provenance', async t => {
  const { dir, doc, publisher } = await fixture(t);
  doc.provenance = publisher.buildProvenance('robinhood', doc, { traderDataDir: dir });
  assert.equal(doc.provenance.status, 'UNAVAILABLE');
  assert.equal(verifyLabProvenance(doc, { dataDir: dir }).status, 'UNVERIFIED');
});
