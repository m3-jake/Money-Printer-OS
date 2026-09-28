// Fixed-budget observational model shared byte-for-byte by OS and Lab. No network calls.
import { CROWD_SCHEMA,CROWD_LIMITS,CROWD_HORIZON_MS,assertCrowdPaper,episodeCoverage,crowdHash,sealCrowdRecord,validCrowdRecord,numberOrNull } from './crowdContract.js';
const sum=xs=>xs.reduce((a,b)=>a+b,0),mean=xs=>xs.length?sum(xs)/xs.length:null;
export const quantile=(xs,p)=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.floor(p*(a.length-1)))]:null;};
function random(seed){let x=parseInt(crowdHash(seed).slice(0,8),16)||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
export function clusteredInterval(rows,{value='value',group='cluster',seed='crowd',samples=256}={}){
 const groups=new Map();for(const r of rows){if(!Number.isFinite(r[value])||!r[group])continue;const a=groups.get(r[group])||[];a.push(r[value]);groups.set(r[group],a);}
 const xs=[...groups.values()].map(mean),n=xs.length,avg=mean(xs);
 if(n<3)return {mean:avg,lower:null,upper:null,clusters:n,samples:rows.length,method:'CLUSTER_BOOTSTRAP_DIAGNOSTIC_NOT_CAUSAL'};
 const rand=random(seed),means=[];for(let k=0;k<samples;k++){let total=0;for(let i=0;i<n;i++)total+=xs[Math.floor(rand()*n)];means.push(total/n);}
 return {mean:avg,lower:quantile(means,.025),upper:quantile(means,.975),clusters:n,samples:rows.length,method:'CLUSTER_BOOTSTRAP_95_PERCENT_DIAGNOSTIC_NOT_CAUSAL'};
}
export function inferCrowdModel(capture,{asOf=Date.now(),copyOutcomes=[]}={}){
 assertCrowdPaper(capture);
 const invalid=new Set(capture.invalidatedIds||[]),events=capture.events.filter(e=>!invalid.has(e.id)&&e.firstObservedAt<=asOf&&e.ingestedAt<=asOf&&e.sourceAt<=asOf&&e.confirmation==='finalized').slice(0,CROWD_LIMITS.events);
 const byAsset=new Map(),wallets=new Map();for(const e of events){const a=byAsset.get(e.asset)||[];a.push(e);byAsset.set(e.asset,a);const w=wallets.get(e.wallet)||{wallet:e.wallet,firstObservedAt:e.firstObservedAt,count:0};w.count++;wallets.set(e.wallet,w);}
 for(const a of byAsset.values())a.sort((a,b)=>a.sourceAt-b.sourceAt||a.slot-b.slot);
 // Point-in-time, first-observed candidate universe. Never take today's profitable leaderboard.
 const selected=[...wallets.values()].sort((a,b)=>a.firstObservedAt-b.firstObservedAt||a.wallet.localeCompare(b.wallet)).slice(0,CROWD_LIMITS.leaders),selectedSet=new Set(selected.map(x=>x.wallet));
 const h=CROWD_HORIZON_MS,episodes=[],components=new Map(),episodeClusters=new Map();let nextGroup=0,incomplete=0;
 const leads=events.filter(e=>e.side==='BUY'&&selectedSet.has(e.wallet)&&e.sourceAt+h<=asOf).sort((a,b)=>a.sourceAt-b.sourceAt||a.id.localeCompare(b.id));
 // Connected intervals prevent overlapping leaders/followers from becoming independent samples.
 for(const e of leads){let g=components.get(e.asset);if(!g||e.sourceAt-h>g.end)g={id:e.asset+':episode-'+(++nextGroup),end:e.sourceAt+h};else g.end=Math.max(g.end,e.sourceAt+h);components.set(e.asset,g);episodeClusters.set(e.id,g.id);}
 const lastByWalletAsset=new Map();
 for(const lead of leads){
  if(episodes.length>=CROWD_LIMITS.episodes)break;
  const key=lead.wallet+':'+lead.asset,prior=lastByWalletAsset.get(key);if(prior&&lead.sourceAt<=prior+h*2)continue;
  if(!episodeCoverage(capture.windows,lead.asset,lead.sourceAt-h,lead.sourceAt+h,asOf).ok){incomplete++;continue;}
  lastByWalletAsset.set(key,lead.sourceAt);
  const rows=byAsset.get(lead.asset)||[],after=[],before=[];
  for(const e of rows){if(e.wallet===lead.wallet||e.sourceAt<lead.sourceAt-h||e.sourceAt>lead.sourceAt+h)continue;
   if(e.relatedGroup&&lead.relatedGroup&&e.relatedGroup===lead.relatedGroup)continue;
   if(e.sourceAt>lead.sourceAt&&e.slot>lead.slot)after.push(e);else if(e.sourceAt<lead.sourceAt)before.push(e);
  }
  const net=xs=>sum(xs.map(e=>(e.side==='BUY'?1:-1)*e.notional));
  const confounded=Boolean(lead.commonSignalId)||after.some(e=>e.commonSignalId);
  const followers=after.filter(e=>e.side==='BUY').map(e=>({wallet:e.wallet,group:e.relatedGroup||e.wallet,delayMs:e.sourceAt-lead.sourceAt,capitalSol:e.notional}));
  const capitalGroups=new Map();for(const f of followers)capitalGroups.set(f.group,(capitalGroups.get(f.group)||0)+f.capitalSol);
  const total=sum([...capitalGroups.values()]),hhi=total>0?sum([...capitalGroups.values()].map(v=>(v/total)**2)):null;
  episodes.push({id:lead.id,wallet:lead.wallet,asset:lead.asset,cluster:lead.commonSignalId?'common:'+lead.commonSignalId:episodeClusters.get(lead.id),sourceAt:lead.sourceAt,availableAt:Math.max(lead.firstObservedAt,...after.map(e=>e.firstObservedAt),...before.map(e=>e.firstObservedAt)),
   reactionFlow:after.map(e=>({delayMs:e.sourceAt-lead.sourceAt,capitalSol:(e.side==='BUY'?1:-1)*e.notional})),beforeNetSol:net(before),afterNetSol:net(after),value:confounded?0:net(after)-net(before),followers,confounded,hhi,
   control:'SAME_ASSET_MIRRORED_PRE_WINDOW; NEWS_AND_SHARED_SIGNALS_NOT_IDENTIFIED',causal:false});
 }
 const summaries=selected.map(w=>{
  const eps=episodes.filter(e=>e.wallet===w.wallet),clean=eps.filter(e=>!e.confounded),flows=clusteredInterval(clean,{seed:w.wallet}),followers=clean.flatMap(e=>e.followers),assets=new Set(clean.map(e=>e.asset));
  const copy=copyOutcomes.filter(x=>x.wallet===w.wallet&&x.phase==='TRAIN'&&x.closedAt<asOf&&x.decisionAt<asOf&&x.fillAt>=x.firstObservedAt&&x.decisionAt>=x.firstObservedAt);
  const copyStats=clusteredInterval(copy,{value:'returnPct',seed:w.wallet+':copy'}),relationMap=new Map();
  for(const e of clean){for(const wallet of new Set(e.followers.map(f=>f.wallet))){const r=relationMap.get(wallet)||{wallet,episodes:0,assets:new Set(),delays:[]};r.episodes++;r.assets.add(e.asset);r.delays.push(...e.followers.filter(f=>f.wallet===wallet).map(f=>f.delayMs));relationMap.set(wallet,r);}}
  return {...w,eligibleEpisodes:eps.length,independentClusters:flows.clusters,assets:assets.size,confoundedEpisodes:eps.filter(e=>e.confounded).length,incrementalFlowSol:flows,
   observedFollowerAddresses:new Set(followers.map(f=>f.wallet)).size,watcherCount:null,estimatedFollowerActivity:followers.length,
   delayMedianMs:quantile(followers.map(f=>f.delayMs),.5),delayP90Ms:quantile(followers.map(f=>f.delayMs),.9),concentrationHhi:mean(clean.map(e=>e.hhi).filter(Number.isFinite)),
   relationships:[...relationMap.values()].filter(r=>r.episodes>=3&&r.assets.size>=2).slice(0,8).map(r=>({wallet:r.wallet,episodes:r.episodes,assets:r.assets.size,followFrequency:clean.length?r.episodes/clean.length:null,delayMedianMs:quantile(r.delays,.5),observational:true})),
   copyRealizable:{...copyStats,allCostsKnown:copy.length>0&&copy.every(x=>x.allCostsKnown===true),medianEntryChasePct:quantile(copy.map(x=>x.entryChasePct),.5),latencyP90Ms:quantile(copy.map(x=>x.detectionDelayMs),.9)},
   remainingSamples:clean.map(e=>({cluster:e.cluster,controlNetSol:e.beforeNetSol,followers:e.reactionFlow})),
   evidenceState:clean.length>=5&&assets.size>=2&&flows.clusters>=3?'OBSERVATIONAL_REPETITION':'INSUFFICIENT_EVIDENCE'};
 });
 // Rank only the already selected point-in-time universe; null evidence is never a zero-profit score.
 summaries.sort((a,b)=>Number(b.copyRealizable.allCostsKnown)-Number(a.copyRealizable.allCostsKnown)||
  (b.copyRealizable.lower??-Infinity)-(a.copyRealizable.lower??-Infinity)||
  (a.concentrationHhi??Infinity)-(b.concentrationHhi??Infinity)||a.firstObservedAt-b.firstObservedAt||a.wallet.localeCompare(b.wallet));
 const body={schema:CROWD_SCHEMA,mode:'PAPER',liveExecutionAllowed:false,createdAt:asOf,asOf,sourceSequence:capture.sequence,sourceHash:capture.hash||null,horizonMs:h,candidates:summaries,
  trialBudget:{modelTrials:1,maxModels:1,maxLeaders:CROWD_LIMITS.leaders,maxEpisodes:CROWD_LIMITS.episodes,bootstrapReplicates:256},
  coverage:{observedEvents:events.length,walletUniverse:wallets.size,evaluatedWallets:selected.length,incompleteEpisodes:incomplete,evaluatedEpisodes:episodes.length,selection:'FIRST_OBSERVED_NOT_PNL',invalidated:invalid.size,status:capture.status},
  caveat:'Timing is not causation. Address counts are not people or subscribers. Mirrored pre-windows do not remove all common-signal confounding. Missing copy costs remain unknown.'};
 return sealCrowdRecord(body);
}
export function chooseCrowdAction({event,model,windows=[],now=Date.now(),quote=null,exposure=false}={}){
 const result=(action,reason,extra={})=>({action,reason,at:now,modelHash:model?.hash||null,eventId:event?.id||null,expectedNetReturnPct:null,uncertainty:null,watcherCount:null,...extra});
 if(!event||event.firstObservedAt>now||event.sourceAt>now)return result('NO_TRADE','INVALID_OBSERVATION_TIME');
 if(exposure)return result('AVOID','EXISTING_OR_PENDING_EXPOSURE');
 if(event.side!=='BUY')return result('NO_TRADE','EXIT_ADJUSTMENT_NOT_OPTED_IN');
 if(event.confirmation!=='finalized')return result('NO_TRADE','UNFINALIZED_EVIDENCE');
 if(now-event.sourceAt>CROWD_HORIZON_MS)return result('AVOID','LATE_DETECTION_REACTION_WINDOW_EXHAUSTED');
 if(!episodeCoverage(windows,event.asset,event.sourceAt-CROWD_HORIZON_MS,event.sourceAt,now).ok)return result('NO_TRADE','INSUFFICIENT_COVERAGE');
 if(!validCrowdRecord(model)||model.schema!==CROWD_SCHEMA||model.liveExecutionAllowed!==false||model.asOf>now||(now-model.asOf>900000&&!(model.frozenForProtocol&&model.validUntil>=now)))return result('NO_TRADE','MISSING_STALE_OR_FUTURE_LAB_MODEL');
 const c=model.candidates.find(x=>x.wallet===event.wallet);if(!c)return result('NO_TRADE','WALLET_OUTSIDE_POINT_IN_TIME_CANDIDATES');
 if(!quote||!(quote.priceSol>0)||!(quote.capacitySol>0)||!(quote.observedAt>=event.firstObservedAt)||quote.observedAt>now||now-quote.observedAt>30000)return result('NO_TRADE','MISSING_EXECUTABLE_ENTRY_EVIDENCE');
 const copy=c.copyRealizable||{},chasePct=(quote.priceSol/event.price-1)*100,penalty=Math.max(0,chasePct-(copy.medianEntryChasePct??chasePct));
 const estimate=Number.isFinite(copy.lower)?copy.lower-penalty:null;
 const elapsed=now-event.sourceAt+(quote.latencyMs||0);
 const tails=(c.remainingSamples||[]).map(e=>({cluster:e.cluster,value:sum(e.followers.filter(f=>f.delayMs>elapsed).map(f=>f.capitalSol))-Math.max(0,e.controlNetSol)*(Math.max(0,CROWD_HORIZON_MS-elapsed)/CROWD_HORIZON_MS)}));
 const remaining=clusteredInterval(tails,{seed:event.id+':remaining'}),extra={expectedNetReturnPct:estimate,uncertainty:copy,remainingFlowSol:remaining,entryChasePct:chasePct,estimatedFollowerActivity:c.estimatedFollowerActivity,observational:true};
 if(!(copy.clusters>=8&&copy.samples>=12&&Number.isFinite(estimate)))return result('NO_TRADE','INSUFFICIENT_COPY_REALIZABLE_OUTCOMES',extra);
 if(!(estimate>0))return result(c.evidenceState==='OBSERVATIONAL_REPETITION'?'WAIT':'NO_TRADE','NO_POSITIVE_AFTER_COST_ENTRY_BOUND',extra);
 if(!copy.allCostsKnown)return result('NO_TRADE','COPY_OUTCOMES_HAVE_UNMEASURED_EXECUTION_COSTS',extra);
 if(c.evidenceState==='OBSERVATIONAL_REPETITION'&&remaining.lower>0&&remaining.mean>quote.capacitySol)return result('AVOID','FOLLOW_ON_FLOW_EXCEEDS_OBSERVED_EXIT_CAPACITY',extra);
 if(c.evidenceState==='OBSERVATIONAL_REPETITION'&&c.incrementalFlowSol?.lower>0&&remaining.lower>0)return result('EARLY_FOLLOW','POSITIVE_COPY_BOUND_AND_REMAINING_OBSERVED_FLOW',extra);
 return result('DIRECT_COPY','POSITIVE_COPY_BOUND_WITHOUT_ESTABLISHED_CROWD_ADVANTAGE',extra);
}
export function evaluateCrowdComparison(study,now=Date.now()){
 if(!study)return {state:'AWAITING_OS_CAPTURE',qualified:false,blockers:['NO_STUDY'],liveExecutionAllowed:false};
 assertCrowdPaper(study);const blockers=[];
 if(!validCrowdRecord(study.protocol))blockers.push('PROTOCOL_INTEGRITY');
 if(!validCrowdRecord(study.baseline))blockers.push('BASELINE_INTEGRITY');
 if(now<study.protocol.holdout.end)blockers.push('UNTOUCHED_HOLDOUT_NOT_SEALED');
 const rows=study.outcomes||[],held=rows.filter(x=>x.phase==='HOLDOUT'),groups=new Set(held.map(x=>x.cluster));
 if(held.filter(x=>x.policy==='CROWD_AWARE').length<100||groups.size<50)blockers.push('MINIMUM_100_CROWD_CLOSES_50_INDEPENDENT_GROUPS');
 if(!held.length||held.some(x=>x.allCostsKnown!==true))blockers.push('UNMEASURED_NETWORK_FAILURE_LATENCY_OR_DATA_COSTS');
 if(study.integrityBlocked)blockers.push('CAPTURE_OR_BOOK_INTEGRITY');
 const pairs=[];for(const x of held.filter(x=>x.policy==='CROWD_AWARE')){const copy=held.find(y=>y.eventId===x.eventId&&y.policy==='DIRECT_COPY'),base=held.find(y=>y.eventId===x.eventId&&y.policy==='BASELINE');if(copy&&base)pairs.push({...x,copyDelta:x.pnlSol-copy.pnlSol,baselineDelta:x.pnlSol-base.pnlSol});}
 const comparisonPairs=(study.comparisons||[]).filter(x=>x.phase==='HOLDOUT'&&x.complete);if(comparisonPairs.length){pairs.length=0;pairs.push(...comparisonPairs);}
 const ablations=crowdAblationDiagnostics(pairs);
 const versusCopy=clusteredInterval(pairs,{value:'copyDelta',seed:'held-copy'}),versusBaseline=clusteredInterval(pairs,{value:'baselineDelta',seed:'held-baseline'});
 if(!(versusCopy.lower>0&&versusBaseline.lower>0))blockers.push('NO_ESTABLISHED_INCREMENTAL_EDGE');
 for(const key of ['removeLargestWallet','removeLargestToken','removeBestOutcome','doubleLatency','higherCosts','heldOutWallets','heldOutAssets','regimeGeneralization'])if(ablations[key]?.passed!==true)blockers.push('ABLATION_NOT_PASSED:'+key);
 // Evaluation is never an execution permission; paper opt-in and existing qualification gates still apply.
 return {schema:CROWD_SCHEMA,mode:'PAPER',liveExecutionAllowed:false,evaluatedAt:now,qualified:blockers.length===0,state:blockers.length?'NOT_QUALIFIED':'REVIEW_ELIGIBLE',blockers,versusCopy,versusBaseline,ablations,trialBudget:1,holdoutEnd:study.protocol.holdout.end,observational:true};
}
export function crowdAblationDiagnostics(pairs=[]){
 const known=pairs.filter(p=>p.complete&&Number.isFinite(p.copyDelta)&&Number.isFinite(p.baselineDelta));
 const measure=(rows,key)=>clusteredInterval(rows,{value:key,seed:'ablation:'+key});
 const check=rows=>{const a=measure(rows,'copyDelta'),b=measure(rows,'baselineDelta');return {status:rows.length?'DIAGNOSTIC':'AWAITING_COMMON_HORIZON_OUTCOMES',samples:rows.length,versusCopy:a,versusBaseline:b,passed:a.lower>0&&b.lower>0};};
 const largest=key=>{const totals=new Map();for(const x of known)totals.set(x[key],(totals.get(x[key])||0)+Math.abs(x.results?.CROWD_AWARE?.sizeSol||0));return [...totals].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])))[0]?.[0];};
 const wallet=largest('wallet'),asset=largest('asset'),best=[...known].sort((a,b)=>b.pnlSol-a.pnlSol||String(a.eventId).localeCompare(String(b.eventId)))[0]?.eventId;
 const filter=measure(known,'filterDelta');
 return {followerModelIncrement:check(known),baselineCrowdFilter:{status:known.length?'DIAGNOSTIC':'AWAITING_COMMON_HORIZON_OUTCOMES',effect:filter,passed:filter.lower>0},
  removeLargestWallet:{...check(known.filter(x=>x.wallet!==wallet)),removed:wallet??null},removeLargestToken:{...check(known.filter(x=>x.asset!==asset)),removed:asset??null},removeBestOutcome:{...check(known.filter(x=>x.eventId!==best)),removed:best??null},
  doubleLatency:{status:'BLOCKED_MISSING_REEXECUTABLE_DELAYED_QUOTES',passed:false},higherCosts:{status:'BLOCKED_UNMEASURED_NETWORK_FAILURE_AND_MATERIAL_DATA_COSTS',passed:false},
  heldOutWallets:{status:'NOT_ESTABLISHED',passed:false},heldOutAssets:{status:known.length?'DISJOINT_ASSET_SELECTION_REQUIRES_INDEPENDENT_AUDIT':'AWAITING_HOLDOUT',passed:false},regimeGeneralization:{status:'AWAITING_DIFFERENT_REGIMES',passed:false}};
}
