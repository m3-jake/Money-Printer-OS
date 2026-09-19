import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(process.env.MONEY_PRINTER_CLUSTER_DIR||'cluster');
const queueFile=path.join(root,'queue.ndjson'),resultsFile=path.join(root,'results.ndjson'),workersFile=path.join(root,'workers.json'),datasetsDir=path.join(root,'datasets');
const ensure=()=>{fs.mkdirSync(root,{recursive:true});fs.mkdirSync(datasetsDir,{recursive:true});};
export const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
function readRows(file){try{return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return[]}}
let qCache=null,rCache=null,claimsSinceCompact=0;
function queue(){return qCache||(qCache=readRows(queueFile))}
function results(){return rCache||(rCache=readRows(resultsFile))}
export function appendQueue(row){ensure();const x={...row,ts:row.ts||Date.now()};fs.appendFileSync(queueFile,JSON.stringify(x)+'\n');if(qCache)qCache.push(x);}
export function appendResult(row){ensure();const x={...row,ts:row.ts||Date.now()};fs.appendFileSync(resultsFile,JSON.stringify(x)+'\n');if(rCache)rCache.push(x);}
export const readQueue=()=>queue();
export const readResults=(ids=null)=>{const xs=results();if(!ids||!ids.size)return xs.slice(-256);return xs.filter(x=>ids.has(x.jobId));};
export function workerHeartbeat(id,meta={}){ensure();let x={};try{x=JSON.parse(fs.readFileSync(workersFile,'utf8'));}catch{}x[id]={id,ts:Date.now(),...meta};fs.writeFileSync(workersFile,JSON.stringify(x,null,2));return x[id];}
export function workers(){try{return JSON.parse(fs.readFileSync(workersFile,'utf8'));}catch{return{}}}
export function saveDataset(rows){ensure();const hash=digest(rows),file=path.join(datasetsDir,hash+'.json');if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(rows));return{hash,file,count:rows.length};}
export function loadDataset(hash){try{return JSON.parse(fs.readFileSync(path.join(datasetsDir,hash+'.json'),'utf8'));}catch{return null}}
const claimTtlMs=()=>Math.max(30000,Number(process.env.CLUSTER_CLAIM_TTL_MS||120000));
function queueState(){const q=queue(),rs=results(),done=new Set(rs.filter(x=>x.ok!==false).map(x=>x.jobId)),jobs=q.filter(x=>!x.claimedBy),claims=new Map();for(const row of q)if(row.claimedBy)claims.set(row.id,row);return{q,results:rs,done,jobs,claims};}
function compact(force=false){ensure();let qs=queue(),rs=results();let bytes=0;try{bytes=fs.statSync(queueFile).size+fs.statSync(resultsFile).size}catch{}if(!force&&bytes<24*1024*1024)return;const done=new Set(rs.filter(x=>x.ok!==false).map(x=>x.jobId)),keepResults=rs.slice(-256);const originals=new Map(),claims=new Map();for(const row of qs){if(row.claimedBy)claims.set(row.id,row);else originals.set(row.id,row)}const keepQ=[];for(const [id,j] of originals){if(done.has(id))continue;keepQ.push(j);if(claims.has(id))keepQ.push(claims.get(id))}fs.writeFileSync(queueFile,keepQ.map(x=>JSON.stringify(x)).join('\n')+(keepQ.length?'\n':''));fs.writeFileSync(resultsFile,keepResults.map(x=>JSON.stringify(x)).join('\n')+(keepResults.length?'\n':''));qCache=keepQ;rCache=keepResults;}
export function clusterStatus(){const {results:rs,done,jobs,claims}=queueState(),ws=workers(),now=Date.now(),ttl=claimTtlMs();const pending=jobs.filter(j=>!done.has(j.id)&&(!claims.get(j.id)||now-Number(claims.get(j.id).claimedAt||0)>ttl));const active=jobs.filter(j=>!done.has(j.id)&&claims.get(j.id)&&now-Number(claims.get(j.id).claimedAt||0)<=ttl);return{queued:pending.length,running:active.length,completed:done.size,failed:rs.filter(x=>x.ok===false).length,workers:Object.values(ws).map(w=>({...w,online:now-w.ts<30000}))};}
export function claimJob(workerId){const {done,jobs,claims}=queueState(),now=Date.now(),ttl=claimTtlMs();const job=jobs.find(x=>!done.has(x.id)&&(!claims.get(x.id)||now-Number(claims.get(x.id).claimedAt||0)>ttl));if(!job){if(++claimsSinceCompact%80===0)compact();return null}appendQueue({...job,claimedBy:workerId,claimedAt:now,type:'claim'});if(++claimsSinceCompact%80===0)compact();return job;}
compact();
