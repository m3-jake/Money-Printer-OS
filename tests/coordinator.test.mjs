import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreDatabase } from '../src/core/database.js';
import { Coordinator, ACKS_SCHEMA, LIMITS, decideExperiment, evaluateHypothesis } from '../src/core/coordinator.js';
import { Intelligence } from '../src/core/intelligence.js';
import { MarketEventBus } from '../src/core/eventBus.js';
import { BotFarm } from '../src/botFarm.js';
import { paperBotRows } from '../src/scoreboard.js';
import { pathToFileURL } from 'node:url';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-coord-'));
  const store = new CoreDatabase(path.join(dir, 'core.sqlite'));
  const c = new Coordinator(store, new MarketEventBus(), { dataDir: dir });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, c };
}
const fresh = { id: 'robinhood-strategy', kind: 'paper', closes: 0, netPnl: 0, freshness: { status: 'FRESH' } };

test('bounded durable requests survive restart and unchanged phase chatter cannot duplicate work', t => {
  const { c, store, dir } = fixture(t), now = 1_000_000;
  c.tick({ now, rows: [fresh] });
  const first = c.pendingRequests(now);
  assert.equal(first.length, LIMITS.dispatchPerTick);
  const r = first.find(r => r.module === 'robinhood-crypto'); assert.ok(r);
  const restarted = new Coordinator(store, null, { dataDir: dir });
  restarted.tick({ now: now + 1, rows: [fresh] });
  assert.equal(restarted.pendingRequests(now + 1).find(x => x.module === r.module).id, r.id);
  assert.ok(restarted.pendingRequests(now + 1).length <= LIMITS.maxPending);
  restarted.tick({ now: now + 2, rows: [{ ...fresh, netPnl: 0.1 }] });
  assert.equal(restarted.pendingRequests(now + 2).find(x => x.module === r.module).id, r.id);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'lab-link/coordinator-requests.json')));
  assert.equal(doc.executionAuthority, false); assert.equal(doc.liveAuthority, false);
  assert.equal(doc.requests.length, restarted.pendingRequests(now + 2).length);
});

test('completion and unchanged-evidence receipts stop retries; new outcomes wake a new identity', t => {
  const { c } = fixture(t), now = 2_000_000;
  c.tick({ now, rows: [fresh] });
  const r = c.pendingRequests(now).find(x => x.module === 'robinhood-crypto');
  assert.equal(c.applyAcks({ schema: ACKS_SCHEMA, acks: [{ requestId: r.id, at: now + 1, module: 'wrong', status: 'COMPLETED' }] }, now + 1), 0);
  assert.equal(c.applyAcks({ schema: ACKS_SCHEMA, acks: [{ requestId: r.id, at: now - 1, status: 'COMPLETED' }] }, now + 1), 0);
  assert.equal(c.applyAcks({ schema: ACKS_SCHEMA, acks: [{ requestId: r.id, at: now + 1, status: 'COMPLETED' }] }, now + 1), 0, 'completion requires an actual finished job receipt');
  c.applyAcks({ schema: ACKS_SCHEMA, acks: [{ requestId: r.id, at: now + 1, status: 'DEDUPED_UNCHANGED_EVIDENCE' }] }, now + 1);
  c.tick({ now: now + 2, rows: [fresh] });
  assert.ok(!c.pendingRequests(now + 2).some(x => x.module === r.module));
  assert.equal(c.snapshot().modules.find(x => x.id === r.module).dispatch.status, 'DONE_FOR_THIS_EVIDENCE');
  c.tick({ now: now + 3, rows: [{ ...fresh, closes: 1, lastCloseAt: now + 2 }] });
  assert.notEqual(c.pendingRequests(now + 3).find(x => x.module === r.module).id, r.id);
});

test('failed/expired requests back off and an existing request is not replaced by fresh evidence', t => {
  const { c } = fixture(t), now = 3_000_000;
  c.tick({ now, rows: [fresh] });
  const r = c.pendingRequests(now).find(x => x.module === 'robinhood-crypto');
  c.tick({ now: now + 1, rows: [{ ...fresh, closes: 1 }] });
  assert.equal(c.pendingRequests(now + 1).find(x => x.module === r.module).id, r.id);
  c.applyAcks({ schema: ACKS_SCHEMA, acks: [{ requestId: r.id, at: now + 2, status: 'FAILED', reason: 'provider offline' }] }, now + 2);
  c.tick({ now: now + 3, rows: [{ ...fresh, closes: 1 }] });
  assert.equal(c.snapshot().modules.find(x => x.id === r.module).dispatch.status, 'BACKOFF');
  c.tick({ now: now + LIMITS.minBackoffMs + 3, rows: [{ ...fresh, closes: 1 }] });
  assert.ok(c.pendingRequests(now + LIMITS.minBackoffMs + 3).some(x => x.module === r.module));
});

test('aging eventually serves lower priority lanes despite fresh high priority work', t => {
  const { c, store } = fixture(t), now = 4_000_000;
  c.tick({ now, rows: [fresh] });
  store.db.prepare("UPDATE coordinator_requests SET status='COMPLETED'").run();
  // Keep high-priority lanes freshly served, while US combos have waited a full day.
  for (const id of ['kalshi-weather', 'kalshi-btc', 'robinhood-crypto', 'robinhood-equities', 'polymarket-clob']) {
    const key = `coord:module:${id}`, state = c.memory(key); state.lastServedAt = now + 86_400_000; c.remember(key, state, now);
  }
  c.tick({ now: now + 86_400_000, rows: [{ ...fresh, closes: 1 }] });
  assert.equal(c.snapshot().modules.find(x => x.id === 'polymarket-us').dispatch.status, 'DISPATCHED');
});

test('prospective decisions do not mutate accounting or treat absent controls as evidence', t => {
  const { c } = fixture(t), row = { ...fresh, closes: 25, minCloses: 20, netPnl: -2, netWithoutBest: -3 };
  const before = structuredClone(row); c.tick({ now: 5_000_000, rows: [row] }); assert.deepEqual(row, before);
  assert.equal(decideExperiment(row).decision, 'REJECT');
  assert.equal(decideExperiment({ ...row, closes: 3, experiment: { evaluationEndsAt: 1 } }).decision, 'REVISE');
  const h = { id: 'ablation', treatment: row.id, control: 'missing-control', baseline: 'momentum', expiresAfterMs: 86_400_000 };
  assert.equal(evaluateHypothesis(h, new Map([[row.id, { ...row, beatsBaseline: 'YES' }]])).status, 'COLLECTING');
  assert.equal(evaluateHypothesis(h, new Map([[row.id, { ...row, beatsBaseline: 'YES' }], ['missing-control', row]])).status, 'COMPARABILITY_UNVERIFIED');
});

test('real Lab frozen exploratory nomination reaches separate trader admission and coordinator evaluation without qualification', async t => {
  const { c, dir } = fixture(t), now = Date.UTC(2026, 9, 3, 12);
  const labRoot = path.resolve('..', 'money-printer-evolution-lab');
  const { exploratoryProposals } = await import(pathToFileURL(path.join(labRoot, 'src/exploratoryProposals.js')));
  const doc = exploratoryProposals({ dir: path.join(dir, 'lab-fixture'), now, codeHash: 'a'.repeat(64), families: {
    weather: { corpusHash: 'b'.repeat(64), best: { corpusHash: 'b'.repeat(64), validationN: 30, validationMeanPerBet: 0.1, v: { minEdge: 0.05 } } }
  } });
  fs.mkdirSync(path.join(dir, 'lab-link'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lab-link/exploratory-proposals.json'), JSON.stringify(doc));
  c.tick({ now, rows: [] });
  assert.equal(c.snapshot().modules.find(x => x.id === 'kalshi-weather').stage, 'ADMISSION');
  const farm = new BotFarm({ dataDir: dir, bots: {}, now: () => now }); farm.variants(); farm.save();
  const admitted = Object.values(farm.state.books).filter(b => b.experiment);
  assert.equal(admitted.length, 1); assert.equal(admitted[0].cashUsd, 25); assert.equal(admitted[0].startUsd, 25);
  assert.equal(admitted[0].experiment.qualificationEffect, 'NONE'); assert.equal(admitted[0].experiment.paperPromotionAllowed, false);
  const row = paperBotRows({ farm: farm.snapshot() }, { now }).find(r => r.exploratory);
  assert.ok(row); c.tick({ now: now + 1, rows: [{ ...row, freshness: { status: 'FRESH' } }] });
  const lane = c.snapshot().modules.find(x => x.id === 'kalshi-weather');
  assert.equal(lane.stage, 'EVALUATE'); assert.equal(lane.exploratory.admitted[0].experiment, doc.proposals[0].id);
  assert.equal(lane.decisions[0].decision, 'CONTINUE'); assert.equal(admitted[0].history.length, 0);
  assert.equal(lane.executionAuthority, false);
});

test('published trader request reaches actual Lab consumer and returns a bound completed receipt', async t => {
  const { c, dir } = fixture(t), now = 6_000_000;
  const { consumeCoordinatorRequests } = await import(pathToFileURL(path.join(path.resolve('..', 'money-printer-evolution-lab'), 'src/coordinatorRequests.js')));
  c.tick({ now, rows: [fresh] });
  const request = c.pendingRequests(now).find(r => r.labModule === 'robinhood'); assert.ok(request);
  const scheduler = { profile: 'MAX_RESEARCH', state: { jobs: [], lanes: {} }, enqueue(spec) { this.state.jobs.push({ ...spec, state: 'QUEUED' }); return { accepted: true }; } };
  const args = { cfg: { traderDataDir: dir, labDataDir: path.join(dir, 'lab') }, scheduler, ids: ['robinhood'], fingerprintOf: () => ({ fingerprint: 'fixture-evidence', hasInput: true }), cooldownOf: () => 1000 };
  consumeCoordinatorRequests({ ...args, now: now + 1 });
  c.tick({ now: now + 2, rows: [fresh] });
  assert.equal(c.pendingRequests(now + 2).find(r => r.id === request.id).status, 'ACKNOWLEDGED');
  const job = scheduler.state.jobs[0]; job.state = 'COMPLETED'; job.finishedAt = now + 3;
  consumeCoordinatorRequests({ ...args, now: now + 4 }); c.tick({ now: now + 5, rows: [fresh] });
  const lane = c.snapshot().modules.find(m => m.id === request.module);
  assert.equal(lane.lastExperiment.jobId, job.id); assert.equal(lane.lastExperiment.completedAt, now + 3);
  assert.equal(lane.dispatch.status, 'DONE_FOR_THIS_EVIDENCE'); assert.equal(lane.receipts[0].inputHash, undefined);
  assert.equal(lane.executionAuthority, false); assert.equal(lane.lastExperiment.after.books[fresh.id].closes, 0);
});

test('feed notifications coalesce one intelligence coordination wake and close cancels it', async t => {
  const { store } = fixture(t), bus = new MarketEventBus(), i = new Intelligence(store, bus);
  t.after(() => i.close());
  let passes = 0; const tick = i.coordinator.tick.bind(i.coordinator); i.coordinator.tick = x => { passes++; return tick(x); };
  i.observe({ at: Date.now(), rows: [fresh] });
  for (let n = 0; n < 10; n++) bus.publish('MARKET_PRICE_UPDATED', { n });
  await new Promise(r => setTimeout(r, 1150)); assert.equal(passes, 2);
  bus.publish('MARKET_PRICE_UPDATED', {}); await new Promise(r => setImmediate(r));
  i.close(); await new Promise(r => setTimeout(r, 1100)); assert.equal(passes, 2);
});
