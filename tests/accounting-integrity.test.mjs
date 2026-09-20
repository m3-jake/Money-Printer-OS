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
