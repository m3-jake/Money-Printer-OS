import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { CoreDatabase } from '../src/core/database.js';
import { UnifiedLedger } from '../src/core/ledger.js';
import { entity,stableId,units,decimal,availableHistory } from '../src/core/model.js';
import { MarketEventBus } from '../src/core/eventBus.js';
import { evaluateRisk,DEFAULT_LIMITS,validateLimits,portfolioRiskState } from '../src/core/risk.js';
import { compareContracts,arbitrageQuote } from '../src/core/contracts.js';
import { normalizeKalshi,normalizeKalshiBook,normalizePolymarket,KalshiProvider,PolymarketProvider } from '../src/core/predictionProviders.js';
import { ProviderRegistry,JsonProvider } from '../src/core/provider.js';
import { MarketPlatform } from '../src/core/platform.js';
import { legacyCoverage,solanaLegacy,usCombosLegacy,legacyTotals } from '../src/core/legacyBooks.js';
import { syncLabChampions,labEvidence,LAB_CHAMPION_SOURCES } from '../src/core/labSync.js';
import { comboPerformance,wilson } from '../src/core/comboPerformance.js';
import { extractTerms,matchTerms,sameName,participants,candidatePairs,termsFingerprint } from '../src/core/contractTerms.js';
import { VERIFY_PHRASE } from '../src/core/platform.js';
import { kalshiFeeModel,polymarketFeeModel,takerFee } from '../src/core/fees.js';
import { AlpacaQuotes,STOCK_VENUE } from '../src/core/brokers.js';
import { ReplaySession,runReplay,tapeRecords,alpacaMinuteRecords,fetchAlpacaMinutes,strategyParams } from '../src/core/replay.js';
import { endOfDayEt,transform as macroTransform,parseFredCsv,vintagesFrom,asOf as macroAsOfFn,impliedLadder,FredSource } from '../src/core/macro.js';
import { filingsFromSubmissions,filingsFromAtom,parseForm4,analyseFiling,userAgent,EdgarSource } from '../src/core/edgar.js';
import { StrategyRegistry,promotionCheck,labChampionLifecycle } from '../src/core/strategies.js';
import { assertGlobalTradingNotHalted } from '../src/core/executionBoundary.js';
import { localMutationAllowed } from '../src/core/http.js';

test('canonical identity is source-qualified and delimiter-safe',()=>{
  assert.notEqual(stableId('Contract','kalshi','123'),stableId('Contract','polymarket','123'));
  assert.notEqual(stableId('Event','a:b','c'),stableId('Event','a','b:c'));
  assert.throws(()=>stableId('Anything','a','b'));
});
test('fixed-point cash remains exact and refuses hidden rounding/nonfinite input',()=>{
  assert.equal(units('0.1')+units('0.2'),units('0.3'));assert.equal(decimal(1000001n),'1.000001');
  for(const v of ['NaN','Infinity','1e8','0.0000001','',null])assert.throws(()=>units(v));
});
test('observation history enforces availability and keeps revised values out of past replay',()=>{
  const s=new CoreDatabase(':memory:');
  const first=entity('EconomicRelease','fred','CPI:2025-01',{value:1},{observedAt:1000,availableAt:900});
  s.put(first);s.put({...first,observedAt:3000,availableAt:2900,data:{value:2}});
  assert.equal(s.history(first.id,2000).at(-1).data.value,1);assert.equal(s.history(first.id,4000).at(-1).data.value,2);
  assert.deepEqual(availableHistory([{id:'x',availableAt:null},{id:'a',availableAt:3,revisionAvailableAt:10}],5),[]);
  assert.throws(()=>entity('Event','x','y',{}, {observedAt:2,availableAt:3}));s.close();
});
test('event notifications are bounded, isolate consumers, and expose failures',async()=>{
  const bus=new MarketEventBus({capacity:2});let deliveries=0;
  bus.on('ORDER_FILLED',async()=>{throw Error('observer failed');});bus.on('ORDER_FILLED',()=>deliveries++);
  bus.publish('ORDER_FILLED',{id:'1'});bus.publish('ORDER_FILLED',{id:'2'});assert.equal(bus.publish('ORDER_FILLED',{id:'3'}),false);
  await nextTurn();await nextTurn();assert.equal(deliveries,2);assert.equal(bus.snapshot().dropped,1);assert.equal(bus.snapshot().listenerErrors,2);
});
const event=(id,kind,patch={})=>({sourceKey:id,at:1000,mode:'PAPER',venue:'kalshi',account:'manual',currency:'USD',kind,reference:'TEST FIXTURE',...patch});
test('ledger reconstructs fee-aware partial closes, idempotency and currency/mode isolation',()=>{
  const s=new CoreDatabase(':memory:'),l=new UnifiedLedger(s);
  l.append(event('deposit','DEPOSIT',{gross:'100'}));
  const buy=event('buy','BUY',{instrumentId:'yes',quantity:'10',gross:'4',fee:'0.1'});l.append(buy);assert.equal(l.append(buy).appended,false);
  l.append(event('sell','SELL',{instrumentId:'yes',quantity:'5',gross:'3',fee:'0.1'}));
  let a=l.portfolio().accounts[0];assert.equal(a.cash,'98.800000');assert.equal(a.realized,'0.850000');assert.equal(a.positions[0].costBasis,'2.050000');
  l.append(event('resolve','SETTLEMENT',{instrumentId:'yes',quantity:'5',gross:'5'}));
  a=l.portfolio().accounts[0];assert.equal(a.cash,'103.800000');assert.equal(a.realized,'3.800000');assert.equal(a.positions.length,0);
  l.append(event('live','DEPOSIT',{mode:'LIVE',gross:'2'}));l.append(event('sol','DEPOSIT',{currency:'SOL',gross:'1'}));
  assert.equal(l.portfolio('LIVE').accounts[0].cash,'2.000000');assert.equal(l.portfolio().accounts.length,2);
  assert.throws(()=>l.append({...buy,gross:'5'}),/Conflicting/);
  assert.throws(()=>s.db.exec("DELETE FROM ledger"),/append-only/);assert.throws(()=>s.db.exec("UPDATE ledger SET gross_units='1'"),/append-only/);s.close();
});
test('overselling and overdrafts roll back atomically, including a failed batch',()=>{
  const s=new CoreDatabase(':memory:'),l=new UnifiedLedger(s);l.append(event('d','DEPOSIT',{gross:'1'}));
  assert.throws(()=>l.append(event('bad','SELL',{instrumentId:'x',quantity:'1',gross:'1'})),/oversell/);
  assert.throws(()=>s.transaction(()=>{l.append(event('good','DEPOSIT',{gross:'1'}));l.append(event('too-much','WITHDRAWAL',{gross:'3'}));}),/overdraw/);
  assert.equal(l.entries().length,1);assert.equal(l.portfolio().accounts[0].cash,'1.000000');s.close();
});
const order={mode:'PAPER',venue:'kalshi',account:'manual',currency:'USD',instrumentId:'x',strategyId:'s',eventId:'e',side:'BUY',quantity:10,price:.5,feeUsd:.1,slippageBps:10,liquidityUsd:100,quoteAt:1000};
const context={halted:false,liveAuthorized:false,reconciled:false,cashUsd:100,heldQuantity:10,positionUsd:0,venueUsd:0,strategyUsd:0,eventUsd:0,totalUsd:0,pendingCount:0,dailyPnlUsd:0,drawdownPct:0};
test('governor checks every money limit, modes and stale/nonfinite inputs',()=>{
  assert.equal(evaluateRisk(order,context,{now:1000}).allowed,true);
  const cases=[[{mode:'LIVE'}, {},'LIVE_NOT_AUTHORIZED'],[{mode:'live'}, {},'INVALID_MODE'],[{quoteAt:0},{},'STALE_QUOTE'],[{quoteAt:2000},{},'STALE_QUOTE'],[{quantity:NaN},{},'INVALID_QUANTITY'],[{feeUsd:null},{},'INVALID_FEEUSD'],[{slippageBps:101},{},'SLIPPAGE_LIMIT'],[{liquidityUsd:1},{},'INSUFFICIENT_LIQUIDITY'],[{quantity:100},{},'ORDER_LIMIT'],[{}, {cashUsd:0},'INSUFFICIENT_CASH'],[{}, {positionUsd:99},'MAXPOSITIONUSD'],[{}, {venueUsd:249},'MAXVENUEUSD'],[{}, {strategyUsd:149},'MAXSTRATEGYUSD'],[{}, {eventUsd:99},'MAXEVENTUSD'],[{}, {totalUsd:499},'MAXTOTALUSD'],[{}, {pendingCount:5},'CONCURRENT_ORDER_LIMIT'],[{}, {dailyPnlUsd:-25},'DAILY_LOSS_LIMIT'],[{}, {drawdownPct:20},'DRAWDOWN_LIMIT'],[{}, {halted:true},'GLOBAL_HALT'],[{side:'SELL',quantity:11},{},'OVERSELL']];
  for(const [o,c,reason] of cases)assert.ok(evaluateRisk({...order,...o},{...context,...c},{now:1000}).reasons.includes(reason),reason);
  assert.throws(()=>validateLimits({maxOrderUsd:NaN}));assert.throws(()=>validateLimits({maxConcurrentOrders:1.5}));
});
test('loss limits block new BUYs but never trap a risk-reducing SELL (regression)',()=>{
  const sell={...order,side:'SELL',quantity:5};
  for(const c of [{dailyPnlUsd:-30},{drawdownPct:50},{dailyPnlUsd:null}]){
    assert.equal(evaluateRisk(sell,{...context,...c},{now:1000}).allowed,true,JSON.stringify(c));
    assert.equal(evaluateRisk(order,{...context,...c},{now:1000}).allowed,false,JSON.stringify(c));
  }
  assert.ok(evaluateRisk(sell,{...context,halted:true},{now:1000}).reasons.includes('GLOBAL_HALT'));
});
test('book risk state is GREEN/YELLOW/RED from loss metrics; HALTED wins',()=>{
  assert.equal(portfolioRiskState({dailyPnlUsd:0,drawdownPct:0}).state,'GREEN');
  assert.equal(portfolioRiskState({dailyPnlUsd:-12.5,drawdownPct:0}).state,'YELLOW');
  assert.equal(portfolioRiskState({dailyPnlUsd:0,drawdownPct:10}).state,'YELLOW');
  assert.deepEqual(portfolioRiskState({dailyPnlUsd:-25,drawdownPct:0}).reasons,['DAILY_LOSS_LIMIT']);
  assert.equal(portfolioRiskState({dailyPnlUsd:0,drawdownPct:20}).state,'RED');
  assert.equal(portfolioRiskState({dailyPnlUsd:null,drawdownPct:0}).state,'RED');
  assert.equal(portfolioRiskState({dailyPnlUsd:-100,drawdownPct:90},DEFAULT_LIMITS,true).state,'HALTED');
});
const terms={eventKey:'federal-decision',outcomeDefinition:'target upper bound <= 4%',expiresAt:10000,resolutionSource:'Federal Reserve official release',settlementRules:'Pays 1 if true',edgeCases:'No announcement: void',cancellationRules:'Return cost on cancellation',currency:'USD',payout:1,termsVerified:true};
test('matching needs complete verified settlement terms, never just equal titles',()=>{
  assert.equal(compareContracts({...terms},{...terms}).classification,'EXACT MATCH');
  assert.equal(compareContracts({...terms,termsVerified:false},{...terms}).classification,'STRONG MATCH');
  assert.equal(compareContracts({title:'Fed'},{title:'Fed'}).classification,'RELATED');
  for(const k of ['eventKey','outcomeDefinition','expiresAt','currency','cancellationRules'])assert.equal(compareContracts(terms,{...terms,[k]:'different'}).classification,'NOT EQUIVALENT');
});
test('arbitrage prices both complementary books with depth, fees and stale-data refusal',()=>{
  const a={...terms,venue:'kalshi'},b={...terms,venue:'polymarket'},book={observedAt:1000,yes:{asks:[{price:.4,quantity:2},{price:.6,quantity:2}]},no:{asks:[{price:.5,quantity:5}]}};
  const q=arbitrageQuote(a,b,book,book,{quantity:3,feeA:.01,feeB:.02,now:1000});
  assert.ok(Math.abs(q.directions[0].capitalRequired-2.93)<1e-10);assert.ok(Math.abs(q.directions[0].theoreticalLockedReturn-.07)<1e-10);assert.equal(q.directions[0].riskFree,false);
  for(const opts of [{quantity:5,feeA:0,feeB:0,now:1000},{quantity:1,now:1000},{quantity:1,feeA:0,feeB:0,now:50000}])assert.equal(arbitrageQuote(a,b,book,book,opts).directions[0].theoreticalLockedReturn,null);
});
test('Kalshi fixed-point dollars and reciprocal books preserve subcent prices',()=>{
  const c=normalizeKalshi({ticker:'ABC',title:'A?',yes_bid_dollars:'0.1234',yes_ask_dollars:'0.15',volume_fp:'12.50'},1000);assert.equal(c.data.yesBid,.1234);assert.equal(c.data.noAsk,null);assert.equal(c.data.volume,12.5);
  const b=normalizeKalshiBook({orderbook_fp:{yes_dollars:[['0.10','3.50']],no_dollars:[['0.7000','5.00']]}},1000);assert.equal(b.yes.asks[0].price,.3);assert.equal(b.no.asks[0].price,.9);assert.equal(b.yes.bids[0].quantity,3.5);
  assert.throws(()=>normalizeKalshiBook({orderbook_fp:{yes_dollars:[['2','3']]}}));
});
test('Polymarket token IDs are mapped by outcome name and never assumed to be US slugs',()=>{
  const c=normalizePolymarket({id:'5',question:'Test',outcomes:'["No","Yes"]',clobTokenIds:'["no-token","yes-token"]',outcomePrices:'["0.7","0.3"]'},1000);
  assert.equal(c.data.yesToken,'yes-token');assert.equal(c.data.impliedProbability,.3);assert.equal(c.data.venue,'polymarket');assert.equal(c.data.termsVerified,false);
});
test('provider caches retain the original timestamp, coalesce requests and report failures',async()=>{
  let calls=0;const p=new JsonProvider('test',{fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({x:1})};}});
  const [a,b]=await Promise.all([p.get('https://test.invalid'),p.get('https://test.invalid')]);assert.equal(calls,1);assert.equal(p.observedAt(a),p.observedAt(b));
  const c=await p.get('https://test.invalid');assert.equal(p.observedAt(c),p.observedAt(a));assert.equal(p.status(p.observedAt(c)+61000).status,'STALE');
  const bad=new JsonProvider('bad',{fetchImpl:async()=>({ok:false,status:429,headers:{get:()=> '5'}})});await assert.rejects(bad.get('https://test.invalid'));assert.equal(bad.status().status,'DEGRADED');await assert.rejects(bad.get('https://test.invalid'),/retry after/);
});
function fixturePlatform(file=':memory:'){
  const registry=new ProviderRegistry();
  const p={id:'kalshi',status:()=>({id:'kalshi',status:'CONNECTED'}),market:async()=>normalizeKalshi({ticker:'TEST',title:'TEST FIXTURE',status:'active',event_ticker:'EVENT'},Date.now()),book:async()=>normalizeKalshiBook({orderbook_fp:{yes_dollars:[['0.4','100']],no_dollars:[['0.5','100']]}},Date.now()),markets:async()=>({markets:[],cursor:null})};
  registry.register(p);return new MarketPlatform({file,providers:registry});
}
const proposal={id:'one',venue:'kalshi',sourceId:'TEST',mode:'MANUAL_APPROVAL',outcome:'YES',side:'BUY',quantity:10,feeBps:100};
test('paper order flows through proposal, repeat risk check, atomic ledger and idempotent fill',async()=>{
  const p=fixturePlatform();assert.equal(p.snapshot().portfolio.accounts.length,0);
  p.deposit({venue:'kalshi',amount:'100',id:'d'});p.deposit({venue:'kalshi',amount:'100',id:'d'});
  const preview=await p.propose(proposal);assert.equal(preview.status,'AWAITING_APPROVAL');assert.equal(p.ledger.entries().length,1);
  assert.throws(()=>p.executePaper('one','yes'),/confirmation/);
  assert.equal(p.executePaper('one','EXECUTE PAPER ORDER').status,'FILLED');assert.equal(p.executePaper('one','EXECUTE PAPER ORDER').duplicate,true);
  assert.equal(p.ledger.entries().length,2);assert.equal(p.ledger.portfolio().accounts[0].cash,'94.950000');
  await assert.rejects(p.propose({...proposal,id:'live',mode:'LIVE'}),/Live execution is unavailable/);p.close();
});
test('concurrent previews cannot overspend; sequential commit revalidates balance',async()=>{
  const p=fixturePlatform();p.deposit({venue:'kalshi',amount:'6'});
  await Promise.all([p.propose({...proposal,id:'a'}),p.propose({...proposal,id:'b'})]);
  const results=await Promise.all(['a','b'].map(id=>Promise.resolve().then(()=>p.executePaper(id,'EXECUTE PAPER ORDER'))));
  assert.equal(results.filter(r=>r.status==='FILLED').length,1);assert.equal(results.filter(r=>r.status==='REJECTED').length,1);p.close();
});
test('emergency stop persists across connections/processes and blocks a previously valid preview',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpos-core-')),file=path.join(dir,'mpos-core.sqlite'),p=fixturePlatform(file);
  try{
    p.deposit({venue:'kalshi',amount:'100'});await p.propose(proposal);p.risk.halt();
    assert.equal(p.executePaper('one','EXECUTE PAPER ORDER').status,'REJECTED');assert.throws(()=>assertGlobalTradingNotHalted({dataDir:dir}),/HALTED/);
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {assertGlobalTradingNotHalted} from './src/core/executionBoundary.js'; assertGlobalTradingNotHalted({dataDir:process.argv[1]});`,dir],{cwd:path.resolve('.'),encoding:'utf8'});assert.notEqual(child.status,0);assert.match(child.stderr,/HALTED/);
    p.close();const reopened=fixturePlatform(file);assert.equal(reopened.risk.state().halted,true);assert.throws(()=>reopened.risk.resumePaper('yes'));reopened.risk.resumePaper('RESUME PAPER TRADING');assert.doesNotThrow(()=>assertGlobalTradingNotHalted({dataDir:dir}));reopened.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('core mutations reject cross-origin browser requests and remote clients',()=>{
  const req={socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:8897','content-type':'application/json',origin:'http://127.0.0.1:8897'}};
  assert.equal(localMutationAllowed(req),true);assert.equal(localMutationAllowed({...req,headers:{...req.headers,origin:'https://evil.example'}}),false);assert.equal(localMutationAllowed({...req,socket:{remoteAddress:'192.168.1.5'}}),false);assert.equal(localMutationAllowed({...req,headers:{host:'127.0.0.1:8897','content-type':'text/plain'}}),false);
});

const good={sampleSize:80,outOfSampleNetUsd:12,costsModeled:true,maxDrawdownPct:10,positiveFoldShare:.75,brier:.2};
test('promotion needs every criterion; one strong metric is never enough',()=>{
  assert.equal(promotionCheck('CANDIDATE',good,{probabilistic:true}).allowed,true);
  assert.equal(promotionCheck('CANDIDATE',{outOfSampleNetUsd:1e6}).allowed,false);
  for(const [k,v] of [['sampleSize',10],['outOfSampleNetUsd',0],['costsModeled',false],['maxDrawdownPct',40],['positiveFoldShare',.3],['brier',.4],['sampleSize',null]])
    assert.equal(promotionCheck('CANDIDATE',{...good,[k]:v},{probabilistic:true}).allowed,false,k);
  assert.equal(promotionCheck('PAUSED',{}).allowed,true);
  assert.equal(labChampionLifecycle('LIVE'),'PAPER');assert.equal(labChampionLifecycle('bogus'),'BACKTESTING');
});
test('strategy lifecycle follows allowed edges, never reaches LIVE, and keeps append-only history',()=>{
  const s=new CoreDatabase(':memory:'),r=new StrategyRegistry(s);
  r.register({id:'tennis-fast',name:'Tennis fast settle',markets:['polymarket','kalshi'],allocationUsd:50,probabilistic:true});
  assert.throws(()=>r.register({id:'tennis-fast',name:'dup'}),/already/);
  assert.throws(()=>r.transition('tennis-fast','PAPER',{reason:'skip'}),/not allowed/);
  r.transition('tennis-fast','BACKTESTING',{reason:'start'});
  assert.throws(()=>r.transition('tennis-fast','PAPER',{reason:'no evidence'}),/SAMPLE_SIZE/);
  r.transition('tennis-fast','PAPER',{reason:'walk-forward ok',evidence:good});
  assert.equal(r.transition('tennis-fast','CANDIDATE',{reason:'paper ok'}).promoted,true);
  assert.throws(()=>r.transition('tennis-fast','LIVE',{reason:'go'}),/unavailable/);
  assert.equal(r.transition('tennis-fast','PAUSED',{reason:'drawdown'}).state,'PAUSED');
  r.transition('tennis-fast','RETIRED',{reason:'done'});
  assert.throws(()=>r.transition('tennis-fast','DRAFT',{reason:'revive'}),/not allowed/);
  assert.deepEqual(r.history('tennis-fast').map(h=>h.to_state),['DRAFT','BACKTESTING','PAPER','CANDIDATE','PAUSED','RETIRED']);
  assert.throws(()=>s.db.exec('DELETE FROM strategy_transitions'),/append-only/);
  assert.throws(()=>s.db.exec("UPDATE strategy_transitions SET reason='x'"),/append-only/);
  s.close();
});

test('legacy books are read-only, never converted, and unknowns stay unknown',()=>{
  const sol=solanaLegacy({cashSol:1.5,paperStartSol:2,positions:[{sizeSol:.2,remainingSol:.1},{sizeSol:.3}],history:[{pnlSol:.05},{pnlSol:-.02}]});
  assert.equal(sol.currency,'SOL');assert.equal(sol.openPositions,2);assert.ok(Math.abs(sol.openCost-.4)<1e-12);assert.ok(Math.abs(sol.realized-.03)<1e-12);
  assert.equal(solanaLegacy({positions:[],history:[{pnlSol:null}]}).realized,null);
  const us=usCombosLegacy({open:[{costUsd:5,fillVerified:true},{stakeUsd:3}],stats:{pnlUsd:-2}});
  assert.equal(us.mode,'LIVE_UNRECONCILED');assert.equal(us.unverifiedFills,1);assert.equal(us.openCost,8);assert.equal(us.cash,null);
  const cov=legacyCoverage({solana:()=>({cashSol:1,positions:[],history:[]}),robinhoodPractice:()=>{throw new Error('disk')},usCombos:()=>({open:[],stats:{pnlUsd:4}})});
  assert.equal(cov.books[1].status,'UNAVAILABLE');assert.match(cov.books[1].reason,/disk/);
  assert.deepEqual(cov.totals.map(t=>t.currency).sort(),['SOL','USD']);
  assert.equal(legacyTotals([{currency:'USD',status:'LEGACY_READ_ONLY',openCost:null,realized:1}])[0].openCost,null);
  const p=new MarketPlatform({providers:new ProviderRegistry()});
  assert.equal(p.snapshot().legacy.books.every(b=>b.status==='UNAVAILABLE'),true);
  p.setLegacyReaders({usCombos:()=>({open:[],stats:{pnlUsd:1}})});
  const snap=p.snapshot();assert.equal(snap.legacy.books[2].realized,1);assert.equal(snap.ledger.length,0);p.close();
});

test('Lab champions mirror into the registry through the common gate, never past it',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-labsync-')),s=new CoreDatabase(':memory:'),r=new StrategyRegistry(s);
  const write=(f,d)=>fs.writeFileSync(path.join(dir,f),JSON.stringify(d));
  // Solana: Lab SHADOW -> BACKTESTING; evidence has no cost flag, so PAPER would be blocked anyway.
  write('champion.json',{schema:'mpo.lab-champion.v1',labNodeId:'n',stateSchema:'mpo.champion-state.v1',state:'SHADOW',paperPromotionAllowed:false,champion:{id:'c1',variant:{a:1},metrics:{heldOutN:43,heldOutAvgPct:13.9,maxDrawdownPct:-79.6,consistencyPct:100}}});
  // Robinhood: Lab PAPER with paper review, strong holdout evidence.
  write('robinhood-champion.json',{schema:'mpo.lab-module-champion.v1',module:'robinhood',stateSchema:'mpo.champion-state.v1',state:'PAPER',paperPromotionAllowed:true,candidate:{id:'RH-1',params:{x:1},holdout:{trades:60,netReturnPct:3,maxDrawdownPct:-8}},evidence:{feesModeled:true}});
  // A record claiming live authority is ignored entirely.
  write('polymarket-champion.json',{schema:'mpo.lab-module-champion.v1',state:'PAPER',paperPromotionAllowed:true,liveActivationAllowed:true,candidate:{id:'bad'}});
  let res=Object.fromEntries(syncLabChampions(r,dir).map(x=>[x.id,x]));
  assert.equal(res['lab-solana'].state,'BACKTESTING');assert.equal(labEvidence(JSON.parse(fs.readFileSync(path.join(dir,'champion.json')))).maxDrawdownPct,79.6);
  // Lab PAPER but no fold-stability evidence: the common gate holds it at BACKTESTING and says why.
  assert.equal(res['lab-robinhood'].state,'BACKTESTING');assert.ok(res['lab-robinhood'].blockers.some(b=>b.startsWith('UNSTABLE_ACROSS_FOLDS')));
  assert.equal(res['lab-polymarket'].present,false);assert.equal(r.get('lab-polymarket'),null);
  // Lab withdraws the Solana champion: the registry demotes, and a new champion id is a new version.
  write('champion.json',{schema:'mpo.lab-champion.v1',labNodeId:'n',stateSchema:'mpo.champion-state.v1',state:'INCUBATOR',qualificationStage:'WITHDRAWN',champion:{id:'c2',variant:{a:2},metrics:{}}});
  res=Object.fromEntries(syncLabChampions(r,dir).map(x=>[x.id,x]));
  assert.equal(res['lab-solana'].state,'DRAFT');assert.equal(r.get('lab-solana').version,'c2');
  // A user pause is never overridden, and a second sync with nothing new is a no-op.
  r.transition('lab-robinhood','PAUSED',{reason:'user'});const n=r.history('lab-robinhood').length;
  res=Object.fromEntries(syncLabChampions(r,dir).map(x=>[x.id,x]));
  assert.equal(res['lab-robinhood'].state,'PAUSED');assert.equal(r.history('lab-robinhood').length,n);
  assert.equal(LAB_CHAMPION_SOURCES.every(x=>r.get(x.id)?.state!=='LIVE'),true);
  s.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('combo performance: empty is unknown, not zero; rates, interval, edge and calibration are exact',()=>{
  const empty=comboPerformance([],[]);
  assert.equal(empty.winRate,null);assert.equal(empty.netPnlUsd,null);assert.equal(empty.edge,null);assert.equal(empty.winRateCi95,null);assert.deepEqual(empty.curve,[]);
  const h=[{status:'WON',fillPrice:.8,costUsd:8,pnlUsd:2,settledAt:3},{status:'LOST',fillPrice:.82,costUsd:8.2,pnlUsd:-8.2,settledAt:1},{status:'WON',fillPrice:.9,costUsd:9,pnlUsd:1,settledAt:2},{status:'CANCELLED',fillPrice:.7,pnlUsd:null}];
  const p=comboPerformance(h,[{costUsd:5,fillVerified:false},{stakeUsd:3,fillVerified:true}]);
  assert.equal(p.settled,3);assert.equal(p.won,2);assert.equal(p.placed,6);assert.equal(p.netPnlUsd,-5.2);assert.equal(p.costUsd,25.2);
  assert.deepEqual(p.curve,[-8.2,-7.2,-5.2]);            // ordered by settlement time
  assert.equal(p.winRate,.6667);assert.equal(p.avgImplied,.84);assert.equal(p.edge,-.1733);
  assert.equal(p.openCostUsd,8);assert.equal(p.unverifiedOpen,1);assert.match(p.sampleNote,/Only 3/);
  assert.deepEqual(p.calibration.map(c=>[c.lo,c.n,c.winRate]),[[.8,2,.5],[.9,1,1]]);
  const ci=wilson(2,3);assert.ok(ci.low<.6667&&ci.high>.6667&&ci.low>=0&&ci.high<=1);
  assert.equal(comboPerformance([{status:'WON',pnlUsd:1,costUsd:1}]).edge,null); // no fill price -> no edge claim
});

// Rule text below is copied from live Kalshi / Polymarket markets (2026-09-26).
const kSpread=normalizeKalshi({ticker:'KXNFLSPREAD-26SEP27KCMIA-KC4',title:'KC Chiefs wins by over 3.5 points?',event_ticker:'KXNFLSPREAD-26SEP27KCMIA',status:'active',expiration_time:'2026-10-11T17:00:00Z',
  rules_primary:'If Kansas City wins by more than 3.5 points in the Kansas City vs Miami professional football game originally scheduled for Sep 27, 2026, then the market resolves to Yes.'},1000);
const pSpread=normalizePolymarket({id:'77',question:'Spread: Chiefs (-3.5)',outcomes:'["Chiefs","Dolphins"]',clobTokenIds:'["kc","mia"]',outcomePrices:'["0.55","0.45"]',endDate:'2026-09-27T17:00:00Z',active:true,resolutionSource:'https://www.nfl.com/scores',
  description:'In the upcoming NFL game, scheduled for September 27 at 1:00 PM ET:  This market will resolve to "Chiefs" if the Chiefs win the game by 4 or more points.  Otherwise, this market will resolve to "Dolphins".',events:[{id:'9',title:'Chiefs vs. Dolphins'}]},1000);
const kTotal=normalizeKalshi({ticker:'KXMLBTOTAL-X-8',title:'Over 7.5 runs scored',status:'active',expiration_time:'2026-10-03T17:00:00Z',
  rules_primary:'If the teams in the game collectively score more than 7.5 runs in the Texas vs Minnesota professional baseball game originally scheduled for Sep 26, 2026, then the market resolves to Yes.'},1000);
const pTotal=normalizePolymarket({id:'78',question:'Texas Rangers vs. Minnesota Twins: O/U 7.5',outcomes:'["Over","Under"]',clobTokenIds:'["o","u"]',outcomePrices:'["0.5","0.5"]',endDate:'2026-09-26T23:00:00Z',active:true,
  description:'In the upcoming MLB game between the Texas Rangers and Minnesota Twins, scheduled for September 26 at 7:10PM ET: This market will resolve to "Over" if the teams combine to score more than 7.5 runs. If the game is canceled entirely, this market will resolve 50-50.'},1000);
test('contract terms: real venue text becomes a comparable proposition',()=>{
  assert.deepEqual(participants('If Chicago C wins the Chicago C vs Boston professional baseball game'),['Chicago C','Boston']);
  assert.deepEqual(participants('In the upcoming college football game between UConn and Miami (OH), scheduled for'),['UConn','Miami (OH)']);
  assert.ok(sameName('Chicago C','Chicago Cubs'));assert.ok(!sameName('Chicago C','Chicago White Sox'));assert.ok(!sameName('New York Y','New York Mets'));assert.ok(sameName('Youngstown St.','Youngstown State'));
  const a=extractTerms(kSpread.data),b=extractTerms(pSpread.data);
  assert.equal(a.type,'SPREAD');assert.equal(a.line,3.5);assert.equal(a.day,'2026-09-27');assert.equal(b.type,'SPREAD');assert.equal(b.day,'2026-09-27');
  assert.equal(pSpread.data.binary,true);assert.equal(pSpread.data.yesLabel,'Chiefs');assert.equal(pSpread.data.yesToken,'kc');
  // Different city/nickname naming: Kansas City vs Chiefs is not assumed equal.
  assert.equal(matchTerms(a,b).classification,'NOT EQUIVALENT');
  const t1=extractTerms(kTotal.data),t2=extractTerms(pTotal.data),m=matchTerms(t1,t2);
  assert.equal(t1.type,'TOTAL');assert.equal(t2.type,'TOTAL');assert.equal(m.classification,'STRONG MATCH');assert.equal(m.orientation,'SAME');
  assert.ok(m.residualRisks.some(r=>r.startsWith('CANCELLATION')));
});
test('contract matching: lines, dates, scope and inverted outcomes; never EXACT automatically',()=>{
  const base=extractTerms(kTotal.data),other=extractTerms(pTotal.data);
  assert.equal(matchTerms(base,{...other,line:8.5}).classification,'RELATED');
  assert.equal(matchTerms(base,{...other,day:'2026-09-27'}).classification,'NOT EQUIVALENT');
  assert.equal(matchTerms({...base,scope:'REGULATION'},{...other,scope:'INCLUDING_OT'}).classification,'NOT EQUIVALENT');
  assert.equal(matchTerms(base,{...other,yesMeans:'UNDER'}).orientation,'INVERTED');
  assert.equal(matchTerms(base,{...other,type:'OTHER'}).classification,'RELATED');
  for(const x of [matchTerms(base,other),matchTerms(base,base)])assert.notEqual(x.classification,'EXACT MATCH');
  const pairs=candidatePairs([kTotal,kSpread],[pTotal,pSpread]);assert.equal(pairs.length,1);assert.equal(pairs[0].a,kTotal.id);
});
test('EXACT MATCH needs an attestation that dies when either venue edits its rules',async()=>{
  const p=new MarketPlatform({providers:new ProviderRegistry()});p.store.put(kTotal);p.store.put(pTotal);
  assert.equal(p.pairMatch(kTotal,pTotal).classification,'STRONG MATCH');
  assert.throws(()=>p.verifyPair({a:{venue:'kalshi',sourceId:kTotal.sourceId},b:{venue:'polymarket',sourceId:pTotal.sourceId},confirmation:'yes'}),/Type/);
  const v=p.verifyPair({a:{venue:'kalshi',sourceId:kTotal.sourceId},b:{venue:'polymarket',sourceId:pTotal.sourceId},confirmation:VERIFY_PHRASE,note:'read both'});
  assert.equal(v.classification,'EXACT MATCH');assert.equal(v.attestation.valid,true);
  const edited={...pTotal,observedAt:2000,availableAt:2000,data:{...pTotal.data,settlementRules:pTotal.data.settlementRules+' Extra innings excluded.'}};
  assert.notEqual(termsFingerprint(edited.data),termsFingerprint(pTotal.data));p.store.put(edited);
  const after=p.pairMatch(kTotal,p.store.get(pTotal.id));assert.equal(after.classification,'STRONG MATCH');assert.equal(after.attestation.valid,false);
  // A non-matching pair can never be attested.
  p.store.put(kSpread);p.store.put(pSpread);
  assert.throws(()=>p.verifyPair({a:{venue:'kalshi',sourceId:kSpread.sourceId},b:{venue:'polymarket',sourceId:pSpread.sourceId},confirmation:VERIFY_PHRASE}),/Only a STRONG MATCH/);
  p.close();
});
test('complement legs are priced from both books with fees; never flagged risk-free',()=>{
  const book=(y,n)=>({observedAt:1000,yes:{bids:[],asks:[{price:y,quantity:10}]},no:{bids:[],asks:[{price:n,quantity:10}]}});
  const match={classification:'EXACT MATCH',missing:[],differences:[],fields:[]};
  const q=arbitrageQuote({venue:'kalshi'},{venue:'polymarket'},book(.4,.62),book(.58,.45),{quantity:1,feeA:0,feeB:0,now:1000,match});
  // SAME orientation: YES(A) .40 + NO(B) .45 = .85 -> 0.15 locked.
  assert.equal(q.directions[0].theoreticalLockedReturn.toFixed(2),'0.15');assert.equal(q.directions[0].riskFree,false);
});

test('regressions from the live check: lazy names; single-market fetch keeps the parent event',async()=>{
  assert.deepEqual(participants('If Houston wins by more than 2.5 points in the HOU Texans vs IND Colts Pro Football game originally'),['HOU Texans','IND Colts']);
  let asked=null;const p=new PolymarketProvider({fetchImpl:async url=>{asked=String(url);return {ok:true,json:async()=>[{id:'77',question:'Spread: Texans (-2.5)',outcomes:'["Texans","Colts"]',clobTokenIds:'["h","i"]',active:true,events:[{id:'9',title:'Texans vs. Colts'}]}]};}});
  const c=await p.market('77');assert.ok(asked.endsWith('/markets?id=77'),asked);assert.equal(c.data.eventTitle,'Texans vs. Colts');assert.deepEqual(extractTerms(c.data).teams,['Texans','Colts']);
  const empty=new PolymarketProvider({fetchImpl:async()=>({ok:true,json:async()=>[]})});await assert.rejects(empty.market('1'),/not found/);
});

test('venue taker fees follow the published formulas and fail closed',()=>{
  // Kalshi docs worked example: $0.055 revenue, model fee 0.00363825 -> fee + rounding = $0.005 (cent precision).
  const k=kalshiFeeModel({ticker:'S',fee_type:'quadratic',fee_multiplier:1}).model;
  const p=0.055,c=0.00363825/(0.07*p*(1-p));
  assert.ok(Math.abs(takerFee(k,[{price:p,quantity:c}])-(0.06-p*c))<1e-6);
  // 100 contracts at 50c, multiplier 0.5: 0.035*100*.25 = 0.875 -> charged 0.88.
  assert.equal(takerFee(kalshiFeeModel({fee_type:'quadratic_with_maker_fees',fee_multiplier:.5}).model,[{price:.5,quantity:100}]),0.88);
  assert.equal(kalshiFeeModel({fee_type:'flat',fee_multiplier:1}).model,null);assert.equal(kalshiFeeModel(null).model,null);
  // Polymarket sports table: 100 shares at $0.50 -> $1.25; at $0.30 -> $1.05. Fees disabled -> 0.
  const pm=polymarketFeeModel({feesEnabled:true,feeType:'sports_fees_v3',feeSchedule:{rate:'0.05',exponent:1,takerOnly:true}}).model;
  assert.equal(takerFee(pm,[{price:.5,quantity:100}]),1.25);assert.equal(takerFee(pm,[{price:.3,quantity:100}]),1.05);
  assert.equal(takerFee(polymarketFeeModel({feesEnabled:false}).model,[{price:.5,quantity:100}]),0);
  assert.equal(polymarketFeeModel({feesEnabled:true,feeSchedule:{rate:'0.05',exponent:2}}).model,null);
  assert.equal(polymarketFeeModel({}).model,null);assert.equal(takerFee(null,[{price:.5,quantity:1}]),null);
});
test("arbitrage prices fees on each direction's actual fills; unknown fees block the locked return",()=>{
  const book=(y,n)=>({observedAt:1000,yes:{bids:[],asks:[{price:y,quantity:100}]},no:{bids:[],asks:[{price:n,quantity:100}]}});
  const match={classification:'EXACT MATCH',missing:[],differences:[],fields:[]};
  const k=kalshiFeeModel({fee_type:'quadratic',fee_multiplier:1}).model,pm=polymarketFeeModel({feesEnabled:true,feeSchedule:{rate:'0.05',exponent:1}}).model;
  const q=arbitrageQuote({venue:'kalshi'},{venue:'polymarket'},book(.4,.62),book(.58,.45),{quantity:100,now:1000,match,feeModels:{a:k,b:pm}});
  const d=q.directions[0];// YES A @ .40 (fee .07*100*.24=1.68), NO B @ .45 (fee .05*100*.2475=1.2375)
  assert.equal(d.feeA,1.68);assert.equal(d.feeB,1.2375);assert.equal(d.theoreticalLockedReturn.toFixed(4),(100-40-45-1.68-1.2375).toFixed(4));
  const none=arbitrageQuote({venue:'kalshi'},{venue:'polymarket'},book(.4,.62),book(.58,.45),{quantity:100,now:1000,match,feeModels:{a:k,b:null}});
  assert.equal(none.directions[0].theoreticalLockedReturn,null);assert.ok(none.directions[0].blocked.includes('FEES_UNAVAILABLE'));
});
test('Kalshi contracts carry the series fee model and settlement source',async()=>{
  const calls=[];const kp=new KalshiProvider({fetchImpl:async url=>{calls.push(String(url));const u=String(url);
    if(u.includes('/series/'))return {ok:true,json:async()=>({series:{ticker:'KXMLBGAME',fee_type:'quadratic_with_maker_fees',fee_multiplier:.5,settlement_sources:[{name:'MLB',url:'https://www.mlb.com/'}]}})};
    return {ok:true,json:async()=>({markets:[{ticker:'KXMLBGAME-26SEP26X-A',event_ticker:'KXMLBGAME-26SEP26X',title:'A wins'},{ticker:'KXMLBGAME-26SEP26X-B',event_ticker:'KXMLBGAME-26SEP26X',title:'B wins'}],cursor:''})};}});
  const r=await kp.markets({series:'KXMLBGAME'});
  assert.equal(calls.filter(u=>u.includes('/series/')).length,1);// one lookup per series, cached
  assert.equal(r.markets[0].data.feeModel.rate,0.035);assert.equal(r.markets[0].data.resolutionSource,'https://www.mlb.com/');
  const broken=new KalshiProvider({fetchImpl:async url=>String(url).includes('/series/')?{ok:false,status:500}:{ok:true,json:async()=>({markets:[{ticker:'T-1',event_ticker:'T-1',title:'x'}]})}});
  const b=await broken.markets({});assert.equal(b.markets[0].data.feeModel,null);assert.match(b.markets[0].data.feeModelReason,/not loaded/);
});

test('paper fills default to the venue fee schedule; no schedule and no typed fee is refused',async()=>{
  const make=series=>{const registry=new ProviderRegistry();registry.register({id:'kalshi',status:()=>({id:'kalshi',status:'CONNECTED'}),
    market:async()=>normalizeKalshi({ticker:'TEST',title:'TEST FIXTURE',status:'active',event_ticker:'EVENT'},Date.now(),series),
    book:async()=>normalizeKalshiBook({orderbook_fp:{yes_dollars:[['0.4','100']],no_dollars:[['0.5','100']]}},Date.now()),markets:async()=>({markets:[],cursor:null})});
    const p=new MarketPlatform({providers:registry});p.deposit({venue:'kalshi',amount:'100',id:'f'});return p;};
  const p=make({ticker:'EVENT',fee_type:'quadratic',fee_multiplier:1});
  const r=await p.propose({id:'v1',venue:'kalshi',sourceId:'TEST',mode:'PAPER',outcome:'YES',side:'BUY',quantity:10});
  // YES ask = 1 - best NO bid 0.5 = 0.50; fee = ceil_cent(5 + 0.07*10*.25) - 5 = 0.18
  assert.equal(r.status,'PROPOSED');assert.equal(r.order.fee,'0.180000');assert.equal(r.order.feeModel.kind,'VENUE_SCHEDULE');
  const typed=await p.propose({id:'v2',venue:'kalshi',sourceId:'TEST',mode:'PAPER',outcome:'YES',side:'BUY',quantity:10,feeBps:100});
  assert.equal(typed.order.fee,'0.050000');assert.equal(typed.order.feeModel.kind,'USER_MODELED_BPS');p.close();
  const q=make(null);await assert.rejects(q.propose({id:'v3',venue:'kalshi',sourceId:'TEST',mode:'PAPER',outcome:'YES',side:'BUY',quantity:10}),/Venue fee schedule unavailable/);q.close();
});

function stockPlatform({quote={bid:99.9,ask:100.1,bidSize:5,askSize:5},state='OPEN',clock=()=>Date.now()}={}){
  const src={status:()=>({status:'CONNECTED'}),quotes:async syms=>Object.fromEntries(syms.map(x=>[x,{symbol:x,...quote,quoteAt:clock(),receivedAt:clock(),source:'test'}]))};
  const p=new MarketPlatform({providers:new ProviderRegistry(),stockQuotes:src,stockClock:clock,stockSession:()=>({state})});
  p.risk.setLimits({maxOrderUsd:1000,maxPositionUsd:1000,maxEventUsd:1000,maxVenueUsd:1000,maxStrategyUsd:1000,maxTotalUsd:1000});return p;
}
test('stocks paper broker: preview -> risk -> fill in the unified ledger; sells pay pass-through fees',async()=>{
  const p=stockPlatform();p.deposit({venue:STOCK_VENUE,amount:'1000',id:'s1'});
  const b=await p.stocksPreview({symbol:'spy',side:'BUY',notionalUsd:250});
  assert.equal(b.status,'PROPOSED');assert.equal(b.order.price,100.1);assert.equal(b.order.quantity,2.497502);assert.equal(b.order.fee,'0.000000');
  assert.equal(p.stocks.account().buyingPower<1000,true);
  assert.equal(p.stocks.submit(b.id).status,'FILLED');
  const pos=p.stocks.positions({SPY:{bid:99.9}});assert.equal(pos[0].symbol,'SPY');assert.equal(pos[0].quantity,2.497502);assert.ok(pos[0].unrealized<0);
  // A sale above $500 would pay SEC; this one is small: no SEC, no TAF (<=50 shares).
  const s2=await p.stocksPreview({symbol:'SPY',side:'SELL',quantity:1});assert.equal(s2.order.price,99.9);assert.equal(s2.order.fee,'0.000000');p.stocks.submit(s2.id);
  assert.equal(p.stocks.positions()[0].quantity,1.497502);
  // Overselling is refused by the governor.
  const over=await p.stocksPreview({symbol:'SPY',side:'SELL',quantity:5});assert.equal(over.status,'REJECTED');assert.ok(over.decision.reasons.includes('OVERSELL'));
  // Cancel a pending preview; a filled order cannot be cancelled.
  const c=await p.stocksPreview({symbol:'QQQ',side:'BUY',quantity:1});assert.equal(p.stocks.cancel(c.id).status,'CANCELLED');assert.throws(()=>p.stocks.cancel(b.id),/FILLED/);
  p.close();
});
test('stocks paper broker refuses closed markets, missing keys, one-sided quotes, non-marketable limits and live mode',async()=>{
  const closed=stockPlatform({state:'CLOSED'});await assert.rejects(closed.stocksPreview({symbol:'SPY',side:'BUY',quantity:1}),/closed/);closed.close();
  const oneSided=stockPlatform({quote:{bid:null,ask:100}});await assert.rejects(oneSided.stocksPreview({symbol:'SPY',side:'BUY',quantity:1}),/two-sided/);oneSided.close();
  const p=stockPlatform();
  await assert.rejects(p.stocksPreview({symbol:'SPY',side:'BUY',quantity:1,type:'limit',limitPrice:99}),/not marketable/);
  await assert.rejects(p.stocksPreview({symbol:'SPY',side:'BUY',quantity:1,mode:'LIVE'}),/no real brokerage/);
  await assert.rejects(p.stocksPreview({symbol:'bad symbol!',side:'BUY',quantity:1}),/Invalid symbol/);
  const noKey=new AlpacaQuotes({env:{}});await assert.rejects(noKey.quotes(['SPY']),/ALPACA_KEY_ID/);assert.equal(noKey.status().status,'NOT CONFIGURED');
  const st=await new MarketPlatform({providers:new ProviderRegistry(),stockQuotes:noKey}).stocksStatus('SPY');assert.match(st.quoteError,/unavailable/);assert.deepEqual(st.quotes,{});
  p.close();
});
test('stale stock quote at submit time is rejected by the governor',async()=>{
  let now=Date.now();const p=stockPlatform({clock:()=>now});p.deposit({venue:STOCK_VENUE,amount:'100',id:'s'});
  const b=await p.stocksPreview({symbol:'SPY',side:'BUY',quantity:0.5});now+=0;// quote stamped at preview time
  const real=Date.now;Date.now=()=>now+60000;try{assert.equal(p.stocks.submit(b.id).status,'REJECTED');}finally{Date.now=real;}
  p.close();
});
test('Alpaca snapshot parsing keeps IEX sizes and timestamps; auth errors are labelled',async()=>{
  const q=new AlpacaQuotes({env:{ALPACA_KEY_ID:'k',ALPACA_SECRET_KEY:'s'},fetchImpl:async()=>({ok:true,json:async()=>({SPY:{latestQuote:{bp:99,ap:101,bs:2,as:3,t:'2026-09-25T15:00:00Z'},latestTrade:{p:100,t:'2026-09-25T15:00:00Z'},prevDailyBar:{c:98}}})})});
  const r=await q.quotes(['SPY','nope!']);assert.deepEqual(Object.keys(r),['SPY']);assert.equal(r.SPY.ask,101);assert.equal(r.SPY.askSize,3);assert.equal(r.SPY.quoteAt,Date.parse('2026-09-25T15:00:00Z'));
  const bad=new AlpacaQuotes({env:{ALPACA_KEY_ID:'k',ALPACA_SECRET_KEY:'s'},fetchImpl:async()=>({ok:false,status:403})});await assert.rejects(bad.quotes(['SPY']));assert.equal(bad.status().status,'AUTH ERROR');
});

test('replay reveals data by availability: candle-derived samples only after their minute closes',()=>{
  const rec=tapeRecords([{t:60000,bid:10,ask:10,src:'coinbase-candles'},{t:75000,bid:12,ask:12,src:'coinbase-candles'},{t:80000,bid:11,ask:11.1,src:'robinhood'}],'X');
  assert.deepEqual(rec.map(r=>r.availableAt),[120000,120000,80000]);assert.equal(rec[0].synthetic,true);assert.equal(rec[2].synthetic,false);
  const sess=new ReplaySession(rec,{start:60000,end:200000});
  assert.equal(sess.quote('X'),null);// nothing is knowable at 60 s, although two rows are stamped 60 s / 75 s
  sess.advanceTo(90000);assert.equal(sess.quote('X').bid,11);// the live quote at 80 s
  sess.advanceTo(130000);assert.equal(sess.history('X').length,3);assert.equal(sess.quote('X').bid,12);
  sess.advanceTo(100000);assert.equal(sess.clock,130000);// the clock never goes back
  assert.deepEqual(alpacaMinuteRecords([{t:'2025-06-10T13:30:00Z',c:200}],'AAPL')[0].availableAt,Date.parse('2025-06-10T13:31:00Z'));
});
test('replay backtest: decisions see only the past, fills happen on the next available quote',()=>{
  const rows=[];for(let i=0;i<200;i++)rows.push({t:i*15000,bid:100+i*.1,ask:100.05+i*.1,src:'robinhood'});
  const rec=tapeRecords(rows,'X'),mk=()=>new ReplaySession(rec,{start:0,end:199*15000});
  const bh=runReplay(mk(),{key:'X',strategy:'buy-hold',cash:1000});
  assert.equal(bh.lookAheadViolations,0);assert.equal(bh.trades.length,1);
  assert.equal(bh.trades[0].decidedAt,0);assert.equal(bh.trades[0].at,15000);assert.ok(Math.abs(bh.trades[0].price-100.15)<1e-9);// ask of the NEXT quote
  assert.ok(bh.returnPct>0&&bh.returnPct<bh.buyHoldPct+1);
  const m=runReplay(mk(),{key:'X',strategy:'momentum',params:{lookback:5,thresholdBps:5},feeBps:10});
  assert.equal(m.lookAheadViolations,0);for(const tr of m.trades)assert.ok(tr.at>tr.decidedAt);
  assert.throws(()=>strategyParams('momentum',{lookback:-1}),/Invalid/);assert.throws(()=>runReplay(mk(),{key:'X',strategy:'nope'}),/Unknown/);
});
test('Market Lab runs are reproducible experiment records (fingerprint, code version, append-only)',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-lab-'));fs.mkdirSync(path.join(dir,'robinhood-tape'));
  fs.writeFileSync(path.join(dir,'robinhood-tape','BTC-USD.ndjson'),Array.from({length:120},(_,i)=>JSON.stringify({t:1e12+i*15000,bid:100+Math.sin(i/5),ask:100.1+Math.sin(i/5),src:'robinhood'})).join(String.fromCharCode(10))+String.fromCharCode(10));
  const p=new MarketPlatform({providers:new ProviderRegistry(),dataDir:dir});
  assert.equal(p.labSources().tape[0].key,'BTC-USD');
  const q={source:'tape',key:'BTC-USD',start:1e12,end:1e12+119*15000,strategy:'mean-reversion',params:{lookback:8,thresholdBps:20}};
  const a=await p.labRun(q),b=await p.labRun(q);
  assert.equal(a.datasetFp,b.datasetFp);assert.equal(a.finalEquity,b.finalEquity);assert.notEqual(a.id,b.id);assert.match(a.codeVersion,/replay./);
  assert.equal(p.labRuns().length,2);assert.throws(()=>p.store.db.exec('DELETE FROM lab_runs'),/append-only/);
  await assert.rejects(p.labRun({...q,start:q.end,end:q.start}),/start before/);
  const r=await p.labReplayStart({source:'tape',key:'BTC-USD',start:q.start,end:q.end});assert.equal(r.visible.length,1);
  const st=p.labReplayStep({id:r.id,ms:30000});assert.equal(st.revealed,3);
  await assert.rejects(fetchAlpacaMinutes({symbol:'AAPL',start:1,end:2,env:{}}),/Alpaca/);
  p.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('macro vintages: a revision is invisible before it was published; values count from end of publication day (ET)',()=>{
  assert.equal(new Date(endOfDayEt('2026-10-14')).toISOString(),'2026-10-15T03:59:59.999Z');// EDT
  assert.equal(new Date(endOfDayEt('2026-01-14')).toISOString(),'2026-01-15T04:59:59.999Z');// EST
  const v=vintagesFrom([{date:'2026-08-01',value:'100',realtime_start:'2026-09-11'},{date:'2026-08-01',value:'101',realtime_start:'2026-10-14'},{date:'2026-09-01',value:'102',realtime_start:'2026-10-14'},{date:'2026-07-01',value:'.',realtime_start:'2026-08-12'}]);
  assert.equal(v.length,3);
  const sept20=Date.parse('2026-09-20T12:00:00Z'),oct14noon=Date.parse('2026-10-14T16:00:00Z'),oct16=Date.parse('2026-10-16T00:00:00Z');
  assert.deepEqual(macroAsOfFn(v,sept20).map(r=>r.value),[100]);
  assert.deepEqual(macroAsOfFn(v,oct14noon).map(r=>r.value),[100]);// published that day, not yet counted
  assert.deepEqual(macroAsOfFn(v,oct16).map(r=>r.value),[101,102]);// the revision replaces the first print
  const rows=[{date:'a',value:100},{date:'b',value:101},{date:'c',value:100}];
  assert.deepEqual(macroTransform(rows,'mom_pct').map(r=>r.value),[1,-0.99]);assert.deepEqual(macroTransform(rows,'diff').map(r=>r.value),[1,-1]);
  assert.deepEqual(parseFredCsv('observation_date,CPIAUCSL\n2026-07-01,332.813\n2026-08-01,.\n'),[{date:'2026-07-01',value:332.813}]);
});
test('macro: keyless FRED refuses as-of history; Kalshi ladder gives an implied median without inventing rungs',async()=>{
  await assert.rejects(new FredSource({env:{}}).vintages('CPIAUCSL'),/FRED_API_KEY/);
  const mk=(strike,bid,ask,type='greater')=>({sourceId:'K-'+strike,data:{strike,strikeType:type,yesBid:bid,yesAsk:ask,title:'t',closeAt:2000}});
  const l=impliedLadder([mk(0.4,.83,.87),mk(0.2,.93,.97),mk(0.3,.93,.97),mk(0.5,.5,.54),mk(0.6,.15,.18),mk(0.7,null,.05),mk(0.9,.01,.02,'less')]);
  assert.deepEqual(l.rungs.map(r=>r.strike),[0.2,0.3,0.4,0.5,0.6]);// one-sided and non-'greater' rungs dropped
  assert.ok(l.impliedMedian>0.5&&l.impliedMedian<0.6);assert.equal(l.closeAt,2000);
  assert.equal(impliedLadder([]).impliedMedian,null);
});
test('macro snapshot: FRED and Kalshi failures stay local to their indicator',async()=>{
  const registry=new ProviderRegistry();
  registry.register({id:'kalshi',status:()=>({}),events:async({series})=>{if(series==='KXU3')throw new Error('kalshi down');return [{event_ticker:series+'-X',title:series,settlement_sources:[{name:'BLS'}]}];},
    markets:async({eventTicker})=>({markets:[0.1,0.2,0.3].map((k,i)=>normalizeKalshi({ticker:eventTicker+'-T'+k,event_ticker:eventTicker,title:'x',floor_strike:k,strike_type:'greater',yes_bid_dollars:String(.9-i*.3),yes_ask_dollars:String(.92-i*.3),close_time:new Date(Date.now()+86400000).toISOString()},Date.now()))})});
  const p=new MarketPlatform({providers:registry});
  p.fred=new FredSource({env:{},fetchImpl:async url=>String(url).includes('UNRATE')?{ok:false,status:500}:{ok:true,text:async()=>'d,v\n2026-06-01,100\n2026-07-01,101\n'}});
  const m=await p.macroSnapshot({force:true});
  const cpi=m.indicators.find(i=>i.id==='CPI'),un=m.indicators.find(i=>i.id==='UNRATE');
  assert.equal(cpi.last.value,1);assert.ok(cpi.ladder.impliedMedian>0.1);assert.match(un.error,/500/);assert.match(un.ladder.error,/kalshi down/);
  assert.equal(m.vintageMode,false);assert.match(m.note,/context only/);assert.ok(m.calendar.length>=1);
  p.close();
});

const SUBMISSIONS={cik:'320193',name:'Apple Inc.',tickers:['AAPL'],sicDescription:'Electronic Computers',filings:{recent:{
  accessionNumber:['0000320193-26-000101','0000320193-26-000100','0000320193-26-000099'],filingDate:['2026-09-25','2026-09-24','2026-08-01'],
  acceptanceDateTime:['2026-09-25T16:31:02.000Z','2026-09-24T20:05:00.000Z','2026-08-01T21:00:00.000Z'],form:['8-K','4','S-8'],
  items:['2.02,9.01','',''],primaryDocument:['a8-k.htm','xslF345X05/wk-form4_1.xml','s8.htm']}}};
const ATOM='<feed><entry><title>8-K - ACME CORP (0000123456) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/123456/000012345626000007/0000123456-26-000007-index.htm"/>'+
  '<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-09-25 &lt;b&gt;AccNo:&lt;/b&gt; 0000123456-26-000007 &lt;b&gt;Size:&lt;/b&gt; 300 KB&lt;br&gt;Item 5.02: Departure of Directors&lt;br&gt;Item 9.01: Financial Statements</summary>'+
  '<updated>2026-09-25T16:05:32-04:00</updated></entry><entry><title>garbage</title></entry></feed>';
const FORM4='<ownershipDocument><issuer><issuerName>Apple Inc.</issuerName><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>'+
  '<reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship></reportingOwner><nonDerivativeTable>'+
  '<nonDerivativeTransaction><transactionDate><value>2026-09-23</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares>'+
  '<transactionPricePerShare><value>231.5</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>'+
  '<postTransactionAmounts><sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>';
test('EDGAR facts: submissions JSON, Atom feed and Form 4 XML parse into declared facts only',()=>{
  const f=filingsFromSubmissions(SUBMISSIONS);
  assert.deepEqual(f.map(x=>x.facts.form),['8-K','4']);// S-8 filtered out
  assert.equal(f[0].facts.acceptedAt,Date.parse('2026-09-25T16:31:02.000Z'));assert.deepEqual(f[0].facts.items.map(i=>i.code),['2.02','9.01']);assert.equal(f[0].facts.ticker,'AAPL');
  assert.equal(f[1].facts.rawXmlUrl,'https://www.sec.gov/Archives/edgar/data/320193/000032019326000100/wk-form4_1.xml');
  const a=filingsFromAtom(ATOM);assert.equal(a.length,1);assert.equal(a[0].facts.company,'ACME CORP');assert.equal(a[0].facts.cik,'123456');assert.equal(a[0].facts.accession,'0000123456-26-000007');
  assert.deepEqual(a[0].facts.items.map(i=>i.code),['5.02','9.01']);assert.equal(a[0].facts.acceptedAt,Date.parse('2026-09-25T20:05:32Z'));
  const q=parseForm4(FORM4);assert.equal(q.owner,'Doe Jane');assert.deepEqual(q.roles,['Officer','CFO']);assert.equal(q.transactions[0].code,'S');assert.equal(q.transactions[0].shares,1000);assert.equal(q.transactions[0].price,231.5);assert.equal(q.transactions[0].acquired,false);
});
test('EDGAR analysis is labelled and separate; filings are stored at acceptance time and announced once',async()=>{
  const f=filingsFromSubmissions(SUBMISSIONS)[0],an=analyseFiling(f,[{id:'c1',provider:'kalshi',data:{title:'Will Apple report revenue above $100B?'}},{id:'c2',provider:'kalshi',data:{title:'Will it rain?'}}]);
  assert.equal(an.kind,'RULE_BASED_ANALYSIS');assert.deepEqual(an.catalysts,['EARNINGS']);assert.deepEqual(an.relatedMarkets.map(m=>m.id),['c1']);assert.equal(f.facts.catalysts,undefined);
  assert.equal(userAgent({SEC_USER_AGENT:'MPOS'}),null);assert.equal(userAgent({SEC_USER_AGENT:'Jo Doe jo@example.com'}),'Jo Doe jo@example.com');
  await assert.rejects(new EdgarSource({env:{}}).latest('8-K'),/SEC_USER_AGENT/);assert.equal(new EdgarSource({env:{}}).status().status,'NOT CONFIGURED');
  let ua=null;const src=new EdgarSource({env:{SEC_USER_AGENT:'Jo Doe jo@example.com'},fetchImpl:async(url,opt)=>{ua=opt.headers['User-Agent'];return {ok:true,text:async()=>ATOM};}});
  assert.equal((await src.latest('8-K')).length,1);assert.equal(ua,'Jo Doe jo@example.com');await assert.rejects(src.latest('S-1'),/Unsupported/);
  const p=new MarketPlatform({providers:new ProviderRegistry()});const seen=[];p.bus.on('SEC_FILING_RECEIVED',e=>seen.push(e.data.id));
  const out=p.recordFilings(filingsFromSubmissions(SUBMISSIONS));p.recordFilings(filingsFromSubmissions(SUBMISSIONS));await nextTurn();await nextTurn();
  assert.equal(out[0].analysis.kind,'RULE_BASED_ANALYSIS');assert.equal(seen.length,2);
  const stored=p.store.get(stableId('Filing','sec','0000320193-26-000101'));assert.equal(stored.availableAt,Date.parse('2026-09-25T16:31:02.000Z'));assert.equal(stored.fact,true);assert.equal(stored.data.catalysts,undefined);
  p.close();
});
