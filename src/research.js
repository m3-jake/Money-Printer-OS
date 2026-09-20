import crypto from 'node:crypto';
import { ensureLearner, learnerSnapshot } from './learner.js';
const clamp=(x,a=0,b=100)=>Math.max(a,Math.min(b,Number(x)||0));
const mean=a=>a.length?a.reduce((s,x)=>s+Number(x||0),0)/a.length:0;
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(Number(x||0)-m)**2)))};
const id=(p='x')=>`${p}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
export const AUTONOMY_LEVELS=['OBSERVER','RESEARCHER','SIMULATOR','OPTIMIZER','SUPERVISOR','LIVE_ASSIST'];

export function ensureResearch(s){
  s.research ||= {};
  Object.assign(s.research, {
    experiments:s.research.experiments||[], lessons:s.research.lessons||[], postmortems:s.research.postmortems||[],
    champion:s.research.champion||{name:'UNIFIED_EDGE',version:1}, challengers:s.research.challengers||[], versions:s.research.versions||[],
    daily:s.research.daily||[], modelHealth:s.research.modelHealth||{status:'COLLECTING',samples:0,drift:0,calibration:0},
    edgeRegistry:s.research.edgeRegistry||{}, walletProfiles:s.research.walletProfiles||{}, deployerProfiles:s.research.deployerProfiles||{},
    feedStats:s.research.feedStats||{}, nightly:s.research.nightly||{lastRun:0}, autonomyLevel:Number(s.research.autonomyLevel??4), universe:s.research.universe||{},
  });
  s.proposals ||= []; s.shadow ||= {bankrolls:{},trades:[],results:{}};
  s.discoveryStats ||= {sources:{},discovered:0,analyzed:0,rejected:0,watch:0,ready:0,held:0};
  ensureLearner(s);
  return s.research;
}

export function recordUniverse(s,a){
  ensureResearch(s); const now=Date.now(); const u=s.research.universe[a.mint];
  if(!u){s.research.universe[a.mint]={mint:a.mint,symbol:a.symbol,firstSeen:now,lastSeen:now,firstPrice:a.priceUsd,lastPrice:a.priceUsd,maxPrice:a.priceUsd,minPrice:a.priceUsd,observations:1,maxFastEdge:a.fastEdgeScore||a.edgeScore||a.score};s.discoveryStats.discovered++;}
  else{u.lastSeen=now;u.lastPrice=a.priceUsd;u.maxPrice=Math.max(Number(u.maxPrice||0),Number(a.priceUsd||0));u.minPrice=Math.min(Number(u.minPrice||a.priceUsd||0),Number(a.priceUsd||0));u.observations=(u.observations||0)+1;u.maxFastEdge=Math.max(Number(u.maxFastEdge||0),Number(a.fastEdgeScore||a.edgeScore||a.score||0));}
  for(const src of a.discovery?.sources||['unknown']){const f=s.research.feedStats[src]||(s.research.feedStats[src]={seen:0,lastSeen:0,errors:0,latencyMs:0});f.seen++;f.lastSeen=now;}
  for(const h of a.risk?.largest||[]){const id=h.owner||h.address;if(!id)continue;const w=s.research.walletProfiles[id]||(s.research.walletProfiles[id]={address:id,seen:0,tokens:{},lastSeen:0,recurrenceScore:50});w.lastSeen=now;w.tokens[a.mint]=1;w.seen=Object.keys(w.tokens).length;w.recurrenceScore=clamp(50+Math.log10(w.seen+1)*6);}
  if(a.risk?.mintAuthority){const key=a.risk.mintAuthority;const d=s.research.deployerProfiles[key]||(s.research.deployerProfiles[key]={address:key,tokens:0,mints:{},lastSeen:0});d.mints ||= {};d.mints[a.mint]=1;d.tokens=Object.keys(d.mints).length;d.lastSeen=now;}
  s.discoveryStats.analyzed++; if(a.stage==='READY')s.discoveryStats.ready++;else if(a.stage==='WATCH')s.discoveryStats.watch++;else s.discoveryStats.rejected++;
}

export function outcomeFeatures(a){return{score:a.fastEdgeScore||a.edgeScore||a.score,explosion:a.explosionScore,moon:a.moonScore,rug:a.rugScore,execution:a.executionScore,momentum:a.momentumScore,liq:a.liq,age:a.ageMin,flow:a.flow5,pc5:a.pc5,velocity:a.micro?.velocity||0,buyerAccel:a.micro?.flowAccel||0,regime:a.regime};}

export function postmortemTrade(s,t){
  ensureResearch(s); const pm={id:id('pm'),ts:Date.now(),symbol:t.symbol,mint:t.mint,strategy:'UNIFIED_EDGE',pnlSol:t.pnlSol||0,returnPct:t.returnPct||0,maxFavorablePct:t.maxFavorablePct||0,maxAdversePct:t.maxAdversePct||0,reason:t.reason,entryFastEdge:t.fastEdgeScore||t.score||0,entryExecution:t.executionScore||0,entrySlippageBps:t.entrySlippageBps||0,exitSlippageBps:t.exitSlippageBps||0,diagnosis:'',lessons:[]};
  if(pm.returnPct>=0)pm.diagnosis='profitable-exit'; else if(String(pm.reason||'').includes('stop'))pm.diagnosis='entry-or-regime'; else pm.diagnosis='exit-or-timing';
  if(pm.returnPct<0)pm.lessons.push('compare entry timing, flow acceleration and execution quality');
  if(String(pm.reason).includes('stale'))pm.lessons.push('activity decayed before upside arrived');
  if((t.feesSol||0)>Math.max(.000001,Math.abs(t.pnlSol||0))*.2)pm.lessons.push('execution friction materially affected outcome');
  s.research.postmortems.unshift(pm);s.research.postmortems=s.research.postmortems.slice(0,500);return pm;
}

export function missedOpportunityScan(s){
  ensureResearch(s); const ticks=s.tickHistory||{};
  for(const a of s.watchlist||[]){const xs=ticks[a.mint]||[];if(xs.length<4)continue;const end=xs.at(-1),targetTs=Number(end?.ts||Date.now())-5*60_000;let base=xs[0];for(const x of xs){if(Number(x.ts)<=targetTs)base=x;else break;}const first=Number(base?.price||0),current=Number(end?.price||0);if(!(first>0&&current>0))continue;const elapsedMs=Number(end.ts||0)-Number(base.ts||0);if(elapsedMs<4*60_000)continue;const gain=(current/first-1)*100;if(gain>50&&!s.positions.some(p=>p.mint===a.mint)&&!s.history.some(h=>h.mint===a.mint)){const key=`miss:${a.mint}:${Math.floor(Date.now()/3600000)}`;if(!s.research.edgeRegistry[key])s.research.edgeRegistry[key]={type:'missed-runner',windowMin:Math.round(elapsedMs/60000),mint:a.mint,symbol:a.symbol,gainPct:gain,score:a.fastEdgeScore||a.score,stage:a.stage,warnings:a.warnings||[],ts:Date.now()};}}
}

const EXPERIMENT_PATCHES=[
  {label:'enter 3 EDGE earlier',thresholdDelta:-3}, {label:'enter 3 EDGE later',thresholdDelta:3},
  {label:'favor execution quality',executionBoost:.10}, {label:'favor explosive acceleration',explosionBoost:.10},
];
export function generateExperiment(s){
  ensureResearch(s); const running=s.research.experiments.filter(x=>x.status==='RUNNING'); if(running.length>=4)return null;
  const used=new Set(running.map(x=>x.patch?.label)); const patch=EXPERIMENT_PATCHES.find(x=>!used.has(x.label))||EXPERIMENT_PATCHES[Math.floor(Math.random()*EXPERIMENT_PATCHES.length)];
  const e={id:id('exp'),createdAt:Date.now(),status:'RUNNING',hypothesis:`Test whether ${patch.label} improves observed 5-minute outcomes`,patch:{...patch},minSamples:200,samples:0,controlN:0,testN:0,controlSum:0,testSum:0,controlWins:0,testWins:0,lastOutcomeTs:0,confidence:0,result:null};s.research.experiments.unshift(e);return e;
}

function testScore(outcome,patch){let score=Number(outcome.predicted||0);const f=outcome.features||{};if(patch.executionBoost)score+=patch.executionBoost*((Number(f.execution||0)*100)-50);if(patch.explosionBoost)score+=patch.explosionBoost*((Number(f.explosion||0)*100)-50);return score;}
export function updateExperiments(s){
  ensureResearch(s); const outcomes=(ensureLearner(s).outcomes||[]).filter(o=>o.horizonMin===5);
  for(const e of s.research.experiments.filter(x=>x.status==='RUNNING')){
    const fresh=outcomes.filter(o=>Number(o.ts)>Number(e.lastOutcomeTs||0)).sort((a,b)=>a.ts-b.ts);
    for(const o of fresh){const ret=Math.max(-100,Math.min(200,Number(o.returnPct||0)));const baseThreshold=Number(o.entryThreshold||60);const control=Number(o.predicted||0)>=baseThreshold;const test=testScore(o,e.patch)>=baseThreshold+Number(e.patch.thresholdDelta||0);if(control){e.controlN++;e.controlSum+=ret;if(ret>0)e.controlWins++;}if(test){e.testN++;e.testSum+=ret;if(ret>0)e.testWins++;}e.samples++;e.lastOutcomeTs=Math.max(e.lastOutcomeTs||0,o.ts);}
    if(e.samples>=e.minSamples&&e.testN>=30&&e.controlN>=30){const c=e.controlSum/e.controlN,t=e.testSum/e.testN,delta=t-c;e.confidence=clamp(50+Math.min(45,Math.abs(delta)*3));e.status='COMPLETE';e.result=delta>0.75?'CHALLENGER':'REJECT';e.controlAvg5mPct=c;e.testAvg5mPct=t;e.deltaAvg5mPct=delta;if(e.result==='CHALLENGER')s.research.challengers.push({id:e.id,name:e.patch.label,score:delta,confidence:e.confidence,createdAt:Date.now(),patch:e.patch,status:'VALIDATED_SHADOW'});}
  }
}

export function tournament(s){
  ensureResearch(s); const completed=s.research.experiments.filter(x=>x.status==='COMPLETE').map(x=>({name:x.patch?.label||x.id,samples:x.samples,testN:x.testN,controlN:x.controlN,testAvg5mPct:x.testAvg5mPct||0,controlAvg5mPct:x.controlAvg5mPct||0,robustScore:(x.deltaAvg5mPct||0)*Math.min(1,x.testN/200),result:x.result})).sort((a,b)=>b.robustScore-a.robustScore);
  return [{name:'UNIFIED_EDGE',samples:ensureLearner(s).samples,robustScore:0,result:'CHAMPION'},...completed.slice(0,20)];
}
export function strategyMutation(s){ensureResearch(s);return generateExperiment(s);}

export function calibrate(s){
  ensureResearch(s); const l=ensureLearner(s), rows=l.outcomes.filter(o=>o.horizonMin===5).slice(0,500),n=rows.length;
  if(n<30){s.research.modelHealth={...s.research.modelHealth,status:'COLLECTING',samples:n};return;}
  const buckets=[];for(let lo=0;lo<100;lo+=10){const xs=rows.filter(x=>x.predicted>=lo&&x.predicted<lo+10);if(xs.length)buckets.push({lo,n:xs.length,avgPred:mean(xs.map(x=>x.predicted)),hit25:xs.filter(x=>x.returnPct>=25).length/xs.length*100,avgReturn:mean(xs.map(x=>x.returnPct))});}
  const first=rows.slice(Math.floor(n/2)),second=rows.slice(0,Math.floor(n/2));const drift=Math.abs(mean(first.map(x=>x.returnPct))-mean(second.map(x=>x.returnPct)));
  const monotonic=buckets.length<2?0:buckets.reduce((q,b,i)=>i? q+(b.avgReturn>=buckets[i-1].avgReturn?1:0):q,0)/(buckets.length-1)*100;
  s.research.modelHealth={status:monotonic>=55?'HEALTHY':'REVIEW',samples:n,drift:clamp(drift),calibration:100-monotonic,buckets,updatedAt:Date.now()};
}
export function learnLesson(s,text,evidence={}){ensureResearch(s);const existing=s.research.lessons.find(x=>x.text===text);if(existing){existing.samples=(existing.samples||1)+1;existing.lastValidated=Date.now();existing.confidence=clamp((existing.confidence||50)+1);return existing}const x={id:id('lesson'),text,evidence,samples:1,confidence:50,createdAt:Date.now(),lastValidated:Date.now(),status:'ACTIVE'};s.research.lessons.unshift(x);s.research.lessons=s.research.lessons.slice(0,300);return x;}
export function nightlyResearch(s){ensureResearch(s);if(Date.now()-s.research.nightly.lastRun<6*3600000)return false;s.research.nightly.lastRun=Date.now();missedOpportunityScan(s);generateExperiment(s);calibrate(s);const l=learnerSnapshot(s);if(l.samples>=40)learnLesson(s,`Unified EDGE learner has ${l.samples} real multi-horizon outcome labels`,{avg5mPct:l.recentAvg5mPct,hit25Pct:l.recentHit25Pct,validatedHorizons:l.validatedHorizons});s.research.daily.unshift({ts:Date.now(),regime:s.market?.regime,champion:s.research.champion,learner:l,experiments:s.research.experiments.filter(x=>x.status==='RUNNING').length,modelHealth:s.research.modelHealth});s.research.daily=s.research.daily.slice(0,90);return true;}
export function evolutionSnapshot(s){ensureResearch(s);return{autonomyLevel:s.research.autonomyLevel,champion:{name:'UNIFIED_EDGE',version:s.research.champion?.version||1},challengers:s.research.challengers.slice(-12),experiments:s.research.experiments.slice(0,20),lessons:s.research.lessons.slice(0,20),postmortems:s.research.postmortems.slice(0,20),modelHealth:s.research.modelHealth,learner:learnerSnapshot(s),tournament:tournament(s),feeds:s.research.feedStats,misses:Object.values(s.research.edgeRegistry).filter(x=>x.type==='missed-runner').slice(-20)};}
