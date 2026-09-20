import fs from 'node:fs';import path from 'node:path';
const dir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data'),file=path.join(dir,'alpha-queue.ndjson'),lastCandidate=new Map();
let pending=[],scheduled=false;
function flush(){scheduled=false;if(!pending.length)return;const batch=pending;pending=[];try{fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(file,batch.join(''))}catch{}}
function scheduleFlush(){if(scheduled)return;scheduled=true;setImmediate(flush)}
export function enqueueAlphaEvent(row){try{if(row?.type==='candidate'&&row?.observation?.mint){const mint=row.observation.mint,now=Number(row.ts||Date.now()),last=lastCandidate.get(mint)||0;if(now-last<30_000)return false;lastCandidate.set(mint,now);if(lastCandidate.size>5000){for(const[k,t]of lastCandidate)if(now-t>6*3600_000)lastCandidate.delete(k)}}pending.push(JSON.stringify({...row,ts:row.ts||Date.now()})+'\n');if(pending.length>=128)flush();else scheduleFlush();return true}catch{return false}}
export function flushAlphaEvents(){flush()}
export function drainAlphaEvents(limit=2000){flush();fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(file))return[];const tmp=`${file}.${process.pid}.${Date.now()}.drain`;try{fs.renameSync(file,tmp)}catch{return[]}try{const xs=fs.readFileSync(tmp,'utf8').split('\n').filter(Boolean);const take=xs.slice(0,limit),remain=xs.slice(limit);if(remain.length)fs.appendFileSync(file,remain.join('\n')+'\n');return take.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean)}finally{try{fs.rmSync(tmp,{force:true})}catch{}}}
for(const sig of ['beforeExit','exit'])process.on(sig,flush);
