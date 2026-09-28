// Robinhood evolution (§22) and Lab paper trials (§23a) — paper only. Moved verbatim out of robinhoodAutoTrader.js
// (P2.3). The live loop state these policies need arrives as the injected deps object `d`:
//   d.quotes             the loop's live quote map        d.fee()               the account fee ratio
//   d.note(stage,e)      the loop's lastError sink        d.applyPaperParams(o) the paper-param apply
//   d.realAutopilot()    the read-only real autopilot view (never mutated here)
// This module deliberately does not import robinhoodAutoTrader.js: the venue stays acyclic, and the policies stay
// testable on their own because they are pure over the paper journal, the tape and the Lab/evolve files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './robinhoodErrors.js';
import * as J from './robinhoodJournal.js';
import * as S from './robinhoodStrategy.js';
import * as T from './robinhoodTape.js';
import * as E from './robinhoodEvolve.js';
import { ROBINHOOD_BACKTEST_VERSION } from './robinhoodBacktest.js';
import { volGateStats, realisticSpreads } from './robinhoodEvidence.js';
import { championState, championPaperAllowed } from './championState.js';
import { paperRecordFrom } from './fitnessLedger.js';
import { laneMayPropose } from './evidenceFlags.js';
import { appendProjectJournal } from './projectJournal.js';
import { writeFileAtomicSync } from './atomicRename.js';
import { clone, TICK_MS, DATA_DIR, now, safeMessage, fresh, paper, robinhoodLimits, robinhoodPrimary, primaryFirst, primaryWeights, robinhoodSymbols } from './robinhoodPolicy.js';

// The evolve run is not re-entrant and it is the only writer of the two caches below; the loop resets all three
// through resetLabState() (its __testing.reset). The Lab-pass throttle (labPassAt) stays in the loop with its timer.
let evolveBusy=false;
export const evolveBusyNow=()=>evolveBusy;
export function resetLabState(){evolveBusy=false;volGateCache={at:0,key:'',value:null};evidenceCache={at:0,key:'',value:null}}

// ------------------------------------------------------------------ evolution (§22, paper-only)
const LAB_RH_STATUS_FILE=path.join(DATA_DIR,'lab-link','modules','robinhood.json');
export const LAB_RH_CHAMPION_FILE=path.join(DATA_DIR,'lab-link','robinhood-champion.json');
function readLabRobinhoodStatus(){try{const v=JSON.parse(fs.readFileSync(LAB_RH_STATUS_FILE,'utf8'));return v?.module==='robinhood'?v:null}catch{return null}}
function readLabRobinhoodChampion(){try{const v=JSON.parse(fs.readFileSync(LAB_RH_CHAMPION_FILE,'utf8'));return v?.schema==='mpo.lab-module-champion.v1'&&v?.module==='robinhood'?v:null}catch{return null}}
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
function evolveSymbols(p=paper()){return primaryFirst([...new Set([robinhoodPrimary().symbol,...robinhoodSymbols(),...p.autopilot.symbols])])}
function compactCandidate(c){return c?{params:c.params,paramsHash:c.paramsHash,score:Math.round(num(c.score)*1000)/1000,metrics:c.metrics,bySymbol:Object.fromEntries(Object.entries(c.bySymbol||{}).map(([s,r])=>[s,{score:Math.round(num(r.score)*1000)/1000,notes:r.notes,test:r.test,train:r.train}])),at:c.at,generation:c.generation}:null}
// The Evolution Lab owns Robinhood search. While its lane has reported within LAB_RH_FRESH_MS the trader never runs its own
// automatic pass (a manual evolve/run still works); if the Lab goes quiet the local search is the fallback.
const LAB_RH_FRESH_MS=30*60000;
export function labRobinhoodResearchActive(t=now()){const l=readLabRobinhoodStatus();return !!l&&l.status!=='ERROR'&&t-num(l.updatedAt)<LAB_RH_FRESH_MS}
// Vol-gate ratio per evolve symbol over the last 7 days of Robinhood rows. Reads a week of tape, so it is cached.
const VOL_GATE_TTL_MS=10*60000;let volGateCache={at:0,key:'',value:null};
export function robinhoodVolGate(p=paper(),d,{force=false}={}){
 const {fee}=d;
 const key=p.paramsHash+':'+fee();if(!force&&volGateCache.value&&volGateCache.key===key&&now()-volGateCache.at<VOL_GATE_TTL_MS)return volGateCache.value;
 const bySymbol={};for(const s of evolveSymbols(p)){try{bySymbol[s]=volGateStats(T.loadTape(s,now()-7*864e5),{params:p.params,feeRatio:fee(),now:now()})}catch(e){bySymbol[s]={verdict:'ERROR',error:safeMessage(e)}}}
 const ratios=Object.values(bySymbol).map(x=>x.ratio).filter(Number.isFinite);
 const value={at:now(),days:7,bySymbol,maxRatio:ratios.length?Math.max(...ratios):null,binding:ratios.length>0&&ratios.every(r=>r<1)};
 volGateCache={at:now(),key,value};return value;
}
// Quote-source mix of the primary pair over the last 7 days (the evidence gate wants >= 90 % Robinhood rows). Cached like the vol gate.
let evidenceCache={at:0,key:'',value:null};
function robinhoodEvidence7d(){
 const primary=robinhoodPrimary().symbol,key=primary;if(evidenceCache.value&&evidenceCache.key===key&&now()-evidenceCache.at<VOL_GATE_TTL_MS)return evidenceCache.value;
 const rows=T.loadTape(primary,now()-7*864e5),sources={};for(const r of rows){const k=r.src||'unknown';sources[k]=(sources[k]||0)+1}
 const venue=rows.filter(r=>r.src==='robinhood'),total=rows.length;
 const value={symbol:primary,rows:total,sources,venueShare:total?venue.length/total:null,syntheticShare:total?(total-venue.length)/total:null,spanDays:venue.length>1?(venue[venue.length-1].t-venue[0].t)/864e5:0};
 evidenceCache={at:now(),key,value};return value;
}
// Parts for the fitness ledger (src/fitnessLedger.js). Read-only.
export function robinhoodFitnessParts({at=now()}={},d){
 const p=paper(),j=J.loadJournal(),ev=robinhoodEvidence7d(),vg=robinhoodVolGate(p,d),l=E.loadEvolveLedger(),labDoc=readLabRobinhoodChampion(),tr=loadLabTrial();
 const rows=p.history.filter(x=>x.status==='CLOSED'&&x.paramsHash===p.paramsHash&&Number.isFinite(Number(x.pnlUsd))).map(x=>({pnl:Number(x.pnlUsd),closedAt:x.closedAt}));
 const applied=l.applied&&l.applied.paramsHash===p.paramsHash?l.applied:null,trialApplied=tr.active&&tr.active.hash===p.paramsHash?tr.active:null;
 const fullWeek=ev.spanDays>=7&&ev.venueShare!==null&&ev.venueShare>=0.9;
 return {
  running:{hash:p.paramsHash,params:p.params,since:trialApplied?.startedAt??applied?.at??null,source:trialApplied?(trialApplied.by||'lab-auto'):applied?'operator':'BASE'},
  paperRecord:paperRecordFrom(rows,{unit:'USD',startBalance:p.startUsd,now:at}),
  evidence:{executablePrices:(ev.sources.robinhood||0)>0,spanDays:ev.spanDays,closes:rows.length,venueShare:ev.venueShare,syntheticShare:ev.syntheticShare,quoteSources:ev.sources},
  proposal:labDoc?{id:labDoc.candidate?.paramsHash||null,stage:labDoc.qualificationStage||labDoc.stage||null,basis:labDoc.basis||null,proposalVersion:labDoc.proposalVersion??null,publishedAt:labDoc.publishedAt||null,paperPromotionAllowed:championPaperAllowed(labDoc)}:null,
  trial:labTrialView(tr,at),lastDecision:tr.lastDecision||null,
  park:fullWeek&&vg.binding?`vol gate binding on every pair after 7 days of Robinhood quotes (best ratio ${vg.maxRatio})`:null,
  blockers:[...(p.recoveryRequired?['paper book needs recovery']:[]),...(j.recoveryRequired?['journal needs recovery']:[]),...(tr.recoveryRequired?['paper trial authority needs recovery']:[]),...(tr.active&&tr.active.phase!=='RUNNING'?['paper trial '+tr.active.phase]:[])],
 };
}
export function robinhoodEvolveView(p=paper(),d){
 const lab=readLabRobinhoodStatus(),labDoc=readLabRobinhoodChampion();
 if(lab||labDoc){const c=labDoc?.candidate||null,champion=c?compactCandidate({params:c.params,paramsHash:c.paramsHash,score:c.score,metrics:c.metrics,bySymbol:c.bySymbol,at:labDoc.publishedAt,generation:lab?.generation||0}):null,proposed=champion&&champion.paramsHash!==p.paramsHash?champion:null;return {source:'evolution-lab',volGate:robinhoodVolGate(p,d),enabled:true,running:lab?.status==='RUNNING',phase:lab?.phase||lab?.status||'STARTING',generation:lab?.generation||0,champion,proposed,incumbent:lab?.incumbent||null,applied:null,currentParamsHash:p.paramsHash,tapeDays:lab?.tapeDays||{},tapeSources:lab?.tapeSources||{},minTapeDays:lab?.minTapeDays||7,lastRunAt:lab?.lastRunAt||null,nextRunAt:null,intervalMin:5,candidates:null,minGainPct:lab?.gainPct??null,autopromote:false,history:[],events:[],lastError:lab?.lastError?{stage:'lab',message:String(lab.lastError)}:null,tape:T.tapeStatus(),paperPromotionAllowed:championPaperAllowed(labDoc),championState:championState(labDoc).state,note:lab?.note||null,daily:lab?.daily&&typeof lab.daily==='object'?lab.daily:null};}
 const cfg=E.evolveConfig(),l=E.loadEvolveLedger(),tapeDays={},tapeSources={};
 for(const s of evolveSymbols(p)){try{const c=T.tapeCoverage(s,now());tapeDays[s]=Math.round(c.days*100)/100;tapeSources[s]=c.sources}catch{tapeDays[s]=0;tapeSources[s]={}}}
 const champion=compactCandidate(l.champion),proposed=champion&&champion.paramsHash!==p.paramsHash?champion:null;
 return {volGate:robinhoodVolGate(p,d),enabled:cfg.enabled,running:evolveBusy,generation:l.generation,champion,proposed,incumbent:compactCandidate(l.incumbent),applied:l.applied,currentParamsHash:p.paramsHash,tapeDays,tapeSources,minTapeDays:cfg.minTapeDays,lastRunAt:l.lastRunAt,nextRunAt:l.lastRunAt?l.lastRunAt+cfg.intervalMin*60000:null,intervalMin:cfg.intervalMin,candidates:cfg.candidates,minGainPct:Math.round(cfg.minGain*1000)/10,autopromote:cfg.autopromote,history:l.history.slice(0,10),events:l.events.slice(0,10),lastError:l.lastError,tape:T.tapeStatus(),daily:null};
}
export async function runRobinhoodEvolveOnce({manual=false}={},d){
 const {fee,note}=d;
 const cfg=E.evolveConfig();
 if(!cfg.enabled&&!manual)return {ran:false,reason:'disabled'};
 if(evolveBusy)return {ran:false,reason:'busy'};
 const p=paper();if(p.recoveryRequired)return {ran:false,reason:'paperRecovery'};
 evolveBusy=true;
 try{
  T.flushTape({force:true,now:now()});
  const since=now()-cfg.maxTapeDays*864e5,tapes={},tapeDays={},need=Math.max(p.params.warmupSamples,p.params.minSamples)*3;
  const synthetic={};for(const s of evolveSymbols(p)){const adj=realisticSpreads(T.loadTape(s,since),{params:p.params}),rows=adj.rows;synthetic[s]={rowsSynthetic:adj.rowsSynthetic,syntheticShare:adj.syntheticShare};tapeDays[s]=rows.length?Math.round((rows[rows.length-1].t-rows[0].t)/864e5*100)/100:0;if(rows.length>=need)tapes[s]=rows}
  const primary=robinhoodPrimary().symbol;
  if(!tapes[primary]||tapeDays[primary]<cfg.minTapeDays){const l=E.loadEvolveLedger();l.lastError={at:now(),stage:'tape',message:`primary tape ${tapeDays[primary]||0} days < ${cfg.minTapeDays}`};E.saveEvolveLedger(l);return {ran:false,reason:'insufficientTape',tapeDays}}
  const l0=E.loadEvolveLedger(),generation=l0.generation+1,split=E.holdoutSplit(tapes,cfg.holdoutFrac),orderUsd=Math.min(p.autopilot.orderUsd,robinhoodLimits().maxOrderUsd);
  const r=await E.searchGeneration({tapes:split.search,incumbentParams:p.params,feeRatio:fee(),orderUsd:Math.min(p.autopilot.orderUsd,robinhoodLimits().maxOrderUsd),startUsd:p.startUsd,weights:primaryWeights(),cfg,generation,now:now()});
  // Only the generation's best is replayed on the sealed holdout; a failed or reused look proposes nothing.
  const gate=r.beats?E.holdoutGate(r.best.params,split.holdout,{feeRatio:fee(),orderUsd,startUsd:p.startUsd,cfg,lookedThrough:l0.holdoutLookedThrough,context:split.context}):null,beats=!!gate?.pass;
  const l=E.loadEvolveLedger();l.generation=generation;l.lastRunAt=now();l.lastError=null;if(gate&&!gate.reasons.includes('holdoutReused'))l.holdoutLookedThrough=gate.through;
  const holdout=gate&&{pass:gate.pass,reasons:gate.reasons,closes:gate.closes,profitFactor:gate.profitFactor,pnlUsd:gate.pnlUsd,robinhoodShare:gate.robinhoodShare};
  l.incumbent={params:r.incumbent.params,paramsHash:r.incumbent.paramsHash,score:r.incumbent.score,metrics:r.incumbent.metrics,bySymbol:r.incumbent.bySymbol,at:now(),generation};
  let promoted=false,proposed=false;
  if(beats){
   const already=l.champion&&l.champion.paramsHash===r.best.paramsHash;
   if(!already||r.best.score>l.champion.score){l.champion={params:r.best.params,paramsHash:r.best.paramsHash,score:r.best.score,metrics:{...r.best.metrics,holdout},bySymbol:r.best.bySymbol,at:now(),generation,basis:{incumbentHash:p.paramsHash},evidence:{evaluatorVersion:ROBINHOOD_BACKTEST_VERSION,datasetHash:createHash('sha256').update(JSON.stringify(tapes)).digest('hex'),beatsIncumbent:r.beats,holdout:gate}};E.ledgerEvent(l,'champion',`G${generation}: ${r.best.paramsHash} scored ${r.best.score.toFixed(3)} vs incumbent ${r.incumbent.score.toFixed(3)} (+${r.gainPct}%)`,{paramsHash:r.best.paramsHash,gainPct:r.gainPct})}
   proposed=true;
  }
  l.history=[{generation,at:now(),elapsedMs:r.elapsedMs,timedOut:r.timedOut,evaluated:r.evaluated.length,symbols:Object.keys(tapes),tapeDays,synthetic,incumbentHash:r.incumbent.paramsHash,incumbentScore:Math.round(r.incumbent.score*1000)/1000,bestHash:r.best?.paramsHash||null,bestScore:r.best?Math.round(r.best.score*1000)/1000:null,gainPct:r.gainPct,beats,searchBeats:r.beats,holdout,promoted:false},...l.history].slice(0,E.__testing.HISTORY_CAP);
  E.saveEvolveLedger(l);
  if(beats&&cfg.autopromote&&l.champion.paramsHash!==p.paramsHash){
   try{applyRobinhoodEvolution({paramsHash:l.champion.paramsHash,by:'autopromote'},d);promoted=true;const l2=E.loadEvolveLedger();if(l2.history[0])l2.history[0].promoted=true;E.saveEvolveLedger(l2)}
   catch(e){const l2=E.loadEvolveLedger();l2.lastError={at:now(),stage:'autopromote',code:e.code||'unknown',message:safeMessage(e)};E.saveEvolveLedger(l2)}
  }
  return {ran:true,generation,evaluated:r.evaluated.length,timedOut:r.timedOut,elapsedMs:r.elapsedMs,incumbentScore:r.incumbent.score,bestScore:r.best?.score??null,bestHash:r.best?.paramsHash||null,gainPct:r.gainPct,beats,searchBeats:r.beats,holdout,proposed:proposed&&!promoted,promoted,tapeDays};
 }catch(e){note('evolve',e);try{const l=E.loadEvolveLedger();l.lastError={at:now(),stage:'search',code:e.code||'unknown',message:safeMessage(e)};E.saveEvolveLedger(l)}catch{}return {ran:false,reason:e.code||'unknown',error:safeMessage(e)}}
 finally{evolveBusy=false}
}
// Apply the ledger champion to the PAPER params only. Real autopilot is never touched here except through the
// paramsChanged disable inside setRobinhoodPaperAutopilot. Qualification resets because the paramsHash changes.
export function applyRobinhoodEvolution({paramsHash,by='operator'}={},d){
 const {realAutopilot:robinhoodAutopilot}=d;
 const hash=String(paramsHash||'').trim(),labDoc=readLabRobinhoodChampion(),labCandidate=labDoc?.candidate;
 let doc=labCandidate?.paramsHash===hash?labDoc:null;
 if(!doc){const c=E.loadEvolveLedger().champion;if(!c)fail('notFound','No evolution champion has been proposed yet');if(!hash||c.paramsHash!==hash)fail('validation',`paramsHash must match the proposed champion ${c.paramsHash}`);
  doc={candidate:c,basis:c.basis,evidence:c.evidence,publishedAt:c.at,qualificationStage:'PAPER_REVIEW',stateSchema:'mpo.champion-state.v1',state:'PAPER',paperPromotionAllowed:true,liveExecution:'manual',liveActivationAllowed:false,automaticLivePromotionAllowed:false};}
 if(!E.withinEvolveBounds(doc.candidate.params))fail('validation','Champion parameters fall outside the evolution bounds');
 const p=paper(),t=loadLabTrial();if(p.recoveryRequired||t.recoveryRequired)fail('stateRecovery','Paper trial state needs recovery');
 if(hash===p.paramsHash)return {ok:true,applied:false,paramsHash:hash,autopilot:clone(p.autopilot),realAutopilot:robinhoodAutopilot()};
 const result=startPaperTrial(doc,p,t,now(),by==='autopromote'?'autopromote':'operator',d);if(!result.ran)fail('notQualified',result.reason);
 return {ok:true,applied:true,paramsHash:hash,autopilot:{...clone(paper().autopilot),paramsHash:hash},realAutopilot:robinhoodAutopilot(),source:doc===labDoc?'evolution-lab':'local-evolution',trial:labTrialView(loadLabTrial())};
}
// ------------------------------------------------------------------ Lab paper trials (docs/FITNESS-LEDGER.md)
// With ROBINHOOD_LAB_AUTO_APPLY_PAPER=true (default false) a cleared Lab proposal is applied to the PAPER params
// only, as a trial against the incumbent. After TRIAL_CLOSES new closes it is kept only if its profit factor is
// >= the incumbent's and its drawdown stays within TRIAL_MAX_DD_PCT of the paper start; otherwise, or with no
// close in TRIAL_IDLE_DAYS, the incumbent params come back and the hash is never applied again. Paper only.
export const TRIAL_CLOSES=20, TRIAL_MAX_DD_PCT=3, TRIAL_IDLE_DAYS=14, LAB_PASS_MS=5*60000;
export const LAB_TRIAL_FILE=path.join(DATA_DIR,'robinhood-lab-trial.json'), LAB_TRIAL_SCHEMA='mpo.robinhood-lab-trial.v1', PROJECT_JOURNAL_FILE=path.join(DATA_DIR,'project-journal.ndjson');
export const labAutoApplyEnabled=()=>String(process.env.ROBINHOOD_LAB_AUTO_APPLY_PAPER||'').toLowerCase()==='true';
export function loadLabTrial(){
 const empty={active:null,rejected:[],lastDecision:null,lastCheck:null,history:[]};
 try{if(fs.statSync(LAB_TRIAL_FILE).size>256*1024)return {...empty,recoveryRequired:true};const v=JSON.parse(fs.readFileSync(LAB_TRIAL_FILE,'utf8'));
   const a=v?.active,hash=x=>typeof x==='string'&&/^[a-f0-9]{12}$/.test(x);
   if(v?.schema!==LAB_TRIAL_SCHEMA||!Array.isArray(v.rejected)||!v.rejected.every(hash)||!Array.isArray(v.history)||a!==null&&(!a||typeof a!=='object'||Array.isArray(a))||a&&(!hash(a.hash)||!hash(a.incumbentHash)||!E.withinEvolveBounds(a.incumbentParams)||S.paramsHash(S.normalizeParams({...a.incumbentParams,sampleMs:TICK_MS}))!==a.incumbentHash||!Number.isFinite(a.startedAt)||a.startedAt<=0||a.startedAt>now()||!Number.isFinite(a.startEquityUsd)||a.startEquityUsd<=0||!['PREPARING','RUNNING','ROLLBACK_PENDING'].includes(a.phase)||!(a.incumbent?.closes>=20)||!(a.incumbent.profitFactorUnbounded===true||Number.isFinite(a.incumbent.profitFactor)&&a.incumbent.profitFactor>=0)))return {...empty,recoveryRequired:true};
   return {...empty,...v,rejected:v.rejected.slice(-200),history:v.history.slice(0,50)};
 }catch(e){return {...empty,recoveryRequired:e.code!=='ENOENT'}}
}
function saveLabTrial(t){writeFileAtomicSync(LAB_TRIAL_FILE,JSON.stringify({schema:LAB_TRIAL_SCHEMA,...t},null,1))}
function trialCloses(p,hash,since,at=now()){const seen=new Set();return p.history.filter(x=>{const id=x.positionId||x.id||`${x.symbol}:${x.closedAt}:${x.paramsHash}`;if(seen.has(id)||x.status!=='CLOSED'||x.paramsHash!==hash||!Number.isFinite(x.pnlUsd)||!Number.isFinite(x.closedAt)||x.closedAt<since||x.closedAt>at)return false;seen.add(id);return true}).map(x=>({pnl:x.pnlUsd,closedAt:x.closedAt}))}
export function labTrialRisk(p,t,at,d){
 const {quotes,fee}=d;
 if(t.recoveryRequired)return {blocked:true,reason:'labTrialRecovery'};
 if(!t.active)return {blocked:false};
 if(t.active.phase!=='RUNNING')return {blocked:true,reason:'trialRecovery'};
 const a=t.active,held=p.positions.filter(x=>x.paramsHash===a.hash);
 if(held.some(x=>!fresh(quotes.get(x.symbol))))return {blocked:true,reason:'trialStaleMark'};
 const realized=trialCloses(p,a.hash,a.startedAt,at).reduce((s,r)=>s+r.pnl,0),unrealized=held.reduce((s,x)=>s+S.markToMarket(x,quotes.get(x.symbol).bid,fee()),0);
 const base=a.startEquityUsd||p.startUsd,lossPct=base>0?-100*(realized+unrealized)/base:Infinity;
 return {blocked:lossPct>=TRIAL_MAX_DD_PCT,reason:'trialLossBudget',lossPct,pnl:realized+unrealized};
}
function labTrialView(t,at=now()){const a=t.active;if(!a)return t.lastDecision&&['kept','reverted'].includes(t.lastDecision.action)?{status:t.lastDecision.action==='kept'?'KEPT':'REVERTED',hash:t.lastDecision.hash,incumbentHash:t.lastDecision.incumbentHash||null,startedAt:t.lastDecision.startedAt||null,endedAt:t.lastDecision.at,closes:t.lastDecision.closes??null,needed:TRIAL_CLOSES,incumbent:t.lastDecision.incumbent||null,candidate:t.lastDecision.candidate||null}:null;
 const p=paper(),rec=paperRecordFrom(trialCloses(p,a.hash,a.startedAt,at),{unit:'USD',startBalance:a.startEquityUsd,now:at});
 return {status:a.phase,hash:a.hash,incumbentHash:a.incumbentHash,startedAt:a.startedAt,endedAt:null,closes:rec.closes,needed:TRIAL_CLOSES,incumbent:a.incumbent,candidate:{profitFactor:rec.profitFactor,profitFactorUnbounded:rec.profitFactorUnbounded,closes:rec.closes,maxDrawdownPct:rec.maxDrawdownPct}};}
function labTrialJournal(title,detail,at){try{appendProjectJournal(PROJECT_JOURNAL_FILE,{kind:'paper-trial',category:'research',module:'robinhood',title,detail,at})}catch{}}
function decide(t,decision){t.lastDecision=decision;t.history.unshift(decision);t.history=t.history.slice(0,50)}
// Manual and scheduled promotion share admission and the same persisted rollback authority.
function proposalRefusal(doc,p,t,at){
 const c=doc?.candidate,e=doc?.evidence,h=e?.holdout;
 if(p.recoveryRequired||t.recoveryRequired)return 'paper trial state needs recovery';
 if(t.active)return 'a paper trial is already active';
 if(!doc||!c)return 'no proposal';
 if(doc.liveExecution!=='manual'||doc.liveActivationAllowed!==false||doc.automaticLivePromotionAllowed!==false)return 'proposal safety contract mismatch';
 if(!Number.isFinite(doc.publishedAt)||doc.publishedAt>at||at-doc.publishedAt>7*864e5)return 'proposal stale or future dated';
 if(doc.qualificationStage!=='PAPER_REVIEW'||!championPaperAllowed(doc))return `proposal is ${doc.qualificationStage||championState(doc).state}, not cleared for paper`;
 if(e?.evaluatorVersion!==ROBINHOOD_BACKTEST_VERSION||!(/^[a-f0-9]{64}$/i.test(e?.datasetHash||'')))return 'proposal evaluator or dataset fingerprint is incompatible';
 const pf=h?.profitFactor==='infinity'?Infinity:h?.profitFactor;
 if(e.beatsIncumbent!==true||h?.pass!==true||!(h.closes>=20)||!(pf>=1.2)||!(h.pnlUsd>0)||!(h.robinhoodShare>=.9)||!Number.isFinite(h.through)||h.through>at||at-h.through>7*864e5)return 'proposal holdout evidence is incomplete or stale';
 if(c.paramsHash===p.paramsHash)return 'proposal is already running';
 if(t.rejected.includes(c.paramsHash))return 'proposal was reverted before';
 if(doc.basis?.incumbentHash!==p.paramsHash)return `proposal basis ${doc.basis?.incumbentHash||'missing'} is not the running params ${p.paramsHash}`;
 if(!E.withinEvolveBounds(c.params))return 'proposal params fall outside the evolution bounds';
 if(S.paramsHash(S.normalizeParams({...p.params,...c.params,sampleMs:TICK_MS}))!==c.paramsHash)return 'proposal params hash does not match the executable policy';
 if(p.positions.length)return 'paper portfolio must be flat before a trial starts';
 if(!Number.isFinite(p.cashUsd)||p.cashUsd<=0)return 'paper trial needs positive known cash equity';
 const ev=robinhoodEvidence7d(),incRows=trialCloses(p,p.paramsHash,0,at),may=laneMayPropose({executablePrices:(ev.sources.robinhood||0)>0,spanDays:ev.spanDays,closes:incRows.length,venueShare:ev.venueShare,syntheticShare:ev.syntheticShare});
 if(!may.ok)return `evidence: ${may.blockers.join('; ')}`;
 return null;
}
function startPaperTrial(doc,p,t,at,by='lab-auto',d){
 const reason=proposalRefusal(doc,p,t,at);if(reason)return {ran:false,reason};
 const c=doc.candidate,inc=paperRecordFrom(trialCloses(p,p.paramsHash,0,at),{unit:'USD',startBalance:p.startUsd,now:at}),incumbentParams=clone(p.params),incumbentHash=p.paramsHash;
 t.active={hash:c.paramsHash,incumbentHash,incumbentParams,incumbent:{profitFactor:inc.profitFactor,profitFactorUnbounded:inc.profitFactorUnbounded,closes:inc.closes,maxDrawdownPct:inc.maxDrawdownPct},startedAt:at,startEquityUsd:p.cashUsd,phase:'PREPARING',by,proposalVersion:doc.proposalVersion??null,proposalId:c.id||c.paramsHash,evaluatorVersion:doc.evidence.evaluatorVersion,datasetHash:doc.evidence.datasetHash};
 saveLabTrial(t);
 try{const applied=d.applyPaperParams({params:c.params});if(applied.paramsHash!==c.paramsHash||paper().paramsHash!==c.paramsHash)throw Error('Applied policy hash does not match proposal');}
 catch(e){t.active.applyError=safeMessage(e);saveLabTrial(t);return {ran:false,reason:'trial preparation needs recovery: '+safeMessage(e)}}
 t.active.phase='RUNNING';decide(t,{action:'applied',reason:`Proposal applied to paper as a ${TRIAL_CLOSES}-close trial`,hash:c.paramsHash,incumbentHash,startedAt:at,at,by});t.lastCheck=null;saveLabTrial(t);
 const l=E.loadEvolveLedger();l.applied={paramsHash:c.paramsHash,at,by};E.ledgerEvent(l,'applied',`${by} applied ${c.paramsHash} to paper as a trial against ${incumbentHash}`,{paramsHash:c.paramsHash,by});E.saveEvolveLedger(l);
 labTrialJournal(`Robinhood Lab trial ${c.paramsHash} started`,`Paper only. Requires ${TRIAL_CLOSES} new closes; ${TRIAL_MAX_DD_PCT}% marked loss budget.`,at);
 return {ran:true,decision:'applied',hash:c.paramsHash};
}
// One pass: settle a running trial, or apply a cleared proposal when auto-apply is on. Never throws on refusal.
export function labProposalPass({at=now()}={},d){
 const {note}=d;
 const t=loadLabTrial(),p=paper();
 if(p.recoveryRequired)return {ran:false,reason:'paperRecovery'};
 if(t.recoveryRequired)return {ran:false,reason:'labTrialRecovery'};
 if(t.active){
  const a=t.active;
  if(a.phase==='PREPARING'&&p.paramsHash===a.hash){a.phase='RUNNING';saveLabTrial(t)}
  if(a.phase==='PREPARING'&&p.paramsHash!==a.incumbentHash)return {ran:false,reason:'trial preparation hash needs recovery'};
  if(a.phase!=='ROLLBACK_PENDING'&&p.paramsHash!==a.hash){decide(t,{action:'abandoned',reason:a.phase==='PREPARING'?'paper trial preparation did not commit':'paper params changed during the trial',hash:a.hash,incumbentHash:a.incumbentHash,startedAt:a.startedAt,at,by:'operator'});t.active=null;saveLabTrial(t);labTrialJournal(`Robinhood Lab trial ${a.hash} abandoned`,'The proposed paper policy is not running.',at);return {ran:true,decision:'abandoned'}}
  const rows=trialCloses(p,a.hash,a.startedAt,at),rec=paperRecordFrom(rows,{unit:'USD',startBalance:a.startEquityUsd,now:at}),lastAt=rows.length?Math.max(...rows.map(r=>num(r.closedAt))):a.startedAt;
  let verdict=null,reason='';
  const trialRisk=labTrialRisk(p,t,at,d);
  if(a.phase==='ROLLBACK_PENDING'){verdict='reverted';reason=a.rollbackReason||'resuming interrupted rollback'}
  else if(trialRisk.reason==='trialLossBudget'&&trialRisk.blocked){verdict='reverted';reason=`marked trial loss ${trialRisk.lossPct.toFixed(2)}% reached ${TRIAL_MAX_DD_PCT}% budget`;}
  else if(rec.closes>=TRIAL_CLOSES&&!p.positions.length){
   const incPf=a.incumbent?.profitFactorUnbounded?Infinity:a.incumbent?.profitFactor,candPf=rec.profitFactorUnbounded?Infinity:rec.profitFactor,dd=rec.maxDrawdownPct;
   const pfOk=candPf!==null&&(incPf===null||incPf===undefined||candPf>=incPf),ddOk=dd!==null&&dd<=TRIAL_MAX_DD_PCT;
   verdict=pfOk&&ddOk&&candPf>1&&rec.netPnl>0&&!trialRisk.blocked?'kept':'reverted';reason=`${rec.closes} closes: PF ${rec.profitFactorUnbounded?'inf':rec.profitFactor} vs incumbent ${a.incumbent?.profitFactorUnbounded?'inf':a.incumbent?.profitFactor??'n/a'}, net ${rec.netPnl}, drawdown ${dd}% (max ${TRIAL_MAX_DD_PCT}%)`;
  }else if(at-lastAt>=TRIAL_IDLE_DAYS*864e5){verdict='reverted';reason=`no close in ${TRIAL_IDLE_DAYS} days (${rec.closes}/${TRIAL_CLOSES})`}
  if(!verdict)return {ran:true,decision:'running',closes:rec.closes};
  if(verdict==='reverted'){
   a.phase='ROLLBACK_PENDING';a.rollbackReason=reason;saveLabTrial(t);
   try{const back=d.applyPaperParams({params:a.incumbentParams});if(back.paramsHash!==a.incumbentHash||paper().paramsHash!==a.incumbentHash)throw Error(`revert produced ${back.paramsHash}, expected ${a.incumbentHash}`);}
   catch(e){a.rollbackError=safeMessage(e);saveLabTrial(t);note('lab-trial',e);return {ran:false,reason:'trialRollbackRecovery'}}
   t.rejected=[...new Set([...t.rejected,a.hash])].slice(-200);
  }
  const l=E.loadEvolveLedger();E.ledgerEvent(l,verdict==='kept'?'trial-kept':'trial-reverted',`lab-auto trial ${a.hash}: ${reason}`,{paramsHash:a.hash,incumbentHash:a.incumbentHash});if(verdict==='reverted')l.applied={paramsHash:a.incumbentHash,at,by:'lab-auto-revert'};E.saveEvolveLedger(l);
  decide(t,{action:verdict,reason,hash:a.hash,incumbentHash:a.incumbentHash,startedAt:a.startedAt,at,by:'lab-auto',closes:rec.closes,incumbent:a.incumbent,candidate:{profitFactor:rec.profitFactor,profitFactorUnbounded:rec.profitFactorUnbounded,closes:rec.closes,maxDrawdownPct:rec.maxDrawdownPct}});
  t.active=null;saveLabTrial(t);
  labTrialJournal(`Robinhood Lab trial ${a.hash} ${verdict}`,reason,at);
  return {ran:true,decision:verdict,reason};
 }
 if(!labAutoApplyEnabled())return {ran:false,reason:'autoApplyOff'};
 const doc=readLabRobinhoodChampion(),c=doc?.candidate;
 const refuse=reason=>{const sig=`${c?.paramsHash||'none'}:${reason}`;if(t.lastCheck?.sig!==sig){t.lastCheck={sig,at,reason,hash:c?.paramsHash||null};saveLabTrial(t)}return {ran:false,reason}};
 const result=startPaperTrial(doc,p,t,at,'lab-auto',d);return result.ran?result:refuse(result.reason);
}
