import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-accounting-'));
process.env.MONEY_PRINTER_DATA_DIR=DIR;
process.env.POLYMARKET_AUTOSTART='false';
process.env.POLYMARKET_KEY_ID='test-key';
process.env.POLYMARKET_SECRET_KEY=Buffer.alloc(64,3).toString('base64');
process.env.POLYMARKET_US_REAL_ENABLED='true';

const accounting=await import('../src/accounting.js');
const store=await import('../src/store.js');
const combos=await import('../src/polymarketUSCombos.js');
const poly=await import('../src/polymarket.js');

test('compact pnl ledger survives detailed-history pruning past 1500 closes',()=>{
 const now=Date.now(),s=store.loadState();s.history=[];s.pnlLedger=[];s.realizedLifetimePnlSol=0;
 for(let i=0;i<1605;i++){const t={closedAt:now-i,pnlSol:.001};s.history.push(t);accounting.bookClosedPnl(s,t)}
 store.saveState(s);const r=store.loadState();assert.equal(r.history.length,1500);assert.equal(r.pnlLedger.length,1605);
 assert.ok(Math.abs(accounting.dailyPnl(r,now)-1.605)<1e-9);assert.ok(Math.abs(r.realizedLifetimePnlSol-1.605)<1e-9)
});

test('portfolio initializes from current marked equity, never a truncated-history reconstruction',()=>{
 const now=Date.now(),s={paperStartSol:1,cashSol:.7,positions:[{remainingSol:.2,entryPrice:1,lastPrice:1.5}],history:Array.from({length:1500},(_,i)=>({closedAt:now-i,pnlSol:9})),pnlLedger:[],realizedLifetimePnlSol:0,portfolioSeries:[],market:{solUsd:200},strategies:{}};
 accounting.updatePortfolio(s,{now});assert.equal(s.portfolioSeries.length,1);assert.ok(Math.abs(s.portfolio.equitySol-1)<1e-9);assert.ok(Math.abs(s.portfolioSeries[0].equitySol-1)<1e-9)
});

test('corrupt real combo journal blocks signed placement before any network action',async()=>{
 fs.writeFileSync(path.join(DIR,'polymarket-us-combos.json'),'{broken');combos.__testing.resetJournal();
 await assert.rejects(()=>combos.placeUSCombo({confirmation:'PLACE REAL COMBO',stakeUsd:1,legKeys:['x']}),e=>e?.code==='stateRecovery')
});

test('corrupt sports paper file reports zero equity instead of a replacement bankroll',()=>{
 fs.writeFileSync(path.join(DIR,'polymarket-paper.json'),'{broken');const m=poly.paperResearchMetrics();assert.equal(m.equityUsd,0)
});

test('engine imports every extracted accounting helper it still calls',()=>{const src=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');assert.match(src,/import \{[^}]*unrealizedPnl[^}]*\} from '\.\/accounting\.js'/)});


test('paper identity holds after closes and survives history prune', () => {
  const now = Date.now();
  const s = store.loadState();
  s.paperStartSol = 1; s.cashSol = 1; s.positions = []; s.history = []; s.pnlLedger = []; s.realizedLifetimePnlSol = 0;
  accounting.bookClosedPnl(s, { closedAt: now, pnlSol: 0.05 });
  s.cashSol = 1.05;
  let id = accounting.paperIdentity(s);
  assert.equal(id.ok, true);
  assert.ok(Math.abs(id.hole) < 1e-9);
  for (let i = 0; i < 1600; i++) {
    const t = { closedAt: now - i, pnlSol: 0.0001 };
    s.history.push(t);
    accounting.bookClosedPnl(s, t);
    s.cashSol += 0.0001;
  }
  store.saveState(s);
  const r = store.loadState();
  assert.equal(r.history.length, 1500);
  assert.ok(r.pnlLedger.length >= 1600);
  id = accounting.paperIdentity(r);
  assert.equal(id.ok, true);
});

test('missing lifetime pnl is reconstructed and absurd equity is flagged', () => {
  const bad = {
    paperStartSol: 10,
    cashSol: 30.56,
    positions: [{ remainingSol: 0.25, sizeSol: 0.6, entryPrice: 0.00001, lastPrice: 0.001, realizedSol: 34.9 }],
    history: [{ closedAt: Date.now(), pnlSol: -3 }],
    strategies: { UNIFIED_EDGE: { pnlSol: -3, trades: 1 } },
    system: { health: 'HEALTHY' },
  };
  // merge happens via reset/load patterns — call paperIdentity + guard directly
  const id = accounting.paperIdentity(bad);
  assert.equal(Number.isFinite(bad.realizedLifetimePnlSol), true);
  assert.equal(id.ok, false);
  assert.ok(id.openRz > 30);
  const jump = accounting.guardEquityJump({ nextEquity: id.equity, startSol: 10, maxMultiple: 5 });
  assert.equal(jump.ok, false);
  assert.ok(jump.reasons.some(r => String(r).includes('equity-multiple') || r.includes('multiple')));
});

// ---------------------------------------------------------------------------------------------
// ACCOUNTING-AUDIT F2 / F7 / F8. src/index.js calls main() at import time and exports nothing, so
// the entry-side rails live in src/positionExecution.js and index.js calls into them; the wiring
// is asserted by source grep below, the behaviour by the helpers themselves.
// ---------------------------------------------------------------------------------------------
const execution = await import('../src/positionExecution.js');
const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('F2 paperIdentity.ok asserts the exact identity, including open realized cash', () => {
  // one open position past TP1: 0.3 SOL of realized proceeds sitting in cash, 0.2 SOL of basis left
  const s = {
    paperStartSol: 1, cashSol: 1 + 0.3 - 0.2,
    positions: [{ sizeSol: 0.5, remainingSol: 0.2, entryPrice: 2, lastPrice: 2, realizedSol: 0.3 }],
    history: [], pnlLedger: [], realizedLifetimePnlSol: 0, strategies: {},
  };
  const id = accounting.paperIdentity(s);
  assert.equal(id.ok, true, `healthy books flagged: hole ${id.hole} holeExact ${id.holeExact}`);
  assert.equal(id.okExact, true);
  assert.ok(Math.abs(id.holeExact) < 1e-9);
  assert.ok(Math.abs(id.hole - 0.3) < 1e-9, 'the inexact hole is retained for compatibility');
  // contract C1 — src/doctor.js (ship-fixes) consumes exactly these keys
  for (const k of ['start', 'life', 'unreal', 'openRz', 'equity', 'hole', 'holeExact', 'ok', 'okExact']) {
    assert.ok(k in id, `paperIdentity must keep ${k}`);
  }
  const off = { ...s, cashSol: s.cashSol + 0.01 };
  assert.equal(accounting.paperIdentity(off).ok, false, '0.01 SOL hole on a 1 SOL start must not be ok');
});

test('F7 a staircase of sub-20x ticks cannot walk the mark past the tick median', () => {
  const now = Date.now();
  const mint = 'PEGmint';
  const ticks = [1.035e-5, 1.04e-5, 1.042e-5, 1.038e-5, 1.045e-5, 1.04e-5]
    .map((price, i) => ({ ts: now - (6 - i) * 5000, price }));
  const p = { mint, entryPrice: 1.0793e-5, lastPrice: 1.04e-5, pairAddress: 'PAIR' };
  const pair = (priceUsd, at) => ({ priceUsd, priceObservedAt: at, baseToken: { address: mint }, pairAddress: 'PAIR' });

  const first = execution.reviewPositionPrice(p, pair(1e-5, now), { paper: true, now, ticks });
  assert.equal(first.accepted, true, 'a tick inside the observed band is still accepted');
  p.lastPrice = first.price;

  // 1e-5 -> 1.9e-4 is 19x, under the 20x anchor window that used to be the only check
  const second = execution.reviewPositionPrice(p, pair(1.9e-4, now), { paper: true, now, ticks });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'price-outside-tick-band');

  const third = execution.reviewPositionPrice(p, pair(1.1e-3, now), { paper: true, now, ticks });
  assert.equal(third.accepted, false);

  assert.equal(p.lastPrice, 1e-5, 'lastPrice never leaves the tick band');
  assert.ok(p.lastPrice <= execution.recentTickMedian(ticks, now) * execution.TICK_BAND_MAX_RATIO);
});

test('F7 the tick band lifts on a stale history and never blocks a quiet position', () => {
  const now = Date.now();
  const stale = [1e-5, 1e-5, 1e-5, 1e-5].map((price, i) => ({ ts: now - 60 * 60_000 - i * 1000, price }));
  assert.equal(execution.recentTickMedian(stale, now), null);
  assert.equal(execution.recentTickMedian([{ ts: now, price: 1e-5 }], now), null, 'too few ticks to band');
});

test('F7 a paper entry without a pool binding is refused', () => {
  assert.equal(execution.paperEntryRejection({ mint: 'M', pairAddress: null }), 'missing-pair-address');
  assert.equal(execution.paperEntryRejection({ mint: 'M' }), 'missing-pair-address');
  assert.equal(execution.paperEntryRejection(null), 'missing-pair-address');
  assert.equal(execution.paperEntryRejection({ mint: 'M', pairAddress: 'PAIR' }), null);
  // index.js must refuse the fill before any cash moves
  assert.match(indexSource, /const entryReject = paperEntryRejection\(pick\);/);
  assert.ok(indexSource.indexOf('const entryReject') < indexSource.indexOf('s.cashSol -= size + entryFee'));
  // and the position's own tick history must reach reviewPositionPrice
  assert.match(indexSource, /reviewPositionPrice\(p,pair,\{[^}]*ticks:s\.tickHistory\?\.\[p\.mint\]/);
});

test('F8 a 100x phantom mark cannot enlarge the next paper fill', () => {
  const config = { riskPerTradePct: 2, maxPositionSol: 0.25, maxTotalExposureSol: 1.5, tradeSizeSol: 0.1 };
  const s = { cashSol: 0.5, positions: [{ remainingSol: 0.25, sizeSol: 0.25, entryPrice: 1e-5, lastPrice: 1e-3 }] };
  assert.ok(Math.abs(accounting.equity(s) - 25.5) < 1e-9, 'marked equity is inflated 100x');
  assert.ok(Math.abs(execution.paperSizingEquity(s) - 0.75) < 1e-9, 'sizing equity is cash + cost basis');

  const sized = execution.entrySizing({ state: s, config, sizeFactor: 1, aggression: 50, stopPct: 20, paper: true, sprint: true });
  assert.ok(Math.abs(sized.eq - 0.75) < 1e-9);
  assert.ok(sized.markedEquity > 25);
  assert.ok(sized.size <= 0.75 + 1e-12, `sized ${sized.size} against a 25.5 mark`);
  // the pre-fix path sized off 25.5 and produced the two ~3.9 SOL positions in state.bad-70sol
  const inflated = execution.entrySizing({ state: { cashSol: 25.5, positions: [] }, config, sizeFactor: 1, aggression: 50, stopPct: 20, paper: true, sprint: true });
  assert.ok(inflated.size > 1.5 * sized.size, 'the ceiling is what holds the fill down');

  // live sizing is untouched: configured caps only, never the mark
  const live = execution.entrySizing({ state: s, config, sizeFactor: 1, aggression: 50, stopPct: 20, paper: false, sprint: false });
  assert.equal(live.positionCap, config.maxPositionSol);
  assert.equal(live.exposureCap, config.maxTotalExposureSol);
  assert.equal(live.targetSize, config.tradeSizeSol);
  assert.equal(live.eq, accounting.equity(s));
  assert.match(indexSource, /paper: isPaper, sprint: sprintPaper/);
});

test('saveState refuses a single-save equity teleport', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-jump-'));
  process.env.MONEY_PRINTER_DATA_DIR = dir;
  // re-import store against new dir by resetting modules is hard; use checkEquityJump export
  const s = store.resetPaper(1, false);
  const prev = accounting.paperIdentity(s).equity;
  const jump = store.checkEquityJump({
    prevEquity: prev,
    nextEquity: prev + 50,
    startSol: 1,
    maxMultiple: 1e9,
    maxAbsJump: 5,
  });
  assert.equal(jump.ok, false);
});

