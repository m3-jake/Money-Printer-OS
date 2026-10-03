// Robinhood stocks & ETFs paper lane: controller + snapshot (docs/ROBINHOOD-AUTO-TRADER.md §25).
// Decide after a completed regular session (first moment the app runs after that close), fill at the first
// regular open after the decision was saved (late=true if the PC was off past the intended open), exactly once.
// Missed sessions are counted, never decided after the fact. Paper only; real equity orders are NOT wired.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastCompletedSession, nextSession, nextOpenAfter, sessionFor, marketState, isSession, CALENDAR_SOURCE, CALENDAR_END } from './robinhoodEquitiesCalendar.js';
import { refreshBars, readBarStore, dataStatus, writeLabBars } from './robinhoodEquitiesData.js';
import { STRATEGIES, DEFAULT_STRATEGY, normalizeParams, paramsHash, symbolsFor, targetWeights, replay } from './robinhoodEquitiesStrategy.js';
import { loadBook, saveBook, fillPending, equityAt, cashUsd, settle, FEES, DEFAULTS } from './robinhoodEquitiesBook.js';
import { championState, championPaperAllowed } from './championState.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function equitiesDataDir(env=process.env){return path.resolve(env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'))}

export const READINESS_TEXT='Paper only. Decisions use public end-of-day bars, not Robinhood quotes. Real stock/ETF orders would go only through Robinhood\'s official Agentic Trading MCP (stocks, options and crypto; long-only; dedicated Agentic account), which is NOT wired in this app.';
export function equitiesReadiness(env=process.env){
 return {platform:'Robinhood stocks & ETFs',execution:'paper-only',realOrders:false,robinhoodQuotes:false,sessions:'regular hours only (NYSE calendar)',
  realRoute:{name:'Robinhood Agentic Trading MCP',scope:'stocks, options and crypto; long-only; dedicated Agentic account; no sandbox; margin borrowing off',wired:false,
   url:'https://agent.robinhood.com/mcp/trading',urlVerified:false,urlNote:'URL taken from third-party setup guides, not a Robinhood page'},
  text:READINESS_TEXT};
}

// Evolution Lab champion for this lane (lab-link/robinhood-equities-champion.json, published by the Lab's
// robinhood-equities worker). Applied only when championState clears it for paper, it claims no live authority,
// it is for this strategy, every bounded param is inside the strategy's bounds (never clamped into range), every
// other param equals the strategy default, and its params hash is the trader's own hash. Existing accepted policies
// stay applied when a proposal is withdrawn; a fresh book without a qualifying proposal runs the defaults.
export function equitiesChampionFile(dataDir){return path.join(dataDir,'lab-link','robinhood-equities-champion.json')}
const sameValue=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const EQUITIES_EVALUATOR='equities-close-next-open-v3';
const APPLIED_POLICY_SCHEMA='mpo.equities-applied-policy.v1';
const sha256=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const millis=v=>typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;
function boundedParams(strategyId,params){
 const s=STRATEGIES[strategyId];
 if(!s||!params||typeof params!=='object'||Array.isArray(params))return false;
 return Object.entries(params).every(([k,v])=>Object.hasOwn(s.bounds,k)
  ?finite(v)&&v>=s.bounds[k][0]&&v<=s.bounds[k][1]&&(k!=='topN'||Number.isInteger(v))
  :Object.hasOwn(s.defaults,k)&&sameValue(v,s.defaults[k]));
}
function prospectiveEvidenceError(doc,hash,incumbentHash,strategyId,clock){
 const e=doc.evidence||{},f=e.freeze||{},p=e.prospective||{},ci=p.interval||{};
 if(e.evaluatorVersion!==EQUITIES_EVALUATOR||!sha256(e.datasetHash)||!sha256(e.experimentId))return 'current evaluator, dataset and experiment fingerprints required';
 if(e.costs?.known!==true||!['slippageBps','sellFeeBps'].every(k=>finite(e.costs[k])&&e.costs[k]>=0&&e.costs[k]<10000&&e.costs[k]===f.costs?.[k]))return 'executable costs are not verified or changed after freeze';
 if(f.schema!=='mpo.equities-freeze.v1'||f.evaluatorVersion!==EQUITIES_EVALUATOR||!sha256(f.datasetHash)||f.candidateHash!==hash||(incumbentHash!==hash&&f.incumbentHash!==incumbentHash))return 'frozen candidate does not match the applied incumbent';
 if(!boundedParams(strategyId,f.candidate?.params)||paramsHash(strategyId,normalizeParams(strategyId,f.candidate.params))!==hash||!boundedParams(strategyId,f.incumbent?.params)||paramsHash(strategyId,normalizeParams(strategyId,f.incumbent.params))!==f.incumbentHash)return 'frozen policies do not match their hashes';
 const published=millis(doc.publishedAt),start=millis(p.start),end=millis(p.end),frozen=millis(f.frozenAt),history=millis(f.historyThrough);
 if(!(published>0&&published<=clock&&clock-published<=7*864e5&&published>=end)||!(history>0&&history<=frozen&&frozen<start&&start<=end&&end<=clock&&clock-end<=7*864e5)||!Number.isInteger(p.sessions)||p.sessions<126||(end-start)/864e5+1<p.sessions||typeof p.accessId!=='string'||!p.accessId.trim())return 'fresh untouched 126-session prospective evidence required';
 if(p.pass!==true||!['costsKnown','candidateTraded','beatsCash','beatsIncumbent','boundedDrawdown','independentMonths','improvementInterval'].every(k=>p.gates?.[k]===true))return 'every prospective gate must pass';
 for(const m of [p.candidate,p.incumbent,p.buyHoldSpy])if(!m||m.sessions!==p.sessions||!finite(m.totalReturnPct)||m.totalReturnPct< -100||!finite(m.maxDrawdownPct)||m.maxDrawdownPct<0||m.maxDrawdownPct>100)return 'prospective metrics are invalid';
 if(!(p.candidate.totalReturnPct>0&&p.candidate.totalReturnPct>p.incumbent.totalReturnPct&&p.candidate.maxDrawdownPct<=p.buyHoldSpy.maxDrawdownPct))return 'candidate must beat cash and incumbent with bounded drawdown';
 if(!Number.isInteger(f.trials)||f.trials<1||e.trials!==f.trials||!Number.isInteger(p.effectiveIndependentGroups)||p.effectiveIndependentGroups<6||p.effectiveIndependentGroups>p.sessions||ci.independentGroups!==p.effectiveIndependentGroups||ci.adjustedForTrials!==f.trials||ci.method!=='paired-independent-group-normal-bonferroni'||ci.grouped!==true||!finite(ci.level)||ci.level<.95||ci.level>=1||!finite(ci.standardErrorPct)||ci.standardErrorPct<0||!finite(ci.lowerPct)||!finite(ci.upperPct)||!finite(ci.meanImprovementPct)||!(ci.lowerPct>0&&ci.lowerPct<=ci.meanImprovementPct&&ci.meanImprovementPct<=ci.upperPct))return 'positive trial-adjusted improvement interval over six independent groups required';
 return null;
}
export function equitiesLabChampion(dataDir,strategyId=DEFAULT_STRATEGY){
 const no=(reason,extra={})=>({applied:false,reason,...extra});
 let doc;try{doc=JSON.parse(fs.readFileSync(equitiesChampionFile(dataDir),'utf8'))}catch(e){return no(e?.code==='ENOENT'?'no Lab champion published':'Lab champion file unreadable')}
 if(!doc||doc.schema!=='mpo.lab-module-champion.v1'||doc.module!=='robinhood-equities')return no('not a robinhood-equities Lab champion record');
 const c=doc.candidate||{},base={id:c.id||null,paramsHash:c.paramsHash||null,state:championState(doc).state,publishedAt:doc.publishedAt||null};
 if(doc.liveActivationAllowed!==false||doc.automaticLivePromotionAllowed!==false||doc.paperOnly!==true)return no('explicit paper-only safety flags required',base);
 if(!championPaperAllowed(doc))return no(`Lab champion is ${base.state}${doc.paperPromotionAllowed===true?'':' without the paper-promotion flag'}, not cleared for paper`,base);
 const s=STRATEGIES[strategyId];
 if(!s||c.strategyId!==strategyId)return no(`champion is for ${String(c.strategyId)}, this book runs ${strategyId}`,base);
 if(!c.params||typeof c.params!=='object'||Array.isArray(c.params))return no('champion has no params',base);
 for(const [k,v] of Object.entries(c.params)){
  if(Object.hasOwn(s.bounds,k)){const [lo,hi]=s.bounds[k];if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)return no(`${k} ${JSON.stringify(v)} outside [${lo}, ${hi}]`,base);if(k==='topN'&&!Number.isInteger(v))return no('topN must be a whole number',base)}
  else if(!Object.hasOwn(s.defaults,k))return no(`unknown param ${k}`,base);
  else if(!sameValue(v,s.defaults[k]))return no(`${k} differs from the strategy default; only bounded params may change`,base);
 }
 const params=normalizeParams(strategyId,c.params),hash=paramsHash(strategyId,params);
 if(c.paramsHash!==hash)return no(`params hash ${String(c.paramsHash)} does not match the trader's ${hash}`,base);
 const clock=Date.now();
 const book=loadBook(dataDir),incumbentHash=book.paramsHash||paramsHash(strategyId,normalizeParams(strategyId,{}));
 const error=prospectiveEvidenceError(doc,hash,incumbentHash,strategyId,clock);
 if(error)return no(error,base);
 return {applied:true,reason:null,...base,params,paramsHash:hash,acceptance:{schema:APPLIED_POLICY_SCHEMA,evaluatorVersion:EQUITIES_EVALUATOR,paramsHash:hash,experimentId:doc.evidence.experimentId,candidateId:c.id,acceptedAt:clock}};
}
// A proposal grants adoption once. Withdrawal or expiry cannot silently replace the applied policy.
export function equitiesStrategyParams(dataDir,strategyId=DEFAULT_STRATEGY){
 const lab=equitiesLabChampion(dataDir,strategyId);
 const book=loadBook(dataDir),receipt=book.appliedPolicy;
 const retained=!book.recoveryRequired&&book.strategyId===strategyId&&boundedParams(strategyId,book.params)&&receipt?.schema===APPLIED_POLICY_SCHEMA&&receipt.evaluatorVersion===EQUITIES_EVALUATOR&&sha256(receipt.experimentId)&&receipt.paramsHash===book.paramsHash&&paramsHash(strategyId,normalizeParams(strategyId,book.params))===book.paramsHash;
 const params=lab.applied?lab.params:retained?normalizeParams(strategyId,book.params):normalizeParams(strategyId,{});
 const {params:_p,acceptance,...labView}=lab;
 return {params,hash:paramsHash(strategyId,params),acceptance:lab.applied?acceptance:retained?receipt:null,lab:{...labView,retained:!lab.applied&&retained,source:lab.applied?'evolution-lab':retained?'applied-incumbent':'defaults'}};
}

let state={running:false,lastRunAt:null,lastError:null,busy:false};
let timer=null;
const handoffVersions=new Map();

function priceMaps(bars){const m={};for(const [s,rows] of Object.entries(bars||{}))m[s]=new Map(rows.map(r=>[r.d,r]));return m}

export async function runEquitiesOnce({now=Date.now(),env=process.env,fetchImpl=globalThis.fetch,dataDir=equitiesDataDir(env),strategyId=env.ROBINHOOD_EQUITIES_STRATEGY||DEFAULT_STRATEGY}={}){
 if(!STRATEGIES[strategyId]||strategyId==='cash'||strategyId==='buy-hold')strategyId=DEFAULT_STRATEGY;
 const {params,hash,acceptance,lab}=equitiesStrategyParams(dataDir,strategyId);const symbols=symbolsFor(strategyId,params);
 const startUsd=Number(env.ROBINHOOD_EQUITIES_START_USD)>0?Number(env.ROBINHOOD_EQUITIES_START_USD):DEFAULTS.startUsd;
 const slippageBps=Number.isFinite(Number(env.ROBINHOOD_EQUITIES_SLIPPAGE_BPS))&&env.ROBINHOOD_EQUITIES_SLIPPAGE_BPS!==''?Math.max(0,Number(env.ROBINHOOD_EQUITIES_SLIPPAGE_BPS)):DEFAULTS.slippageBps;
 const {store}=await refreshBars(dataDir,symbols,{now,env,fetchImpl});
 const book=loadBook(dataDir,{startUsd,slippageBps,strategyId,paramsHash:hash,now});
 const events=[];
 if(book.recoveryRequired)return {book,store,events:['RECOVERY']};
 const ds=dataStatus(store,symbols,now,env);
 if(ds.status==='NO_DATA')return {book,store,events:['NO_DATA']};
 const px=priceMaps(store.bars);
 // 1) Fill a pending decision at the first regular open after it was saved, once that session's bar exists.
 if(book.pending){
  const x=nextOpenAfter(Date.parse(book.pending.decidedAt));
  if(x&&px.SPY?.get(x)){
   const fills=fillPending(book,{session:x,openOf:s=>px[s]?.get(x)?.o,settlesOn:nextSession(x)||x,late:x!==book.pending.executeAtOpenOf,now});
   events.push('FILLED '+x+' ('+fills.length+')');
  }
 }
 // 2) Mark equity and baselines for every completed session with bars since the last mark.
 const L=lastCompletedSession(now);
 const spyRows=store.bars.SPY||[];
 const lastMarked=book.equityDaily.at(-1)?.d||null;
 for(const r of spyRows){
  if(r.d>(L||'')||(lastMarked&&r.d<=lastMarked))continue;
  if(!lastMarked&&book.lastDecidedSession===null&&r.d!==L)continue; // start marking from the first live session only
  settle(book,r.d);
  if(!book.bench)book.bench={startSession:r.d,spyShares:book.startUsd/r.c,cashUsd:book.startUsd};
  const eq=equityAt(book,s=>px[s]?.get(r.d)?.c);
  book.equityDaily.push({d:r.d,equityUsd:eq,benchUsd:Math.round(book.bench.spyShares*r.c*100)/100,cashUsd:book.bench.cashUsd});
  for(const [s,p] of Object.entries(book.positions)){const c=px[s]?.get(r.d)?.c;if(c)p.lastPx=c}
 }
 if(book.equityDaily.length>3000)book.equityDaily.splice(0,book.equityDaily.length-3000);
 // 3) Decide once for the latest completed session (never retroactively for missed ones).
 if(L&&ds.status==='FRESH'&&!book.pending&&(!book.lastDecidedSession||L>book.lastDecidedSession)){
  if(book.lastDecidedSession){let d=book.lastDecidedSession,n=0;while((d=nextSession(d))&&d<L&&n<400)n++;book.missedSessions+=n}
  const t=targetWeights(strategyId,params,store.bars,L);
  book.lastDecidedSession=L;
  book.lastDecision={session:L,at:new Date(now).toISOString(),ready:t.ready,weights:t.weights,reasons:t.reasons,detail:t.detail};
  if(t.ready){
   const eq=equityAt(book,s=>px[s]?.get(L)?.c);
   const all=new Set([...Object.keys(book.positions),...Object.keys(t.weights)]);let drift=0;
   for(const s of all){const c=px[s]?.get(L)?.c||0;const cw=eq>0?((book.positions[s]?.qty||0)*c)/eq:0;drift=Math.max(drift,Math.abs(cw-(t.weights[s]||0)))}
   if(drift*100>DEFAULTS.driftPct){book.pending={decidedAt:new Date(now).toISOString(),decidedForSession:L,executeAtOpenOf:nextSession(L),targets:t.weights,strategyId,paramsHash:hash};events.push('QUEUED for '+nextSession(L))}
   else events.push('HOLD (drift '+(drift*100).toFixed(2)+'%)');
  }else events.push('NOT_READY');
 }
 if(book.paramsHash!==hash||!book.appliedAt)book.appliedAt=now;
 book.strategyId=strategyId;book.paramsHash=hash;book.params=params;
 book.appliedPolicy=acceptance;
 saveBook(dataDir,book);
 const handoffKey=store.fetchedAt+'|'+hash+'|'+book.slippageBps;
 if(handoffVersions.get(dataDir)!==handoffKey){
   writeLabBars(dataDir,store,{incumbent:{strategyId,params,paramsHash:hash,since:book.appliedAt,source:lab.source},
     executionAssumptions:{known:false,slippageBps:book.slippageBps,feeSchedule:FEES,model:'robinhood-equities-pass-through-v1',adjustment:'splits and dividends',blockers:['Adjusted IEX historical bars are not raw executable venue quotes','Spread, available size and corporate-action cash flows are not observed']}});
   handoffVersions.set(dataDir,handoffKey);if(handoffVersions.size>16)handoffVersions.delete(handoffVersions.keys().next().value);
 }
 return {book,store,events};
}

let baselineCache={key:null,value:null};
function baselines(store,strategyId,params,book){
 const key=store.fetchedAt+'|'+strategyId+'|'+paramsHash(strategyId,params);
 if(baselineCache.key===key)return baselineCache.value;
 if(!store.bars?.SPY?.length){baselineCache={key,value:null};return null}
 const o={startUsd:book.startUsd,slippageBps:book.slippageBps};
 // Start once every sleeve can be computed, so all three lines cover the same window.
 const probe=store.bars.SPY.find(r=>targetWeights(strategyId,params,store.bars,r.d).ready)?.d||null;
 const value=probe?{window:'replay on the fetched history (public daily bars, next-open fills, T+1 ignored)',from:probe,
  strategy:replay(strategyId,params,store.bars,{...o,from:probe}).stats,buyHoldSpy:replay('buy-hold',{},store.bars,{...o,from:probe}).stats,
  cash:{returnPct:0,cagrPct:0,maxDrawdownPct:0,sharpe:null,note:'0% idle cash; whether an Agentic account earns sweep interest is unknown'},
  note:'Verified research expectation: lower drawdown than SPY, not higher return.'}:null;
 baselineCache={key,value};return value;
}

export function robinhoodEquitiesSnapshot({now=Date.now(),env=process.env,dataDir=equitiesDataDir(env)}={}){
 const strategyId=STRATEGIES[env.ROBINHOOD_EQUITIES_STRATEGY]&&!['cash','buy-hold'].includes(env.ROBINHOOD_EQUITIES_STRATEGY)?env.ROBINHOOD_EQUITIES_STRATEGY:DEFAULT_STRATEGY;
 const {params,hash,lab}=equitiesStrategyParams(dataDir,strategyId);const symbols=symbolsFor(strategyId,params);
 const store=readBarStore(dataDir);const book=loadBook(dataDir,{strategyId});
 const m=marketState(now);const L=lastCompletedSession(now);
 const last=book.equityDaily.at(-1)||null;
 const pct=(a,b)=>b>0?Math.round((a/b-1)*10000)/100:null;
 return {
  at:new Date(now).toISOString(),
  readiness:equitiesReadiness(env),
  market:{...m,lastCompletedSession:L,nextSession:L?nextSession(L):null,todayIsSession:isSession(m.date),calendar:{...CALENDAR_SOURCE,validThrough:CALENDAR_END}},
  data:dataStatus(store,symbols,now,env),
  book:{startUsd:book.startUsd,cashUsd:cashUsd(book),settledCashUsd:book.settledCashUsd,unsettled:book.unsettled,positions:book.positions,
   equityUsd:last?.equityUsd??book.startUsd,returnPct:last?pct(last.equityUsd,book.startUsd):0,pending:book.pending,lastFill:book.lastFill||null,
   recentFills:book.history.slice(-12),lastDecidedSession:book.lastDecidedSession,missedSessions:book.missedSessions,equityDaily:book.equityDaily.slice(-260),
   recoveryRequired:!!book.recoveryRequired,recoveryReason:book.recoveryReason||null,
   costs:{commissionUsd:FEES.commissionUsd,slippageBps:book.slippageBps,sellFees:FEES,settlement:'T+1 (cash account; buys use settled cash only)',longOnly:true,margin:false,fractional:'1e-6 shares, $1 minimum'}},
  strategy:{id:strategyId,title:STRATEGIES[strategyId].title,params,paramsHash:hash,lastDecision:book.lastDecision||null,lab},
  benchmark:{live:last?{buyHoldSpyUsd:last.benchUsd,buyHoldSpyReturnPct:pct(last.benchUsd,book.startUsd),cashUsd:last.cashUsd,cashReturnPct:0,since:book.bench?.startSession||null}:null,
   replay:baselines(store,strategyId,params,book)},
  loop:{running:state.running,lastRunAt:state.lastRunAt},
  lastError:state.lastError||store.lastError||null,
 };
}

function autostartDisabled(env=process.env){return String(env.ROBINHOOD_AUTOSTART).toLowerCase()==='false'||String(env.ROBINHOOD_EQUITIES_AUTOSTART).toLowerCase()==='false'}
async function tick(){
 if(state.busy)return;state.busy=true;
 try{await runEquitiesOnce();state.lastError=null}catch(e){state.lastError={at:new Date().toISOString(),message:String(e?.message||e).slice(0,200)}}
 finally{state.lastRunAt=new Date().toISOString();state.busy=false}
}
export function startRobinhoodEquitiesLoop({tickMs=60000}={}){
 if(timer||autostartDisabled())return false;
 state.running=true;timer=setInterval(tick,tickMs);timer.unref?.();setTimeout(tick,5000).unref?.();return true;
}
export function stopRobinhoodEquitiesLoop(){if(timer)clearInterval(timer);timer=null;state.running=false}
