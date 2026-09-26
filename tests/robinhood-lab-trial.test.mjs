// Lab paper trials (docs/FITNESS-LEDGER.md): a cleared Lab proposal is applied to PAPER params only when
// ROBINHOOD_LAB_AUTO_APPLY_PAPER=true, then kept or reverted after 20 closes. Offline; nothing is sent anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-rh-trial-'));
process.env.MONEY_PRINTER_DATA_DIR = path.join(root, 'data');
Object.assign(process.env, { ROBINHOOD_AUTOSTART: 'false', POLYMARKET_AUTOSTART: 'false', ROBINHOOD_API: 'https://rh.test', ROBINHOOD_SYMBOLS: 'BTC-USD', ROBINHOOD_API_KEY: '', ROBINHOOD_PRIVATE_KEY: '' });
const nativeFetch = globalThis.fetch;
globalThis.fetch = async url => { throw new Error('unexpected network call ' + url); };
const T = await import('../src/robinhoodTape.js'), S = await import('../src/robinhoodStrategy.js'), J = await import('../src/robinhoodJournal.js'), E = await import('../src/robinhoodEvolve.js');
const RH = await import('../src/robinhoodAutoTrader.js');
const { readProjectJournal } = await import('../src/projectJournal.js');
const DAY = 864e5, T0 = Date.UTC(2026, 8, 26, 12);
test.after(() => { RH.stopRobinhoodLoops(); globalThis.fetch = nativeFetch; fs.rmSync(root, { recursive: true, force: true }); delete process.env.ROBINHOOD_LAB_AUTO_APPLY_PAPER; });

function reset({ tapeDays = 8, src = 'robinhood' } = {}) {
  RH.__testing.reset();
  fs.rmSync(process.env.MONEY_PRINTER_DATA_DIR, { recursive: true, force: true }); fs.mkdirSync(process.env.MONEY_PRINTER_DATA_DIR, { recursive: true });
  RH.__testing.setClock(() => T0);
  fs.mkdirSync(T.TAPE_DIR, { recursive: true });
  const n = Math.floor(tapeDays * DAY / (15 * 60000)), rows = [];
  for (let i = 0; i < n; i++) { const t = T0 - (n - 1 - i) * 15 * 60000, mid = 100000 * (1 + 0.001 * Math.sin(i / 7)); rows.push({ t, bid: mid * 0.9999, ask: mid * 1.0001, src }); }
  fs.writeFileSync(T.tapeFile('BTC-USD'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.env.ROBINHOOD_LAB_AUTO_APPLY_PAPER = 'true';
}
const paper = () => { const p = J.loadPaper(); p.params = S.normalizeParams({ ...p.params, sampleMs: RH.__testing.TICK_MS }); p.paramsHash = S.paramsHash(p.params); return p; };
function addCloses(hash, n, pnl, startAt) {
  const p = J.loadPaper();
  for (let i = 0; i < n; i++) p.history.unshift({ id: `c${hash}${i}${startAt}`, symbol: 'BTC-USD', status: 'CLOSED', placedBy: 'paper-autopilot', closedBy: 'strategy', paramsHash: hash, pnlUsd: typeof pnl === 'function' ? pnl(i) : pnl, closedAt: startAt + (i + 1) * 60000 });
  J.savePaper(p, { force: true });
}
function propose(params, basisHash, extra = {}) {
  const norm = S.normalizeParams({ ...params, sampleMs: RH.__testing.TICK_MS }), doc = { schema: 'mpo.lab-module-champion.v1', module: 'robinhood', stateSchema: 'mpo.champion-state.v1', state: 'PAPER', paperPromotionAllowed: true, qualificationStage: 'PAPER_REVIEW', liveActivationAllowed: false, automaticLivePromotionAllowed: false, liveExecution: 'manual', proposalVersion: 1, supersedes: null, basis: { incumbentHash: basisHash, trials: 12 }, publishedAt: T0, candidate: { params: norm, paramsHash: S.paramsHash(norm) }, ...extra };
  fs.mkdirSync(path.dirname(RH.__testing.labChampionFile), { recursive: true }); fs.writeFileSync(RH.__testing.labChampionFile, JSON.stringify(doc));
  return doc.candidate.paramsHash;
}
const candidateParams = base => E.mutateParams(base, E.mulberry32(3));

test('off by default and refuses unless every condition holds', () => {
  reset(); const p = paper(); addCloses(p.paramsHash, 25, i => (i % 3 ? 2 : -1), T0 - 3 * DAY);
  const cand = candidateParams(p.params), hash = propose(cand, p.paramsHash);
  delete process.env.ROBINHOOD_LAB_AUTO_APPLY_PAPER;
  assert.deepEqual(RH.labProposalPass({ at: T0 }), { ran: false, reason: 'autoApplyOff' });
  process.env.ROBINHOOD_LAB_AUTO_APPLY_PAPER = 'true';
  propose(cand, 'someoneelse'); assert.match(RH.labProposalPass({ at: T0 }).reason, /basis/);
  propose(cand, p.paramsHash, { qualificationStage: 'RESEARCH_ONLY' }); assert.match(RH.labProposalPass({ at: T0 }).reason, /not cleared/);
  propose(cand, p.paramsHash, { paperPromotionAllowed: false }); assert.match(RH.labProposalPass({ at: T0 }).reason, /not cleared/);
  propose({ ...cand, maxSpreadBps: 999 }, p.paramsHash); assert.match(RH.labProposalPass({ at: T0 }).reason, /bounds|basis|running/);
  assert.equal(paper().paramsHash, p.paramsHash, 'nothing was applied');
  assert.ok(hash);
});

test('thin or synthetic evidence refuses the proposal', () => {
  reset({ tapeDays: 3 }); let p = paper(); addCloses(p.paramsHash, 25, 1, T0 - DAY); propose(candidateParams(p.params), p.paramsHash);
  assert.match(RH.labProposalPass({ at: T0 }).reason, /evidence: evidence spans/);
  reset({ src: 'coinbase-public-paper' }); p = paper(); addCloses(p.paramsHash, 25, 1, T0 - DAY); propose(candidateParams(p.params), p.paramsHash);
  assert.match(RH.labProposalPass({ at: T0 }).reason, /no executable venue prices/);
  reset(); p = paper(); addCloses(p.paramsHash, 5, 1, T0 - DAY); propose(candidateParams(p.params), p.paramsHash);
  assert.match(RH.labProposalPass({ at: T0 }).reason, /5 of 20 paper closes/);
});

test('apply starts a trial; 20 better closes keep it', () => {
  reset(); const p = paper(), inc = p.paramsHash; addCloses(inc, 25, i => (i % 2 ? 2 : -1.5), T0 - 3 * DAY);
  const hash = propose(candidateParams(p.params), inc);
  const r = RH.labProposalPass({ at: T0 });
  assert.equal(r.decision, 'applied'); assert.equal(paper().paramsHash, hash);
  let f = RH.robinhoodFitnessParts({ at: T0 });
  assert.equal(f.trial.status, 'RUNNING'); assert.equal(f.trial.closes, 0); assert.equal(f.trial.needed, 20); assert.equal(f.running.source, 'lab-auto');
  assert.equal(E.loadEvolveLedger().applied.by, 'lab-auto');
  assert.equal(RH.labProposalPass({ at: T0 + 60000 }).decision, 'running');
  addCloses(hash, 20, i => (i % 4 ? 2 : -1), T0);
  const k = RH.labProposalPass({ at: T0 + DAY });
  assert.equal(k.decision, 'kept', k.reason); assert.equal(paper().paramsHash, hash);
  f = RH.robinhoodFitnessParts({ at: T0 + DAY });
  assert.equal(f.trial.status, 'KEPT'); assert.equal(f.lastDecision.action, 'kept');
  const titles = readProjectJournal(path.join(process.env.MONEY_PRINTER_DATA_DIR, 'project-journal.ndjson')).map(x => x.title);
  assert.ok(titles.some(t => /trial .* started/.test(t)) && titles.some(t => /trial .* kept/.test(t)), 'decisions reach the project journal');
});

test('a worse trial reverts to the incumbent and is never applied again', () => {
  reset(); const p = paper(), inc = p.paramsHash, incParams = p.params; addCloses(inc, 25, i => (i % 4 ? 2 : -1), T0 - 3 * DAY);
  const hash = propose(candidateParams(p.params), inc);
  assert.equal(RH.labProposalPass({ at: T0 }).decision, 'applied');
  addCloses(hash, 20, i => (i % 2 ? 1 : -2), T0);
  const r = RH.labProposalPass({ at: T0 + DAY });
  assert.equal(r.decision, 'reverted'); assert.equal(paper().paramsHash, inc); assert.deepEqual(paper().params, incParams);
  assert.equal(RH.robinhoodFitnessParts({ at: T0 + DAY }).trial.status, 'REVERTED');
  propose(candidateParams(incParams), inc);
  assert.match(RH.labProposalPass({ at: T0 + DAY + 1 }).reason, /reverted before/);
});

test('a trial with no close in 14 days reverts; a hand edit abandons it', () => {
  reset(); let p = paper(), inc = p.paramsHash; addCloses(inc, 25, 1, T0 - 3 * DAY);
  propose(candidateParams(p.params), inc);
  assert.equal(RH.labProposalPass({ at: T0 }).decision, 'applied');
  assert.equal(RH.labProposalPass({ at: T0 + 13 * DAY }).decision, 'running');
  const r = RH.labProposalPass({ at: T0 + 15 * DAY });
  assert.equal(r.decision, 'reverted'); assert.match(r.reason, /no close in 14 days/); assert.equal(paper().paramsHash, inc);
  reset(); p = paper(); inc = p.paramsHash; addCloses(inc, 25, 1, T0 - 3 * DAY);
  propose(candidateParams(p.params), inc);
  assert.equal(RH.labProposalPass({ at: T0 }).decision, 'applied');
  RH.setRobinhoodPaperAutopilot({ params: { ...paper().params, maxHoldMin: 45 } });
  assert.equal(RH.labProposalPass({ at: T0 + 1000 }).decision, 'abandoned');
});
