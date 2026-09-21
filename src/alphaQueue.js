import fs from 'node:fs';import path from 'node:path';
const dir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data'),file=path.join(dir,'alpha-queue.ndjson'),lastCandidate=new Map();
let pending=[],scheduled=false;

// This queue has the same append-many/read-whole-file-to-drain shape that flooded
// data/actions.ndjson to 99.74 GB on 2026-09-18 (see src/store.js). It never hit that
// failure only because the alpha worker normally drains faster than the trader writes;
// disabling ALPHA_WORKER_ENABLED or crash-looping the worker removes that assumption.
// Same three rails as store.js: cap a single record, cap the file, sweep orphaned drains.
export const RECORD_MAX_BYTES = 64 * 1024;
export const QUEUE_MAX_BYTES = 64 * 1024 * 1024;
export const DRAIN_ORPHAN_MS = 5 * 60_000;

function flush(){scheduled=false;if(!pending.length)return;const batch=pending;pending=[];try{fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(file,batch.join(''))}catch{}}
function scheduleFlush(){if(scheduled)return;scheduled=true;setImmediate(flush)}

export function enqueueAlphaEvent(row){
  try{
    if(row?.type==='candidate'&&row?.observation?.mint){
      const mint=row.observation.mint,now=Number(row.ts||Date.now()),last=lastCandidate.get(mint)||0;
      if(now-last<30_000)return false;
      lastCandidate.set(mint,now);
      if(lastCandidate.size>5000){for(const[k,t]of lastCandidate)if(now-t>6*3600_000)lastCandidate.delete(k)}
    }
    const line=JSON.stringify({...row,ts:row.ts||Date.now()})+'\n';
    if(Buffer.byteLength(line)>RECORD_MAX_BYTES)return false; // drop, don't grow the queue unbounded
    pending.push(line);
    if(pending.length>=128)flush();else scheduleFlush();
    return true;
  }catch{return false}
}
export function flushAlphaEvents(){flush()}

export function quarantineAlphaQueue(reason='oversized'){
  const target=`${file}.quarantined-${Date.now()}`;
  try{fs.renameSync(file,target)}catch{return null}
  return target;
}
// An orphaned .drain belongs to a worker that died mid-drain (or hit ENOSPC); it would
// otherwise sit on disk forever, same as the four actions.ndjson.*.drain files did.
export function cleanupAlphaDrains(now=Date.now()){
  let removed=0;
  try{
    for(const name of fs.readdirSync(dir)){
      if(!name.startsWith('alpha-queue.ndjson.')||!name.endsWith('.drain')||name.startsWith(`alpha-queue.ndjson.${process.pid}.`))continue;
      const f=path.join(dir,name);
      try{if(now-fs.statSync(f).mtimeMs>DRAIN_ORPHAN_MS){fs.rmSync(f,{force:true});removed++}}catch{}
    }
  }catch{}
  return removed;
}

let lastDrainSweep=0;
export function drainAlphaEvents(limit=2000){
  flush();
  fs.mkdirSync(dir,{recursive:true});
  const now=Date.now();
  if(now-lastDrainSweep>60_000){lastDrainSweep=now;cleanupAlphaDrains(now)}
  if(!fs.existsSync(file))return[];
  try{const size=fs.statSync(file).size;if(size>QUEUE_MAX_BYTES){quarantineAlphaQueue(`${size} bytes`);return[]}}catch{}
  const tmp=`${file}.${process.pid}.${Date.now()}.drain`;
  try{fs.renameSync(file,tmp)}catch{return[]}
  try{
    const xs=fs.readFileSync(tmp,'utf8').split('\n').filter(Boolean);
    const take=xs.slice(0,limit),remain=xs.slice(limit);
    if(remain.length)fs.appendFileSync(file,remain.join('\n')+'\n');
    return take.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
  }finally{try{fs.rmSync(tmp,{force:true})}catch{}}
}

for(const sig of ['beforeExit','exit'])process.on(sig,flush);
