// Robinhood Auto Trader — durable price tape (docs/ROBINHOOD-AUTO-TRADER.md §22).
// One NDJSON file per symbol under <DATA_DIR>/robinhood-tape/<SYMBOL>.ndjson, rows {t,bid,ask,src}. `src` names the quote
// source ('robinhood' or 'coinbase-public-paper'); rows written before batch 12 have none and read back as src:null. Appends are buffered in
// memory and flushed at most every TAPE_FLUSH_MS (or on demand); files are compacted to the newest TAPE_KEEP_DAYS.
// The in-memory 720-sample tape in robinhood-paper.json stays the source for live signals; this file feeds the
// paper-only evolution replay. No network, no imports from the trader; fs errors are reported, never thrown, by flush.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renameSyncWithRetry} from './atomicRename.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||path.join(ROOT,'data'));
export const TAPE_DIR=path.join(DATA_DIR,'robinhood-tape');
export const TAPE_FLUSH_MS=30000, TAPE_KEEP_DAYS=45, COMPACT_EVERY_MS=6*3600e3;
const DAY_MS=864e5;
const SYMBOL_RE=/^[A-Z0-9]{2,10}-USD$/;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0};
const cleanSrc=v=>typeof v==='string'&&/^[a-z0-9-]{1,32}$/.test(v)?v:null;
const buffers=new Map();          // symbol -> [{t,bid,ask,src?}]
const lastRow=new Map();          // symbol -> last t written or buffered (dedupe)
let lastFlushAt=0, lastCompactAt=0, lastError=null, flushedRows=0;

export function tapeFile(symbol){return path.join(TAPE_DIR,`${String(symbol||'').toUpperCase()}.ndjson`)}
export function validTapeSymbol(symbol){return SYMBOL_RE.test(String(symbol||'').toUpperCase())}

// Buffer one sample. Rejects malformed or crossed quotes and repeats of the same timestamp. Never touches disk.
export function bufferTape(symbol,{t,bid,ask,src}={}){
 const sym=String(symbol||'').toUpperCase(),b=num(bid),a=num(ask),ts=num(t);
 if(!SYMBOL_RE.test(sym)||!(b>0)||!(a>=b)||!(ts>0))return false;
 if(num(lastRow.get(sym))>=ts)return false;
 lastRow.set(sym,ts);
 if(!buffers.has(sym))buffers.set(sym,[]);
 const row={t:ts,bid:b,ask:a},s=cleanSrc(src);if(s)row.src=s;
 buffers.get(sym).push(row);
 return true;
}
// Buffer older rows that fill a hole (warm start). They must carry a src tag and never move the
// live dedupe cursor; parseLines sorts and dedupes on read, so appending them out of order is safe.
export function bufferBackfill(symbol,rows){
 const sym=String(symbol||'').toUpperCase();if(!SYMBOL_RE.test(sym))return 0;let n=0;
 for(const r of Array.isArray(rows)?rows:[]){const b=num(r?.bid),a=num(r?.ask),ts=num(r?.t),s=cleanSrc(r?.src);if(!s||!(b>0)||!(a>=b)||!(ts>0))continue;
  if(!buffers.has(sym))buffers.set(sym,[]);buffers.get(sym).push({t:ts,bid:b,ask:a,src:s});n++}
 return n;
}
export function pendingTapeRows(){let n=0;for(const rows of buffers.values())n+=rows.length;return n}

function appendFile(sym,rows){
 fs.mkdirSync(TAPE_DIR,{recursive:true});
 fs.appendFileSync(tapeFile(sym),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
}
function parseLines(text){
 const out=[];
 for(const line of String(text).split('\n')){
  if(!line)continue;
  try{const r=JSON.parse(line);const t=num(r?.t),bid=num(r?.bid),ask=num(r?.ask);if(t>0&&bid>0&&ask>=bid){const row={t,bid,ask},s=cleanSrc(r.src);if(s)row.src=s;out.push(row)}}catch{}
 }
 out.sort((a,b)=>a.t-b.t);
 const dedup=[];for(const r of out){if(dedup.length&&dedup[dedup.length-1].t===r.t)dedup[dedup.length-1]=r;else dedup.push(r)}
 return dedup;
}
// Rewrite the file keeping only rows newer than now - keepDays. Atomic (tmp + rename).
export function compactTape(symbol,{now=Date.now(),keepDays=TAPE_KEEP_DAYS}={}){
 const sym=String(symbol||'').toUpperCase(),file=tapeFile(sym);
 if(!fs.existsSync(file))return {rows:0,dropped:0};
 const rows=parseLines(fs.readFileSync(file,'utf8')),since=now-keepDays*DAY_MS,keep=rows.filter(r=>r.t>=since);
 const tmp=file+`.${process.pid}.${Date.now().toString(36)}.tmp`;
 try{fs.writeFileSync(tmp,keep.length?keep.map(r=>JSON.stringify(r)).join('\n')+'\n':'');renameSyncWithRetry(tmp,file)}
 catch(e){try{fs.rmSync(tmp,{force:true})}catch{}throw e}
 return {rows:keep.length,dropped:rows.length-keep.length};
}
// Flush buffered rows to disk when due (or forced). Returns {flushed, error}; never throws.
export function flushTape({force=false,now=Date.now()}={}){
 if(!force&&now-lastFlushAt<TAPE_FLUSH_MS)return {flushed:0,skipped:true,error:lastError};
 lastFlushAt=now;let flushed=0;
 try{
  for(const [sym,rows] of buffers){if(!rows.length)continue;appendFile(sym,rows);flushed+=rows.length;rows.length=0}
  if(now-lastCompactAt>=COMPACT_EVERY_MS){lastCompactAt=now;for(const sym of listTapeSymbols())compactTape(sym,{now})}
  flushedRows+=flushed;lastError=null;
 }catch(e){lastError={at:now,message:String(e?.message||e).slice(0,200)}}
 return {flushed,skipped:false,error:lastError};
}
export function listTapeSymbols(){
 try{return fs.readdirSync(TAPE_DIR).filter(n=>n.endsWith('.ndjson')).map(n=>n.slice(0,-7)).filter(validTapeSymbol).sort()}catch{return []}
}
// Rows for one symbol since `sinceMs` (inclusive), oldest first, with mid; includes unflushed buffered rows.
export function loadTape(symbol,sinceMs=0){
 const sym=String(symbol||'').toUpperCase();let rows=[];
 try{if(fs.existsSync(tapeFile(sym)))rows=parseLines(fs.readFileSync(tapeFile(sym),'utf8'))}catch{rows=[]}
 const pending=buffers.get(sym)||[];
 if(pending.length){rows=parseLines(rows.concat(pending).map(r=>JSON.stringify(r)).join('\n'))}
 const since=num(sinceMs);
 return rows.filter(r=>r.t>=since).map(r=>({t:r.t,bid:r.bid,ask:r.ask,mid:(r.bid+r.ask)/2,src:r.src||null}));
}
// Rows since `sinceMs` read from the END of the file only (the chart asks every 15 s; the file can hold 45 days).
// Reads backwards in doubling chunks until a row older than sinceMs is seen or the file start is reached.
const NL=String.fromCharCode(10);
export function loadTapeSince(symbol,sinceMs,{chunk=256*1024}={}){
 const sym=String(symbol||'').toUpperCase(),since=num(sinceMs),file=tapeFile(sym);let text='';
 try{
  const fd=fs.openSync(file,'r');
  try{const size=fs.fstatSync(fd).size;let len=Math.min(size,chunk);
   for(;;){const buf=Buffer.alloc(len);fs.readSync(fd,buf,0,len,size-len);text=buf.toString('utf8');
    if(len>=size)break;const nl=text.indexOf(NL);const first=parseLines(text.slice(nl+1).split(NL,1)[0]);
    if(first.length&&first[0].t<since){text=text.slice(nl+1);break}len=Math.min(size,len*2)}
  }finally{fs.closeSync(fd)}
 }catch{text=''}
 let rows=parseLines(text);const pending=buffers.get(sym)||[];
 if(pending.length)rows=parseLines(rows.concat(pending).map(r=>JSON.stringify(r)).join(NL));
 return rows.filter(r=>r.t>=since).map(r=>({t:r.t,bid:r.bid,ask:r.ask,mid:(r.bid+r.ask)/2,src:r.src||null}));
}
const coverageCache=new Map(); // symbol -> {key, value}; the HUD asks every snapshot, the file changes every 30 s at most
export function tapeCoverage(symbol,now=Date.now()){
 const sym=String(symbol||'').toUpperCase();let size=-1;try{size=fs.statSync(tapeFile(sym)).size}catch{}
 const key=size+':'+(buffers.get(sym)?.length||0)+':'+num(lastRow.get(sym)),hit=coverageCache.get(sym);if(hit&&hit.key===key)return {...hit.value,sources:{...hit.value.sources}};
 const value=coverage(symbol);coverageCache.set(sym,{key,value});return {...value,sources:{...value.sources}};
}
function coverage(symbol){
 const rows=loadTape(symbol,0);
 if(!rows.length)return {symbol:String(symbol||'').toUpperCase(),rows:0,firstAt:null,lastAt:null,days:0,sources:{}};
 const first=rows[0].t,last=rows[rows.length-1].t;
 const sources={};for(const r of rows){const k=r.src||'unknown';sources[k]=(sources[k]||0)+1}
 return {symbol:String(symbol||'').toUpperCase(),rows:rows.length,firstAt:first,lastAt:last,days:Math.max(0,(last-first)/DAY_MS),sources};
}
export function tapeStatus(){return {dir:TAPE_DIR,pending:pendingTapeRows(),flushedRows,lastFlushAt,lastCompactAt,lastError}}
export const __testing={
 reset(){buffers.clear();lastRow.clear();coverageCache.clear();lastFlushAt=0;lastCompactAt=0;lastError=null;flushedRows=0},
 buffers,parseLines,
};
