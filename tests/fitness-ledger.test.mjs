import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneMayPropose, evidenceThresholds, EVIDENCE_DEFAULTS } from '../src/evidenceFlags.js';
import { fitnessDoc, fitnessSnapshot, paperRecordFrom, solanaRunningPolicy, solanaFitnessParts, polymarketFitnessParts, writeFitnessFiles, readFitnessFile, FITNESS_SCHEMA, FITNESS_MAX_BYTES } from '../src/fitnessLedger.js';
import { traderStatusRecord } from '../src/labLink.js';

const good = { executablePrices: true, spanDays: 8, closes: 25, venueShare: 0.97, syntheticShare: 0.03 };

test('evidence gate fails closed and can only be tightened', () => {
  assert.equal(laneMayPropose(good).ok, true);
  const none = laneMayPropose({});
  assert.equal(none.ok, false); assert.equal(none.blockers.length, 5);
  assert.match(laneMayPropose({ ...good, executablePrices: 'yes' }).blockers[0], /executable/);
  assert.match(laneMayPropose({ ...good, venueShare: 0.5 }).blockers[0], /50%; need 90%/);
  const loose = evidenceThresholds({ minSpanDays: 1, minCloses: 2, minVenueShare: 0.1, maxSyntheticShare: 0.9, requireExecutablePrices: false });
  assert.deepEqual(loose, { ...EVIDENCE_DEFAULTS });
  assert.equal(laneMayPropose(good, { minCloses: 30 }).ok, false, 'tightening works');
});

test('a module record carries the safety flags, a verdict and JSON-safe numbers', () => {
  const blocked = fitnessDoc('robinhood', { evidence: { executablePrices: false } }, { now: 5 });
  assert.equal(blocked.schema, FITNESS_SCHEMA); assert.equal(blocked.liveExecution, 'manual'); assert.equal(blocked.liveActivationAllowed, false); assert.equal(blocked.automaticLivePromotionAllowed, false);
  assert.equal(blocked.verdict, 'BLOCKED'); assert.equal(blocked.mayPropose.ok, false);
  assert.equal(fitnessDoc('robinhood', { evidence: good }).verdict, 'KEEP_RESEARCHING');
  assert.equal(fitnessDoc('robinhood', { evidence: good, park: 'vol gate binding' }).verdict, 'PARK');
  assert.equal(fitnessDoc('robinhood', { evidence: good, blockers: ['journal needs recovery'] }).verdict, 'BLOCKED');
  assert.throws(() => fitnessDoc('kalshi', {}), /unknown fitness module/);
  const rec = paperRecordFrom([{ pnl: 2, closedAt: 1 }, { pnl: 3, closedAt: 2 }], { unit: 'USD', startBalance: 100, now: 3 });
  assert.equal(rec.profitFactor, null); assert.equal(rec.profitFactorUnbounded, true); assert.equal(rec.hitRate, 1);
  const dd = paperRecordFrom([{ pnl: 5, closedAt: 1 }, { pnl: -3, closedAt: 2 }, { pnl: -1, closedAt: 3 }, { pnl: 4, closedAt: 4 }], { unit: 'USD', startBalance: 200 });
  assert.equal(dd.maxDrawdown, 4); assert.equal(dd.maxDrawdownPct, 2); assert.equal(dd.profitFactor, 2.25);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(fitnessSnapshot({ robinhood: { evidence: good, paperRecord: rec } }))));
});

test('Solana: the running FAIR policy is published and the lane stays blocked without executable prices', () => {
  const runtime = { profile: 'FAIR', exitPreset: 'fair' };
  const pol = solanaRunningPolicy(runtime, {});
  assert.equal(pol.stopPct, 8); assert.equal(pol.takePct, 12); assert.equal(pol.maxHoldMin, 90); assert.match(pol.hash, /^[0-9a-f]{16}$/);
  assert.equal(solanaRunningPolicy(runtime, {}).hash, pol.hash, 'stable hash');
  const history = [...Array.from({ length: 30 }, (_, i) => ({ exitPreset: 'fair', pnlSol: i % 3 ? 0.01 : -0.02, closedAt: 1000 + i })), { exitPreset: 'sprint', pnlSol: 5, closedAt: 5 }];
  const doc = fitnessDoc('solana', solanaFitnessParts({ runtime, history }, {}));
  assert.equal(doc.paperRecord.closes, 30, 'only closes under the running preset'); assert.equal(doc.paperRecord.unit, 'SOL');
  assert.equal(doc.evidence.executablePrices, false); assert.equal(doc.verdict, 'BLOCKED');
  assert.ok(doc.blockers.includes('no executable venue prices'));
  const st = traderStatusRecord({ runtime, history }, { now: 1, nodeId: 'n', name: 'x' });
  assert.equal(st.runningPolicy.hash, pol.hash); assert.equal(st.runningPolicy.module, 'solana');
});

test('Polymarket record comes from the shadow summary and stays blocked while combos are parked', () => {
  const doc = fitnessDoc('polymarket', polymarketFitnessParts({ byWindow: { LATE: { settled: 4, hitRate: 0.5, pnlUsd: -3 }, EARLY: { settled: 0, hitRate: null, pnlUsd: 0 } }, trackedLegs: 99, blockers: ['LATE: 4/20 settled shadow combos'], combosParked: true }));
  assert.equal(doc.paperRecord.closes, 4); assert.equal(doc.paperRecord.hitRate, 0.5); assert.equal(doc.paperRecord.netPnl, -3);
  assert.equal(doc.verdict, 'BLOCKED'); assert.ok(doc.blockers.some(b => /4\/20/.test(b))); assert.ok(doc.blockers.some(b => /parked/.test(b)));
});

test('files are written atomically per module and bad files read as missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-fitness-'));
  try {
    const snap = fitnessSnapshot({ solana: solanaFitnessParts({ runtime: { exitPreset: 'fair' }, history: [] }, {}), robinhood: { evidence: good }, polymarket: null, now: 7 });
    assert.equal(snap.modules.polymarket.verdict, 'BLOCKED'); assert.ok(snap.modules.polymarket.blockers.includes('polymarket fitness unavailable'));
    const out = writeFitnessFiles(dir, snap);
    assert.deepEqual(out, { written: ['solana', 'robinhood', 'polymarket'], errors: [] });
    assert.equal(readFitnessFile(dir, 'robinhood').verdict, 'KEEP_RESEARCHING');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'lab-link', 'fitness')).sort(), ['polymarket.json', 'robinhood.json', 'solana.json']);
    fs.writeFileSync(path.join(dir, 'lab-link', 'fitness', 'solana.json'), '{"schema":"mpo.fitness');
    assert.equal(readFitnessFile(dir, 'solana'), null);
    fs.writeFileSync(path.join(dir, 'lab-link', 'fitness', 'polymarket.json'), JSON.stringify({ schema: FITNESS_SCHEMA, module: 'polymarket', pad: 'x'.repeat(FITNESS_MAX_BYTES) }));
    assert.equal(readFitnessFile(dir, 'polymarket'), null, 'over the byte cap');
    const big = writeFitnessFiles(dir, { modules: { robinhood: { ...snap.modules.robinhood, pad: 'x'.repeat(FITNESS_MAX_BYTES) } } });
    assert.match(big.errors[0], /exceeds/); assert.equal(readFitnessFile(dir, 'robinhood').verdict, 'KEEP_RESEARCHING', 'the old file survives a refused write');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
