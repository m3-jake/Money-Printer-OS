// Robinhood stocks & ETFs lane <-> Evolution Lab (robinhood-equities): longer Alpaca history (>= 6 years, older weekday
// bars kept), the lab-link bar hand-off, and the Lab champion applied only when championState clears it for paper and
// its params are within bounds. Mocked fetch only: any real network call fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const nativeFetch = globalThis.fetch;
globalThis.fetch = url => { throw new Error('network disabled in tests: ' + new URL(url).hostname); };
const Cal = await import('../src/robinhoodEquitiesCalendar.js');
const Data = await import('../src/robinhoodEquitiesData.js');
const Strat = await import('../src/robinhoodEquitiesStrategy.js');
const Book = await import('../src/robinhoodEquitiesBook.js');
const Eq = await import('../src/robinhoodEquities.js');
test.after(() => { globalThis.fetch = nativeFetch; });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-rheq-lab-'));
const ET = (date, h, m = 0) => Cal.etToUtcMs(date, h, m);
const KEYS = { ALPACA_KEY_ID: 'test-id', ALPACA_SECRET_KEY: 'test-secret', ROBINHOOD_EQUITIES_DATA: 'alpaca' };
const UNIVERSE = ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'VNQ', 'GLD', 'DBC', 'IEF', 'BIL'];
// Weekdays before the NYSE table, real sessions inside it.
function days(from, to) {
  const out = []; let t = Date.parse(from + 'T12:00:00Z');
  for (; t <= Date.parse(to + 'T12:00:00Z'); t += 864e5) { const d = new Date(t).toISOString().slice(0, 10); if (Data.preCalendarWeekday(d) || Cal.isSession(d)) out.push(d); }
  return out;
}
function synthBars(from, to) {
  const ds = days(from, to), out = {};
  for (const s of UNIVERSE) { let p = 100; out[s] = ds.map((d, i) => { const o = p; p *= 1 + 0.0003 + Math.sin(i * 0.7 + s.charCodeAt(0)) * 0.004; return { d, o: +o.toFixed(4), h: +(Math.max(o, p) * 1.002).toFixed(4), l: +(Math.min(o, p) * 0.998).toFixed(4), c: +p.toFixed(4), v: 1000 }; }); }
  return out;
}
function alpacaFetch(bars, calls) {
  return async (url, init) => {
    const u = new URL(url); calls.push(u);
    assert.equal(u.hostname, 'data.alpaca.markets'); assert.equal(init.method, 'GET');
    const start = u.searchParams.get('start'), out = {};
    for (const s of u.searchParams.get('symbols').split(',')) out[s] = (bars[s] || []).filter(b => b.d >= start).map(b => ({ t: new Date(ET(b.d, 0)).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    return { ok: true, status: 200, json: async () => ({ bars: out, next_page_token: null }) };
  };
}

test('bars: weekday bars before the calendar start are kept; weekends and dates past the table are not', () => {
  const row = d => ({ d, o: 1, h: 1, l: 1, c: 1, v: 0 });
  const kept = Data.cleanBars(['2019-03-01', '2019-03-02', '2019-03-04', '2023-12-29', '2024-01-01', '2024-01-02', '2028-01-03'].map(row)).map(r => r.d);
  assert.deepEqual(kept, ['2019-03-01', '2019-03-04', '2023-12-29', '2024-01-02'], 'Saturday, the 2024 holiday and post-table dates are dropped');
  assert.equal(Data.lookbackDaysFor({}), 2557); assert.equal(Data.lookbackDaysFor({ ROBINHOOD_EQUITIES_LOOKBACK_DAYS: '800' }), 2192, 'never below 6 years');
  assert.equal(Data.lookbackDaysFor({ ROBINHOOD_EQUITIES_LOOKBACK_DAYS: '3000' }), 3000);
});

test('refresh: asks Alpaca for at least 6 years, keeps the old bars and hands them to the Lab in lab-link', async () => {
  const dir = tmp(), calls = [], bars = synthBars('2018-06-01', '2026-09-25'), now = ET('2026-09-25', 17, 0);
  // An older ~800-day store (no lookbackDays recorded) is refetched once with the longer window.
  fs.mkdirSync(path.dirname(Data.barsFile(dir)), { recursive: true });
  fs.writeFileSync(Data.barsFile(dir), JSON.stringify({ version: 1, provider: 'alpaca', fetchedAt: 'x', lastSession: '2026-09-25', bars: Object.fromEntries(UNIVERSE.map(s => [s, bars[s].filter(b => b.d >= '2024-07-15')])), lastError: null, lastAttemptAt: null }));
  const r = await Data.refreshBars(dir, UNIVERSE, { now, env: KEYS, fetchImpl: alpacaFetch(bars, calls) });
  assert.equal(r.fetched, true, r.reason); assert.equal(calls.length, 1);
  const start = calls[0].searchParams.get('start');
  assert.ok(start <= new Date(now - 6 * 365.25 * 864e5).toISOString().slice(0, 10), 'start ' + start + ' is at least 6 years back');
  assert.ok(r.store.bars.SPY[0].d < '2021-01-01', 'bars before the calendar start survive: ' + r.store.bars.SPY[0].d);
  assert.ok(r.store.bars.SPY.length > 1700); assert.equal(r.store.lookbackDays, 2557);
  const hand = JSON.parse(fs.readFileSync(Data.labBarsFile(dir), 'utf8'));
  assert.equal(hand.version, 1); assert.equal(hand.provider, 'alpaca'); assert.equal(hand.robinhoodQuotes, false);
  assert.deepEqual(Object.keys(hand.bars).sort(), [...UNIVERSE].sort()); assert.equal(hand.bars.SPY.length, r.store.bars.SPY.length); assert.equal(hand.firstSession, r.store.bars.SPY[0].d);
  assert.equal(path.relative(dir, Data.labBarsFile(dir)).split(path.sep).join('/'), 'lab-link/robinhood-equities-bars.json');
  const again = await Data.refreshBars(dir, UNIVERSE, { now, env: KEYS, fetchImpl: alpacaFetch(bars, calls) });
  assert.equal(again.reason, 'FRESH'); assert.equal(calls.length, 1);
  fs.rmSync(Data.labBarsFile(dir));
  await Data.refreshBars(dir, UNIVERSE, { now, env: KEYS, fetchImpl: alpacaFetch(bars, calls) });
  assert.ok(fs.existsSync(Data.labBarsFile(dir)), 'a missing hand-off file is rewritten without a fetch'); assert.equal(calls.length, 1);
});

test('strategy: month-ends before the calendar come from the data, so the older history is usable', () => {
  const bars = synthBars('2019-01-02', '2024-03-28');
  const a = Strat.targetWeights('tactical-a', {}, bars, '2023-06-15');
  assert.equal(a.ready, true, a.reasons.join()); assert.equal(a.detail.rotationAsOf, '2023-05-31');
  assert.equal(Strat.targetWeights('tactical-a', {}, bars, '2024-02-15').detail.rotationAsOf, '2024-01-31', 'inside the table the calendar still decides');
  assert.equal(Strat.targetWeights('tactical-a', {}, bars, '2024-01-10').detail.rotationAsOf, '2023-12-29', 'the last pre-table session is a month-end');
});

const champ = (patch = {}, candPatch = {}) => {
  const params = Strat.normalizeParams('tactical-a', { smaDays: 150, bandPct: 3, topN: 2 });
  const clock=Date.now(),day=864e5;
  const incumbent=Strat.normalizeParams('tactical-a',{}),costs={slippageBps:2,sellFeeBps:.3};
  const metric=(totalReturnPct,maxDrawdownPct)=>({sessions:126,totalReturnPct,maxDrawdownPct});
  return { schema: 'mpo.lab-module-champion.v1', module: 'robinhood-equities', publishedAt: clock, qualificationStage: 'PAPER_REVIEW', paperPromotionAllowed: true, paperOnly: true,
    stateSchema: 'mpo.champion-state.v1', state: 'PAPER', liveActivationAllowed: false, automaticLivePromotionAllowed: false,
    evidence:{evaluatorVersion:'equities-close-next-open-v2',datasetHash:'a'.repeat(64),experimentId:'b'.repeat(64),trials:129,costs:{...costs,known:true},
      freeze:{schema:'mpo.equities-freeze.v1',evaluatorVersion:'equities-close-next-open-v2',datasetHash:'c'.repeat(64),candidateHash:Strat.paramsHash('tactical-a',params),candidate:{params},incumbentHash:Strat.paramsHash('tactical-a',incumbent),incumbent:{params:incumbent},costs,trials:129,frozenAt:clock-201*day,historyThrough:clock-202*day},
      prospective:{pass:true,sessions:126,accessId:'isolated-fixture-receipt',start:clock-200*day,end:clock-day,candidate:metric(10,4),incumbent:metric(5,5),buyHoldSpy:metric(12,8),effectiveIndependentGroups:7,
        gates:{costsKnown:true,candidateTraded:true,beatsCash:true,beatsIncumbent:true,boundedDrawdown:true,independentMonths:true,improvementInterval:true},
        interval:{lowerPct:.1,upperPct:1,meanImprovementPct:.55,standardErrorPct:.1,level:1-.05/129,independentGroups:7,adjustedForTrials:129,grouped:true,method:'paired-independent-group-normal-bonferroni'}}},
    candidate: { id: 'RHEQ-LAB-x', strategyId: 'tactical-a', family: 'blend', params, paramsHash: Strat.paramsHash('tactical-a', params), ...candPatch }, ...patch };
};
const writeChamp = (dir, doc) => { fs.mkdirSync(path.join(dir, 'lab-link'), { recursive: true }); fs.writeFileSync(Eq.equitiesChampionFile(dir), JSON.stringify(doc)); };

test('Lab champion: applied only when cleared for paper, for this strategy, in bounds and with the trader hash', () => {
  const dir = tmp();
  assert.equal(Eq.equitiesLabChampion(dir).applied, false); assert.match(Eq.equitiesLabChampion(dir).reason, /no Lab champion/);
  writeChamp(dir, champ());
  const ok = Eq.equitiesLabChampion(dir);
  assert.equal(ok.applied, true, ok.reason); assert.equal(ok.params.smaDays, 150); assert.equal(ok.params.topN, 2); assert.equal(ok.state, 'PAPER');
  const bad = {
    'SHADOW state': champ({ state: 'SHADOW' }),
    'no lifecycle state': champ({ state: undefined, stateSchema: undefined }),
    'no paper flag': champ({ paperPromotionAllowed: false }),
    'no evidence': champ({evidence:null}),
    'old evaluator': champ({evidence:{...champ().evidence,evaluatorVersion:'equities-v1'}}),
    'unknown costs': champ({evidence:{...champ().evidence,costs:{known:false}}}),
    'no prospective period': champ({evidence:{...champ().evidence,prospective:{pass:false}}}),
    'live claim': champ({ liveActivationAllowed: true }),
    'other module': champ({ module: 'robinhood' }),
    'other strategy': champ({}, { strategyId: 'buy-hold' }),
    'smaDays out of bounds': champ({}, { params: { ...champ().candidate.params, smaDays: 400 }, paramsHash: Strat.paramsHash('tactical-a', Strat.normalizeParams('tactical-a', { smaDays: 400 })) }),
    'fractional topN': champ({}, { params: { ...champ().candidate.params, topN: 2.5 } }),
    'unbounded param changed': champ({}, { params: { ...champ().candidate.params, universe: ['SPY', 'TQQQ'] } }),
    'unknown param': champ({}, { params: { ...champ().candidate.params, leverage: 3 } }),
    'hash mismatch': champ({}, { paramsHash: 'deadbeef0000' }),
  };
  for (const [name, doc] of Object.entries(bad)) { writeChamp(dir, doc); const r = Eq.equitiesLabChampion(dir); assert.equal(r.applied, false, name); assert.ok(r.reason, name); }
  fs.writeFileSync(Eq.equitiesChampionFile(dir), '{broken'); assert.equal(Eq.equitiesLabChampion(dir).applied, false);
});

test('controller: a cleared policy persists after Lab withdraws the proposal; fresh books use defaults', async () => {
  const bars = synthBars('2018-06-01', '2026-10-02'), now = ET('2026-09-25', 17, 0);
  const defaults = Strat.paramsHash('tactical-a', Strat.normalizeParams('tactical-a', {}));
  const d1 = tmp();
  let r = await Eq.runEquitiesOnce({ now, env: KEYS, fetchImpl: alpacaFetch(bars, []), dataDir: d1 });
  assert.equal(r.book.paramsHash, defaults);
  let snap = Eq.robinhoodEquitiesSnapshot({ now, env: KEYS, dataDir: d1 });
  assert.equal(snap.strategy.lab.applied, false); assert.equal(snap.strategy.lab.source, 'defaults'); assert.equal(snap.strategy.paramsHash, defaults);
  assert.deepEqual(Object.keys(snap), ['at', 'readiness', 'market', 'data', 'book', 'strategy', 'benchmark', 'loop', 'lastError']);
  const d2 = tmp(), doc = champ(); writeChamp(d2, doc);
  r = await Eq.runEquitiesOnce({ now, env: KEYS, fetchImpl: alpacaFetch(bars, []), dataDir: d2 });
  assert.equal(r.book.paramsHash, doc.candidate.paramsHash); assert.equal(r.book.lastDecision.session, '2026-09-25');
  snap = Eq.robinhoodEquitiesSnapshot({ now, env: KEYS, dataDir: d2 });
  assert.equal(snap.strategy.lab.applied, true); assert.equal(snap.strategy.lab.source, 'evolution-lab'); assert.equal(snap.strategy.params.smaDays, 150);
  assert.equal(snap.readiness.execution, 'paper-only'); assert.ok(snap.benchmark.replay?.from < '2024-01-01', 'the replay baseline now covers the older history');
  writeChamp(d2, champ({ state: 'SHADOW' }));
  r = await Eq.runEquitiesOnce({ now: ET('2026-09-28', 17, 0), env: KEYS, fetchImpl: alpacaFetch(bars, []), dataDir: d2 });
  assert.equal(r.book.paramsHash, doc.candidate.paramsHash, 'proposal withdrawal preserves the applied incumbent');
  fs.unlinkSync(Eq.equitiesChampionFile(d2));
  const resolved=Eq.equitiesStrategyParams(d2);
  assert.equal(resolved.hash,doc.candidate.paramsHash);assert.equal(resolved.lab.source,'applied-incumbent');
  const hand=JSON.parse(fs.readFileSync(Data.labBarsFile(d2),'utf8'));
  assert.equal(hand.incumbent.paramsHash,doc.candidate.paramsHash);
  r.book.appliedPolicy.paramsHash='wrong';Book.saveBook(d2,r.book);
  assert.equal(Eq.equitiesStrategyParams(d2).hash,defaults,'tampered acceptance receipt cannot preserve parameters');
  assert.ok(fs.existsSync(Book.bookFile(d2)));
});

test('consumer independently verifies prospective metrics, cost binding, trials, timing and safety flags',()=>{
 const dir=tmp(),changes={
  'losing candidate despite pass':d=>d.evidence.prospective.candidate.totalReturnPct=-90,
  'worse than incumbent':d=>d.evidence.prospective.incumbent.totalReturnPct=11,
  'deeper drawdown than benchmark':d=>d.evidence.prospective.candidate.maxDrawdownPct=9,
  'unbounded drawdown':d=>d.evidence.prospective.incumbent.maxDrawdownPct=101,
  'missing metric':d=>delete d.evidence.prospective.candidate.sessions,
  'numeric string':d=>d.evidence.prospective.candidate.totalReturnPct='10',
  'failed gate':d=>d.evidence.prospective.gates.beatsCash=false,
  'missing gate':d=>delete d.evidence.prospective.gates.candidateTraded,
  '20 sessions':d=>d.evidence.prospective.sessions=20,
  'compressed dates':d=>d.evidence.prospective.start=Date.now()-3*864e5,
  'too few groups':d=>d.evidence.prospective.effectiveIndependentGroups=5,
  'nonpositive lower interval':d=>d.evidence.prospective.interval.lowerPct=0,
  'unadjusted trials':d=>d.evidence.prospective.interval.adjustedForTrials=1,
  'wrong interval method':d=>d.evidence.prospective.interval.method='unadjusted',
  'changed fee':d=>d.evidence.costs.sellFeeBps=0,
  'bad freeze params':d=>d.evidence.freeze.candidate.params.smaDays=200,
  'wrong freeze evaluator':d=>d.evidence.freeze.evaluatorVersion='old',
  'no experiment fingerprint':d=>delete d.evidence.experimentId,
  'stale publication':d=>d.publishedAt=Date.now()-8*864e5,
  'future publication':d=>d.publishedAt=Date.now()+864e5,
  'stale window':d=>d.evidence.prospective.end=Date.now()-8*864e5,
  'future window':d=>d.evidence.prospective.end=Date.now()+864e5,
  'missing live safety flag':d=>delete d.liveActivationAllowed,
  'missing automatic safety flag':d=>delete d.automaticLivePromotionAllowed,
  'missing paper-only flag':d=>delete d.paperOnly,
 };
 for(const [name,change] of Object.entries(changes)){const d=champ();change(d);writeChamp(dir,d);const r=Eq.equitiesLabChampion(dir);assert.equal(r.applied,false,name);assert.ok(r.reason,name)}
});

const labRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','money-printer-evolution-lab');
test('actual sibling Lab freeze, prospective evaluator and publisher satisfy the consumer contract',{skip:!fs.existsSync(path.join(labRoot,'src','equitiesProspective.js'))},async()=>{
 const load=file=>import(pathToFileURL(path.join(labRoot,'src',file)).href);
 const [{freezeEquitiesCandidate,evaluateEquitiesProspective},research,{publishModuleChampion}]=await Promise.all([load('equitiesProspective.js'),load('robinhoodEquitiesResearch.js'),load('moduleRegistry.js')]);
 const dates=[];for(let t=Date.now()-900*864e5;t<Date.now()-864e5;t+=864e5){const date=new Date(t);if(![0,6].includes(date.getUTCDay()))dates.push(date.toISOString().slice(0,10))}
 const bars=Object.fromEntries(UNIVERSE.map(s=>{let px=100;return [s,dates.map(d=>{const o=px;px*=1+(s==='SPY'?.001:.0001);return {d,o,h:px,l:o,c:px,v:1000}})]}));
 const params=research.normalizeParams({trendWeight:1}),incumbent=research.normalizeParams({}),costs={slippageBps:2,sellFeeBps:.3};
 const freezeDate=dates.at(-127),freeze=freezeEquitiesCandidate({leader:{params,paramsHash:research.paramsHash(params)},incumbent:{params:incumbent,paramsHash:research.paramsHash(incumbent)},split:{holdoutTo:freezeDate},trials:129},{now:Date.parse(freezeDate+'T23:59:59Z'),datasetHash:'a'.repeat(64),costs});
 const result=evaluateEquitiesProspective(bars,freeze,{incumbentParams:incumbent,costsKnown:true,...costs,consumeHoldout:()=>({id:'actual-producer-fixture-receipt',allowed:true})});
 assert.equal(result.prospective.pass,true,JSON.stringify(result.blockers));
 const dir=tmp();publishModuleChampion('robinhood-equities',{qualificationStage:'PAPER_REVIEW',paperPromotionAllowed:true,paperOnly:true,candidate:result.proposal,evidence:{experimentId:'b'.repeat(64),datasetHash:'c'.repeat(64),evaluatorVersion:research.EQUITIES_EVALUATOR_VERSION,costs:{...costs,known:true},trials:129,freeze,prospective:result.prospective}},{traderDataDir:dir,labDataDir:path.join(dir,'lab')});
 const accepted=Eq.equitiesLabChampion(dir);assert.equal(accepted.applied,true,accepted.reason);assert.equal(accepted.paramsHash,result.proposal.paramsHash);
});
