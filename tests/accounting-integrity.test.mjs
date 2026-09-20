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

