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
import {candidateLeaders,LeaderDiscovery,LEADER_SOURCES,discoveredCopyRows} from '../src/leaderDiscovery.js';
import {commandCenterSnapshot,createLabConnection,commandMarketSnapshot,readCommandContracts} from '../src/commandCenter.js';
import {CoreDatabase} from '../src/core/database.js';

test('leader discovery deduplicates sources and retains the last real candidates on provider failure',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'copy-discovery-')),wallet='0x'+'a'.repeat(40);let offline=false,time=1000,calls=0;
 const row={proxyWallet:wallet,userName:'Leader',pnl:100,vol:1000,rank:1};
 const fetchImpl=async()=>{calls++;if(offline)throw Error('provider offline');return {ok:true,json:async()=>[row,{...row,proxyWallet:'invalid'},{...row,proxyWallet:'0x'+'b'.repeat(40),pnl:-1}]};};
 const discovery=new LeaderDiscovery({dataDir:dir,fetchImpl,now:()=>time});
 try{const first=await discovery.run();assert.equal(calls,LEADER_SOURCES.length);assert.equal(first.candidates.length,1);assert.equal(first.candidates[0].sources.length,5);assert.equal(first.rejected,10);assert.equal(first.candidates[0].qualification,'UNQUALIFIED');
  offline=true;time=2000;const failed=await discovery.run();assert.equal(failed.status,'ERROR');assert.equal(failed.lastRunAt,2000);assert.equal(failed.lastSuccessAt,1000);assert.deepEqual(failed.candidates,first.candidates);assert.equal(discovery.snapshot().running,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('discovery never elevates leaderboard profit to follower qualification and rejects nonfinite data',()=>{
 const result=candidateLeaders([{period:'DAY',category:'ALL',rows:[{proxyWallet:'0x'+'c'.repeat(40),pnl:Infinity,vol:200},{proxyWallet:'0x'+'d'.repeat(40),pnl:20,vol:100}]}],100);
 assert.equal(result.rejected,1);assert.equal(result.candidates[0].qualification,'UNQUALIFIED');assert.match(result.candidates[0].note,/follower/);
});

test('copy refill uses only fresh weekly evidence in the frozen category',()=>{
 const source={period:'WEEK',category:'SPORTS',observedAt:1000,rank:2,pnl:90,volume:300};
 const catalogue={candidates:[{proxyWallet:'0x'+'a'.repeat(40),userName:'A',pnl:999,vol:999,sources:[source]}]};
 assert.deepEqual(discoveredCopyRows(catalogue,{category:'SPORTS',now:2000}),[{proxyWallet:'0x'+'a'.repeat(40),userName:'A',rank:2,pnl:90,vol:300}]);
 assert.deepEqual(discoveredCopyRows(catalogue,{category:'ALL',now:2000}),[]);assert.deepEqual(discoveredCopyRows(catalogue,{category:'SPORTS',now:0}),[]);assert.deepEqual(discoveredCopyRows(catalogue,{category:'SPORTS',now:21*60000}),[]);
});

test('coordination separates discovery, watched leaders, loss pauses, and missing Lab status',()=>{
 const result=commandCenterSnapshot({bots:{polycopy:{status:'PAUSED',follows:[{wallet:'a',name:'A'}],open:[{}],stats:{closed:71,pnlUsd:-136.5},lastRunAt:900,drawdownPause:{active:true,reason:'drawdown'}}},discovery:{candidates:[{},{}],lastSuccessAt:500},now:1000});
 assert.equal(result.copy.uniqueLeaders,1);assert.equal(result.copy.books[0].paused,true);assert.equal(result.copy.books[0].lastRunAt,900);assert.equal(result.copy.catalogue.lastSuccessAt,500);assert.equal(result.lab.connected,false);assert.equal(result.lab.resources,null);assert.equal(result.profiles.lab,null);
 assert.equal(commandCenterSnapshot({state:{runtime:{profile:"MAX",researchMode:"MAX_RESEARCH"}}}).profiles.trader,"MAX_RESEARCH");assert.equal(commandCenterSnapshot().copy.uniqueLeaders,null);assert.ok(operatingProfiles.MAX_RESEARCH);assert.equal(operatingProfiles.MAX_RESEARCH.paidModelCalls,0);
});

test('Lab connection coalesces reads and requires profile acknowledgement',async()=>{
 let release,calls=0,time=10000,fail=false;const held=new Promise(r=>release=r);
 const c=createLabConnection({now:()=>time,fetchImpl:async(url,opt)=>{calls++;if(opt.method==='POST')return {ok:true,json:async()=>({ok:true,policy:{profile:'FAST_PAPER_STEADY'}})};await held;if(fail)throw Error('offline');return {ok:true,json:async()=>({build:{},schedulerPolicy:{profile:'BURST_RESEARCH'}})};}});
 const a=c.state(),b=c.state();release();assert.deepEqual(await a,await b);assert.equal(calls,1);await c.state();assert.equal(calls,1);
 await assert.rejects(c.profile('MAX_RESEARCH'),/acknowledge/);await assert.rejects(c.profile('invented'),/Unknown/);
 time+=6000;fail=true;const result=await c.state();assert.equal(result.lab,null);assert.equal(result.error,'offline');
});

test('price overview reads every stored contract and distinguishes quotes, session closes and unknowns',()=>{
 const store=new CoreDatabase(':memory:');
 try{const insert=store.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)');for(let i=0;i<1001;i++)insert.run('c'+i,'Contract','kalshi','t'+i,1000,1000,null,1,JSON.stringify({title:'Contract '+i,yesBid:.3,yesAsk:i===1000?null:.4,currency:'USD'}));
  const contracts=readCommandContracts(store);assert.equal(contracts.length,1001);
  const market=commandMarketSnapshot({contracts,crypto:[{symbol:'BTC-USD',bid:100,ask:102,at:1000,source:'v2'}],equities:{provider:'IEX',bars:{SPY:[{d:'2026-10-02',c:600}]}},state:{watchlist:[{mint:'a',symbol:'A',priceUsd:null}]}});
  assert.equal(market.predictions.length,1001);assert.equal(market.predictions.find(q=>q.id==='c1000').ask,null);assert.equal(market.assets[0].price,101);assert.equal(market.assets[1].kind,'SESSION_CLOSE');assert.equal(market.assets[1].at,null);assert.equal(market.assets[2].price,null);assert.ok(market.predictions.every(p=>!p.executable));
 }finally{store.db.close();}
});
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
