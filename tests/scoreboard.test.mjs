// Scoreboard: pure row builders over mocked module snapshots, plus one read of the real modules in a temp data dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-scoreboard-'));
process.env.MONEY_PRINTER_DATA_DIR = TMP;
process.env.ROBINHOOD_AUTOSTART = 'false';
process.env.ROBINHOOD_PRACTICE_AUTOSTART = 'false';
process.env.ROBINHOOD_EQUITIES_AUTOSTART = 'false';

const SB = await import('../src/scoreboard.js');
const { closeStats, verdict, VERDICT, MIN_CLOSES, pumpfunRows, robinhoodCryptoRows, cryptoHoldBaseline, equitiesRow, polymarketRows, platformRows, labRows, buildScoreboard, freshness } = SB;

const NOW = Date.parse('2026-09-26T18:00:00Z');
const MIN = 60_000;
const closes = (pnls, t0 = NOW - 10 * 3600e3) => pnls.map((pnl, i) => ({ pnl, at: t0 + i * MIN }));

test('closeStats: hit rate, profit factor, net per trade and the single-best-trade outlier check', () => {
  // The audit case: one trade carries 92% of the book's P/L.
  const s = closeStats(closes([0.92, 0.05, 0.05, -0.02, -0.01, 0.01]));
  assert.equal(s.closes, 6);
  assert.equal(s.wins, 4);
  assert.equal(s.hitRate, 0.6667);
  assert.equal(s.netPnl, 1);
  assert.equal(s.netPerTrade, 0.166667);
  assert.equal(s.profitFactor, 34.333);
  assert.equal(s.bestTrade.pnl, 0.92);
  assert.equal(s.netWithoutBest, 0.08);
  assert.equal(s.bestShareOfNet, 0.92);
  assert.equal(s.outlier, true);
  assert.equal(s.curve.at(-1), 1);
  const even = closeStats(closes([1, 1, 1, -0.5]));
  assert.equal(even.outlier, false);
  assert.equal(closeStats([]).profitFactor, null);
  assert.equal(closeStats(closes([1, 2])).profitFactor, 'infinity');
  assert.equal(closeStats([{ pnl: 'x' }, { pnl: null }]).closes, 0, 'non-numeric P/L is not a close');
});

test('verdict: NOT ENOUGH DATA below the bar, NO when only the best trade beats the baseline, YES otherwise', () => {
  const few = closeStats(closes(Array(MIN_CLOSES - 1).fill(1)));
  assert.equal(verdict(few, 0).beatsBaseline, VERDICT.NOT_ENOUGH);
  const enough = closeStats(closes([...Array(MIN_CLOSES).fill(1)]));
  assert.equal(verdict(enough, 0).beatsBaseline, VERDICT.YES);
  assert.equal(verdict(enough, 50).beatsBaseline, VERDICT.NO);
  assert.equal(verdict(enough, null).beatsBaseline, VERDICT.NOT_ENOUGH, 'no baseline, no verdict');
  const lucky = closeStats(closes([100, ...Array(MIN_CLOSES - 1).fill(-1)]));
  const v = verdict(lucky, 0);
  assert.equal(v.beatsBaseline, VERDICT.NO);
  assert.match(v.reason, /single best trade/);
});

test('Pump.fun: FAIR and SPRINT books against doing nothing, with active/idle freshness', () => {
  const history = [
    ...closes(Array(25).fill(0.01)).map((c, i) => ({ profile: 'FAIR', pnlSol: c.pnl, closedAt: c.at, feesSol: 0.001, id: 'f' + i })),
    { exitPreset: 'sprint', pnlSol: 0.3, closedAt: NOW - 50 * MIN },
    { profile: 'SPRINT', pnlSol: -0.1, closedAt: NOW - 40 * MIN },
    { profile: 'SCALPER', pnlSol: 0.02, closedAt: NOW - 30 * MIN },
  ];
  const rows = pumpfunRows({ history, runtime: { profile: 'FAIR' }, system: { lastCycle: NOW - 20_000 } }, { now: NOW });
  const fair = rows.find(r => r.id === 'pumpfun-fair'), sprint = rows.find(r => r.id === 'pumpfun-sprint'), other = rows.find(r => r.id === 'pumpfun-other');
  assert.equal(fair.unit, 'SOL');
  assert.equal(fair.closes, 25);
  assert.equal(fair.netPnl, 0.25);
  assert.equal(fair.baseline.kind, 'do-nothing');
  assert.equal(fair.baseline.netPnl, 0);
  assert.equal(fair.beatsBaseline, VERDICT.YES);
  assert.equal(fair.freshness.status, 'FRESH');
  assert.equal(sprint.closes, 2, 'old closes fall back to the exit preset');
  assert.equal(sprint.beatsBaseline, VERDICT.NOT_ENOUGH);
  assert.equal(sprint.freshness.status, 'IDLE');
  assert.equal(other.closes, 1);
  const stale = pumpfunRows({ history: [], runtime: { profile: 'SPRINT' }, system: { lastCycle: NOW - 3600e3 } }, { now: NOW });
  assert.equal(stale.find(r => r.id === 'pumpfun-sprint').freshness.status, 'STALE');
  assert.equal(stale.find(r => r.id === 'pumpfun-fair').closes, 0);
});

test('Robinhood crypto: strategy, exploration and practice books against buy-and-hold of the traded coins', () => {
  const trade = (i, pnlUsd, symbol = 'BTC-USD') => ({ id: 'rp' + i, status: 'CLOSED', symbol, pnlUsd, openedAt: NOW - (100 - i) * MIN, closedAt: NOW - (99 - i) * MIN });
  const strict = { startUsd: 1000, feeRatio: 0.0095, autopilot: { enabled: true }, history: [...Array(20)].map((_, i) => trade(i, 1)).concat([{ status: 'OPEN', pnlUsd: 5 }]) };
  const explore = { startUsd: 1000, autopilot: { enabled: false }, history: [trade(1, -2, 'ETH-USD')] };
  const practice = { startUsd: 500, settings: { feeBps: 95, slippageBps: 8, autopilot: true }, telemetry: { lastTickAt: NOW - 10_000 }, history: [trade(2, 3)] };
  const holdPrices = { 'robinhood-strategy': { 'BTC-USD': { from: 100000, to: 101000 } }, 'robinhood-exploration': { 'ETH-USD': { from: 4000, to: null } } };
  const rows = robinhoodCryptoRows({ strict, explore, practice, tapeAt: NOW - 15_000, holdPrices }, { now: NOW });
  const [s, e, p] = rows;
  assert.equal(s.id, 'robinhood-strategy');
  assert.equal(s.closes, 20, 'only CLOSED rows count');
  assert.equal(s.netPnl, 20);
  assert.equal(s.baseline.kind, 'buy-and-hold');
  // $1000 in BTC: +1% move, 0.95% fee each way.
  assert.equal(s.baseline.netPnl, Math.round(1000 * ((1 - 0.0095) * 1.01 * (1 - 0.0095) - 1) * 1e6) / 1e6);
  assert.equal(s.beatsBaseline, VERDICT.YES);
  assert.equal(s.freshness.status, 'FRESH');
  assert.equal(e.baseline.netPnl, null, 'a missing tape price makes the baseline unavailable');
  assert.equal(e.freshness.status, 'IDLE');
  assert.equal(p.id, 'robinhood-practice');
  assert.equal(p.baseline.netPnl, null, 'no hold price supplied for practice');
  assert.equal(p.freshness.status, 'FRESH');
  assert.equal(cryptoHoldBaseline({ startUsd: 100, feeRatio: 0, symbols: ['A-USD', 'B-USD'], prices: { 'A-USD': { from: 1, to: 1.2 }, 'B-USD': { from: 1, to: 0.9 } } }).netPnl, 5);
});

test('Robinhood equities: per-session evidence against buy-and-hold SPY', () => {
  const daily = [...Array(25)].map((_, i) => ({ d: `2026-08-${String(i + 1).padStart(2, '0')}`, equityUsd: 10000 + (i + 1) * 10, benchUsd: 10000 + (i + 1) * 5, cashUsd: 10000 }));
  const snap = { strategy: { title: 'Dual momentum' }, book: { startUsd: 10000, equityUsd: 10250, equityDaily: daily }, benchmark: { live: { buyHoldSpyUsd: 10125, since: '2026-08-01' } }, data: { status: 'FRESH', fetchedAt: new Date(NOW - 3600e3).toISOString(), latestBar: '2026-09-25' }, loop: {} };
  const r = equitiesRow(snap, { now: NOW });
  assert.equal(r.unit, 'USD');
  assert.equal(r.per, 'session');
  assert.equal(r.closes, 25);
  assert.equal(r.netPnl, 250);
  assert.equal(r.netPerTrade, 10);
  assert.equal(r.baseline.kind, 'buy-and-hold-spy');
  assert.equal(r.baseline.netPnl, 125);
  assert.equal(r.beatsBaseline, VERDICT.YES);
  assert.equal(r.freshness.status, 'FRESH');
  const short = equitiesRow({ ...snap, book: { ...snap.book, equityDaily: daily.slice(0, 5), equityUsd: 10050 } }, { now: NOW });
  assert.equal(short.beatsBaseline, VERDICT.NOT_ENOUGH);
  const behind = equitiesRow({ ...snap, benchmark: { live: { buyHoldSpyUsd: 10400 } } }, { now: NOW });
  assert.equal(behind.beatsBaseline, VERDICT.NO);
  const none = equitiesRow(null, { now: NOW });
  assert.equal(none.freshness.status, 'NO_DATA');
  assert.equal(none.baseline.netPnl, null);
});

test('Polymarket US shadow: settled combos per window against cash; VOID is not a close', () => {
  const hist = [...Array(20)].map((_, i) => ({ status: i % 2 ? 'WON' : 'LOST', pnlUsd: i % 2 ? 1.5 : -1, settledAt: NOW - i * MIN })).concat([{ status: 'VOID', pnlUsd: 0 }]);
  const rows = polymarketRows({ updatedAt: NOW - 5 * MIN, shadow: { NEAR_END: { open: [{}], history: hist }, LATE: { open: [], history: [] } } }, { now: NOW });
  const near = rows.find(r => r.id === 'polymarket-shadow-near_end');
  assert.equal(near.kind, 'shadow');
  assert.equal(near.closes, 20);
  assert.equal(near.hitRate, 0.5);
  assert.equal(near.netPnl, 5);
  assert.equal(near.open, 1);
  assert.equal(near.beatsBaseline, VERDICT.YES);
  assert.equal(rows.find(r => r.id === 'polymarket-shadow-late').beatsBaseline, VERDICT.NOT_ENOUGH);
  assert.deepEqual(polymarketRows(null, { now: NOW }), []);
});

test('Core ledger: per-close stats come from the ledger itself, one row per venue', async () => {
  const { CoreDatabase } = await import('../src/core/database.js');
  const { UnifiedLedger } = await import('../src/core/ledger.js');
  const store = new CoreDatabase(':memory:'), l = new UnifiedLedger(store);
  const base = { mode: 'PAPER', venue: 'kalshi', account: 'manual', currency: 'USD', reference: 'test' };
  l.append({ ...base, sourceKey: 'd', at: NOW - 5 * MIN, kind: 'DEPOSIT', gross: '100' });
  l.append({ ...base, sourceKey: 'b1', at: NOW - 4 * MIN, kind: 'BUY', instrumentId: 'X', quantity: '10', gross: '4', fee: '0.1' });
  l.append({ ...base, sourceKey: 's1', at: NOW - 3 * MIN, kind: 'SELL', instrumentId: 'X', quantity: '10', gross: '6', fee: '0.1' });
  l.append({ ...base, sourceKey: 'b2', at: NOW - 2 * MIN, kind: 'BUY', instrumentId: 'Y', quantity: '5', gross: '3', fee: '0' });
  l.append({ ...base, sourceKey: 's2', at: NOW - 1 * MIN, kind: 'SELL', instrumentId: 'Y', quantity: '5', gross: '2', fee: '0' });
  const pf = l.portfolio('PAPER');
  assert.equal(pf.accounts[0].closeStats.closes, 2);
  assert.equal(pf.accounts[0].closeStats.best, '1.800000');
  const [row] = platformRows(pf, { lastEntryAt: NOW - MIN, now: NOW });
  assert.equal(row.id, 'platform-kalshi');
  assert.equal(row.closes, 2);
  assert.equal(row.wins, 1);
  assert.equal(row.netPnl, Number(pf.accounts[0].realized));
  assert.equal(row.netPnl, 0.8);
  assert.equal(row.netWithoutBest, -1);
  assert.equal(row.profitFactor, 1.8);
  assert.equal(row.outlier, true);
  assert.equal(row.beatsBaseline, VERDICT.NOT_ENOUGH);
  assert.equal(row.freshness.status, 'FRESH');
  store.close();
  const [empty] = platformRows({ accounts: [] }, { now: NOW });
  assert.equal(empty.closes, 0);
  assert.equal(empty.freshness.status, 'IDLE');
});

test('Evolution Lab rows: lifecycle state plus held-out result, verdict only with enough held-out trades', () => {
  const rows = labRows({
    solana: { state: 'PAPER', declared: 'PAPER', updatedAt: NOW - MIN, n: 40, perTrade: 0.8, unit: '%', metric: 'held-out avg' },
    robinhood: { state: 'SHADOW', updatedAt: NOW - 3600e3, n: 5, value: 12, unit: 'USD' },
  }, { now: NOW });
  const sol = rows.find(r => r.id === 'lab-solana'), rh = rows.find(r => r.id === 'lab-robinhood'), pm = rows.find(r => r.id === 'lab-polymarket-combo');
  assert.equal(sol.state, 'PAPER');
  assert.equal(sol.beatsBaseline, VERDICT.YES);
  assert.equal(sol.freshness.status, 'FRESH');
  assert.equal(rh.beatsBaseline, VERDICT.NOT_ENOUGH);
  assert.equal(rh.freshness.status, 'STALE');
  assert.equal(pm.state, 'NONE');
  assert.equal(pm.freshness.status, 'IDLE');
  const neg = labRows({ solana: { state: 'SHADOW', n: 30, perTrade: -0.2, updatedAt: NOW } }, { now: NOW }).find(r => r.id === 'lab-solana');
  assert.equal(neg.beatsBaseline, VERDICT.NO);
});

test('buildScoreboard: one broken source is reported, not thrown; summary counts verdicts', () => {
  const board = buildScoreboard({
    pumpfun: { history: 'not-an-array', runtime: {}, system: {} },
    polymarket: { get shadow() { throw new Error('boom'); } },
    lab: {},
    errors: [{ source: 'equities', error: 'unreadable' }],
  }, { now: NOW });
  assert.equal(board.schema, 'mpo.scoreboard.v1');
  assert.equal(board.paperOnly, true);
  assert.ok(board.rows.some(r => r.id === 'pumpfun-fair'));
  assert.deepEqual(board.errors.map(e => e.source).sort(), ['equities', 'polymarket']);
  assert.equal(board.summary.rows, board.rows.length);
  assert.equal(board.summary.notEnoughData, board.rows.length);
  assert.equal(freshness(null, { now: NOW }).status, 'NO_DATA');
});

test('readScoreboard reads the real modules from a data dir without writing to it', async () => {
  const trade = i => ({ id: 'rp' + i, status: 'CLOSED', symbol: 'BTC-USD', pnlUsd: i % 3 ? 1 : -0.5, qty: 0.001, costUsd: 25, fillPrice: 100000, openedAt: NOW - (60 - i) * MIN, closedAt: NOW - (59 - i) * MIN });
  fs.writeFileSync(path.join(TMP, 'robinhood-paper.json'), JSON.stringify({ version: 1, cashUsd: 1000, startUsd: 1000, positions: [], history: [...Array(6)].map((_, i) => trade(i)), autopilot: { enabled: true } }));
  fs.mkdirSync(path.join(TMP, 'lab-link'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'lab-link', 'polymarket-combo-champion.json'), JSON.stringify({ schema: 'mpo.lab-module-champion.v1', module: 'polymarket-combo', liveActivationAllowed: false, state: 'SHADOW', stateSchema: 'mpo.champion-state.v1', publishedAt: NOW - MIN, candidate: { holdout: { combos: 8, roi: 0.02 } } }));
  const before = fs.readdirSync(TMP).sort();
  const board = await SB.readScoreboard({ now: NOW });
  const { closeMarketPlatform } = await import('../src/core/platform.js');
  closeMarketPlatform();
  assert.deepEqual(board.errors, []);
  const ids = board.rows.map(r => r.id);
  for (const id of ['pumpfun-fair', 'pumpfun-sprint', 'robinhood-strategy', 'robinhood-exploration', 'robinhood-practice', 'robinhood-equities', 'platform-kalshi', 'lab-solana', 'lab-robinhood', 'lab-polymarket-combo']) assert.ok(ids.includes(id), id);
  const rh = board.rows.find(r => r.id === 'robinhood-strategy');
  assert.equal(rh.closes, 6);
  assert.equal(rh.netPnl, 3);
  assert.equal(board.rows.find(r => r.id === 'lab-polymarket-combo').state, 'SHADOW');
  const created = fs.readdirSync(TMP).filter(n => !before.includes(n));
  assert.deepEqual(created.filter(n => !n.startsWith('mpos-core.sqlite')), [], 'only the core ledger database the server already opens');
  assert.equal(await SB.readScoreboard({ now: NOW + 1000 }), board, 'served from the short cache');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
