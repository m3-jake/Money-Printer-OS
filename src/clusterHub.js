import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {appendQueue,appendResult,claimJob,clusterStatus,loadDataset,readResults,saveDataset,workerHeartbeat} from './clusterStore.js';
const port=Number(process.env.CLUSTER_PORT||8798),token=process.env.CLUSTER_TOKEN||'';
const auth=req=>!token||req.headers.authorization===`Bearer ${token}`;
const json=(res,code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
const body=req=>new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>32*1024*1024)reject(new Error('body too large'))});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});req.on('error',reject)});
const server=http.createServer(async(req,res)=>{
 try{
  if(!auth(req))return json(res,401,{error:'unauthorized'});
  if(req.method==='GET'&&req.url==='/status')return json(res,200,clusterStatus());
  if(req.method==='GET'&&req.url==='/update/manifest'){
   const dir=path.resolve(process.env.CLUSTER_RELEASE_DIR||path.join(process.env.MONEY_PRINTER_CLUSTER_DIR||'cluster','releases')),file=path.join(dir,'manifest.json');
   if(!fs.existsSync(file))return json(res,404,{error:'no published update'});const m=JSON.parse(fs.readFileSync(file,'utf8')),key=process.env.CLUSTER_TOKEN||'';if(key&&m.version&&m.sha256&&m.size!=null)m.signature=crypto.createHmac('sha256',key).update(`${m.version}:${m.sha256}:${m.size}`).digest('hex');return json(res,200,m);
  }
  if(req.method==='GET'&&req.url==='/update/app.asar'){
   const dir=path.resolve(process.env.CLUSTER_RELEASE_DIR||path.join(process.env.MONEY_PRINTER_CLUSTER_DIR||'cluster','releases')),file=path.join(dir,'app.asar');
   if(!fs.existsSync(file)){res.writeHead(404);return res.end('missing update');}const prev=process.noAsar;process.noAsar=true;let buf;try{buf=fs.readFileSync(file)}finally{process.noAsar=prev}res.writeHead(200,{'content-type':'application/octet-stream','content-length':buf.length,'cache-control':'no-store'});return res.end(buf);
  }
  if(req.method==='GET'&&req.url?.startsWith('/results')){const u=new URL(req.url,'http://127.0.0.1');const ids=new Set((u.searchParams.get('ids')||'').split(',').filter(Boolean));return json(res,200,{results:readResults(ids.size?ids:null)});}
  if(req.method==='POST'&&req.url==='/heartbeat'){const b=await body(req);return json(res,200,workerHeartbeat(String(b.id||'worker'),b.meta||{}));}
  if(req.method==='POST'&&req.url==='/dataset'){const b=await body(req),d=saveDataset(b.rows||[]);return json(res,200,d);}
  if(req.method==='GET'&&req.url?.startsWith('/dataset/')){const rows=loadDataset(req.url.split('/').pop());return rows?json(res,200,{rows}):json(res,404,{error:'missing dataset'});}
  if(req.method==='POST'&&req.url==='/jobs'){const b=await body(req);for(const j of b.jobs||[])appendQueue(j);return json(res,200,{queued:(b.jobs||[]).length});}
  if(req.method==='POST'&&req.url==='/claim'){const b=await body(req);return json(res,200,{job:claimJob(String(b.workerId||'worker'))});}
  if(req.method==='POST'&&req.url==='/result'){const b=await body(req);appendResult(b);return json(res,200,{ok:true});}
  return json(res,404,{error:'not found'});
 }catch(e){return json(res,500,{error:String(e.message||e)});}
});
server.listen(port,'0.0.0.0',()=>console.log(`MONEY PRINTER CLUSTER HUB :${port}`));
if(process.env.MONEY_PRINTER_SUPERVISED==='1'){process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));process.stdin.resume()}
