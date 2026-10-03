import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeSolFlowFeatures,tickRobinhoodExternalBooks,robinhoodExternalBookViews} from '../src/robinhoodExternalFeatures.js';
import {pumpProfitScoreboardBooks,standaloneBookRow} from '../src/scoreboard.js';
const at=Date.UTC(2026,9,3);
function feature(now=at){return nativeSolFlowFeatures(Array.from({length:3},(_,i)=>({signature:`sig${i}`,wallet:`wallet${i}`,source:'indexed-rpc',mint:'memecoin',ts:at-1000,solDelta:.5,tokenDelta:-100,raw:{signer:true,program:'pump'}})),{now,supportedSymbols:['SOL-USD']});}
const quote=(now)=>async symbol=>({symbol,supported:true,source:'robinhood-estimated-price',bid:99,ask:100,at:now,bidSize:1,askSize:1,quantityStep:.01});
test('native flow requires attributable swap legs and preserves feature identity',()=>{
 const f=feature();assert.equal(f.signals[0].events,3);assert.equal(f.signals[0].netFlowSol,1.5);assert.equal(f.signals[0].independentClusters,null);
 assert.equal(nativeSolFlowFeatures([{signature:'x',wallet:'w',source:'rpc',ts:at,solDelta:1,tokenDelta:-1,raw:{signer:true,program:'transfer'}}],{now:at,supportedSymbols:['SOL-USD']}).signals.length,0);
 assert.equal(feature(at+1).featureHash,f.featureHash);
});
test('three isolated paper ablations require delayed quote and supervise paused exits with corruption isolated',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rh-ext-'));
 try{
 let r=await tickRobinhoodExternalBooks({dataDir:dir,features:feature(),momentum:true,quoteFn:quote(at),supportedSymbols:['SOL-USD'],now:at});
 assert.equal(r.ordersSubmitted,0);assert.equal(robinhoodExternalBookViews({dataDir:dir}).filter(b=>b.open.length).length,0);
 await tickRobinhoodExternalBooks({dataDir:dir,features:feature(at+1000),momentum:true,quoteFn:quote(at+1000),supportedSymbols:['SOL-USD'],now:at+1000});
 let books=robinhoodExternalBookViews({dataDir:dir});assert.equal(books.length,3);
 for(const b of books){assert.equal(b.open.length,1);assert.equal(b.open[0].quantity,.04);assert.ok(b.cashUsd>20);assert.equal(b.experiment.qualificationEffect,'NONE');}
 const exitAt=at+3602000;
 await tickRobinhoodExternalBooks({dataDir:dir,enabled:false,quoteFn:quote(exitAt),now:exitAt});
 books=robinhoodExternalBookViews({dataDir:dir});for(const b of books){assert.equal(b.open.length,0);assert.equal(b.history.length,1);assert.ok(b.history[0].pnlUsd<0);assert.equal(b.status,'PAUSED_NEW_ENTRIES');}
 fs.writeFileSync(books[0].file,'{bad');
 r=await tickRobinhoodExternalBooks({dataDir:dir,enabled:false,quoteFn:quote(exitAt),now:exitAt});assert.equal(r.books[0].status,'RECOVERY_REQUIRED');assert.equal(r.books.length,3);assert.equal(fs.readFileSync(books[0].file,'utf8'),'{bad');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Pump profit discovery books remain separate and unobserved exposure unavailable',()=>{
 const b={id:'BASELINE@.25',candidateId:'BASELINE',startSol:.25,cashSol:.1,positions:[{id:'p',remainingSol:.15,lastPrice:99}],history:[]};
 const rows=pumpProfitScoreboardBooks({createdAt:at-1000,updatedAt:at,books:[b],discoveryBooks:[{...b,positions:[],cashSol:.25}]});
 assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);
 const active=standaloneBookRow(rows[0].id,rows[0].book,{now:at,...rows[0].options});assert.equal(active.economicNetPnl,null);assert.equal(active.exposureCost,.15);assert.equal(active.countsTowardQualification,false);
});
