import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renameSyncWithRetry } from './atomicRename.js';

const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const RAW_DIR=path.join(DATA_DIR,'research-evidence','raw');
const CURSOR_FILE=path.join(DATA_DIR,'research-evidence','collector-state.json');
const STATUS_FILE=path.join(DATA_DIR,'research-capture-status.json');
const LOCK_FILE=path.join(DATA_DIR,'research-evidence','collector.lock');
const LOCK_STALE_MS=Math.max(10_000,Number(process.env.MPO_COLLECTOR_LOCK_STALE_MS||60_000));
const SOLANA_MS=Math.max(500,Number(process.env.MPO_SOLANA_CAPTURE_MS||1000));
const POLY_MS=Math.max(2000,Number(process.env.MPO_POLY_CAPTURE_MS||5000));
const POLY_HEARTBEAT_MS=Math.max(POLY_MS,Number(process.env.MPO_POLY_HEARTBEAT_MS||30000));
const MARKET_LIMIT=Math.max(5,Math.min(30,Number(process.env.MPO_POLY_CAPTURE_MARKETS||20)));
const POLY_US_MS=Math.max(5000,Number(process.env.MPO_POLY_US_CAPTURE_MS||15000));
const LEVELS=Math.max(3,Math.min(20,Number(process.env.MPO_POLY_CAPTURE_LEVELS||10)));
const RAW_KEEP_DAYS=Math.max(3,Number(process.env.MPO_RAW_KEEP_DAYS||45));
const RAW_BUDGET_BYTES=Math.max(256,Number(process.env.MPO_RAW_BUDGET_MB||20480))*1024*1024;
const PRUNE_MS=60*60*1000;
// Jupiter quote tape (public quote GETs only): every JUP_MS, up to JUP_TARGETS tokens, JUP_DAILY calls a UTC day.
const JUP_ON=String(process.env.MPO_JUP_QUOTES??'true').toLowerCase()!=='false';
const JUP_MS=Math.max(30_000,Number(process.env.MPO_JUP_QUOTE_MS||120_000));
const JUP_TARGETS=Math.max(1,Math.min(20,Number(process.env.MPO_JUP_QUOTE_TARGETS||6)));
const JUP_DAILY=Math.max(0,Number(process.env.MPO_JUP_QUOTES_DAILY||10_000));
const JUP_NOTIONAL_SOL=Math.max(0.001,Math.min(10,Number(process.env.MPO_JUP_QUOTE_SOL||0.1)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function readJson(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
// fsync before rename: a power loss must leave either the old file or the new one, never a NUL-filled file.
export function atomicJson(file,obj){
 fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;
 const fd=fs.openSync(tmp,'w');try{fs.writeSync(fd,JSON.stringify(obj,null,2));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 renameSyncWithRetry(tmp,file);
}
function day(ts=Date.now()){return new Date(ts).toISOString().slice(0,10)}
// A torn tail (power loss mid-append, or a NUL-extended file) must not swallow the next record:
// start a fresh line whenever the file does not already end in a newline.
export const RESEARCH_RAW_DIR=RAW_DIR;
export function appendNdjson(name,rows,{dir=RAW_DIR,now=Date.now()}={}){
 if(!rows.length)return 0;fs.mkdirSync(dir,{recursive:true});
 const f=path.join(dir,`${name}-${day(now)}.ndjson`);let lead='';
 try{const st=fs.statSync(f);if(st.size>0){const fd=fs.openSync(f,'r');try{const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,st.size-1);if(b[0]!==0x0a)lead='\n'}finally{fs.closeSync(fd)}}}catch{}
 const body=lead+rows.map(x=>JSON.stringify(x)).join('\n')+'\n';
 // fsync so a power loss cannot leave a NUL-filled tail; the lead newline above isolates any torn line.
 const fd=fs.openSync(f,'a');try{fs.writeSync(fd,body);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 return Buffer.byteLength(body);
}
// Raw tape retention (hourly): drop day files older than keepDays, then the oldest first while over the byte
// budget. Today's and yesterday's files are never touched, nor anything matching exemptPrefixes (the Polymarket US
// evidence stays until its shadow record is complete). A removed day file takes its .sha256 sidecar with it.
const DATED_RAW=/^(.+)-(\d{4}-\d{2}-\d{2})\.ndjson$/;
export function pruneRawTapes({dir=RAW_DIR,now=Date.now(),keepDays=RAW_KEEP_DAYS,budgetBytes=RAW_BUDGET_BYTES,exemptPrefixes=[]}={}){
 const yesterday=day(now-864e5),cutoff=day(now-keepDays*864e5),removed=[];
 let names=[];try{names=fs.readdirSync(dir)}catch{return {at:now,files:0,totalBytes:0,removed,removedBytes:0,budgetBytes,keepDays,overBudget:false}}
 const files=names.map(name=>{const m=DATED_RAW.exec(name);if(!m)return null;try{return {name,date:m[2],size:fs.statSync(path.join(dir,name)).size}}catch{return null}}).filter(Boolean);
 let total=files.reduce((a,x)=>a+x.size,0);
 const locked=x=>x.date>=yesterday||exemptPrefixes.some(p=>x.name.startsWith(p));
 const drop=(x,reason)=>{try{fs.rmSync(path.join(dir,x.name));try{fs.rmSync(path.join(dir,x.name+'.sha256'),{force:true})}catch{}removed.push({name:x.name,bytes:x.size,reason});total-=x.size;x.gone=true}catch{}};
 for(const x of files)if(!locked(x)&&x.date<cutoff)drop(x,'age');
 for(const x of files.filter(x=>!x.gone&&!locked(x)).sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name))){if(total<=budgetBytes)break;drop(x,'budget')}
 return {at:now,files:files.filter(x=>!x.gone).length,totalBytes:total,removed,removedBytes:removed.reduce((a,x)=>a+x.bytes,0),budgetBytes,keepDays,overBudget:total>budgetBytes};
}
// One collector per data dir. The trader spawns one as a child and a standalone runner may run another;
// without this they would both append the same day file. A lock is stale when its pid is gone or it has
// not been refreshed for staleMs (covers pid reuse after a reboot).
function pidAlive(pid){try{process.kill(pid,0);return true}catch(e){return e?.code==='EPERM'}}
export function acquireCollectorLock(file,{pid=process.pid,now=Date.now(),staleMs=LOCK_STALE_MS,isAlive=pidAlive}={}){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=fs.openSync(file,'wx');try{fs.writeSync(fd,JSON.stringify({pid,at:now}))}finally{fs.closeSync(fd)}return {ok:true,file}}
  catch(e){if(e?.code!=='EEXIST')throw e}
  const held=readJson(file,null),age=(()=>{try{return now-fs.statSync(file).mtimeMs}catch{return Infinity}})();
  const holder=Number(held?.pid||0);
  if(holder&&holder!==pid&&isAlive(holder)&&age<staleMs)return {ok:false,file,heldBy:holder};
  try{fs.unlinkSync(file)}catch{}
 }
 return {ok:false,file,heldBy:null};
}
export function releaseCollectorLock(file,pid=process.pid){try{if(Number(readJson(file,null)?.pid)===pid)fs.unlinkSync(file)}catch{}}
function hashBook(r){return crypto.createHash('sha256').update(JSON.stringify({b:r.bids,a:r.asks,f:r.feeMeta})).digest('hex')}

export function collectSolanaTicks(state={},cursor={}){
 const out=[],next={...cursor};
 for(const [mint,xs] of Object.entries(state.tickHistory||{})){
  let last=Number(next[mint]||0);
  for(const x of Array.isArray(xs)?xs:[]){
   const ts=Number(x?.ts||0);if(!(ts>last))continue;
   out.push({schema:'mpo.solana-path-tape.v1',ts,mint,price:Number(x.price||0),liquidity:Number(x.liq||0),volume5m:Number(x.v5||0),flow:Number(x.flow||0),score:Number(x.score||0),buys:Number(x.buys||0),sells:Number(x.sells||0),
    quoteKind:'last-price+liquidity',provenance:'observed-state-tick',selectionUse:false,
    coverage:{asOfPrice:true,liquidity:true,bidAsk:false,depth:false,costs:false,executionLatency:false}});
   if(ts>last)last=ts;
  }
  if(last)next[mint]=last;
 }
 return {rows:out,cursor:next};
}

export function filterPolymarketRecords(snapshot={},state={},now=Date.now()){
 const out=[],books={...(state.books||{})};
 for(const raw of snapshot.records||[]){
  const r={...raw,bids:(raw.bids||[]).slice(0,LEVELS),asks:(raw.asks||[]).slice(0,LEVELS)};
  const key=String(r.tokenId||''),h=hashBook(r),prior=books[key]||{};
  if(prior.hash===h && now-Number(prior.at||0)<POLY_HEARTBEAT_MS)continue;
  const feesObserved=!!(r.feeMeta?.feeSchedule||Number(r.feeMeta?.takerBaseFee)>0||r.feeMeta?.feesEnabled===false);
  out.push({...r,schema:'mpo.polymarket-depth-tape.v1',capturedAt:now,
    coverage:{asOfSignals:true,costs:feesObserved,depth:true,latency:false,sharedCapital:false,eventGrouping:!!(r.gameId||r.eventId)}});
  books[key]={hash:h,at:now};
 }
 return {rows:out,books};
}

async function run(){
 fs.mkdirSync(RAW_DIR,{recursive:true});
 const lock=acquireCollectorLock(LOCK_FILE);
 if(!lock.ok){console.log(`research collector: another collector (pid ${lock.heldBy??'unknown'}) owns ${DATA_DIR}; exiting`);return}
 const release=()=>releaseCollectorLock(LOCK_FILE);process.on('exit',release);
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{release();process.exit(0)});
 let cursor=readJson(CURSOR_FILE,{solana:{},books:{},stats:{solanaRows:0,polyRows:0,bytes:0}}),lastPoly=0,polyApi=null,lastPolyUS=0,usEvidence=null,lastPrune=0,lastJup=0,jupBackoffUntil=0,jupApi=null;
 process.env.POLYMARKET_AUTOSTART='false';
 const status={schema:'mpo.research-capture-status.v1',startedAt:Date.now(),pid:process.pid,liveOrderAccess:false};
 while(true){
  const loopAt=Date.now();
  try{
   const state=readJson(path.join(DATA_DIR,'state.json'),{}),c=collectSolanaTicks(state,cursor.solana||{});
   cursor.solana=c.cursor;const bytes=appendNdjson('solana-path',c.rows);cursor.stats.solanaRows=Number(cursor.stats.solanaRows||0)+c.rows.length;cursor.stats.bytes=Number(cursor.stats.bytes||0)+bytes;
   status.solana={lastAt:Date.now(),rowsTotal:cursor.stats.solanaRows,lastBatch:c.rows.length,coverage:{bidAsk:false,depth:false,costs:false,executionLatency:false}};
  }catch(e){status.solana={...(status.solana||{}),error:String(e?.message||e),lastErrorAt:Date.now()}}
  if(Date.now()-lastPoly>=POLY_MS){
   lastPoly=Date.now();
   try{
    polyApi ||= await import('./polymarket.js');
    const snap=await polyApi.polymarketEvidenceSnapshot({marketLimit:MARKET_LIMIT});
    const f=filterPolymarketRecords(snap,cursor,Date.now());cursor.books=f.books;
    const bytes=appendNdjson('polymarket-depth',f.rows);cursor.stats.polyRows=Number(cursor.stats.polyRows||0)+f.rows.length;cursor.stats.bytes=Number(cursor.stats.bytes||0)+bytes;
    const feeRows=f.rows.filter(x=>x.coverage?.costs).length;
    status.polymarket={lastAt:Date.now(),rowsTotal:cursor.stats.polyRows,lastBatch:f.rows.length,bookRows:snap.records?.length||0,feeRows,
      coverage:{depth:true,costs:feeRows>0,latency:false,sharedCapital:false}};
   }catch(e){status.polymarket={...(status.polymarket||{}),error:String(e?.message||e),lastErrorAt:Date.now()}}
  }
  // Polymarket US combo evidence: legs tape, settlement tracker, calibration, shadow auto (public GETs only).
  if(process.env.MPO_POLY_US_EVIDENCE!=='false'&&Date.now()-lastPolyUS>=POLY_US_MS){
   lastPolyUS=Date.now();
   try{
    usEvidence ||= await import('./polymarketUSEvidence.js');
    const r=await usEvidence.evidenceTick();
    status.polymarketUS={lastAt:Date.now(),legRows:r.legRows,estimates:r.estimates,resolved:r.resolved,rateLimited:r.rateLimited,shadowDecisions:r.decisions.length};
   }catch(e){status.polymarketUS={...(status.polymarketUS||{}),error:String(e?.message||e),lastErrorAt:Date.now()}}
  }
  if(JUP_ON&&Date.now()-lastJup>=JUP_MS&&Date.now()>=jupBackoffUntil){
   lastJup=Date.now();
   try{
    jupApi ||= await import('./jupiterQuoteSampler.js');
    const today=day(),j=cursor.jupiter&&cursor.jupiter.day===today?cursor.jupiter:{day:today,calls:0,rows:0};
    const state=readJson(path.join(DATA_DIR,'state.json'),{});
    const r=await jupApi.sampleJupiterQuotes({state,limit:JUP_TARGETS,callsLeft:JUP_DAILY-j.calls,notionalSol:JUP_NOTIONAL_SOL});
    const bytes=appendNdjson('jupiter-quotes',r.rows);cursor.stats.bytes=Number(cursor.stats.bytes||0)+bytes;
    j.calls+=r.calls;j.rows+=r.rows.length;cursor.jupiter=j;cursor.stats.jupiterRows=Number(cursor.stats.jupiterRows||0)+r.rows.length;
    if(r.rateLimited)jupBackoffUntil=Date.now()+5*60_000;
    status.jupiter={lastAt:Date.now(),rowsTotal:cursor.stats.jupiterRows,lastBatch:r.rows.length,callsToday:j.calls,dailyCap:JUP_DAILY,rateLimitedAt:r.rateLimited?Date.now():(status.jupiter?.rateLimitedAt||null),
     errors:r.errors.slice(0,3),medianRoundTripPct:(()=>{const v=r.rows.map(x=>x.roundTripPct).filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[v.length>>1]:null})(),quotesOnly:true};
   }catch(e){status.jupiter={...(status.jupiter||{}),error:String(e?.message||e),lastErrorAt:Date.now()}}
  }
  if(Date.now()-lastPrune>=PRUNE_MS){
   lastPrune=Date.now();
   try{let complete=false;try{complete=usEvidence?.polymarketFitness?.().searchAllowed===true}catch{}
    const r=pruneRawTapes({exemptPrefixes:complete?[]:['polymarket-us-']});
    status.retention={at:r.at,files:r.files,totalBytes:r.totalBytes,budgetBytes:r.budgetBytes,keepDays:r.keepDays,overBudget:r.overBudget,removedFiles:r.removed.length,removedBytes:r.removedBytes,polymarketUSExempt:!complete};
   }catch(e){status.retention={...(status.retention||{}),error:String(e?.message||e),lastErrorAt:Date.now()}}
  }
  // A transient Windows rename refusal (Dropbox/AV holding the file) must not kill the collector.
  try{cursor.updatedAt=Date.now();atomicJson(CURSOR_FILE,cursor);atomicJson(STATUS_FILE,{...status,updatedAt:Date.now(),bytesTotal:cursor.stats.bytes,rawDir:RAW_DIR})}
  catch(e){status.lastWriteError={message:String(e?.message||e),at:Date.now()}}
  // Refresh the lock; if another collector declared it stale and took it over, yield rather than double-write.
  const owner=readJson(LOCK_FILE,null);
  if(owner&&Number(owner.pid)!==process.pid){console.log('research collector: lock taken over; exiting');return}
  try{const t=new Date();fs.utimesSync(LOCK_FILE,t,t)}catch{}
  await sleep(Math.max(50,SOLANA_MS-(Date.now()-loopAt)));
 }
}

// Same entry rule as src/index.js: the loader realpaths import.meta.url but not argv[1] (symlinked
// installs, /var -> /private/var), and a plain compare made the collector a silent no-op there.
export function isEntryModule(argv1=process.argv[1],moduleUrl=import.meta.url,env=process.env){
 if(env.MONEY_PRINTER_SUPERVISED==='1')return true;
 if(!argv1)return false;
 const real=p=>{try{return fs.realpathSync(p)}catch{return p}};
 try{return real(fileURLToPath(moduleUrl))===real(path.resolve(argv1))}catch{return false}
}
const isMain=isEntryModule();
if(isMain)run().catch(e=>{console.error(e);process.exitCode=1});
