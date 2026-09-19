import os from 'node:os';
import { resourceSnapshot } from './resourcePolicy.js';
import {Worker} from 'node:worker_threads';
const hub=(process.env.CLUSTER_HUB_URL||'http://127.0.0.1:8798').replace(/\/$/,'');
const token=process.env.CLUSTER_TOKEN||'',id=process.env.CLUSTER_WORKER_ID||os.hostname();
const slots=Math.max(1,Math.min(Number(process.env.CLUSTER_WORKER_SLOTS||resourceSnapshot().maxWorkerSlots),resourceSnapshot().maxWorkerSlots,16));
const headers={'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})};
const post=async(path,obj)=>{const r=await fetch(hub+path,{method:'POST',headers,body:JSON.stringify(obj)});if(!r.ok)throw new Error(`${path} ${r.status}`);return r.json()};
const get=async path=>{const r=await fetch(hub+path,{headers});if(!r.ok)throw new Error(`${path} ${r.status}`);return r.json()};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cache=new Map();
function evaluate(variants,rows){return new Promise((resolve,reject)=>{const w=new Worker(new URL('./evolutionWorker.js',import.meta.url));w.once('message',x=>{resolve(x);w.terminate()});w.once('error',reject);w.postMessage({variants,rows})})}
async function getRows(hash){if(cache.has(hash))return cache.get(hash);const rows=(await get('/dataset/'+hash)).rows||[];cache.set(hash,rows);return rows}
async function runner(slot){
 const workerId=`${id}#${slot+1}`;
 while(true){
  const current=resourceSnapshot();
  if(slot>=current.maxWorkerSlots){await sleep(1200);continue}
  const {job}=await post('/claim',{workerId}).catch(()=>({job:null}));
  if(!job){await sleep(750);continue}
  try{const rows=await getRows(job.datasetHash),scored=await evaluate(job.variants||[],rows);await post('/result',{jobId:job.id,workerId,ok:true,scored,completedAt:Date.now()})}
  catch(e){await post('/result',{jobId:job.id,workerId,ok:false,error:String(e.message||e),completedAt:Date.now()}).catch(()=>{})}
 }
}
async function heartbeat(){while(true){const r=resourceSnapshot();await post('/heartbeat',{id,meta:{slots:r.maxWorkerSlots,cpuPercent:r.cpuPercent,memoryGB:r.memoryGB,cpus:os.cpus().length,platform:process.platform,arch:process.arch,pid:process.pid}}).catch(()=>{});await sleep(5000)}}
async function main(){console.log(`MONEY PRINTER CLUSTER WORKER ${id} slots=${slots} -> ${hub}`);await Promise.all([heartbeat(),...Array.from({length:slots},(_,i)=>runner(i))])}
if(process.env.MONEY_PRINTER_SUPERVISED==='1'){process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));process.stdin.resume()}
main().catch(e=>{console.error(e);process.exit(1)});
