import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const RAW_DIR=path.join(DATA_DIR,'research-evidence','raw');
const CURSOR_FILE=path.join(DATA_DIR,'research-evidence','collector-state.json');
const STATUS_FILE=path.join(DATA_DIR,'research-capture-status.json');
const SOLANA_MS=Math.max(500,Number(process.env.MPO_SOLANA_CAPTURE_MS||1000));
const POLY_MS=Math.max(2000,Number(process.env.MPO_POLY_CAPTURE_MS||5000));
const POLY_HEARTBEAT_MS=Math.max(POLY_MS,Number(process.env.MPO_POLY_HEARTBEAT_MS||30000));
const MARKET_LIMIT=Math.max(5,Math.min(30,Number(process.env.MPO_POLY_CAPTURE_MARKETS||20)));
const LEVELS=Math.max(3,Math.min(20,Number(process.env.MPO_POLY_CAPTURE_LEVELS||10)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function readJson(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function atomicJson(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(obj,null,2));fs.renameSync(tmp,file)}
function day(ts=Date.now()){return new Date(ts).toISOString().slice(0,10)}
function appendNdjson(name,rows){if(!rows.length)return 0;fs.mkdirSync(RAW_DIR,{recursive:true});const f=path.join(RAW_DIR,`${name}-${day()}.ndjson`);const body=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';fs.appendFileSync(f,body);return Buffer.byteLength(body)}
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
 let cursor=readJson(CURSOR_FILE,{solana:{},books:{},stats:{solanaRows:0,polyRows:0,bytes:0}}),lastPoly=0,polyApi=null;
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
  cursor.updatedAt=Date.now();atomicJson(CURSOR_FILE,cursor);atomicJson(STATUS_FILE,{...status,updatedAt:Date.now(),bytesTotal:cursor.stats.bytes,rawDir:RAW_DIR});
  await sleep(Math.max(50,SOLANA_MS-(Date.now()-loopAt)));
 }
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain)run().catch(e=>{console.error(e);process.exitCode=1});
