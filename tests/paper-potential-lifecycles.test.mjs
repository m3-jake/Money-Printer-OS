import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializePaperBook, mutatePaperBook, paperBookStatus,assertPaperPrimaryAvailable,markPaperInitialized } from '../src/paperBookStore.js';
import {BotFarm} from '../src/botFarm.js';
import {KalshiPaperBots} from '../src/kalshiBots.js';
import { resetPaperSingles, placePaperSingle, closePaperSingle, settlePaperSingles, paperSinglesBookView } from '../src/polymarketUSSinglesPaper.js';
import { disclosureSignals, tickDisclosurePaper, disclosurePaperView, DISCLOSURE_POLICY } from '../src/disclosurePaper.js';
import { standaloneBookRow } from '../src/scoreboard.js';
const temp = fn => async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-lifecycle-')); try { await fn(path.join(dir, 'book.json')); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
test('immutable initialization evidence blocks missing primary refunds and never replaces intact marker',temp(async file=>{
 assert.equal(assertPaperPrimaryAvailable(file),false);fs.writeFileSync(file,'original');markPaperInitialized(file);const bytes=fs.readFileSync(file+'.initialized.json','utf8');
 markPaperInitialized(file);assert.equal(fs.readFileSync(file+'.initialized.json','utf8'),bytes);fs.unlinkSync(file);assert.throws(()=>assertPaperPrimaryAvailable(file),e=>e.code==='RECOVERY_REQUIRED');assert.equal(fs.existsSync(file),false);
}));
test('farm and Kalshi primary deletion or malformed exposures fail closed, preserve bytes and archive explicit resets',temp(async file=>{
 const dataDir=path.dirname(file),farm=new BotFarm({dataDir}),bots=new KalshiPaperBots({dataDir});farm.save();bots.save();
 fs.unlinkSync(farm.file);fs.unlinkSync(bots.file);
 const missingFarm=new BotFarm({dataDir}),missingBots=new KalshiPaperBots({dataDir});assert.equal(missingFarm.snapshot().recoveryRequired,true);assert.equal(missingBots.snapshot('weather').cashUsd,null);
 await assert.rejects(()=>missingFarm.run('btc'),/missing/);await assert.rejects(()=>missingBots.run('btc'),/missing/);missingFarm.save();missingBots.save();assert.equal(fs.existsSync(farm.file),false);assert.equal(fs.existsSync(bots.file),false);
 const corrupt={schema:'mpo.kalshi-paper-bots.v1',bots:{weather:{startUsd:12.5,cashUsd:5,open:[{qty:-1,costUsd:1,feeUsd:0}],history:[]}}};const bytes=JSON.stringify(corrupt);fs.writeFileSync(bots.file,bytes);
 const invalid=new KalshiPaperBots({dataDir});assert.equal(invalid.snapshot('weather').recoveryRequired,true);invalid.save();assert.equal(fs.readFileSync(bots.file,'utf8'),bytes);
 invalid.reset('weather',{confirmation:'RESET BOT',startUsd:25});const archive=fs.readdirSync(dataDir).find(n=>n.startsWith('kalshi-paper-bots.json.archive-'));assert.equal(fs.readFileSync(path.join(dataDir,archive),'utf8'),bytes);
}));
test('corrupt books preserve cash history checkpoint and never silently fund', temp(async file => {
 initializePaperBook(file,{mode:'PAPER',cashUsd:25,open:[],history:[]});
 mutatePaperBook(file,b=>{b.cashUsd=20},{receiptId:'first'});
 const dup=mutatePaperBook(file,b=>{b.cashUsd=0},{receiptId:'first'}); assert.equal(dup.duplicate,true); assert.equal(dup.book.cashUsd,20);
 fs.writeFileSync(file,'{broken');const state=paperBookStatus(file);assert.equal(state.recoveryRequired,true);assert.equal(state.cashUsd,null);assert.equal(state.lastVerified.book.cashUsd,20);
 assert.throws(()=>mutatePaperBook(file,b=>{b.cashUsd=25}),/preserved/);assert.throws(()=>initializePaperBook(file,{mode:'PAPER',cashUsd:25,open:[],history:[]}),/reset/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
}));
test('singles require real depth, retry exits, partial exits and settle idempotently after restart', temp(async file => {
 resetPaperSingles({file,startUsd:25});
 assert.throws(()=>placePaperSingle({file,market:{slug:'x',ask:.5,bid:.49},stakeUsd:5,now:1000}),/depth/);
 const p=placePaperSingle({file,market:{slug:'x',ask:.5,bid:.49,quoteAt:1000,askSize:100},stakeUsd:5,now:1000});
 assert.throws(()=>closePaperSingle({file,id:p.id,market:{slug:'x',bid:.6,quoteAt:1001,bidSize:0},now:1001}),/depth/);
 const q=closePaperSingle({file,id:p.id,quantity:2,market:{slug:'x',bid:.6,quoteAt:1001,bidSize:20},now:1001,receiptId:'exit-1'});
 assert.equal(q.quantity,2);assert.equal(closePaperSingle({file,id:p.id,quantity:2,market:{slug:'x',bid:.6,quoteAt:1001,bidSize:20},now:1001,receiptId:'exit-1'}),null);
 assert.equal(paperSinglesBookView({file}).open[0].quantity,p.quantity-2);
 assert.equal((await settlePaperSingles({file,markets:[{slug:'x',status:'MARKET_STATUS_RESOLVED',outcomePrices:'[null,null]'}],now:1999})).settled,0);
 const markets=[{slug:'x',status:'MARKET_STATUS_RESOLVED',outcomePrices:'[1,0]'}];
 assert.equal((await settlePaperSingles({file,markets,now:2000})).settled,1);assert.equal((await settlePaperSingles({file,markets,now:2001})).settled,0);
 const b=paperSinglesBookView({file});assert.equal(b.history.length,2);assert.equal(b.openCount,0);assert.ok(Math.abs(b.cashUsd-25-b.history.reduce((sum,x)=>sum+x.pnlUsd,0))<.011);
}));
test('disclosure follows public availability, excludes grants/amendments and closes using provider quote', temp(async file=>{
 const now=2000000000,first=now-5000;
 const f={facts:{form:'4',accession:'abc',acceptedAt:first-1000},firstObservedAt:first,form4:{ticker:'ABC',owner:'A',transactions:[{code:'P',acquired:true,shares:100,price:1},{code:'A',acquired:true,shares:200}]}};
 assert.equal(disclosureSignals([f,{...f,facts:{...f.facts,form:'4/A'}}]).length,1);
 let calls=0;
 const quote=async(symbol,args)=>{calls++;return {provider:'fixture-equity',assetClass:'equity',symbol,session:'REGULAR_OPEN',corporateActionsVerified:true,observedAt:args.now,bid:9.9,ask:10,bidSize:100,askSize:100,feeUsd:.01,fractional:true,quantityStep:.001}};
 await tickDisclosurePaper({file,filings:[f],secConfigured:true,quote,now});let b=disclosurePaperView({file});assert.equal(b.open.length,1);assert.equal(b.open[0].entryAsk,10);assert.equal(b.open[0].insiderComparisonPrice,1);assert.ok(b.open[0].entryQuoteAt>=first+1000);
 await tickDisclosurePaper({file,filings:[f],secConfigured:true,quote,now:now+100});assert.equal(disclosurePaperView({file}).open.length,1);
 await tickDisclosurePaper({file,filings:[],secConfigured:false,quote,now:now+DISCLOSURE_POLICY.holdMs});b=disclosurePaperView({file});assert.equal(b.open.length,0);assert.equal(b.history.length,1);assert.equal(b.status,'SEC_USER_AGENT_REQUIRED');assert.ok(calls>=3);
}));
test('scoreboard includes open losses and missing marks never become zero losses',()=>{
 const now=100000,base={mode:'PAPER',startUsd:25,cashUsd:10,createdAt:1,history:[],open:[{id:'x',costUsd:15,markValueUsd:8,markAt:now}]};
 const row=standaloneBookRow('x',base,{now});assert.equal(row.economicNetPnl,-7);assert.equal(row.exposureCost,15);assert.equal(row.markCoverage.observed,1);
 assert.equal(standaloneBookRow('x',{...base,open:[{id:'x',costUsd:15}]},{now}).economicNetPnl,null);
});
