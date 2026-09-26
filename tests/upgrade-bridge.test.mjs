import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const lab=path.resolve(process.env.MPO_LAB_SOURCE_DIR||path.join(root,'..','money-printer-evolution-lab'));
test('actual trader-to-Lab Kalshi handoff, shared leases and evaluator bytes interoperate offline',{skip:!fs.existsSync(path.join(lab,'src','moduleResearch.js'))},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-two-apps-')),traderData=path.join(temp,'trader'),labData=path.join(temp,'lab');
 Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:traderData,MPO_LAB_TRADER_DATA_DIR:traderData,MPO_LAB_DATA_DIR:labData,MPO_COMPUTE_BUDGET_FILE:path.join(temp,'budget.json')});
 fs.mkdirSync(traderData,{recursive:true});fs.mkdirSync(labData,{recursive:true});
 const native=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network is forbidden in bridge fixtures')};let platform;
 try{
  for(const [a,b] of [['src/core/computeLease.js','src/computeLease.js'],['src/robinhoodBacktest.js','src/robinhoodBacktest.js'],['src/predictionExperiment.js','src/predictionExperiment.js']])assert.equal(fs.readFileSync(path.join(root,a),'utf8'),fs.readFileSync(path.join(lab,b),'utf8'),a);
  const source=await import('../src/core/computeLease.js'),remote=await import(pathToFileURL(path.join(lab,'src','computeLease.js')));
  const first=source.acquireComputeLease({owner:'trader-fixture',maxSlots:1});assert.equal(first.ok,true);
  assert.equal(remote.acquireComputeLease({owner:'lab-fixture',maxSlots:1}).ok,false);assert.equal(source.releaseComputeLease(first.token).ok,true);
  const second=remote.acquireComputeLease({owner:'lab-fixture',maxSlots:1});assert.equal(second.ok,true);remote.releaseComputeLease(second.token);
  const {MarketPlatform}=await import('../src/core/platform.js'),{termsFingerprint}=await import('../src/core/contractTerms.js');
  platform=new MarketPlatform({file:':memory:',dataDir:traderData});
  const now=Date.now(),contract={venue:'kalshi',title:'Synthetic test contract',eventId:'fixture-event',closeAt:now-10000,settlementRules:'YES iff fixture wins',resolutionSource:'isolated fixture',currency:'USD',payout:1};
  const base={kind:'Contract',provider:'kalshi',sourceId:'K-ONE'};
  platform.store.put({...base,data:contract,observedAt:now-60000,availableAt:now-60000});
  const rulesFingerprint=termsFingerprint(contract),feeModel={venue:'kalshi',kind:'KALSHI_QUADRATIC_TAKER',rate:.07,rounding:'CENT_PER_ORDER',overrideState:'NONE',overridesChecked:true};
  for(const [offset,ask] of [[40000,.4],[30000,.41]])platform.store.put({kind:'OrderBook',provider:'kalshi',sourceId:'K-ONE',observedAt:now-offset,availableAt:now-offset,
    data:{contractCloseAt:contract.closeAt,contractRulesFingerprint:rulesFingerprint,feeModel,yes:{asks:[{price:ask,quantity:10}]}}});
  platform.store.put({...base,data:{...contract,settlementOutcome:'YES'},observedAt:now-5000,availableAt:now-5000});
  const handoff=platform.publishPredictionHandoff();assert.equal(handoff.episodes.length,1);assert.equal(handoff.episodes[0].quotes.length,2);
  const {runKalshiResearch}=await import(pathToFileURL(path.join(lab,'src','moduleResearch.js')));
  const cfg={labDataDir:labData,traderDataDir:traderData,sameMachineTrader:true,bridgeDir:'',bridgeKey:'',nodeId:'isolated-fixture',nodeName:'isolated-fixture'};
  const result=await runKalshiResearch({cfg,now});assert.equal(result.closedOutcomes,1);assert.ok(Math.abs(result.netPnl-.57)<1e-8);assert.equal(result.paperPromotionAllowed,false);assert.equal(result.liveActivationAllowed,false);
  assert.ok(result.experiment.id);assert.equal(JSON.parse(fs.readFileSync(path.join(traderData,'lab-link','modules','kalshi.json'))).experiment.id,result.experiment.id);
  platform.store.put({kind:'OrderBook',provider:'kalshi',sourceId:'K-ONE',observedAt:now-20000,availableAt:now-20000,
    data:{contractCloseAt:contract.closeAt,contractRulesFingerprint:rulesFingerprint,feeModel:{...feeModel,overrideState:'UNVERIFIED'},yes:{asks:[{price:.42,quantity:10}]}}});
  assert.equal(platform.predictionEpisodes().episodes[0].quotes.find(q=>q.ask===.42).feesKnown,false,'a modeled unknown override is not verified cost evidence');
  fs.writeFileSync(path.join(traderData,'lab-link','kalshi-episodes.json'),JSON.stringify({...handoff,schema:'incompatible'}));
  assert.equal((await runKalshiResearch({cfg,now})).phase,'WAITING_FOR_DATA');
 }finally{platform?.close();globalThis.fetch=native;fs.rmSync(temp,{recursive:true,force:true})}
});
