import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MarketPlatform} from '../src/core/platform.js';
import {entity} from '../src/core/model.js';
import {operatingProfiles,paperLaneEnabled} from '../src/runtime.js';
import {exploratoryVariants,BotFarm} from '../src/botFarm.js';
import {createPumpfunCopyPaper,qualifiedPumpCopyWallets} from '../src/pumpfunCopyPaper.js';
import {usSingleExecutableMarket} from '../src/polymarketUS.js';
import {dailyExecutionQuoteFromEstimates} from '../src/robinhoodAutoTrader.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('exact-size RH estimates reject either invalid quote leg and retain greater observed fees',()=>{
 const args={symbol:'SOL-USD',quantity:1,increment:.001,receivedAt:10000,eligibleAt:9000,accountFeeRatio:.0095,
  asks:[{symbol:'SOL-USD',quantity:1,ask:101,at:9500,feeRatio:.02}],bids:[{symbol:'SOL-USD',quantity:1,bid:100,at:9600,estFee:3}]};
 const q=dailyExecutionQuoteFromEstimates(args);assert.equal(q.feeRatio,.03);assert.equal(q.executableQuantity,1);
 const future=structuredClone(args);future.bids[0].at=10001;assert.equal(dailyExecutionQuoteFromEstimates(future),null);
 const early=structuredClone(args);early.asks[0].at=8999;assert.equal(dailyExecutionQuoteFromEstimates(early),null);
 const size=structuredClone(args);size.bids[0].quantity=2;assert.equal(dailyExecutionQuoteFromEstimates(size),null);
});
test('US singles read exact best-level capacity and reject crossed or mismatched books',async()=>{
 const book={marketSlug:'fixture',state:'MARKET_STATE_OPEN',bids:[{px:{value:'.4'},qty:2}],offers:[{px:{value:'.6'},qty:3},{px:{value:'.6'},qty:1},{px:{value:'.7'},qty:90}]};
 const fetchImpl=async(url,options)=>{assert.match(url,/\/v1\/markets\/fixture\/book$/);assert.equal(options.method,undefined);return {ok:true,json:async()=>book};};
 const q=await usSingleExecutableMarket({slug:'fixture'},{fetchImpl,now:()=>1000});assert.equal(q.askSize,4);assert.equal(q.bidSize,2);assert.equal(q.quoteAt,1000);
 book.marketSlug='other';await assert.rejects(usSingleExecutableMarket({slug:'fixture'},{fetchImpl}),/identity mismatch/);
 book.marketSlug='fixture';book.bids[0].px.value='.8';await assert.rejects(usSingleExecutableMarket({slug:'fixture'},{fetchImpl}),/two-sided executable depth/);
});
const proposal=(now=1000)=>{const params={minEdge:.04,volMultiple:1};const identity=hash({paramsHash:hash(params),corpusHash:'a'.repeat(64),featureHash:'b'.repeat(64),codeHash:'c'.repeat(64)});return {schema:'mpo.lab-exploratory-proposals.v1',paperOnly:true,qualificationEffect:'NONE',proposals:[{id:identity,module:'kalshi-btc',strategyId:'standing-btc',params,paramsHash:hash(params),corpusHash:'a'.repeat(64),featureHash:'b'.repeat(64),codeHash:'c'.repeat(64),frozenAt:now,startAfter:now,evaluationEndsAt:now+7*86400e3,capitalUsd:25,maxLossUsd:25,qualificationStage:'EXPLORATORY',qualificationEffect:'NONE',paperPromotionAllowed:false,prediction:{meanPerBet:.02,validationN:30,role:'ADAPTIVE_VALIDATION'}}]};};
test('steady preserves fast paper lanes and cannot enable real orders',()=>{
 assert.equal(operatingProfiles.FAST_PAPER_STEADY.paidModelCalls,0);
 assert.equal(paperLaneEnabled(operatingProfiles.FAST_PAPER_STEADY,'arbitrage','paper'),true);
 assert.equal(paperLaneEnabled(operatingProfiles.FAST_PAPER_STEADY,'arbitrage','live'),false);
 assert.equal(paperLaneEnabled(operatingProfiles.FAST_PAPER_STEADY,'nativeSniper','paper'),false);
});
test('exploratory admission checks identities, frozen window and authority without qualification bypass',()=>{
 const p=proposal(),valid=exploratoryVariants(p,1500);assert.equal(valid.length,1);assert.equal(valid[0].experiment.qualificationEffect,'NONE');
 const altered=structuredClone(p);altered.proposals[0].params.minEdge=.02;assert.equal(exploratoryVariants(altered,1500).length,0);
 const live=structuredClone(p);live.proposals[0].liveActivationAllowed=true;assert.equal(exploratoryVariants(live,1500).length,0);
 assert.equal(exploratoryVariants(p,999).length,0);assert.equal(exploratoryVariants(p,1000+8*86400e3).length,0);
});
test('admitted books freeze params and capital; changing proposal does not reset prior outcomes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-farm-forward-'));try{
 fs.mkdirSync(path.join(dir,'lab-link'));fs.writeFileSync(path.join(dir,'lab-link','exploratory-proposals.json'),JSON.stringify(proposal()));
 const farm=new BotFarm({dataDir:dir,bots:{},now:()=>1500}),v=farm.variants().find(x=>x.exploratory);
 assert.equal(farm.state.books[v.id].startUsd,25);farm.state.books[v.id].cashUsd=3;farm.save();
 const changed=proposal();changed.proposals[0].params.volMultiple=2;changed.proposals[0].paramsHash=hash(changed.proposals[0].params);changed.proposals[0].id=hash({paramsHash:changed.proposals[0].paramsHash,corpusHash:changed.proposals[0].corpusHash,featureHash:changed.proposals[0].featureHash,codeHash:changed.proposals[0].codeHash});
 fs.writeFileSync(farm.exploratoryFile,JSON.stringify(changed));const all=farm.variants().filter(x=>x.exploratory);
 assert.equal(all.length,2);assert.equal(farm.state.books[v.id].cashUsd,3);assert.equal(all.find(x=>x.id===v.id).over.volMultiple,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('prospective collector retains separate exact-depth receipts and settles without backfilling',async()=>{
 const p=new MarketPlatform();let clock=Date.now()-3000;const closeAt=clock+100000;
 const contract=()=>entity('Contract','kalshi','KXBTC-TEST',{title:'BTC',eventId:'btc-event',closeAt,settlementRules:'settle on index',resolutionSource:'index',feeModel:{venue:'kalshi',kind:'KALSHI_QUADRATIC_TAKER',rate:.07,rounding:'CENT_PER_ORDER',overridesChecked:true,overrideState:'NONE'}});
 const provider={markets:async()=>({markets:[contract()]}),market:async()=>contract(),book:async()=>({observedAt:clock,yes:{asks:[{price:.4,quantity:3}],bids:[{price:.39,quantity:3}]},no:{asks:[{price:.61,quantity:3}],bids:[{price:.6,quantity:3}]}})};
 p.providers.providers.set('kalshi',provider);
 try{assert.equal((await p.capturePredictionEvidence({now:clock})).books,1);clock+=1500;await p.capturePredictionEvidence({now:clock});
 const e=p.predictionEpisodes().episodes[0];assert.equal(e.quotes.length,2);assert.equal(Math.abs(e.quotes[1].at-e.quotes[0].at),1500);assert.equal(e.quotes[0].quantity,1);assert.equal(e.settlement,null);
 const r=p.predictionResearch();assert.equal(r.closedOutcomes,0);assert.equal(r.refusals[0].reason,'MISSING_OR_INCOMPATIBLE_SETTLEMENT');
 }finally{p.close();}
});
test('exploratory Pump cohorts do not alter the qualified wallet gate or share cash',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-pump-forward-')),now=Date.now(),wallet='11111111111111111111111111111111';
 const card={asOf:now-1,wallets:[{wallet,lastTs:now-1000,roundTrips:2,realizedPnlSol:-1,pnlWithoutBestSol:-2}]};
 try{const core=createPumpfunCopyPaper({dataDir:dir,now:()=>now,scorecard:()=>card});
 const explorer=createPumpfunCopyPaper({dataDir:dir,now:()=>now,scorecard:()=>card,experiment:{id:'emerging-v1',policy:'emerging'},settings:{minTrips:2}});
 assert.equal(qualifiedPumpCopyWallets(card,{asOf:now}).length,0);assert.equal(core.view().leaders.length,0);assert.equal(explorer.view().leaders.length,1);assert.notEqual(core.file,explorer.file);assert.equal(explorer.view().experiment.qualificationStage,'EXPLORATORY');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
