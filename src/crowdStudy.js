// Isolated, counterfactual SOL books, using the incumbent's sizing/exit/quote primitives.
// No wallet, transport, swap construction or real-order endpoint exists in this module.
import { CROWD_SCHEMA,CROWD_LIMITS,assertCrowdPaper,crowdHash,sealCrowdRecord,validCrowdRecord,crowdPhase } from './crowdContract.js';
import { chooseCrowdAction } from './crowdResearch.js';
import { createProfitExperiments,settleOrders,observePositions,offerOpportunity,profitQuoteRequests,validExactQuote } from './pumpProfitExperiments.js';
import { routePaperProposal,bookRouteLogger } from './paperRouting.js';
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const entered=a=>['DIRECT_COPY','EARLY_FOLLOW'].includes(a);
export function createCrowdStudy({policy,config,capitalSol=.15,now=Date.now(),sourceStateHash=null}={}){
 if(!policy?.hash||!policy.exit)throw new Error('A verified incumbent policy is required');
 const embargo=Math.max(120,Number(policy.exit.maxHold||120))*60000;
 const train={start:now,end:now+86400000},validation={start:train.end+embargo,end:train.end+embargo+86400000},holdout={start:validation.end+embargo,end:validation.end+embargo+172800000};
 const candidates=['BASELINE','DIRECT_COPY','CROWD_AWARE','BASELINE_CROWD_FILTER'].map(id=>({id,multiplier:1,exit:structuredClone(policy.exit)}));
 const baseline=sealCrowdRecord({schema:CROWD_SCHEMA,createdAt:now,policy:structuredClone(policy),config:structuredClone(config),capitalSol,sourceStateHash});
 const protocol=sealCrowdRecord({schema:CROWD_SCHEMA,mode:'PAPER',createdAt:now,train,validation,holdout,maxDecisions:512,maxEntriesPerHour:3,maxQuoteAgeMs:30000,modeledSubmitDelayMs:1500,
  capitalsSol:[capitalSol],candidates,modelTrials:1,liveExecutionAllowed:false,comparison:'ALTERNATIVE_PORTFOLIOS_NEVER_SUM',unsupportedActions:['EXIT_ADJUSTMENT','CONFIRMED_REVERSAL'],selection:'FIRST_OBSERVED_WALLETS',heldoutGrouping:'CONNECTED_ASSET_EPISODES_AND_DISJOINT_ASSETS'});
 return {schema:CROWD_SCHEMA,mode:'PAPER',liveExecutionAllowed:false,createdAt:now,updatedAt:now,baseline,protocol,cohorts:[],decisions:[],outcomes:[],seen:[],waiting:[],priorAssets:[],entryHours:{},state:'SHADOW_COMPARISON',integrityBlocked:false};
}
function cohortFor(study,phase,operatorMode){
 const id=phase+':'+operatorMode;let c=study.cohorts.find(c=>c.id===id);
 if(!c){c={...createProfitExperiments(study.protocol,study.baseline.policy,study.baseline.config),id,phase,operatorMode};for(const b of c.books){b.id=id+':'+b.candidateId;b.proposals=[];}study.cohorts.push(c);}return c;
}
export function availableQuote(event,market,quotes,now){
 const buys=quotes.filter(q=>q.mint===event.asset&&q.side==='BUY').sort((a,b)=>b.receivedAt-a.receivedAt);
 for(const buy of buys){
  if(!Number.isInteger(market?.decimals)||!validExactQuote(buy,{mint:event.asset,side:'BUY',amountRaw:String(buy.inAmount),submittedAt:event.firstObservedAt},now))continue;
  // The sell must quote liquidation of the WHOLE conservative entry quantity, after our observation.
  const sell=quotes.find(q=>q.side==='SELL'&&validExactQuote(q,{mint:event.asset,side:'SELL',amountRaw:String(buy.otherAmountThreshold),submittedAt:event.firstObservedAt},now));
  if(!sell)continue;
  return {priceSol:Number(buy.inAmount)/1e9/(Number(buy.otherAmountThreshold)/10**market.decimals),capacitySol:Number(sell.otherAmountThreshold)/1e9,
   observedAt:Math.max(buy.receivedAt,sell.receivedAt),latencyMs:Math.max(buy.receivedAt-buy.requestedAt,sell.receivedAt-sell.requestedAt),quoteId:buy.id,exitQuoteId:sell.id,
   capacityEvidence:'EXACT_WHOLE_POSITION_SELL_QUOTE_NOT_ALL_MARKET_LIQUIDITY'};
 }
 return null;
}
function routeAndOffer(study,cohort,book,event,market,decision,now){
 const pick={...market,id:event.id,at:now,mint:event.asset,cluster:decision.cluster,eligible:true,signalSource:'wallet-crowd:'+book.candidateId};
 const routed=routePaperProposal({state:book,pick,mode:'paper',assetClass:'memecoin',platform:'pumpfun',proposalId:book.id+':'+event.id,logger:bookRouteLogger(book)});
 if(!routed.proposal){book.rejections['central-route-blocked']=(book.rejections['central-route-blocked']||0)+1;return;}
 offerOpportunity(book,pick,cohort,now);
 for(const o of book.pending.filter(x=>x.id===book.id+':'+event.id)){o.submittedAt=now+study.protocol.modeledSubmitDelayMs;o.expiresAt=o.submittedAt+30000;o.eventId=event.id;}
 book.proposals=book.proposals.slice(-64);
}
function collectOutcomes(study){
 const known=new Set(study.outcomes.map(x=>x.id));
 for(const c of study.cohorts)for(const b of c.books)for(const p of b.history){
  if(known.has(p.id))continue;const d=study.decisions.find(d=>p.id===b.id+':'+d.eventId);if(!d)continue;
  const fill=b.receipts.find(r=>r.positionId===p.id&&r.side==='BUY');
  const outcome={id:p.id,eventId:d.eventId,policy:b.candidateId,sizeSol:p.sizeSol,feesSol:p.feesSol,phase:c.phase,operatorMode:c.operatorMode,wallet:d.wallet,asset:d.asset,cluster:d.cluster,firstObservedAt:d.firstObservedAt,
   decisionAt:d.at,fillAt:fill?.at??p.openedAt,closedAt:p.closedAt,pnlSol:p.pnlSol,returnPct:p.sizeSol>0?p.pnlSol/p.sizeSol*100:null,
   detectionDelayMs:d.at-d.sourceAt,entryChasePct:d.leaderPriceSol>0?(p.entryPrice/p.entrySolUsd/d.leaderPriceSol-1)*100:null,
   allCostsKnown:false,evidence:'CONSERVATIVE_EXACT_SIZE_QUOTE_NOT_TRANSACTION',costsUnknown:['transaction-success','priority-and-rent-fees','failed-transaction-cost','execution-latency-calibration','material-data-cost']};
  study.outcomes.push(outcome);known.add(p.id);
 }
}
export function advanceCrowdStudy(study,{events=[],windows=[],markets=[],quotes=[],model=null,control={mode:'SHADOW_COMPARISON'},incumbentPolicyHash=null,incumbentPositions=[],entryAllowed=true,now=Date.now()}={}){
 assertCrowdPaper(study);if(now<study.updatedAt)throw new Error('Crowd study clock moved backwards');
 if(!validCrowdRecord(study.protocol)||!validCrowdRecord(study.baseline))throw new Error('Crowd immutable baseline/protocol integrity failure');
 const phase=crowdPhase(study.protocol,now),entryMode=entryAllowed&&['SHADOW_COMPARISON','PAPER_EXPERIMENT'].includes(control.mode);
 study.state=control.mode;study.phase=phase;
 // Risk reduction and already-open experimental exits continue in EVERY mode and after budgets expire.
 for(const c of study.cohorts){
  for(const b of c.books){
   if(!entryMode||c.operatorMode!==control.mode||c.phase!==phase||['EMBARGO','SEALED'].includes(phase)||study.integrityBlocked)b.pending=b.pending.filter(o=>o.side!=='BUY');
   settleOrders(b,quotes,c,now);observePositions(b,markets,c,now);
   const unknown=b.positions.some(p=>p.priceEvidence!=='OBSERVED'||now-Number(p.tickHistory?.at(-1)?.ts||0)>30000);
   const marked=sum(b.positions.map(p=>p.remainingSol*p.lastPrice/p.entryPrice*(p.entrySolUsd/p.lastSolUsd)));
   const equity=unknown?null:b.cashSol+marked;
   if(!b.series.length||now-b.series.at(-1).ts>=60000)b.series.push({ts:now,equitySol:equity,cashSol:b.cashSol,markEvidence:unknown?'UNKNOWN':'MODELED_MARK_NOT_LIQUIDATION'});
   b.series=b.series.slice(-10000);
  }
 }
 collectOutcomes(study);settleCommonComparisons(study,now);
 // WAIT is a later decision with a later quote, never a rewrite of the first decision.
 for(const w of [...study.waiting]){
  const d=study.decisions.find(d=>d.eventId===w.event.id),c=study.cohorts.find(c=>c.id===w.cohortId),m=markets.find(m=>m.mint===w.event.asset);
  if(!d||!c||!entryMode||phase!==c.phase||control.mode!==c.operatorMode||now>w.expiresAt){study.waiting=study.waiting.filter(x=>x!==w);continue;}
  if(!m||m.at<=w.lastMarketAt)continue;w.lastMarketAt=m.at;
  const action=chooseCrowdAction({event:w.event,model,windows,quote:availableQuote(w.event,m,quotes,now),now});
  d.transitions||=[];d.transitions.push(action);d.transitions=d.transitions.slice(-20);
  if(entered(action.action)){routeAndOffer(study,c,c.books.find(b=>b.candidateId==='CROWD_AWARE'),w.event,m,d,now);study.waiting=study.waiting.filter(x=>x!==w);}
 }
 const known=new Set(study.seen),hour=String(Math.floor(now/3600000));
 for(const e of events){
  if(known.has(e.id)||study.decisions.length>=study.protocol.maxDecisions)continue;
  if(e.firstObservedAt>now||e.ingestedAt>now)continue;
  study.seen.push(e.id);known.add(e.id);
  if(e.firstObservedAt<study.createdAt||e.side!=='BUY'){study.excludedEvents||={};const reason=e.side!=='BUY'?'NON_ENTRY_SIDE':'OBSERVED_BEFORE_STUDY';study.excludedEvents[reason]=(study.excludedEvents[reason]||0)+1;continue;}
  const m=markets.find(m=>m.mint===e.asset&&m.at>=e.firstObservedAt&&m.at<=now&&now-m.at<=30000&&m.integrityPassed===true);
  const commonEligible=e.side==='BUY'&&e.confirmation==='finalized'&&!!m&&m.priceUsd>0&&m.liquidityUsd>0&&m.solUsd>0&&Number.isInteger(m.decimals);
  const exposure=control.mode==='PAPER_EXPERIMENT'&&incumbentPositions.some(p=>p.mint===e.asset);
  const action=chooseCrowdAction({event:e,model,windows,quote:availableQuote(e,m,quotes,now),exposure,now});
  const baselineAvailable=incumbentPolicyHash===study.baseline.policy.hash,baselineEnter=baselineAvailable&&m?.eligible===true;
  const cohort=entryMode&&!['EMBARGO','SEALED'].includes(phase)?cohortFor(study,phase,control.mode):null;
  const heldoutOverlap=phase==='HOLDOUT'&&study.priorAssets.includes(e.asset);
  const allowed=commonEligible&&cohort&&!study.integrityBlocked&&!exposure&&!heldoutOverlap&&(study.entryHours[hour]||0)<study.protocol.maxEntriesPerHour;
  const d={eventId:e.id,evaluationDueAt:now+study.baseline.policy.exit.maxHold*60000+30000,at:now,firstObservedAt:e.firstObservedAt,sourceAt:e.sourceAt,wallet:e.wallet,asset:e.asset,leaderPriceSol:e.price,cluster:e.asset,
   phase,operatorMode:control.mode,commonEligible,eligible:!!allowed,baselineAvailable,baselineEnter,modelHash:model?.hash||null,action,
   benchmark:'DIRECT_COPY_IS_AN_UNVALIDATED_COUNTERFACTUAL_NOT_A_CHAMPION',reason:!commonEligible?'MISSING_FRESH_MARKET_OR_TOKEN_DECIMALS':heldoutOverlap?'PURGED_HELDOUT_ASSET':!baselineAvailable?'INCUMBENT_CHANGED_BASELINE_UNAVAILABLE':action.reason};
  study.decisions.push(d);
  if(!allowed)continue;
  study.entryHours[hour]=(study.entryHours[hour]||0)+1;
  if(phase!=='HOLDOUT'&&!study.priorAssets.includes(e.asset))study.priorAssets.push(e.asset);
  for(const b of cohort.books){
   const accept=b.candidateId==='BASELINE'?baselineEnter:b.candidateId==='DIRECT_COPY'?true:b.candidateId==='BASELINE_CROWD_FILTER'?baselineEnter&&entered(action.action):entered(action.action);
   if(accept)routeAndOffer(study,cohort,b,e,m,d,now);else b.rejections['policy-no-entry']=(b.rejections['policy-no-entry']||0)+1;
  }
  if(['WAIT','NO_TRADE'].includes(action.action)&&['NO_POSITIVE_AFTER_COST_ENTRY_BOUND','MISSING_EXECUTABLE_ENTRY_EVIDENCE'].includes(action.reason))study.waiting.push({event:structuredClone(e),cohortId:cohort.id,lastMarketAt:m.at,expiresAt:e.sourceAt+120000});
 }
 study.capacityProbes=quotes.filter(q=>q.side==='BUY'&&q.receivedAt<=now&&now-q.receivedAt<20000&&study.waiting.some(w=>w.event.asset===q.mint)&&/^\d+$/.test(String(q.otherAmountThreshold))).slice(-8).map(q=>({key:q.mint+':SELL:'+q.otherAmountThreshold,mint:q.mint,side:'SELL',amountRaw:String(q.otherAmountThreshold),submittedAt:q.receivedAt,expiresAt:q.receivedAt+30000,capacityProbe:true}));
 study.updatedAt=now;study.budgetSpent=study.decisions.length>=study.protocol.maxDecisions;return study;
}
export function crowdStudyRequests(study,now=Date.now()){
 assertCrowdPaper(study);
 const requests=[...study.cohorts.flatMap(c=>profitQuoteRequests(c)),...(study.capacityProbes||[])].filter(o=>o.expiresAt>=now).sort((a,b)=>(a.side==='SELL'?0:1)-(b.side==='SELL'?0:1));
 return {schema:CROWD_SCHEMA,mode:'PAPER',liveExecutionAllowed:false,protocolHash:study.protocol.hash,expiresAt:now+45000,requests:[...new Map(requests.map(r=>[r.key,r])).values()].slice(0,24),
  observations:[...new Map(study.cohorts.flatMap(c=>c.books.flatMap(b=>b.positions)).map(p=>[p.mint+':'+p.pairAddress,{mint:p.mint,pairAddress:p.pairAddress}])).values()].slice(0,30)};
}
export function crowdStudyView(study,now=Date.now()){
 if(!study)return {state:'AWAITING_CAPTURE',books:[]};
 const blind=now>=study.protocol.holdout.start&&now<study.protocol.holdout.end;
 return {protocolHash:study.protocol.hash,baselineHash:study.baseline.hash,incumbentPolicyHash:study.baseline.policy.hash,createdAt:study.createdAt,updatedAt:study.updatedAt,phase:study.phase,
  state:study.state,excludedEvents:study.excludedEvents||{},capitalSol:study.baseline.capitalSol,decisions:study.decisions.length,budgetSpent:study.budgetSpent,holdoutBlinded:blind,holdout:study.protocol.holdout,comparison:'ALTERNATIVES_NOT_ADDITIVE',
  unsupportedActions:study.protocol.unsupportedActions,lastDecisions:study.decisions.slice(-8).map(d=>({eventId:d.eventId,at:d.at,wallet:d.wallet,asset:d.asset,action:d.action.action,reason:d.reason,remainingFlowSol:d.action.remainingFlowSol||null,eligible:d.eligible,operatorMode:d.operatorMode})),
  books:study.cohorts.flatMap(c=>c.books.map(b=>{const values=b.series.map(x=>x.equitySol).filter(Number.isFinite);let high=b.startSol,dd=0;for(const v of values){high=Math.max(high,v);dd=Math.max(dd,high-v);}const marks=b.series.at(-1);return {id:b.id,phase:c.phase,operatorMode:c.operatorMode,policy:b.candidateId,startSol:b.startSol,cashSol:blind&&c.phase==='HOLDOUT'?null:b.cashSol,
   realizedNetSol:blind&&c.phase==='HOLDOUT'?null:sum(b.history.map(p=>p.pnlSol))+sum(b.positions.map(p=>p.realizedSol)),markedEquitySol:blind&&c.phase==='HOLDOUT'?null:marks?.equitySol??(b.positions.length?null:b.cashSol),
   drawdownSol:blind&&c.phase==='HOLDOUT'?null:b.series.some(x=>x.equitySol===null)?null:dd,turnoverSol:sum(b.receipts.map(r=>Math.abs(r.deltaSol))),open:b.positions.length,closed:b.history.length,pending:b.pending.length,rejections:b.rejections,
   evidence:'PROVISIONAL_QUOTES_NOT_TRANSACTION_PROFIT',markEvidence:marks?.markEvidence||'NO_OPEN_POSITIONS'};}))};
}
// Fixed common horizon: a policy's deliberate NO TRADE is zero exposure, not a missing winner.
// Unfilled requests and still-open positions are explicitly distinguished; unknown exits stay unknown.
export function settleCommonComparisons(study,now=Date.now()){
 study.comparisons||=[];const done=new Set(study.comparisons.filter(x=>x.complete).map(x=>x.eventId));
 for(const d of study.decisions){
  if(!d.eligible||!d.baselineAvailable||!d.evaluationDueAt||now<d.evaluationDueAt||done.has(d.eventId))continue;
  const c=study.cohorts.find(c=>c.id===d.phase+':'+d.operatorMode);if(!c)continue;
  const results={};for(const b of c.books){const id=b.id+':'+d.eventId,p=b.history.find(p=>p.id===id),open=b.positions.some(p=>p.id===id)||b.pending.some(p=>p.id===id||p.positionId===id);
   results[b.candidateId]={netSol:open?null:p?p.pnlSol:0,feesSol:p?.feesSol??0,sizeSol:p?.sizeSol??0,state:open?'OPEN_OR_PENDING_EXIT':p?'CLOSED_QUOTE_SIMULATION':'NO_EXECUTED_ENTRY',allCostsKnown:false};
  }
  const base=results.BASELINE,copy=results.DIRECT_COPY,crowd=results.CROWD_AWARE,filter=results.BASELINE_CROWD_FILTER;
  const complete=[base,copy,crowd,filter].every(x=>Number.isFinite(x?.netSol));
  const row={eventId:d.eventId,phase:d.phase,operatorMode:d.operatorMode,wallet:d.wallet,asset:d.asset,cluster:d.cluster,at:now,complete,allCostsKnown:false,results,
   copyDelta:complete?crowd.netSol-copy.netSol:null,baselineDelta:complete?crowd.netSol-base.netSol:null,filterDelta:complete?filter.netSol-base.netSol:null,pnlSol:crowd.netSol};
  const prior=study.comparisons.findIndex(x=>x.eventId===d.eventId);if(prior<0)study.comparisons.push(row);else study.comparisons[prior]=row;
 }
 return study.comparisons;
}
