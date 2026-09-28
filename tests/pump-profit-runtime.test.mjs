import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {collectPumpProfitQuotes,PROFIT_QUOTE_URL} from '../src/pumpProfitQuotes.js';
import {simulatePumpPaperExecution} from '../src/executionSim.js';
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mpo-profit-test-'));
test('exact-input buys cannot exceed allowed SOL; liquidity and timestamp safeguards remain active',()=>{const now=Date.now(),candidate={mint:'test',priceUsd:1,priceObservedAt:now,liq:1000,executionScore:80,micro:{}};for(const size of [.005,.01,.1]){const f=simulatePumpPaperExecution(candidate,size,100,80,25,{side:'BUY',now,seed:'stable'});if(f.status!=='REJECTED'){assert.ok(f.gross<=size+1e-12);assert.ok(f.fillAt>=now);assert.ok(f.feeSol>=0);}}const empty=simulatePumpPaperExecution({...candidate,liq:0},.01,100,80,25,{now});assert.equal(empty.status,'REJECTED');});
test('keyless quotes use public GET only, retain executable data, and enforce budget',async()=>{const dir=tmp(),now=Date.now(),mint='A'.repeat(32),requests={mode:'PAPER',protocolHash:'test',liveExecutionAllowed:false,createdAt:now,expiresAt:now+60000,requests:[{key:'one',mint,side:'BUY',amountRaw:'10000000',submittedAt:now,expiresAt:now+60000}]};fs.writeFileSync(path.join(dir,'pump-profit-requests.json'),JSON.stringify(requests));let calls=0;const result=await collectPumpProfitQuotes({dir,now,sleep:async()=>{},fetchImpl:async(url,options)=>{calls++;assert.equal(new URL(url).origin,new URL(PROFIT_QUOTE_URL).origin);assert.equal(options.method,'GET');assert.deepEqual(options.headers,{accept:'application/json'});return {ok:true,json:async()=>({inputMint:new URL(url).searchParams.get('inputMint'),outputMint:mint,inAmount:'10000000',outAmount:'1000000',otherAmountThreshold:'990000',swapMode:'ExactIn',contextSlot:100,routePlan:[{swapInfo:{ammKey:'pool',feeAmount:'25'}}]})};}});assert.equal(calls,1);assert.equal(result.paidCalls,0);const cache=JSON.parse(fs.readFileSync(path.join(dir,'pump-profit-quotes.json')));assert.equal(cache.quotes[0].allCostsKnown,false);assert.ok(fs.existsSync(path.join(dir,'research-evidence/raw/pump-profit-quotes-test.ndjson')));cache.calls=4096;fs.writeFileSync(path.join(dir,'pump-profit-quotes.json'),JSON.stringify(cache));assert.equal((await collectPumpProfitQuotes({dir,now,sleep:async()=>{},fetchImpl:async()=>{throw Error('budget bypass');}})).calls,0);fs.rmSync(dir,{recursive:true,force:true});});
test('runtime safety and pinned policies survive a new Node process without resetting capital',()=>{const dir=tmp(),moduleUrl=new URL('../src/pumpProfitRuntime.js',import.meta.url).href;const code=`import fs from 'node:fs';import {initializePumpCapture,applyPumpSafety} from ${JSON.stringify(moduleUrl)};const s={mode:'PAPER',paperStartSol:.15,cashSol:.14,realizedLifetimePnlSol:-.01,positions:[],history:[],runtime:{profile:'FAIR',aggression:72,followLabBest:false},portfolioSeries:[]};const cfg={mode:'paper',minSolReserve:.02,simulatedFeeBps:25,tradeSizeSol:.05,maxPositionSol:.15,maxTotalExposureSol:.45,riskPerTradePct:1};applyPumpSafety(s,{maxPositionSol:.025,feeReserveSol:.03});initializePumpCapture(s,cfg);fs.writeFileSync(process.env.MONEY_PRINTER_DATA_DIR+'/fixture.json',JSON.stringify(s));`;const env={...process.env,MONEY_PRINTER_DATA_DIR:dir,MODE:'paper'};let r=spawnSync(process.execPath,['--input-type=module','-e',code],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const original=JSON.parse(fs.readFileSync(path.join(dir,'fixture.json')));r=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';const s=JSON.parse(fs.readFileSync(process.env.MONEY_PRINTER_DATA_DIR+'/fixture.json'));if(s.runtime.pumpSafety.maxPositionSol!==.025||s.cashSol!==.14||s.realizedLifetimePnlSol!==-.01)process.exit(1);console.log(s.pumpProfitCapture.baseline.policy.hash);`],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),original.pumpProfitCapture.baseline.policy.hash);fs.rmSync(dir,{recursive:true,force:true});});

test('SOL exchange-rate conversion is prospective; untagged historical positions remain unchanged',async()=>{
 const {markedPositionValue,equity}=await import('../src/accounting.js');
 const {paperExitQuote,exitSimulation,simulatePaperExit}=await import('../src/positionExecution.js');
 const p={id:'fx',mint:'test',sizeSol:.1,remainingSol:.1,entryPrice:1,lastPrice:1,entrySolUsd:100,lastSolUsd:200,realizedSol:0,lastLiquidityUsd:1e6,executionScore:95};
 assert.equal(markedPositionValue(p),.05);
 assert.ok(Math.abs(equity({cashSol:.9,market:{solUsd:200},positions:[p]})-.95)<1e-12);
 const sim={slippageBps:0,feeBps:0,solUsd:200};
 assert.equal(paperExitQuote(p,1,sim).proceeds,.05);
 const old={...p};delete old.entrySolUsd;
 assert.equal(markedPositionValue(old),.1);assert.equal(paperExitQuote(old,1,sim).proceeds,.1);
 const pair={priceUsd:1,liquidity:{usd:1e6}};
 assert.equal(exitSimulation(p,pair,200,0,0).solUsd,200);
 assert.equal(simulatePaperExit(p,pair,200,0,0,1,{seed:'fx'}).requestedValueSol,.05);
});

test('production state store preserves safety limits and capital across restart',()=>{
 const dir=tmp(),url=new URL('../src/store.js',import.meta.url).href;
 const env={...process.env,MONEY_PRINTER_DATA_DIR:dir,MODE:'paper',PAPER_START_SOL:'0.15'};
 const save=`import {loadState,saveState} from ${JSON.stringify(url)};const s=loadState();s.runtime.pumpSafety={maxPositionSol:.025,maxExposureSol:.07,feeReserveSol:.03};s.runtime.followLabBest=false;s.runtime.controlMode='MANUAL';saveState(s);`;
 let r=spawnSync(process.execPath,['--input-type=module','-e',save],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const read=`import {loadState} from ${JSON.stringify(url)};const s=loadState();if(s.runtime.pumpSafety.maxPositionSol!==.025||s.runtime.pumpSafety.feeReserveSol!==.03||s.runtime.controlMode!=='MANUAL'||s.cashSol!==.15||s.paperStartSol!==.15)throw Error('production persistence regression');`;
 r=spawnSync(process.execPath,['--input-type=module','-e',read],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 fs.rmSync(dir,{recursive:true,force:true});
});
