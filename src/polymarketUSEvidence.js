// Polymarket US combo evidence: the legs tape, a public settlement tracker, a
// calibration table and a SHADOW auto-combo. Nothing here signs a request or
// places anything; every call is a public GET. The research collector (one per
// data dir, under its lock) drives evidenceTick(); the HUD only reads the state.
//
// Observed public shapes (2026-09-26), used as-is:
//  - GET /v1/markets?slug=a&slug=b -> {markets:[{slug,status,marketSides:[{long,price}],outcomePrices}]}
//    A resolved market has status MARKET_STATUS_RESOLVED and side prices "1"/"0".
//  - GET /v1/markets/{slug}/settlement -> {slug,settlement} and returns 0.5 for UNRESOLVED
//    markets, so it is never trusted alone. We use the markets list only.
import fs from 'node:fs';
import path from 'node:path';
import { appendNdjson, atomicJson, RESEARCH_RAW_DIR } from './researchCollector.js';
import { usLiveEvents, usCandidatesFromEvents, chooseUSCombo, comboFeePerContract, STRATEGY_WINDOWS, usComboSettings } from './polymarketUSCombos.js';

const GATEWAY=process.env.POLYMARKET_US_GATEWAY||'https://gateway.polymarket.us';
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
export const EVIDENCE_STATE_FILE=path.join(DATA_DIR,'research-evidence','polymarket-us-evidence.json');
export const LEG_HEARTBEAT_MS=60_000;            // re-log an unchanged leg at most once a minute
export const RESOLVE_POLL_MS=60_000;             // settlement polling cadence
export const RESOLVE_BATCH=20,RESOLVE_CALLS_PER_TICK=3;
export const RESOLVE_GIVE_UP_MS=72*3600e3;       // an unresolved leg this old is dropped as UNKNOWN
export const CONSERVATIVE_MARKUP=0.03;           // assumed RFQ markup until real quotes are observed
export const SHADOW_STAKE_USD=2,SHADOW_MAX_OPEN=2,SHADOW_COOLDOWN_MS=180_000;
export const MIN_MARKUP_SAMPLES=5;
const PRICE_BUCKETS=[0.6,0.7,0.8,0.85,0.9,0.95,0.985];

const num=x=>{const n=Number(x);return Number.isFinite(n)?n:0};
const r4=x=>Math.round(num(x)*1e4)/1e4,r2=x=>Math.round(num(x)*100)/100;
const TICK=0.001,ceilTick=p=>Math.ceil(p/TICK-1e-9)*TICK;

export function priceBucket(p){
 const x=num(p);let lo=null;
 for(const b of PRICE_BUCKETS)if(x>=b-1e-9)lo=b;
 if(lo==null)return '<0.60';
 const i=PRICE_BUCKETS.indexOf(lo);
 return i===PRICE_BUCKETS.length-1?`${lo.toFixed(3)}+`:`${lo.toFixed(2)}-${PRICE_BUCKETS[i+1].toFixed(2)}`;
}

export function defaultEvidenceState(){
 return {schema:'mpo.polymarket-us-evidence.v1',legHashes:{},tracked:{},calibration:{},resolvedRecent:[],
  shadow:Object.fromEntries(STRATEGY_WINDOWS.map(w=>[w,{open:[],history:[],cooldowns:{},decisions:[]}])),
  markup:{samples:[],median:null},lastResolveAt:0,stats:{legRows:0,resolved:0,unknown:0,scans:0},updatedAt:0};
}
export function loadEvidenceState(file=EVIDENCE_STATE_FILE){
 try{
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  const d=defaultEvidenceState();
  return {...d,...s,shadow:{...d.shadow,...(s.shadow||{})},stats:{...d.stats,...(s.stats||{})},markup:{...d.markup,...(s.markup||{})}};
 }catch{return defaultEvidenceState()}
}

// ------------------------------------------------------------- legs tape
// One board scan per window. A leg's row carries every window's verdict so the
// Lab can replay any window from the same tape.
export function scanWindows(events,now=Date.now(),settings=usComboSettings()){
 const byWindow={};
 for(const w of STRATEGY_WINDOWS)byWindow[w]=usCandidatesFromEvents(events,now,{...settings,window:w});
 return byWindow;
}
export function legTapeRows(byWindow,now=Date.now(),state=defaultEvidenceState()){
 const legs=new Map();
 for(const [w,built] of Object.entries(byWindow)){
  for(const c of built.board||[]){
   if(!c.key)continue;
   const cur=legs.get(c.key)||{c,windows:{}};
   cur.windows[w]={ok:!!c.eligible,eta:c.etaMinutes??null,reason:c.reason??null,rank:c.rank??null,parts:c.rankParts||null};
   legs.set(c.key,cur);
  }
 }
 const rows=[],hashes={...state.legHashes};
 for(const [key,{c,windows}] of legs){
  const h=[c.bid,c.ask,c.liveState?.period,c.liveState?.elapsed,c.liveState?.score,Object.values(windows).map(x=>x.ok?1:0).join('')].join('|');
  const prior=hashes[key];
  if(prior&&prior.h===h&&now-num(prior.at)<LEG_HEARTBEAT_MS)continue;
  hashes[key]={h,at:now};
  rows.push({schema:'mpo.polymarket-us-legs.v1',capturedAt:now,key,symbol:c.symbol,side:c.side,eventSlug:c.eventSlug,event:c.event,
   sport:c.sport,league:c.league,marketType:c.marketType,outcome:c.outcome,
   bid:c.bid,ask:c.ask,price:c.price,spread:c.spread,liquidity:c.liquidity||null,
   clock:{period:c.liveState?.period??null,elapsed:c.liveState?.elapsed??null,score:c.liveState?.score??null},
   feeCoefficient:c.feeCoefficient,feePerContract:c.feePerContract,freshnessSec:c.freshnessSec,windows,
   coverage:{bidAsk:true,depth:false,rfqQuote:false,settlement:false}});
 }
 // Forget hashes of legs not seen for an hour.
 for(const [k,v] of Object.entries(hashes))if(now-num(v.at)>3600e3)delete hashes[k];
 return {rows,legHashes:hashes};
}
// Per window, the combo the auto logic would pick right now and its ask-product estimate.
export function comboEstimateRows(byWindow,now=Date.now(),legs=2){
 const rows=[];
 for(const [w,built] of Object.entries(byWindow)){
  const picked=chooseUSCombo(built.candidates||[],legs,{open:[],cooldowns:{}},now);
  if(picked.length<2)continue;
  const askProduct=r4(picked.reduce((a,l)=>a*num(l.price),1));
  rows.push({schema:'mpo.polymarket-us-combo-estimate.v1',capturedAt:now,window:w,legs:picked.map(l=>l.key),
   askProduct,estPrice:r4(Math.min(0.999,ceilTick(askProduct))),feePerContract:r4(comboFeePerContract(Math.min(0.999,ceilTick(askProduct)),now))});
 }
 return rows;
}

// ------------------------------------------------------- settlement tracker
// Every leg that qualified in a window is tracked once per (leg, window) at its
// first qualifying price. It resolves from the public markets list.
export function trackLegs(state,byWindow,now=Date.now()){
 for(const [w,built] of Object.entries(byWindow)){
  for(const c of built.candidates||[]){
   const id=`${c.key}|${w}`;
   if(state.tracked[id])continue;
   state.tracked[id]={id,key:c.key,symbol:c.symbol,side:c.side,eventSlug:c.eventSlug,sport:c.sport,league:c.league,window:w,
    price:c.price,feePerContract:c.feePerContract,rank:c.rank??null,parts:c.rankParts||null,etaMinutes:c.etaMinutes??null,firstSeenAt:now,lastSeenAt:now};
  }
 }
 const live=new Set();for(const built of Object.values(byWindow))for(const c of built.board||[])live.add(c.eventSlug);
 for(const t of Object.values(state.tracked))if(live.has(t.eventSlug))t.lastSeenAt=now;
 return state;
}
// Interprets one observed market row. Returns 1 (long won), 0 (long lost) or null (unresolved/unknown).
export function longSettlement(market){
 if(!market||market.status!=='MARKET_STATUS_RESOLVED')return null;
 const long=(market.marketSides||[]).find(s=>s?.long===true);
 let px=long?Number(long.price):NaN;
 if(!Number.isFinite(px)){try{px=Number(JSON.parse(market.outcomePrices||'[]')[0])}catch{px=NaN}}
 return px===1||px===0?px:null;
}
export function legWon(side,long){return long==null?null:side==='SIDE_BUY'?long===1:long===0}
export async function fetchMarketsBySlug(slugs,fetchImpl=globalThis.fetch){
 const url=new URL('/v1/markets',GATEWAY);
 for(const s of slugs)url.searchParams.append('slug',s);
 url.searchParams.set('limit',String(Math.max(slugs.length,1)));
 const res=await fetchImpl(url.toString(),{headers:{accept:'application/json'}});
 if(!res?.ok){const e=new Error(`markets lookup HTTP ${res?.status}`);e.status=Number(res?.status||0);throw e}
 const j=JSON.parse(await res.text());
 return Array.isArray(j?.markets)?j.markets:[];
}
export function calibrationKey(t){return `${priceBucket(t.price)}|${t.sport||'other'}|${t.window}`}
function addCalibration(state,t,won){
 const k=calibrationKey(t);
 const c=state.calibration[k]||(state.calibration[k]={bucket:priceBucket(t.price),sport:t.sport||'other',window:t.window,n:0,wins:0,sumPrice:0,sumFee:0});
 c.n++;if(won)c.wins++;c.sumPrice=r4(c.sumPrice+num(t.price));c.sumFee=r4(c.sumFee+num(t.feePerContract));
}
// A settled table row: winRate vs implied price and the single-leg edge after the modelled fee.
export function calibrationTable(state){
 return Object.values(state.calibration).map(c=>{
  const implied=c.n?c.sumPrice/c.n:null,fee=c.n?c.sumFee/c.n:null,winRate=c.n?c.wins/c.n:null;
  return {...c,implied:implied==null?null:r4(implied),winRate:winRate==null?null:r4(winRate),
   edgeAfterFee:winRate==null?null:r4(winRate-implied-fee)};
 }).sort((a,b)=>a.window.localeCompare(b.window)||a.bucket.localeCompare(b.bucket)||a.sport.localeCompare(b.sport));
}
export async function resolveTracked(state,{now=Date.now(),fetchImpl=globalThis.fetch,liveEvents=new Set()}={}){
 const pending=Object.values(state.tracked).filter(t=>!liveEvents.has(t.eventSlug));
 const slugs=[...new Set(pending.map(t=>t.symbol))].slice(0,RESOLVE_BATCH*RESOLVE_CALLS_PER_TICK);
 const outcomes=[];let rateLimited=false;
 const bySlug=new Map();
 for(let i=0;i<slugs.length;i+=RESOLVE_BATCH){
  try{for(const m of await fetchMarketsBySlug(slugs.slice(i,i+RESOLVE_BATCH),fetchImpl))bySlug.set(m.slug,m)}
  catch(e){if(e.status===429){rateLimited=true;break}throw e}
 }
 for(const t of pending){
  const m=bySlug.get(t.symbol);
  const long=longSettlement(m);
  let won=legWon(t.side,long);
  if(won==null){
   // Resolved but not 0/1 (void/push) or never resolved in time: UNKNOWN, not a win.
   const voided=m&&m.status==='MARKET_STATUS_RESOLVED';
   if(!voided&&now-num(t.firstSeenAt)<RESOLVE_GIVE_UP_MS)continue;
   state.stats.unknown++;
   outcomes.push({...t,outcome:'UNKNOWN',resolvedAt:now});
   delete state.tracked[t.id];continue;
  }
  addCalibration(state,t,won);state.stats.resolved++;
  outcomes.push({...t,outcome:won?'WON':'LOST',resolvedAt:now});
  delete state.tracked[t.id];
 }
 state.resolvedRecent=[...outcomes,...state.resolvedRecent].slice(0,300);
 return {outcomes,rateLimited};
}

// --------------------------------------------------------- RFQ markup log
export function rfqEvidenceRow({at=Date.now(),legs=[],rawPrice=null,estPrice=null,quoted=null,outcome,code=null}={}){
 const markup=quoted!=null&&rawPrice!=null?r4(num(quoted)-num(rawPrice)):null;
 return {schema:'mpo.polymarket-us-rfq.v1',at,legs:legs.map(l=>l.symbol||l),legCount:legs.length,askProduct:rawPrice,estPrice,quoted,markup,outcome,code};
}
export function medianMarkup(samples=[]){
 const xs=samples.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
 if(xs.length<MIN_MARKUP_SAMPLES)return null;
 const m=Math.floor(xs.length/2);return r4(xs.length%2?xs[m]:(xs[m-1]+xs[m])/2);
}
export function readRfqMarkups(dir=RESEARCH_RAW_DIR,days=14,now=Date.now()){
 const out=[];
 for(let d=0;d<days;d++){
  const t=new Date(now-d*86400e3),day=`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
  let text='';try{text=fs.readFileSync(path.join(dir,`polymarket-us-rfq-${day}.ndjson`),'utf8')}catch{continue}
  for(const line of text.split('\n')){if(!line.trim())continue;try{const r=JSON.parse(line);if(r.outcome==='quote'&&Number.isFinite(Number(r.markup)))out.push(Number(r.markup))}catch{}}
 }
 return out;
}
export function effectiveMarkup(state){return state.markup?.median??CONSERVATIVE_MARKUP}

// ------------------------------------------------------------ SHADOW auto
// Runs the exact auto selection (chooseUSCombo over the window's candidates),
// "places" at askProduct + markup with a fixed stake, settles against real leg
// outcomes. Any UNKNOWN leg voids the combo (not counted).
export function shadowStep(state,byWindow,{now=Date.now(),legs=2,legOutcome=()=>null}={}){
 const markup=effectiveMarkup(state),decisions=[];
 for(const w of STRATEGY_WINDOWS){
  const sh=state.shadow[w]||(state.shadow[w]={open:[],history:[],cooldowns:{},decisions:[]});
  // settle
  for(const c of [...sh.open]){
   const res=c.legs.map(l=>legOutcome(l,w));
   let status=null;
   if(res.includes('LOST'))status='LOST';
   else if(res.includes('UNKNOWN'))status='VOID';
   else if(res.every(x=>x==='WON'))status='WON';
   if(!status)continue;
   const pnl=status==='WON'?r2(c.quantity-c.costUsd):status==='LOST'?r2(-c.costUsd):0;
   sh.open=sh.open.filter(x=>x.id!==c.id);
   sh.history.unshift({...c,status,pnlUsd:pnl,settledAt:now});sh.history=sh.history.slice(0,500);
   for(const l of c.legs)sh.cooldowns[l.eventSlug]=now;
   decisions.push({at:now,window:w,action:'settled',status,pnlUsd:pnl,id:c.id});
  }
  // enter
  if(sh.open.length>=SHADOW_MAX_OPEN){decisions.push({at:now,window:w,action:'skipped',reason:'max open'});continue}
  const cands=(byWindow[w]?.candidates)||[];
  const picked=chooseUSCombo(cands,legs,{open:sh.open,cooldowns:Object.fromEntries(Object.entries(sh.cooldowns).filter(([,t])=>now-num(t)<SHADOW_COOLDOWN_MS))},now);
  if(picked.length<Math.max(2,legs)){decisions.push({at:now,window:w,action:'skipped',reason:`only ${picked.length} eligible leg(s)`});continue}
  const askProduct=picked.reduce((a,l)=>a*num(l.price),1);
  const price=Math.min(0.999,r4(ceilTick(askProduct)+markup));
  const fee=comboFeePerContract(price,now);
  const quantity=Math.floor(SHADOW_STAKE_USD/(price+fee)*100)/100;
  if(!(quantity>0)){decisions.push({at:now,window:w,action:'rejected',reason:'stake too small'});continue}
  const entry={id:`sh-${now.toString(36)}-${w}`,at:now,window:w,askProduct:r4(askProduct),markup,price,feePerContract:r4(fee),quantity,
   costUsd:r2(quantity*(price+fee)),legs:picked.map(l=>({key:l.key,symbol:l.symbol,side:l.side,eventSlug:l.eventSlug,price:l.price,sport:l.sport}))};
  sh.open.push(entry);
  decisions.push({at:now,window:w,action:'placed',id:entry.id,price,legs:entry.legs.length});
 }
 // Log each decision, but collapse repeats of the same skip so the feed stays readable.
 for(const d of decisions){
  const sh=state.shadow[d.window],head=(sh.decisions||[])[0];
  if(d.action==='skipped'&&head&&head.action==='skipped'&&head.reason===d.reason){head.lastAt=d.at;head.repeats=num(head.repeats)+1;continue}
  sh.decisions=[d,...(sh.decisions||[])].slice(0,50);
 }
 return decisions;
}
export function shadowRecord(state){
 const out={};
 for(const w of STRATEGY_WINDOWS){
  const sh=state.shadow[w]||{open:[],history:[]};
  const settled=sh.history.filter(x=>x.status==='WON'||x.status==='LOST');
  const won=settled.filter(x=>x.status==='WON').length;
  const staked=settled.reduce((a,x)=>a+num(x.costUsd),0),pnl=settled.reduce((a,x)=>a+num(x.pnlUsd),0);
  out[w]={open:sh.open.length,settled:settled.length,won,lost:settled.length-won,voided:sh.history.filter(x=>x.status==='VOID').length,
   winRate:settled.length?r4(won/settled.length):null,pnlUsd:r2(pnl),stakedUsd:r2(staked),roi:staked>0?r4(pnl/staked):null,
   lastDecision:(sh.decisions||[])[0]||null};
 }
 return out;
}

// ------------------------------------------------------------- one tick
// Leg outcomes for the shadow come from the tracker's resolved list.
function outcomeLookup(state){
 const m=new Map();for(const r of state.resolvedRecent)m.set(`${r.key}|${r.window}`,r.outcome);
 return (leg,w)=>m.get(`${leg.key}|${w}`)||null;
}
export async function evidenceTick({now=Date.now(),state=loadEvidenceState(),fetchImpl=globalThis.fetch,events=null,settings=null,rawDir=RESEARCH_RAW_DIR,stateFile=EVIDENCE_STATE_FILE}={}){
 let evs=events;
 if(!evs){const f=await usLiveEvents({force:true});if(!f.ok)throw new Error(f.error||'feed down');evs=f.events}
 const st=settings||usComboSettings();
 const byWindow=scanWindows(evs,now,st);
 const tape=legTapeRows(byWindow,now,state);state.legHashes=tape.legHashes;
 const est=comboEstimateRows(byWindow,now,Math.max(2,Math.min(4,num(st.maxLegs)||2)));
 appendNdjson('polymarket-us-legs',[...tape.rows,...est],{dir:rawDir,now});
 state.stats.legRows+=tape.rows.length;state.stats.scans++;
 trackLegs(state,byWindow,now);
 let resolved={outcomes:[],rateLimited:false};
 if(now-num(state.lastResolveAt)>=RESOLVE_POLL_MS){
  state.lastResolveAt=now;
  const live=new Set();for(const b of Object.values(byWindow))for(const c of b.board||[])live.add(c.eventSlug);
  resolved=await resolveTracked(state,{now,fetchImpl,liveEvents:live});
  if(resolved.outcomes.length)appendNdjson('polymarket-us-outcomes',resolved.outcomes.map(o=>({schema:'mpo.polymarket-us-outcome.v1',...o})),{dir:rawDir,now});
  const samples=readRfqMarkups(rawDir,14,now);state.markup={samples:samples.slice(-200),median:medianMarkup(samples),count:samples.length};
 }
 const decisions=shadowStep(state,byWindow,{now,legs:Math.max(2,Math.min(4,num(st.maxLegs)||2)),legOutcome:outcomeLookup(state)});
 state.updatedAt=now;
 atomicJson(stateFile,state);
 return {legRows:tape.rows.length,estimates:est.length,resolved:resolved.outcomes.length,rateLimited:resolved.rateLimited,decisions};
}

// HUD summary (read-only).
export function evidenceSummary(state=loadEvidenceState()){
 return {updatedAt:state.updatedAt||null,stats:state.stats,tracked:Object.keys(state.tracked).length,
  markup:{median:state.markup?.median??null,samples:state.markup?.count??0,used:effectiveMarkup(state),conservative:state.markup?.median==null},
  shadow:shadowRecord(state),calibration:calibrationTable(state)};
}

// ------------------------------------------------------------ Lab proposal
// The Lab publishes <data>/lab-link/polymarket-combo-champion.json (paper-only).
// Only its window/priceMin/maxLegs/rankWeights are read, and setUSComboSettings
// re-validates them against the trader's own bounds before anything changes.
export const LAB_PROPOSAL_FILE=path.join(DATA_DIR,'lab-link','polymarket-combo-champion.json');
export function labComboProposal(file=LAB_PROPOSAL_FILE){
 let doc;try{doc=JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}
 if(!doc||doc.module!=='polymarket-combo'||doc.schema!=='mpo.lab-module-champion.v1')return {valid:false,reason:'not a polymarket-combo champion'};
 if(doc.liveActivationAllowed!==false)return {valid:false,reason:'proposal claims live authority; ignored'};
 const p=doc.candidate?.params||{};
 const params={window:p.window,priceMin:Number(p.priceMin),maxLegs:Number(p.maxLegs),rankWeights:p.rankWeights};
 return {valid:true,publishedAt:doc.publishedAt||null,stage:doc.qualificationStage||null,id:doc.candidate?.id||null,params,
  train:doc.candidate?.train||null,holdout:doc.candidate?.holdout||null,positiveEdge:!!doc.evidence?.positiveEdge,markup:doc.evidence?.markup||null,trials:doc.evidence?.trials??null};
}
