// Robinhood Evolution (docs/ROBINHOOD-AUTO-TRADER.md §22): bounded mutations, walk-forward scoring, min-gain promotion,
// propose-only by default, APPLY touches the paper params only and disables real autopilot ('paramsChanged').
// Offline: the trader boots against the mock API; nothing is signed or written to Robinhood.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRobinhoodKeyPair } from '../src/robinhoodSigner.js';
import { createRobinhoodMock } from './helpers/robinhoodMock.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-evolve-'));
process.env.MONEY_PRINTER_DATA_DIR=path.join(root,'data');
Object.assign(process.env,{ROBINHOOD_AUTOSTART:'false',POLYMARKET_AUTOSTART:'false',ROBINHOOD_API:'https://rh.test',ROBINHOOD_TICK_MS:'60000',ROBINHOOD_SYMBOLS:'BTC-USD',ROBINHOOD_EVOLVE_CANDIDATES:'6',ROBINHOOD_EVOLVE_MAX_TAPE_DAYS:'5'});
const KEYS={apiKey:'rh-api-11111111-2222-3333-4444-555555555555',seed:generateRobinhoodKeyPair().privateKeyBase64};
process.env.ROBINHOOD_API_KEY=KEYS.apiKey;process.env.ROBINHOOD_PRIVATE_KEY=KEYS.seed;process.env.ROBINHOOD_REAL_ENABLED='true';
const nativeFetch=globalThis.fetch;
const E=await import('../src/robinhoodEvolve.js'),T=await import('../src/robinhoodTape.js'),S=await import('../src/robinhoodStrategy.js'),J=await import('../src/robinhoodJournal.js'),TX=await import('../src/robinhoodTransport.js');
const RH=await import('../src/robinhoodAutoTrader.js');
const mock=createRobinhoodMock({journalFile:J.JOURNAL_FILE});globalThis.fetch=mock.fetch;
const STEP=60000,DAY=864e5;
function series({n,start,drift=0.004,noise=0.02,spread=0.001,seed=7}){let s=seed,mid=100;const out=[];for(let i=0;i<n;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;mid*=1+drift+(s/4294967296-0.5)*noise;out.push({t:start+i*STEP,bid:mid*(1-spread/2),ask:mid*(1+spread/2),mid})}return out}
function reset(){RH.__testing.reset();RH.__testing.unlockRealExecutionForTests(true);fs.rmSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true,force:true});fs.mkdirSync(process.env.MONEY_PRINTER_DATA_DIR,{recursive:true});TX.__testing.resetTransport();TX.__testing.setClock(()=>mock.state.time);RH.__testing.setClock(()=>mock.state.time);mock.calls.length=0;mock.state.orders.clear();mock.state.bid=100;mock.state.ask=100.1;mock.state.time=1700000000000;
 Object.assign(process.env,{ROBINHOOD_API_KEY:KEYS.apiKey,ROBINHOOD_PRIVATE_KEY:KEYS.seed,ROBINHOOD_REAL_ENABLED:'true'});for(const k of ['ROBINHOOD_EVOLVE_AUTOPROMOTE','ROBINHOOD_EVOLVE_ENABLED','ROBINHOOD_EVOLVE_MIN_GAIN'])delete process.env[k]}
function writeTape(symbol,days,opts={}){const n=Math.floor(days*DAY/STEP),rows=series({n,start:mock.state.time-(n-1)*STEP,...opts});fs.mkdirSync(T.TAPE_DIR,{recursive:true});fs.writeFileSync(T.tapeFile(symbol),rows.map(r=>JSON.stringify({t:r.t,bid:r.bid,ask:r.ask})).join('\n')+'\n');return rows}
const qualify=()=>{const p=J.loadPaper();p.params=S.normalizeParams({...p.params,sampleMs:RH.__testing.TICK_MS});p.paramsHash=S.paramsHash(p.params);p.history=Array.from({length:25},(_,i)=>({id:'rp'+i,symbol:'BTC-USD',status:'CLOSED',placedBy:'paper-autopilot',closedBy:'strategy',paramsHash:p.paramsHash,pnlUsd:1,feeUsd:0.1,exit:{feeUsd:0.1,reason:'take'},costUsd:10,costPct:0.0185,stopPct:0.0185,takePct:0.074,closedAt:mock.state.time-i*60000}));J.savePaper(p,{force:true});assert.equal(RH.robinhoodReadiness().qualified,true)};
test.after(()=>{RH.stopRobinhoodLoops();globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});

test('config defaults: disabled, 360 min, 24 candidates, 15% min gain, autopromote off; env overrides re-read every call',()=>{
 reset();const c=E.evolveConfig();assert.equal(c.enabled,false,'the scheduled search is off unless ROBINHOOD_EVOLVE_ENABLED is exactly true');assert.equal(c.intervalMin,360);assert.equal(c.candidates,6,'env override from this suite');assert.equal(c.minGain,0.15);assert.equal(c.autopromote,false);assert.equal(c.budgetMs,20000);assert.equal(c.minTapeDays,3);
 process.env.ROBINHOOD_EVOLVE_ENABLED='TRUE';process.env.ROBINHOOD_EVOLVE_AUTOPROMOTE='TRUE';process.env.ROBINHOOD_EVOLVE_MIN_GAIN='0.5';
 const d=E.evolveConfig();assert.equal(d.enabled,true);assert.equal(d.autopromote,true);assert.equal(d.minGain,0.5);
 delete process.env.ROBINHOOD_EVOLVE_ENABLED;delete process.env.ROBINHOOD_EVOLVE_AUTOPROMOTE;delete process.env.ROBINHOOD_EVOLVE_MIN_GAIN;
 assert.equal(path.basename(E.EVOLVE_FILE),'robinhood-evolve.json');assert.equal(path.dirname(E.EVOLVE_FILE),process.env.MONEY_PRINTER_DATA_DIR);
});
test('mutations stay inside the evolution bounds, keep emaFast < emaSlow, change only search keys and are reproducible',()=>{
 const base=S.normalizeParams({sampleMs:STEP});const rng=E.mulberry32(42);const seen=new Set();
 for(let i=0;i<300;i++){
  const m=E.mutateParams(base,rng);assert.equal(E.withinEvolveBounds(m),true,JSON.stringify(m));assert.ok(m.emaFast<m.emaSlow);
  for(const k of Object.keys(base))if(!E.EVOLVE_KEYS.includes(k))assert.equal(m[k],base[k],k+' is not a search key');
  seen.add(S.paramsHash(m));
 }
 assert.ok(seen.size>100,'mutations explore');
 const a=E.mutateParams(base,E.mulberry32(9)),b=E.mutateParams(base,E.mulberry32(9));assert.deepEqual(a,b);
 assert.deepEqual(E.EVOLVE_BOUNDS.emaFast,[5,30,true]);assert.deepEqual(E.EVOLVE_BOUNDS.maxHoldMin,[30,720,false]);assert.deepEqual(E.EVOLVE_BOUNDS.breakoutBufferPct,[0,0.002,false]);
 assert.equal(E.withinEvolveBounds({...base,emaFast:60,emaSlow:50}),false);assert.equal(E.withinEvolveBounds({...base,maxSpreadBps:200}),false);
});
test('scoring: PF-weighted test score with penalties for few closes, drawdown, losses and train/test overfit; primary weight applies',()=>{
 const good={closes:30,profitFactor:2,pnlUsd:40,maxDrawdownUsd:5};
 assert.equal(E.scoreSymbol({train:good,test:good}).score,2);
 assert.ok(E.scoreSymbol({train:good,test:{...good,closes:10}}).score<1.1,'closes < 20 scales the score down');
 assert.equal(E.scoreSymbol({train:good,test:{...good,maxDrawdownUsd:40}},{startUsd:1000}).score,1,'drawdown > 3% halves it');
 assert.equal(E.scoreSymbol({train:good,test:{...good,pnlUsd:-1}}).score,0.5);
 assert.ok(E.scoreSymbol({train:{...good,profitFactor:5},test:good}).score<1,'overfit gap is penalized');
 assert.equal(E.scoreSymbol({train:good,test:{closes:0}}).score,0);assert.equal(E.scoreSymbol({train:good,test:{...good,profitFactor:Infinity}}).score,5,'PF is capped at 5');
 assert.equal(E.compositeScore({'BTC-USD':{score:2},'ETH-USD':{score:0}},{'BTC-USD':1.5}),1.2);assert.equal(E.compositeScore({'BTC-USD':{score:2},'ETH-USD':{score:0}}),1);assert.equal(E.compositeScore({}),0);
});
test('searchGeneration: walk-forward per symbol, time-boxed with yields, champion only beats the incumbent by the min gain',async()=>{
 const tape=series({n:3000,start:1700000000000});const tapes={'BTC-USD':tape};
 const incumbentParams=S.normalizeParams({sampleMs:STEP});
 const cfg={...E.evolveConfig(),candidates:4,minGain:0.15,budgetMs:20000};
 let yields=0;const r=await E.searchGeneration({tapes,incumbentParams,feeRatio:0.0085,orderUsd:25,startUsd:1000,weights:{'BTC-USD':1.5},cfg,generation:1,now:1700000000000,rng:E.mulberry32(3),yieldFn:async()=>{yields++}});
 assert.equal(r.evaluated.length,4);assert.equal(yields,4);assert.equal(r.timedOut,false);assert.ok(r.incumbent.bySymbol['BTC-USD'].test.samples===900&&r.incumbent.bySymbol['BTC-USD'].train.samples===2100,'70/30 split');
 assert.ok(r.incumbent.bySymbol['BTC-USD'].cutAt>tape[2000].t);
 const bestScore=r.best.score,incScore=r.incumbent.score;
 assert.equal(r.beats,bestScore>0&&(incScore<=0?bestScore>0:bestScore>=incScore*1.15));
 const strict=await E.searchGeneration({tapes,incumbentParams,feeRatio:0.0085,cfg:{...cfg,minGain:1000},generation:1,now:1700000000000,rng:E.mulberry32(3),yieldFn:async()=>{}});
 assert.equal(strict.beats,false,'a 1000x gain requirement never promotes');assert.equal(strict.best.paramsHash,r.best.paramsHash,'same seed, same candidates');
 const zero=await E.searchGeneration({tapes,incumbentParams:{...incumbentParams,maxSpreadBps:1},feeRatio:0.0085,cfg:{...cfg,minGain:0.15},generation:2,now:1700000000000,rng:E.mulberry32(5),yieldFn:async()=>{}});
 assert.equal(zero.incumbent.score,0,'an incumbent that never trades scores 0');assert.equal(zero.beats,zero.best.score>0);
 let calls=0;const boxed=await E.searchGeneration({tapes,incumbentParams,feeRatio:0.0085,cfg:{...cfg,candidates:50,budgetMs:5},clock:()=>{calls++;return calls*10},generation:3,now:1700000000000,yieldFn:async()=>{}});
 assert.equal(boxed.timedOut,true);assert.ok(boxed.evaluated.length<50);
});
test('ledger: ENOENT default, atomic save, normalization drops junk, history and events are capped',()=>{
 reset();E.__testing.reset();const l=E.loadEvolveLedger();assert.deepEqual(l,E.defaultLedger());
 l.generation=3;l.champion={params:{takeMult:5},paramsHash:'abc',score:1.2,metrics:{closes:21},at:1};l.history=Array.from({length:150},(_,i)=>({generation:i}));for(let i=0;i<70;i++)E.ledgerEvent(l,'x','event '+i);
 E.saveEvolveLedger(l);E.__testing.reset();const back=E.loadEvolveLedger();
 assert.equal(back.generation,3);assert.equal(back.champion.paramsHash,'abc');assert.equal(back.champion.params.takeMult,5);assert.equal(back.history.length,100);assert.equal(back.events.length,50);assert.equal(back.events[0].text,'event 69');
 assert.equal(fs.readdirSync(process.env.MONEY_PRINTER_DATA_DIR).filter(n=>n.endsWith('.tmp')).length,0);
 fs.writeFileSync(E.EVOLVE_FILE,'{broken');E.__testing.reset();const bad=E.loadEvolveLedger();assert.equal(bad.generation,0);assert.equal(bad.lastError.stage,'load');
 assert.equal(E.normalizeLedger({champion:{paramsHash:'x'}}).champion,null,'a champion without params is dropped');
});
test('trader: no run without 3 days of primary tape; a run proposes a champion but never applies it when autopromote is off',async()=>{
 reset();assert.equal((await RH.runRobinhoodEvolveOnce({manual:true})).reason,'insufficientTape');
 writeTape('BTC-USD',1);const short=await RH.runRobinhoodEvolveOnce({manual:true});assert.equal(short.reason,'insufficientTape');assert.ok(short.tapeDays['BTC-USD']<3);
 process.env.ROBINHOOD_EVOLVE_ENABLED='false';assert.equal((await RH.runRobinhoodEvolveOnce()).reason,'disabled');delete process.env.ROBINHOOD_EVOLVE_ENABLED;
 // Incumbent cannot trade (spread cap below the tape's 10 bps), so any trading mutation is a champion candidate.
 writeTape('BTC-USD',4);RH.setRobinhoodPaperAutopilot({params:{maxSpreadBps:1}});const hashBefore=J.loadPaper().paramsHash;
 let r=null;for(let i=0;i<12&&!(r&&r.beats);i++){mock.state.time+=1000;r=await RH.runRobinhoodEvolveOnce({manual:true})}
 assert.equal(r.ran,true,JSON.stringify(r));assert.equal(r.beats,true,'expected a champion within 12 generations: '+JSON.stringify(r));assert.equal(r.promoted,false);assert.equal(r.proposed,true);
 assert.equal(r.incumbentScore,0);assert.ok(r.bestScore>0);assert.ok(r.evaluated<=6);
 const view=RH.robinhoodEvolveView();assert.equal(view.autopromote,false);assert.ok(view.generation>=1);assert.equal(view.proposed.paramsHash,r.bestHash);assert.equal(view.champion.paramsHash,r.bestHash);assert.ok(view.tapeDays['BTC-USD']>=3.9);assert.equal(view.applied,null);
 assert.equal(J.loadPaper().paramsHash,hashBefore,'paper params untouched without APPLY');assert.equal(mock.writes().length,0,'evolution never posts to Robinhood');
 const ledger=JSON.parse(fs.readFileSync(RH.__testing.evolveFile,'utf8'));assert.equal(ledger.champion.paramsHash,r.bestHash);assert.equal(ledger.history[0].beats,true);assert.equal(ledger.events[0].type,'champion');
 const snap=await RH.robinhoodSnapshot({force:true});assert.deepEqual(Object.keys(snap),['at','readiness','account','pairs','quotes','tape','paper','journal','limits','qualificationThresholds','strategy','loop','equities','evolve','lastError']);assert.equal(snap.evolve.proposed.paramsHash,r.bestHash);
});
test('trader: APPLY changes the paper params only, resets qualification and disables real autopilot with paramsChanged',async()=>{
 reset();writeTape('BTC-USD',4);
 const champion=S.normalizeParams({...J.loadPaper().params,sampleMs:STEP,takeMult:5,emaFast:10,emaSlow:40});const hash=S.paramsHash(champion);
 const l=E.loadEvolveLedger();l.champion={params:champion,paramsHash:hash,score:2,metrics:{closes:25},at:mock.state.time,generation:1};E.saveEvolveLedger(l);
 qualify();RH.armRobinhood(true);RH.setRobinhoodAutopilot({enabled:true,confirmation:'ENABLE REAL CRYPTO AUTOPILOT'});assert.equal(RH.robinhoodAutopilot().enabled,true);
 const realBefore=JSON.stringify({...J.loadJournal().autopilot,enabled:null,disabledReason:null,disabledAt:null,lastAction:null});
 assert.throws(()=>RH.applyRobinhoodEvolution({paramsHash:'nope'}),e=>e.code==='validation');assert.throws(()=>RH.applyRobinhoodEvolution({}),e=>e.code==='validation');
 assert.equal(RH.robinhoodAutopilot().enabled,true,'a refused apply changes nothing');
 const a=RH.applyRobinhoodEvolution({paramsHash:hash});assert.equal(a.applied,true);assert.equal(a.paramsHash,hash);
 const p=J.loadPaper();assert.equal(p.paramsHash,hash);assert.equal(p.params.takeMult,5);assert.equal(p.qualification.qualified,false);assert.equal(p.qualification.closes,0,'qualification counts only the new hash');
 const ap=RH.robinhoodAutopilot();assert.equal(ap.enabled,false);assert.equal(ap.disabledReason,'paramsChanged');assert.equal(a.realAutopilot.disabledReason,'paramsChanged');
 assert.equal(JSON.stringify({...ap,enabled:null,disabledReason:null,disabledAt:null,lastAction:null}),realBefore,'real autopilot settings are otherwise untouched');
 const ledger=JSON.parse(fs.readFileSync(RH.__testing.evolveFile,'utf8'));assert.equal(ledger.applied.paramsHash,hash);assert.equal(ledger.applied.by,'operator');assert.equal(ledger.events[0].type,'applied');
 assert.equal(RH.robinhoodEvolveView().proposed,null,'an applied champion is no longer proposed');
 assert.equal(RH.applyRobinhoodEvolution({paramsHash:hash}).applied,false,'idempotent');
 const out=E.loadEvolveLedger();out.champion.params={...champion,emaFast:200};E.saveEvolveLedger(out);RH.setRobinhoodPaperAutopilot({params:{takeMult:4}});
 assert.throws(()=>RH.applyRobinhoodEvolution({paramsHash:hash}),e=>e.code==='validation','out-of-bounds champions are refused');
 assert.equal(mock.writes().length,0);
});
test('trader: autopromote applies a proposed champion to paper only and records the promotion',async()=>{
 reset();writeTape('BTC-USD',4);RH.setRobinhoodPaperAutopilot({params:{maxSpreadBps:1}});process.env.ROBINHOOD_EVOLVE_AUTOPROMOTE='true';
 let r=null;for(let i=0;i<12&&!(r&&r.beats);i++){mock.state.time+=1000;r=await RH.runRobinhoodEvolveOnce({manual:true})}
 assert.equal(r.beats,true,JSON.stringify(r));assert.equal(r.promoted,true);assert.equal(r.proposed,false);
 assert.equal(J.loadPaper().paramsHash,r.bestHash);const ledger=JSON.parse(fs.readFileSync(RH.__testing.evolveFile,'utf8'));assert.equal(ledger.applied.by,'autopromote');assert.equal(ledger.history[0].promoted,true);
 assert.equal(RH.robinhoodAutopilot().enabled,false);assert.equal(mock.writes().length,0);
 delete process.env.ROBINHOOD_EVOLVE_AUTOPROMOTE;
});
test('trader: the loop tick buffers the durable tape and the paper params change disables real autopilot immediately',async()=>{
 reset();qualify();RH.armRobinhood(true);RH.setRobinhoodAutopilot({enabled:true,confirmation:'ENABLE REAL CRYPTO AUTOPILOT'});
 RH.setRobinhoodPaperAutopilot({params:{takeMult:6}});assert.equal(RH.robinhoodAutopilot().enabled,false);assert.equal(RH.robinhoodAutopilot().disabledReason,'paramsChanged');
 RH.setRobinhoodPaperAutopilot({params:{takeMult:6}});assert.equal(RH.robinhoodAutopilot().disabledReason,'paramsChanged','same hash: no new event');
 RH.setRobinhoodPaperAutopilot({enabled:true,symbols:['BTC-USD']});const tick=await RH.__testing.tick();assert.equal(tick.ran,true,JSON.stringify(tick));
 const st=T.tapeStatus();assert.equal(st.pending+st.flushedRows,1,'one sampled quote reached the durable tape');const rows=T.loadTape('BTC-USD');assert.equal(rows.length,1);assert.equal(rows[0].bid,100);assert.equal(rows[0].t,mock.state.time);
 mock.state.time+=RH.__testing.TICK_MS;mock.state.bid=101;mock.state.ask=101.1;await RH.__testing.tick();assert.equal(T.loadTape('BTC-USD').length,2);
 RH.stopRobinhoodLoops();assert.equal(T.pendingTapeRows(),0);assert.equal(T.loadTape('BTC-USD').length,2,'stop flushes the tape');assert.ok(fs.existsSync(T.tapeFile('BTC-USD')));
});
test('lab champions: need Robinhood-sourced evidence and 100 test closes, match their hash, stay proposed, and arrive at most hourly',()=>{
 reset();E.__testing.reset();const base=J.loadPaper().params;
 const doc=(emaFast,extra={})=>{const params={...base,emaFast};return {schema:'mpo.lab-champion.v1',family:'robinhood-breakout',labNodeId:'lab-1',publishedAt:1,paramsHash:S.paramsHash(S.normalizeParams(params)),params,evidence:{quoteSource:'robinhood',testCloses:120,testPF:1.4},...extra}};
 assert.equal(RH.offerLabChampion(doc(10,{evidence:{quoteSource:'coinbase-public-paper',testCloses:500}})).reason,'quoteSource');
 assert.equal(RH.offerLabChampion(doc(10,{evidence:{quoteSource:'robinhood',testCloses:40}})).reason,'testCloses');
 assert.equal(RH.offerLabChampion(doc(10,{paramsHash:'000000000000'})).reason,'paramsHash');
 assert.equal(RH.offerLabChampion(doc(2)).reason,'bounds');
 const hashBefore=J.loadPaper().paramsHash,ok=RH.offerLabChampion(doc(10));
 assert.equal(ok.accepted,true);assert.equal(ok.promoted,false);
 const l=E.loadEvolveLedger();assert.equal(l.champion.paramsHash,ok.paramsHash);assert.equal(l.champion.metrics.source,'evolution-lab');assert.equal(l.events[0].source,'evolution-lab');
 assert.equal(J.loadPaper().paramsHash,hashBefore,'a lab champion is only proposed while autopromote is off');
 assert.equal(RH.offerLabChampion(doc(10)).reason,'duplicate');
 assert.equal(RH.offerLabChampion(doc(11)).reason,'rateLimited');
 mock.state.time+=3601e3;assert.equal(RH.offerLabChampion(doc(11)).accepted,true);
 assert.equal(RH.applyRobinhoodEvolution({paramsHash:E.loadEvolveLedger().champion.paramsHash}).applied,true,'APPLY still works on a lab champion');
});
