// Robinhood crypto daily-bar paper book (src/robinhoodDailyBook.js). Mocked Coinbase candles only: any other network
// call fails. One decision per closed UTC bar, next-open fills (Robinhood quote inside the open window, else the
// Coinbase open), multi-day holds, 0.95%/side floor plus slippage, its own qualification, paper only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
const nativeFetch = globalThis.fetch;
globalThis.fetch = url => { throw new Error('network disabled in tests: ' + new URL(url).hostname); };
const D = await import('../src/robinhoodDailyBook.js');
test.after(() => { D.__testing.reset(); globalThis.fetch = nativeFetch; });

const DAY = 864e5;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-rh-daily-'));
const t0 = d => Date.parse(d + 'T00:00:00Z');
const addDays = (d, n) => new Date(t0(d) + n * DAY).toISOString().slice(0, 10);
const SYMS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
// Market: per symbol a map day -> {o,h,l,c}. flat(n) closes at 100 for n days ending at `last`.
function market(last, n = 300) {
  const m = {};
  for (const s of SYMS) { m[s] = new Map(); for (let i = n - 1; i >= 0; i--) { const d = addDays(last, -i); m[s].set(d, { o: 100, h: 100.5, l: 99.5, c: 100 }); } }
  return m;
}
// Coinbase-shaped mock: rows [time_s, low, high, open, close, volume], newest first, only candles that exist by `clock()`.
function coinbase(m, clock, calls = []) {
  return async (url, init) => {
    const u = new URL(url); calls.push(u);
    assert.equal(u.hostname, 'api.exchange.coinbase.com'); assert.equal(init.method, 'GET');
    const sym = u.pathname.match(/^\/products\/([A-Z0-9-]+)\/candles$/)[1];
    assert.equal(u.searchParams.get('granularity'), '86400');
    const start = Date.parse(u.searchParams.get('start')), end = Date.parse(u.searchParams.get('end'));
    assert.ok((end - start) / DAY <= 300, 'at most 300 daily candles per request');
    const rows = [...(m[sym] || new Map()).entries()].map(([d, b]) => ({ t: t0(d), ...b }))
      .filter(b => b.t >= start && b.t <= end && b.t <= clock()).sort((a, b) => b.t - a.t);
    return { ok: true, status: 200, json: async () => rows.map(b => [b.t / 1000, b.l, b.h, b.o, b.c, 1]) };
  };
}
const rhQuote = (bid, ask) => sym => sym === 'BTC-USD' ? { symbol: sym, bid, ask, at: Date.now(), source: 'v2' } : null;

test('Lab signal parity: the executor rule reproduces the Lab replay trades for every family', { skip: !fs.existsSync(path.resolve(process.env.MPO_LAB_SRC || 'W:/money-printer-evolution-lab/src', 'robinhoodDaily.js')) && 'Lab repo not found' }, async () => {
  const L = await import(pathToFileURL(path.resolve(process.env.MPO_LAB_SRC || 'W:/money-printer-evolution-lab/src', 'robinhoodDaily.js')).href);
  let seed = 11, p = 100; const bars = [];
  for (let i = 0; i < 700; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const o = p; p *= 1 + (seed / 4294967296 - 0.5) * 0.08 + Math.sin(i / 40) * 0.01; const t = t0('2024-01-01') + i * DAY; bars.push({ d: new Date(t).toISOString().slice(0, 10), t, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p }); }
  const cands = [{ family: 'breakout', params: { entryDays: 20, exitDays: 10 } }, { family: 'trend', params: { smaDays: 100, bandPct: 2 } }, { family: 'trend', params: { smaDays: 200, bandPct: 2 } }, { family: 'tsmom', params: { lookbackDays: 56, thresholdPct: 5 } }];
  for (const c of cands) {
    const lab = L.simulateDaily(bars, c).trades.map(t => [t.entryI, t.exitI]);
    let holding = false, pending = null, open = null; const ours = [];
    for (let i = 0; i < bars.length; i++) {
      if (i > 0) { if (pending === true && !holding) { holding = true; open = [i, null]; } else if (pending === false && holding) { holding = false; open[1] = i; ours.push(open); open = null; } }
      pending = null; const want = D.dailySignal(c.family, c.params, bars, i, holding); if (want !== null && want !== holding) pending = want;
    }
    if (open) ours.push(open);
    assert.ok(lab.length > 0, c.family + ' trades in the fixture');
    assert.deepEqual(ours, lab, `${c.family} ${JSON.stringify(c.params)}`);
    assert.equal(D.dailyParamsHash(c.family, c.params), L.dailyParamsHash(c.family, c.params));
  }
});

test('strategy source: the Lab proposal only when championState clears it for paper and its params are in bounds', () => {
  const none = D.pickDailyStrategy(null);
  assert.equal(none.kind, 'lab-default'); assert.equal(none.family, 'trend'); assert.deepEqual(none.params, { smaDays: 200, bandPct: 2 });
  assert.match(none.label, /NOT A QUALIFIED STRATEGY/); assert.match(none.reasons[0], /no Lab daily record/);
  const noEdge = D.pickDailyStrategy({ phase: 'NO_EDGE', proposal: null, paperPromotionAllowed: false });
  assert.equal(noEdge.kind, 'lab-default'); assert.match(noEdge.reasons[0], /NO_EDGE/);
  const proposal = { id: 'RH-DAILY-breakout-x', family: 'breakout', params: { entryDays: 55, exitDays: 20 }, qualificationStage: 'PAPER_REVIEW', paperOnly: true, traderExecutable: false, liveActivationAllowed: false, automaticLivePromotionAllowed: false };
  // As the Lab publishes it today: no lifecycle state, so it reads SHADOW and is not cleared.
  const shadow = D.pickDailyStrategy({ phase: 'PAPER_REVIEW_READY', paperPromotionAllowed: true, proposal });
  assert.equal(shadow.kind, 'lab-default'); assert.equal(shadow.state, 'SHADOW'); assert.match(shadow.reasons.join(), /SHADOW.*not cleared for paper/);
  const cleared = { phase: 'PAPER_REVIEW_READY', paperPromotionAllowed: true, proposal: { ...proposal, stateSchema: 'mpo.champion-state.v1', state: 'PAPER' } };
  const ok = D.pickDailyStrategy(cleared);
  assert.equal(ok.kind, 'lab-proposal'); assert.equal(ok.family, 'breakout'); assert.deepEqual(ok.params, { entryDays: 55, exitDays: 20 }); assert.equal(ok.paramsHash, D.dailyParamsHash('breakout', { entryDays: 55, exitDays: 20 }));
  assert.equal(D.pickDailyStrategy({ ...cleared, paperPromotionAllowed: false }).kind, 'lab-default', 'the Lab paper-promotion flag is required');
  assert.equal(D.pickDailyStrategy({ ...cleared, proposal: { ...cleared.proposal, state: 'LIVE', liveActivationAllowed: true } }).kind, 'lab-default', 'a live claim is refused');
  for (const params of [{ entryDays: 400, exitDays: 20 }, { entryDays: 20, exitDays: 30 }, { entryDays: 20.5, exitDays: 10 }, { entryDays: 55, exitDays: 20, extra: 1 }]) {
    assert.equal(D.pickDailyStrategy({ ...cleared, proposal: { ...cleared.proposal, params } }).kind, 'lab-default', JSON.stringify(params));
  }
  assert.equal(D.pickDailyStrategy({ ...cleared, proposal: { ...cleared.proposal, family: 'trend', params: { smaDays: 50, bandPct: 2 } } }).kind, 'lab-default', 'short trend without a wide band is refused');
  assert.equal(D.pickDailyStrategy({ ...cleared, proposal: { ...cleared.proposal, family: 'martingale', params: {} } }).kind, 'lab-default');
});

test('controller: one decision per closed bar, next-open fill on a Robinhood quote, multi-day hold, Coinbase open when late, never repeated', async () => {
  const dir = tmp(), D0 = '2026-09-20', m = market(D0);
  m['BTC-USD'].set(D0, { o: 100, h: 105.5, l: 99.8, c: 105 }); // close > SMA200 x 1.02 -> BUY
  m['BTC-USD'].set(addDays(D0, 1), { o: 106, h: 107, l: 105, c: 106 });
  for (let k = 1; k <= 5; k++) for (const s of ['ETH-USD', 'SOL-USD']) m[s].set(addDays(D0, k), { o: 100, h: 100.5, l: 99.5, c: 100 }); // candles appear only once their day starts
  let now = t0(addDays(D0, 1)) + 10 * 60_000; const calls = [], fetchFn = coinbase(m, () => now, calls);
  const run = (extra = {}) => D.runDailyOnce({ dataDir: dir, now, env: {}, fetchFn, labDaily: null, ...extra });
  let r = await run({ quoteFn: rhQuote(106.9, 107), feeRatio: 0.001 });
  assert.ok(r.events.includes('DECIDED buy BTC-USD for the 2026-09-21 open'), r.events.join());
  assert.ok(r.events.some(e => e.startsWith('FILLED buy BTC-USD 2026-09-21 @ robinhood-quote:v2')), r.events.join());
  assert.equal(r.book.source.kind, 'lab-default'); assert.equal(r.book.lastDecidedDay, D0);
  assert.equal(r.book.feeRatio, 0.0095, 'fee never below 0.95% per side');
  const alloc = 333.33, sl = r.book.sleeves['BTC-USD'];
  assert.ok(Math.abs(sl.qty - alloc * (1 - 0.0095) / (107 * 1.0005)) < 1e-9, 'ask + 5 bps slippage, 0.95% fee');
  assert.equal(sl.entry.late, false); assert.equal(r.book.lastDecision.bySymbol['ETH-USD'].action, 'HOLD');
  const fills = r.book.fills.length, nCalls = calls.length;
  r = await run({ quoteFn: rhQuote(106.9, 107) });
  assert.deepEqual(r.events.filter(e => /DECIDED|FILLED/.test(e)), [], 'a restart the same day never decides or fills again');
  assert.equal(r.book.fills.length, fills); assert.equal(calls.length, nCalls, 'fresh bar cache: no request');
  // Next closed bar: still above the band -> hold (multi-day).
  m['BTC-USD'].set(addDays(D0, 2), { o: 107, h: 107, l: 103, c: 104 });
  now = t0(addDays(D0, 2)) + 20 * 60_000;
  r = await run({ quoteFn: rhQuote(106, 106.1) });
  assert.equal(r.book.lastDecision.bySymbol['BTC-USD'].action, 'HOLD'); assert.ok(r.book.sleeves['BTC-USD'].qty > 0);
  // App off for two days; the crash bar decides SELL; the app returns at 10:00 UTC (outside the quote window).
  m['BTC-USD'].set(addDays(D0, 3), { o: 104, h: 104, l: 102, c: 103 });
  m['BTC-USD'].set(addDays(D0, 4), { o: 103, h: 103, l: 90, c: 90 });
  m['BTC-USD'].set(addDays(D0, 5), { o: 89, h: 90, l: 88, c: 89 });
  now = t0(addDays(D0, 5)) + 10 * 3600_000;
  r = await run({ quoteFn: rhQuote(95, 95.1) });
  assert.ok(r.events.includes('DECIDED sell BTC-USD for the 2026-09-25 open'), r.events.join());
  assert.equal(r.book.missedDays, 2, 'two closed bars were never decided after the fact');
  const trade = r.book.history[0];
  assert.equal(trade.exitDay, '2026-09-25'); assert.equal(trade.priceSource.exit, 'coinbase-open'); assert.equal(trade.late.exit, true);
  assert.equal(trade.holdDays, 4); assert.equal(trade.entryDay, '2026-09-21');
  const proceeds = sl.qty * 89 * (1 - 0.0005) * (1 - 0.0095);
  assert.ok(Math.abs(trade.proceedsUsd - Math.round(proceeds * 100) / 100) < 0.011); assert.ok(trade.pnlUsd < 0);
  assert.equal(r.book.sleeves['BTC-USD'].qty, 0);
  r = await run({ quoteFn: rhQuote(95, 95.1) });
  assert.equal(r.book.history.length, 1, 'restart never double-executes');
  const snap = D.dailySnapshot({ dataDir: dir, now, labDaily: null });
  assert.equal(snap.execution, 'paper-only'); assert.equal(snap.liveEligible, false); assert.equal(snap.qualification.liveEligible, false);
  assert.match(snap.label, /LAB DEFAULT DAILY FAMILY/); assert.ok(snap.book.equityDaily.length >= 3); assert.ok(snap.book.buyHoldUsd > 0);
  assert.ok(calls.every(u => u.hostname === 'api.exchange.coinbase.com'));
});

test('controller: a decision is saved before its fill; without any price it waits and fills once when the open is known', async () => {
  const dir = tmp(), D0 = '2026-09-20', m = market(D0);
  m['BTC-USD'].set(D0, { o: 100, h: 105.5, l: 99.8, c: 105 });
  let now = t0(addDays(D0, 1)) + 5 * 60_000; const fetchFn = coinbase(m, () => now);
  let r = await D.runDailyOnce({ dataDir: dir, now, env: {}, fetchFn, labDaily: null });
  assert.equal(r.book.pending.length, 1, 'no quote and no open yet: the order waits'); assert.equal(r.book.lastDecidedDay, D0);
  const saved = JSON.parse(fs.readFileSync(D.bookFile(dir), 'utf8')); assert.equal(saved.lastDecidedDay, D0); assert.equal(saved.pending.length, 1);
  m['BTC-USD'].set(addDays(D0, 1), { o: 106, h: 106, l: 106, c: 106 });
  now += 20 * 60_000;
  r = await D.runDailyOnce({ dataDir: dir, now, env: {}, fetchFn, labDaily: null });
  assert.equal(r.book.pending.length, 0); assert.equal(r.book.fills.length, 1); assert.equal(r.book.fills[0].priceSource, 'coinbase-open');
  assert.equal(r.book.fills[0].refPrice, 106); assert.ok(!r.events.some(e => e.startsWith('DECIDED')), 'not decided twice');
});

test('controller: switches to a cleared Lab proposal and labels it', async () => {
  const dir = tmp(), D0 = '2026-09-20', m = market(D0); let now = t0(addDays(D0, 1)) + 5 * 60_000;
  const lab = { phase: 'PAPER_REVIEW_READY', paperPromotionAllowed: true, proposal: { id: 'RH-DAILY-trend-abc', family: 'trend', params: { smaDays: 150, bandPct: 5 }, stateSchema: 'mpo.champion-state.v1', state: 'PAPER', traderExecutable: false, liveActivationAllowed: false } };
  const r = await D.runDailyOnce({ dataDir: dir, now, env: {}, fetchFn: coinbase(m, () => now), labDaily: lab });
  assert.equal(r.book.source.kind, 'lab-proposal'); assert.equal(r.book.source.id, 'RH-DAILY-trend-abc'); assert.match(r.book.source.label, /LAB DAILY PROPOSAL/);
  assert.equal(r.book.lastDecision.paramsHash, D.dailyParamsHash('trend', { smaDays: 150, bandPct: 5 }));
});

test('qualification: minimum trades and days over a long window, beats cash and buy-and-hold, drawdown and profit factor', () => {
  const hash = 'h1', b = D.newDailyBook({ now: 0 }); b.source = { paramsHash: hash };
  const days = 200, start = '2026-01-01';
  b.equityDaily = Array.from({ length: days }, (_, i) => ({ d: addDays(start, i), equityUsd: 1000 * (1 + 0.001 * i), benchUsd: 1000 * (1 + 0.0005 * i) - (i === 100 ? 60 : 0), paramsHash: hash }));
  const trade = (i, pnl) => ({ symbol: 'BTC-USD', exitDay: addDays(start, 10 + i * 15), pnlUsd: pnl, paramsHash: hash });
  b.history = Array.from({ length: 12 }, (_, i) => trade(i, i % 3 ? 20 : -10));
  let q = D.dailyQualification(b);
  assert.equal(q.qualified, true, q.reasons.join('; ')); assert.equal(q.liveEligible, false); assert.equal(q.metrics.closedTrades, 12);
  b.history = b.history.slice(0, 6); q = D.dailyQualification(b);
  assert.equal(q.qualified, false); assert.match(q.reasons.join(), /6 of 10 closed round trips/);
  b.history = Array.from({ length: 12 }, (_, i) => ({ ...trade(i, 20), paramsHash: i < 6 ? 'old' : hash })); q = D.dailyQualification(b);
  assert.equal(q.metrics.closedTrades, 6, 'trades under other params never count');
  b.history = Array.from({ length: 12 }, (_, i) => trade(i, i % 3 ? 20 : -10));
  b.equityDaily = b.equityDaily.map((m, i) => ({ ...m, benchUsd: 1000 * (1 + 0.002 * i) })); q = D.dailyQualification(b);
  assert.equal(q.gates.beatsBuyHold, false); assert.match(q.reasons.join(), /does not beat buy-and-hold/);
  b.equityDaily = b.equityDaily.slice(0, 90); q = D.dailyQualification(b);
  assert.equal(q.gates.runDays, false, 'fewer than 180 paper days');
});

test('book: corrupt file forces recovery and is never overwritten; reset needs the typed phrase', async () => {
  const dir = tmp(); fs.writeFileSync(D.bookFile(dir), '{nope');
  const r = await D.runDailyOnce({ dataDir: dir, now: Date.now(), env: {}, fetchFn: () => { throw new Error('no fetch expected'); }, labDaily: null });
  assert.deepEqual(r.events, ['RECOVERY']); assert.equal(fs.readFileSync(D.bookFile(dir), 'utf8'), '{nope');
  assert.throws(() => D.resetDailyBook({ dataDir: dir, confirmation: 'reset' }), /RESET DAILY/);
  const snap = D.resetDailyBook({ dataDir: dir, confirmation: 'RESET DAILY' });
  assert.equal(snap.book.recoveryRequired, false); assert.equal(snap.book.equityUsd, 1000);
});

test('paper only: the daily book imports no transport, signer or order path', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/robinhoodDailyBook.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /robinhoodTransport|robinhoodSigner|robinhoodJournal|placeOrder|robinhoodAutoTrader/);
  assert.match(src, /liveEligible: false/);
});

test('HUD: daily tab and the small daily-verdict line', () => {
  const panel = fs.readFileSync(fileURLToPath(new URL('../public/assets/robinhood-panel.js', import.meta.url)), 'utf8');
  const ctx = vm.createContext({ document: { getElementById: () => null }, window: { innerWidth: 1200 }, polyEscape: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), money: n => '$' + Number(n).toFixed(2), fmt: (n, d) => Number(n).toFixed(d) });
  vm.runInContext(panel, ctx);
  assert.match(vm.runInContext('rhDailyVerdictLine(null)', ctx), /no verdict published yet/);
  ctx.lab = { phase: 'NO_EDGE', leader: { id: 'trend-200-2', family: 'trend', holdout: { strategy: { totalReturnPct: 12.5 }, buyHold: { totalReturnPct: 40.1 } } }, proposal: null, blockers: ['holdout trend-200-2 Sharpe 0.8 vs buy-and-hold 1.1'] };
  const line = vm.runInContext('rhDailyVerdictLine(lab)', ctx);
  assert.match(line, /id="rhDailyVerdict"/); assert.match(line, /Daily bars \(Lab\): <b class="amber">NO EDGE<\/b>/); assert.match(line, /leader trend-200-2/); assert.match(line, /holdout \+12\.50% vs buy-and-hold \+40\.10%/); assert.match(line, /no proposal/);
  ctx.dy = { label: 'LAB DEFAULT DAILY FAMILY · PAPER ONLY · NOT A QUALIFIED STRATEGY', source: { kind: 'lab-default', family: 'trend', params: { smaDays: 200, bandPct: 2 }, paramsHash: 'abc', reasons: ['the proposal is SHADOW, not cleared for paper'] }, rules: 'One decision per closed UTC bar.',
    book: { equityUsd: 1010, returnPct: 1, buyHoldUsd: 1020, buyHoldReturnPct: 2, positions: [{ symbol: 'BTC-USD', long: true, entry: { day: '2026-09-21', fillPrice: 107 }, lastClose: 110, valueUsd: 340, unrealizedUsd: 6 }], pending: [], equityDaily: [{ d: '2026-09-20', equityUsd: 1000, benchUsd: 1000, cashUsd: 1000 }, { d: '2026-09-21', equityUsd: 1010, benchUsd: 1020, cashUsd: 1000 }], history: [], costs: { feeRatio: 0.0095, slipBps: 5 } },
    qualification: { qualified: false, reasons: ['0 of 10 closed round trips'], rules: { minClosedTrades: 10, minRunDays: 180, windowDays: 365, minProfitFactor: 1.2 }, metrics: {} } };
  const sec = vm.runInContext('rhDailySection(dy,lab)', ctx);
  for (const re of [/LAB DEFAULT DAILY FAMILY/, /PAPER ONLY · NEVER LIVE/, /id="rhDailyWhyDefault"/, /SHADOW, not cleared for paper/, /id="rhDailyVerdict"/, /<svg id="rhDailyCurve"/, /id="rhDailyPositions"/, /LONG/, /0 of 10 closed round trips/, /never unlocks live/, /id="rhDailyRun"/, /0\.95%\/side \+ 5 bps/]) assert.match(sec, re);
  assert.match(panel, /daily:\['head','cryptohead','daily'\]/); assert.match(panel, /rhPrompt\('RESET DAILY'/); assert.match(panel, /\$\{rhDailyVerdictLine\(ev\.daily\)\}/, 'the evolution panel shows the verdict line');
  assert.match(vm.runInContext('rhEqCurveSvg([])', ctx), /id="rhEqCurve">The equity curve starts at the first marked session close; it is drawn next to buy-and-hold SPY and cash/, 'stocks curve unchanged');
});
