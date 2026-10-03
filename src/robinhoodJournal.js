// Robinhood Auto Trader — journal + paper store (docs/ROBINHOOD-AUTO-TRADER.md §5, §6, §9, §10, §20 B).
// Two files, deliberately: data/robinhood-auto-trader.json (real exposure, read by the release gate; fail-closed)
// and data/robinhood-paper.json (paper book, price tape, qualification; corruption revokes qualification only).
// Imports only src/robinhoodErrors.js. No network. sessionArmed is never written to either file.
import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry, writeFileSynced } from './atomicRename.js';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fail} from './robinhoodErrors.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'));
export const JOURNAL_FILE=path.join(DATA_DIR,'robinhood-auto-trader.json');
export const PAPER_FILE=path.join(DATA_DIR,'robinhood-paper.json');
export const EXPLORE_FILE=path.join(DATA_DIR,'robinhood-paper-explore.json');

export const OPEN_STATUSES=['PENDING_SUBMIT','SUBMITTED','SUBMITTED_UNCERTAIN','OPEN','CLOSING','CLOSING_UNCERTAIN'];
export const TERMINAL_STATUSES=['CLOSED','CANCELLED','REJECTED','FAILED','FORGOTTEN'];
const TRANSITIONS={
 PENDING_SUBMIT:['SUBMITTED','SUBMITTED_UNCERTAIN','REJECTED','FAILED'],
 SUBMITTED:['OPEN','CANCELLED','FAILED','SUBMITTED'],
 SUBMITTED_UNCERTAIN:['OPEN','CANCELLED','FAILED','SUBMITTED'],
 OPEN:['CLOSING'],
 CLOSING:['CLOSING_UNCERTAIN','OPEN','CLOSED'],
 CLOSING_UNCERTAIN:['CLOSED','OPEN','CLOSING'],
};
const HISTORY_CAP=200, PAPER_HISTORY_CAP=500, TAPE_CAP=720, TAPE_FLUSH_MS=30000, STALE_MS=72*3600e3;
// Six coins (the autopilot's cap). BTC/ETH alone almost never clear the ~2% round trip (audit 2026-10-03).
const DEFAULT_SYMBOLS=['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','AVAX-USD','XRP-USD'];
const SYMBOL_RE=/^[A-Z0-9]{2,10}-USD$/;

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const numOrNull=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};
const r2=v=>Math.round(num(v)*100)/100;
const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const envNum=(k,d)=>{const v=Number(process.env[k]);return Number.isFinite(v)&&v>0?v:d};
const rand4=()=>Math.random().toString(36).slice(2,6).padEnd(4,'0');
const symbols=(v,d)=>{const a=Array.isArray(v)?v.map(s=>String(s||'').toUpperCase().trim()).filter(s=>SYMBOL_RE.test(s)):null;return a&&a.length?[...new Set(a)].slice(0,6):d.slice()};
const list=(v)=>Array.isArray(v)?v.filter(isObj):[];
const objMap=(v)=>{const o={};if(isObj(v))for(const [k,x] of Object.entries(v)){const n=num(x);if(n>0)o[k]=n}return o};

// ---------------------------------------------------------------- real journal
const REAL_DEFAULT_SYMBOLS=['BTC-USD','ETH-USD'];
export function defaultRealAutopilot(){return {enabled:false,orderUsd:10,maxOpen:2,dailyLossCapUsd:25,symbols:REAL_DEFAULT_SYMBOLS.slice(),orderType:'market',
 lastRunAt:0,lastAction:null,skipped:[],disabledReason:null,disabledAt:0,enabledAt:0,paramsHash:null}}
function defaultStats(){return {placed:0,closed:0,won:0,lost:0,pnlUsd:0,feesUsd:0,hitRate:null,profitFactor:null,unverified:0}}
export function defaultJournal(){return {version:1,mode:'LIVE',pnlMode:'LIVE',open:[],history:[],stats:defaultStats(),autopilot:defaultRealAutopilot(),cooldowns:{},
 account:{accountNumber:null,feeRatio:null,buyingPowerUsd:null,apiVersion:null,at:0},lastReconcileAt:0,lastError:null}}
function normalizeRealAutopilot(a){
 const d=defaultRealAutopilot(),s=isObj(a)?a:{};
 return {enabled:s.enabled===true,orderUsd:num(s.orderUsd)>0?num(s.orderUsd):d.orderUsd,maxOpen:num(s.maxOpen)>0?Math.floor(num(s.maxOpen)):d.maxOpen,
  dailyLossCapUsd:num(s.dailyLossCapUsd)>0?num(s.dailyLossCapUsd):d.dailyLossCapUsd,symbols:symbols(s.symbols,d.symbols),
  orderType:s.orderType==='limit'?'limit':'market',lastRunAt:num(s.lastRunAt),lastAction:s.lastAction??null,
  skipped:Array.isArray(s.skipped)?s.skipped.slice(-8):[],disabledReason:s.disabledReason??null,disabledAt:num(s.disabledAt),enabledAt:num(s.enabledAt),
  paramsHash:typeof s.paramsHash==='string'?s.paramsHash:null};
}
export function normalizeJournal(s={}){
 const src=isObj(s)?s:{};
 const out={...defaultJournal(),...src};
 delete out.sessionArmed;
 out.version=1;
 out.open=list(src.open).filter(e=>OPEN_STATUSES.includes(e.status));
 out.history=list(src.history).slice(0,HISTORY_CAP);
 out.stats={...defaultStats(),...(isObj(src.stats)?src.stats:{})};
 out.autopilot=normalizeRealAutopilot(src.autopilot);
 out.cooldowns=objMap(src.cooldowns);
 out.account={...defaultJournal().account,...(isObj(src.account)?src.account:{})};
 out.lastReconcileAt=num(src.lastReconcileAt);
 out.lastError=isObj(src.lastError)?src.lastError:null;
 if(src.recoveryRequired===true){out.recoveryRequired=true;out.recoveryError=String(src.recoveryError||'STATE RECOVERY REQUIRED');out.autopilot.enabled=false}
 else{delete out.recoveryRequired;delete out.recoveryError}
 return out;
}
let journalCache=null;
export function loadJournal(){
 if(journalCache)return journalCache;
 try{const raw=JSON.parse(fs.readFileSync(JOURNAL_FILE,'utf8'));
  if(!isObj(raw)||raw.version!==1||!Array.isArray(raw.open)||!Array.isArray(raw.history)||raw.open.some(e=>!isObj(e)||!OPEN_STATUSES.includes(e.status)||!e.id||!e.clientOrderId))throw new Error('Invalid real journal schema or unknown exposure');
  journalCache=normalizeJournal(raw)}
 catch(e){
  if(e?.code==='ENOENT')journalCache=defaultJournal();
  else journalCache=normalizeJournal({...defaultJournal(),recoveryRequired:true,recoveryError:`STATE RECOVERY REQUIRED: ${e?.message||e}`,autopilot:{...defaultRealAutopilot(),enabled:false}});
 }
 return journalCache;
}
function atomicWrite(file,name,data){
 const dir=path.dirname(file);
 fs.mkdirSync(dir,{recursive:true});
 const tmp=path.join(dir,`.${name}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}.tmp`);
 try{writeFileSynced(tmp,JSON.stringify(data,null,2));renameSyncWithRetry(tmp,file)}
 catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
}
export function saveJournal(s){
 journalCache=normalizeJournal(s);
 atomicWrite(JOURNAL_FILE,'robinhood-auto-trader',journalCache);
 return journalCache;
}

export function newEntryId(){return `rh-${Date.now().toString(36)}${rand4()}`}
export function newPaperId(){return `rp-${Date.now().toString(36)}${rand4()}`}

export function makeRealEntry({symbol,side='buy',requestedQty,requestedUsd,refAsk,refBid,refAt,orderType='market',limitPrice=null,timeInForce='gtc',previewFeeUsd=0,placedBy='manual',stopPct,takePct,trailArmPct,trailPct,paramsHash=null}={}){
 const now=Date.now();
 return {id:newEntryId(),kind:'real',symbol:String(symbol||'').toUpperCase(),side:side==='sell'?'sell':'buy',
  status:'PENDING_SUBMIT',placedBy:placedBy==='autopilot'?'autopilot':'manual',
  clientOrderId:randomUUID(),orderId:null,
  orderType:orderType==='limit'?'limit':'market',limitPrice:numOrNull(limitPrice),timeInForce:timeInForce||'gtc',
  requestedQty:num(requestedQty),requestedUsd:num(requestedUsd),refAsk:numOrNull(refAsk),refBid:numOrNull(refBid),refAt:num(refAt)||now,previewFeeUsd:num(previewFeeUsd),
  fillVerified:false,filledQty:0,avgPrice:null,feeUsd:0,costUsd:null,
  exit:null,
  stopPct:numOrNull(stopPct),takePct:numOrNull(takePct),trailArmPct:numOrNull(trailArmPct),trailPct:numOrNull(trailPct),peakBid:null,trailStop:null,
  markBid:null,unrealizedUsd:null,pnlUsd:null,
  submittedAt:null,openedAt:null,closedAt:null,at:now,
  reconcile:{attempts:0,successfulListings:0,firstListingAt:0,lastAt:0},
  paramsHash:typeof paramsHash==='string'?paramsHash:null,
  notes:[]};
}

// Enforces the status graph. Terminal statuses move the row open[] -> history[] (unshift, cap 200); open+history count is preserved.
export function transition(j,entryId,nextStatus,patch={}){
 const idx=j.open.findIndex(e=>e&&e.id===entryId);
 if(idx<0)fail('notFound',`Robinhood entry ${entryId} is not open`);
 const entry=j.open[idx];
 const from=entry.status;
 const allowed=(TRANSITIONS[from]||[]).includes(nextStatus)||(nextStatus==='FORGOTTEN'&&OPEN_STATUSES.includes(from));
 if(!allowed)fail('unknown',`Illegal Robinhood entry transition ${from} -> ${nextStatus}`);
 const next={...entry,...(isObj(patch)?patch:{}),status:nextStatus};
 if(nextStatus==='CLOSED'&&!(next.fillVerified===true&&num(next.exit?.filledQty)>0))fail('unknown','CLOSED requires a verified fill and a filled exit');
 if(TERMINAL_STATUSES.includes(nextStatus)){
  if(!num(next.closedAt))next.closedAt=Date.now();
  if(nextStatus==='FORGOTTEN')next.pnlUsd=null;
  j.open.splice(idx,1);
  j.history.unshift(next);
  if(j.history.length>HISTORY_CAP)j.history.length=HISTORY_CAP;
 }else j.open[idx]=next;
 return next;
}

const verifiedClose=x=>x&&x.status==='CLOSED'&&x.fillVerified===true&&num(x.exit?.filledQty)>0;
export function recomputeStats(j){
 const closes=j.history.filter(verifiedClose);
 const won=closes.filter(x=>num(x.pnlUsd)>0).length;
 const grossWin=closes.reduce((a,x)=>a+Math.max(0,num(x.pnlUsd)),0);
 const grossLoss=closes.reduce((a,x)=>a+Math.max(0,-num(x.pnlUsd)),0);
 const unverified=j.open.filter(x=>x&&(x.fillVerified!==true||/UNCERTAIN/.test(x.status))).length;
 j.stats={placed:Math.max(num(j.stats?.placed),j.open.length+j.history.length),closed:closes.length,won,lost:closes.length-won,
  pnlUsd:r2(closes.reduce((a,x)=>a+num(x.pnlUsd),0)),feesUsd:r2(closes.reduce((a,x)=>a+num(x.feeUsd)+num(x.exit?.feeUsd),0)),
  hitRate:closes.length?won/closes.length:null,profitFactor:!closes.length?null:grossLoss>0?grossWin/grossLoss:grossWin>0?Infinity:null,unverified};
 return j;
}
export function startOfDay(now=Date.now()){const d=new Date(now);d.setHours(0,0,0,0);return d.getTime()}
export function realizedTodayUsd(j=loadJournal(),now=Date.now()){
 const from=startOfDay(now);
 return r2(j.history.filter(x=>x&&num(x.closedAt)>=from&&num(x.closedAt)<=now).reduce((a,x)=>a+num(x.pnlUsd),0));
}
export function setCooldown(j,symbol,untilMs){if(!isObj(j.cooldowns))j.cooldowns={};j.cooldowns[String(symbol).toUpperCase()]=num(untilMs)}
export function inCooldown(j,symbol,now=Date.now()){return num(j.cooldowns?.[String(symbol).toUpperCase()])>now}

// ---------------------------------------------------------------- paper store
export function defaultPaperAutopilot(){return {enabled:false,orderUsd:5,maxOpen:3,symbols:DEFAULT_SYMBOLS.slice(),lastRunAt:0,lastAction:null,skipped:[]}}
function defaultPaperStats(){return {closes:0,won:0,lost:0,pnlUsd:0,grossWinUsd:0,grossLossUsd:0,feesUsd:0,hitRate:null,profitFactor:null,maxDrawdownUsd:0}}
function defaultQualification(paramsHash=null,windowDays=qualificationThresholds().windowDays){return {qualified:false,paramsHash,closes:0,hitRate:null,profitFactor:null,pnlUsd:0,grossPnlUsd:0,feesUsd:0,feeDragPct:null,maxDrawdownUsd:0,requiredHitRate:null,lastCloseAt:null,windowDays,reasons:[`closes 0 < ${qualificationThresholds().minCloses}`],at:0}}
export function defaultPaper(){
 // Paper wallets start at $25 (bing, 2026-10-03), with $5 orders.
 const start=envNum('ROBINHOOD_PAPER_START_USD',25);
 return {version:1,mode:'PAPER',pnlMode:'PAPER',createdAt:Date.now(),cashUsd:start,startUsd:start,feeRatio:envNum('ROBINHOOD_FEE_RATIO_FALLBACK',0.0095),
  positions:[],history:[],autopilot:defaultPaperAutopilot(),params:{},paramsHash:null,cooldowns:{},tape:{},tapeAt:0,
  stats:defaultPaperStats(),qualification:defaultQualification()};
}
function normalizePaperAutopilot(a){
 const d=defaultPaperAutopilot(),s=isObj(a)?a:{};
 return {enabled:s.enabled===true,orderUsd:num(s.orderUsd)>0?num(s.orderUsd):d.orderUsd,maxOpen:num(s.maxOpen)>0?Math.floor(num(s.maxOpen)):d.maxOpen,
  symbols:symbols(s.symbols,d.symbols),lastRunAt:num(s.lastRunAt),lastAction:s.lastAction??null,skipped:Array.isArray(s.skipped)?s.skipped.slice(-8):[]};
}
function normalizeTape(t){
 const out={};
 if(!isObj(t))return out;
 for(const [sym,v] of Object.entries(t)){
  if(!isObj(v)||!SYMBOL_RE.test(sym))continue;
  const samples=Array.isArray(v.samples)?v.samples.map(r=>Array.isArray(r)?[num(r[0]),num(r[1]),num(r[2])]:null).filter(r=>r&&r[0]>0&&r[1]>0&&r[2]>0):[];
  samples.sort((a,b)=>a[0]-b[0]);
  const dedup=[];for(const r of samples){if(dedup.length&&dedup[dedup.length-1][0]===r[0])dedup[dedup.length-1]=r;else dedup.push(r)}
  out[sym]={intervalMs:num(v.intervalMs)>0?num(v.intervalMs):15000,quoteSource:v.quoteSource==='v1'?'v1':'v2',samples:dedup.slice(-TAPE_CAP)};
 }
 return out;
}
export function normalizePaper(s={}){
 const src=isObj(s)?s:{};
 const d=defaultPaper();
 const out={...d,...src};
 delete out.sessionArmed;
 out.version=1;
 out.mode='PAPER';out.pnlMode='PAPER';
 out.createdAt=num(src.createdAt)||d.createdAt;
 out.cashUsd=Number.isFinite(Number(src.cashUsd))?Number(src.cashUsd):d.cashUsd;
 out.startUsd=num(src.startUsd)>0?num(src.startUsd):d.startUsd;
 out.feeRatio=num(src.feeRatio)>0?num(src.feeRatio):d.feeRatio;
 out.positions=list(src.positions).filter(p=>p.status==='OPEN');
 out.history=list(src.history).slice(0,PAPER_HISTORY_CAP);
 out.autopilot=normalizePaperAutopilot(src.autopilot);
 out.params=isObj(src.params)?src.params:{};
 out.paramsHash=typeof src.paramsHash==='string'?src.paramsHash:null;
 out.cooldowns=objMap(src.cooldowns);
 out.tape=normalizeTape(src.tape);
 out.tapeAt=num(src.tapeAt);
 out.stats={...defaultPaperStats(),...(isObj(src.stats)?src.stats:{})};
 out.qualification={...defaultQualification(out.paramsHash),...(isObj(src.qualification)?src.qualification:{})};
 out.qualification.qualified=out.qualification.qualified===true;
 out.qualification.reasons=Array.isArray(out.qualification.reasons)?out.qualification.reasons.map(String):[];
 if(src.recoveryRequired===true){
  out.recoveryRequired=true;out.recoveryError=String(src.recoveryError||'STATE RECOVERY REQUIRED');
  out.cashUsd=0;out.autopilot.enabled=false;out.qualification.qualified=false;
  if(!out.qualification.reasons.includes('paperRecovery'))out.qualification.reasons.push('paperRecovery');
 }else{delete out.recoveryRequired;delete out.recoveryError}
 return out;
}
let paperCache=null,lastPaperSaveAt=0;
export function loadPaper(){
 if(paperCache)return paperCache;
 try{const raw=JSON.parse(fs.readFileSync(PAPER_FILE,'utf8'));
  if(!isObj(raw)||raw.version!==1||!Array.isArray(raw.positions)||!Array.isArray(raw.history)||!Number.isFinite(raw.cashUsd)||raw.cashUsd<0||raw.positions.some(p=>!isObj(p)||p.status!=='OPEN'||!(p.qty>0)||!(p.costUsd>0)))throw new Error('Invalid paper book schema');
  paperCache=normalizePaper(raw)}
 catch(e){
  if(e?.code==='ENOENT')paperCache=defaultPaper();
  else paperCache=normalizePaper({...defaultPaper(),cashUsd:0,recoveryRequired:true,recoveryError:`STATE RECOVERY REQUIRED: ${e?.message||e}`,autopilot:{...defaultPaperAutopilot(),enabled:false},qualification:{...defaultQualification(),qualified:false}});
 }
 return paperCache;
}
// The tape is appended every tick, so unforced saves only refresh the in-memory book and hit disk at most every TAPE_FLUSH_MS.
export function savePaper(s,{force=false}={}){
 const candidate=normalizePaper(s),now=Date.now();
 if(force||now-lastPaperSaveAt>=TAPE_FLUSH_MS){
  try{atomicWrite(PAPER_FILE,'robinhood-paper',candidate)}
  catch(e){paperCache=null;throw e} // Reload the last durable book after a failed write.
  lastPaperSaveAt=now;
 }
 paperCache=candidate;
 return paperCache;
}

// Exploration book (§23): a second, separate paper book with its own bank and looser params. It holds
// no tape (it reads the strict book's), and its closes are tagged placedBy 'explore-autopilot', which
// evaluateQualification never counts. Corruption is handled like the strict book: recovery, never a throw.
let exploreCache=null,lastExploreSaveAt=0;
export function defaultExplore(){const d=defaultPaper();return {...d,exploration:true,autopilot:{...d.autopilot,enabled:true}}}
export function loadExplore(){
 if(exploreCache)return exploreCache;
 try{const raw=JSON.parse(fs.readFileSync(EXPLORE_FILE,'utf8'));
  if(!isObj(raw)||raw.version!==1||!Array.isArray(raw.positions)||!Array.isArray(raw.history)||!Number.isFinite(raw.cashUsd)||raw.cashUsd<0)throw new Error('Invalid exploration book schema');
  exploreCache={...normalizePaper(raw),exploration:true,tape:{},tapeAt:0}}
 catch(e){exploreCache=e?.code==='ENOENT'?defaultExplore():{...normalizePaper({...defaultExplore(),cashUsd:0,recoveryRequired:true,recoveryError:`STATE RECOVERY REQUIRED: ${e?.message||e}`}),exploration:true}}
 return exploreCache;
}
export function saveExplore(s,{force=false}={}){
 const candidate={...normalizePaper({...s,tape:{},tapeAt:0}),exploration:true},now=Date.now();
 if(force||now-lastExploreSaveAt>=TAPE_FLUSH_MS){
  try{atomicWrite(EXPLORE_FILE,'robinhood-paper-explore',candidate)}catch(e){exploreCache=null;throw e}
  lastExploreSaveAt=now;
 }
 exploreCache=candidate;return exploreCache;
}

export function appendTape(p,symbol,{bid,ask,at,quoteSource}={},cap=TAPE_CAP){
 const sym=String(symbol||'').toUpperCase();
 const b=num(bid),a=num(ask),t=num(at)||Date.now();
 if(!SYMBOL_RE.test(sym)||!(b>0)||!(a>=b))return;
 if(!isObj(p.tape))p.tape={};
 const row=p.tape[sym]||(p.tape[sym]={intervalMs:envNum('ROBINHOOD_TICK_MS',15000),quoteSource:'v2',samples:[]});
 if(quoteSource==='v1'||quoteSource==='v2')row.quoteSource=quoteSource;
 const s=row.samples,sample=[t,b,a];
 const last=s.length?s[s.length-1][0]:-Infinity;
 if(t>last)s.push(sample);
 else{
  let i=s.length-1;while(i>=0&&s[i][0]>t)i--;
  if(i>=0&&s[i][0]===t)s[i]=sample;else s.splice(i+1,0,sample);
 }
 const c=Math.max(1,Math.floor(num(cap))||TAPE_CAP);
 if(s.length>c)s.splice(0,s.length-c);
 p.tapeAt=Math.max(num(p.tapeAt),t);
}
export function tapeFor(p,symbol){
 const row=p?.tape?.[String(symbol||'').toUpperCase()];
 return Array.isArray(row?.samples)?row.samples.map(([t,bid,ask])=>({t,bid,ask,mid:(bid+ask)/2})):[];
}

// ---------------------------------------------------------------- qualification
export function qualificationThresholds(){
 return {minCloses:envNum('ROBINHOOD_QUAL_MIN_CLOSES',20),minHitRate:envNum('ROBINHOOD_QUAL_MIN_HIT_RATE',0.45),
  minProfitFactor:envNum('ROBINHOOD_QUAL_MIN_PROFIT_FACTOR',1.3),windowDays:envNum('ROBINHOOD_QUAL_WINDOW_DAYS',30)};
}
const median=a=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};
export function evaluateQualification(p,now=Date.now(),thresholds=qualificationThresholds(),limits={dailyLossCapUsd:envNum('ROBINHOOD_DAILY_LOSS_CAP_USD',50)}){
 const th={...qualificationThresholds(),...(isObj(thresholds)?thresholds:{})};
 const cap=num(limits?.dailyLossCapUsd)>0?num(limits.dailyLossCapUsd):envNum('ROBINHOOD_DAILY_LOSS_CAP_USD',50);
 const since=now-th.windowDays*864e5;
 const rows=list(p?.history).filter(x=>x.status==='CLOSED'&&x.placedBy==='paper-autopilot'&&x.closedBy==='strategy'&&x.paramsHash===(p?.paramsHash??null)&&num(x.closedAt)>=since&&num(x.closedAt)<=now&&Number.isFinite(x.pnlUsd))
  .sort((a,b)=>num(a.closedAt)-num(b.closedAt));
 const n=rows.length;
 let won=0,grossWin=0,grossLoss=0,pnl=0,fees=0,cum=0,peak=0,dd=0,lastCloseAt=null;
 const hitReqs=[];
 for(const x of rows){
  const pl=num(x.pnlUsd);pnl+=pl;if(pl>0){won++;grossWin+=pl}else grossLoss+=-pl;
  fees+=num(x.feeUsd)+num(x.exit?.feeUsd);
  cum+=pl;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);
  lastCloseAt=Math.max(num(lastCloseAt),num(x.closedAt));
  const stop=num(x.stopPct),take=num(x.takePct);
  const C=num(x.costPct)>0?num(x.costPct):num(x.costUsd)>0?(num(x.feeUsd)+num(x.exit?.feeUsd))/num(x.costUsd):2*num(p?.feeRatio);
  if(take+stop>0)hitReqs.push((stop+C)/(take+stop));
 }
 const hitRate=n?won/n:null;
 const profitFactor=!n?null:grossLoss>0?grossWin/grossLoss:grossWin>0?Infinity:null;
 const grossPnlUsd=r2(pnl+fees);
 const reasons=[];
 if(n<th.minCloses)reasons.push(`closes ${n} < ${th.minCloses}`);
 if(n&&(hitRate===null||hitRate<th.minHitRate))reasons.push(`hitRate ${hitRate===null?'n/a':hitRate.toFixed(3)} < ${th.minHitRate}`);
 if(n&&(profitFactor===null||profitFactor<th.minProfitFactor))reasons.push(`profitFactor ${profitFactor===null?'n/a':profitFactor===Infinity?'inf':profitFactor.toFixed(2)} < ${th.minProfitFactor}`);
 if(n&&pnl<=0)reasons.push(`pnlUsd ${r2(pnl)} <= 0`);
 if(dd>cap)reasons.push(`maxDrawdownUsd ${r2(dd)} > dailyLossCapUsd ${cap}`);
 if(lastCloseAt!==null&&now-lastCloseAt>STALE_MS)reasons.push('stale');
 if(p?.recoveryRequired===true)reasons.push('paperRecovery');
 return {qualified:reasons.length===0,paramsHash:p?.paramsHash??null,closes:n,hitRate,profitFactor,pnlUsd:r2(pnl),grossPnlUsd,feesUsd:r2(fees),
  feeDragPct:n?fees/Math.max(1,grossPnlUsd):null,maxDrawdownUsd:r2(dd),requiredHitRate:median(hitReqs),lastCloseAt,windowDays:th.windowDays,reasons,at:now};
}

export const __testing={
 resetJournal(){journalCache=null},
 resetPaper(){paperCache=null;lastPaperSaveAt=0;exploreCache=null;lastExploreSaveAt=0},
 journalFile:JOURNAL_FILE,paperFile:PAPER_FILE,TAPE_FLUSH_MS,TAPE_CAP,HISTORY_CAP,PAPER_HISTORY_CAP,
};
