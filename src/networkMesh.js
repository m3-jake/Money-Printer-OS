import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { resourceSnapshot } from './resourcePolicy.js';

const UDP_PORT=Number(process.env.MONEY_PRINTER_MESH_PORT||18799);
const HTTP_PORT=Number(process.env.MONEY_PRINTER_MESH_HTTP_PORT||18800);
const UPDATE_PORT=Number(process.env.MONEY_PRINTER_MESH_UPDATE_PORT||18801);
const APP_ASAR=process.env.MONEY_PRINTER_APP_ASAR||'';
const APP_VERSION=process.env.MONEY_PRINTER_VERSION||process.env.npm_package_version||'';
const ROOM=String(process.env.MONEY_PRINTER_ROOM||'money-printer-home').slice(0,64);
const STATE_FILE=path.join(path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data'),'state.json');
const BRIDGE_DIR=process.env.MONEY_PRINTER_BRIDGE_DIR||'',BRIDGE_KEY=process.env.MONEY_PRINTER_BRIDGE_KEY||'';
const OFFLINE_AFTER_MS=16000, LISTEN_RETRY_MS=30000;
const nodeId=process.env.MONEY_PRINTER_NODE_ID||crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0,10);
const displayName=process.env.MONEY_PRINTER_NODE_NAME||os.hostname();
const peers=new Map(), messages=[], events=[];
let seq=0, standby=false;
const now=()=>Date.now();

// The trading engine owns state.json; the mesh only reads a small "situation" summary from it so
// peers can see each other's equity / P&L / contribution. Cached by mtime so presence pings stay cheap.
let situationCache={stamp:'',value:null};
function localSituation(){
 let stamp='missing';try{const st=fs.statSync(STATE_FILE);stamp=`${Math.trunc(st.mtimeMs)}:${st.size}`}catch{}
 if(situationCache.stamp===stamp)return situationCache.value;
 let value=null;
 try{
  const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')),p=s.portfolio||{},st=s.stats||{};
  const cash=Number(s.cashSol||0),positions=Array.isArray(s.positions)?s.positions:[];
  const equity=Number.isFinite(Number(p.equitySol))?Number(p.equitySol):cash+positions.reduce((a,x)=>a+Number(x.remainingSol??x.sizeSol??0),0);
  value={
   equitySol:+equity.toFixed(4),cashSol:+cash.toFixed(4),sessionPnlSol:+Number(s.dailyPnlSol||0).toFixed(4),
   openPositions:positions.length,health:s.system?.health||'UNKNOWN',mode:s.runtime?.profile||null,updatedAt:Number(p.updatedAt||s.system?.lastCycle||0)||null,
   contribution:{trades:Array.isArray(s.history)?s.history.length:0,signals:Number(st.signals||0),jobs:Number(s.evolutionLoop?.variantsTested||s.evolution?.loop?.variantsTested||0)},
  };
 }catch{}
 situationCache={stamp,value};
 return value;
}
const localInfo=()=>{const sit=localSituation();return{id:nodeId,name:displayName,hostname:os.hostname(),platform:os.platform(),arch:os.arch(),cpus:os.cpus().length,memoryGB:+(os.totalmem()/1073741824).toFixed(1),resources:resourceSnapshot(nodeId),situation:sit,contribution:sit?.contribution||{trades:0,signals:0,jobs:0},room:ROOM,version:APP_VERSION,updatePort:APP_ASAR?UPDATE_PORT:null,ts:now()}};

function pushEvent(e){const ev={ts:now(),...e};events.push(ev);if(events.length>200)events.splice(0,events.length-200);return ev}
function remember(p){
 if(!p||p.room!==ROOM||!p.id)return;
 const prev=peers.get(p.id),t=now();
 if(!prev)pushEvent({type:'join',nodeId:p.id,name:p.name,text:p.id===nodeId?`came online (${p.version||'dev'})`:`joined the network (${p.version||'dev'})`});
 else{
  if(!prev.online&&prev.lastSeen&&t-prev.lastSeen>=OFFLINE_AFTER_MS)pushEvent({type:'back',nodeId:p.id,name:p.name,text:'is back online'});
  if(prev.version&&p.version&&prev.version!==p.version)pushEvent({type:'version',nodeId:p.id,name:p.name,text:`updated ${prev.version} → ${p.version}`});
 }
 peers.set(p.id,{...(prev||{}),...p,lastSeen:p.transport==='sync'?p.ts:t,online:true});
}
function pushMessage(m){if(!m||m.room!==ROOM||!m.id||!m.text)return;if(messages.some(x=>x.id===m.id))return;messages.push(m);if(messages.length>250)messages.splice(0,messages.length-250);pushEvent({type:'chat',nodeId:m.nodeId,name:m.name,text:`said: ${String(m.text).slice(0,120)}`});}
function sweep(){const t=now();for(const p of peers.values()){const online=t-p.lastSeen<(p.transport==='sync'?120000:OFFLINE_AFTER_MS);if(p.online&&!online){p.online=false;if(p.id!==nodeId)pushEvent({type:'offline',nodeId:p.id,name:p.name,text:'went offline'})}else p.online=online}}
let bridgeBusy=false;
async function syncBridge(){
 if(standby||bridgeBusy||!BRIDGE_DIR||!BRIDGE_KEY)return;
 bridgeBusy=true;
 try{
  await fs.promises.mkdir(BRIDGE_DIR,{recursive:true});
  const payload=JSON.stringify({node:{...localInfo(),transport:'sync',updatePort:null},messages:messages.filter(m=>m.nodeId===nodeId).slice(-100)});
  const record=JSON.stringify({payload,signature:crypto.createHmac('sha256',BRIDGE_KEY).update(payload).digest('hex')});
  const target=path.join(BRIDGE_DIR,nodeId+'.json'),tmp=target+'.tmp';
  await fs.promises.writeFile(tmp,record);await fs.promises.rename(tmp,target);
  for(const name of (await fs.promises.readdir(BRIDGE_DIR)).filter(n=>/^[a-f0-9]{10}\.json$/.test(n)&&n!==nodeId+'.json').slice(0,32)){
   try{
    const file=path.join(BRIDGE_DIR,name);if((await fs.promises.stat(file)).size>262144)continue;
    const rec=JSON.parse(await fs.promises.readFile(file,'utf8'));if(typeof rec.payload!=='string'||typeof rec.signature!=='string')continue;
    const expected=crypto.createHmac('sha256',BRIDGE_KEY).update(rec.payload).digest('hex');
    if(rec.signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(rec.signature)))continue;
    const packet=JSON.parse(rec.payload),n=packet.node;
    if(!n||n.room!==ROOM||n.id+'.json'!==name||!Number.isFinite(n.ts)||now()-n.ts>120000||n.ts>now()+30000)continue;
    const prev=peers.get(n.id);if(!prev||prev.transport==='sync'||now()-prev.lastSeen>OFFLINE_AFTER_MS)remember({...n,transport:'sync',host:null,updatePort:null});
    for(const m of (Array.isArray(packet.messages)?packet.messages:[]))if(m.nodeId===n.id&&typeof m.text==='string'&&m.text.length<=500)pushMessage(m);
   }catch{}
  }
 }catch(e){console.error('mesh sync:',e.code||e.message)}finally{bridgeBusy=false}
}
setInterval(syncBridge,5000).unref();
const sock=dgram.createSocket({type:'udp4',reuseAddr:true});
function send(packet){if(standby)return;const b=Buffer.from(JSON.stringify(packet));try{sock.send(b,UDP_PORT,'255.255.255.255')}catch{}}
sock.on('message',(buf,rinfo)=>{if(standby)return;try{const p=JSON.parse(buf),node=p.node?{...p.node,host:rinfo.address,transport:'lan'}:null;if(p.kind==='presence')remember(node);if(p.kind==='chat'){remember(node);pushMessage(p.message)}}catch{}});
sock.on('error',e=>console.error('mesh udp',e.message));
sock.bind(UDP_PORT,()=>{try{sock.setBroadcast(true)}catch{}});
setInterval(()=>{if(standby)return;remember(localInfo());sweep();send({kind:'presence',node:localInfo()})},5000).unref();

function totals(list){const t={equitySol:0,sessionPnlSol:0,trades:0,signals:0,jobs:0,nodes:0};for(const p of list){if(!p.online)continue;t.nodes++;t.equitySol+=Number(p.situation?.equitySol||0);t.sessionPnlSol+=Number(p.situation?.sessionPnlSol||0);t.trades+=Number(p.contribution?.trades||0);t.signals+=Number(p.contribution?.signals||0);t.jobs+=Number(p.contribution?.jobs||0)}t.equitySol=+t.equitySol.toFixed(4);t.sessionPnlSol=+t.sessionPnlSol.toFixed(4);return t}
function state(){remember(localInfo());sweep();const list=[...peers.values()].sort((a,b)=>(b.online-a.online)||a.name.localeCompare(b.name));return{room:ROOM,self:localInfo(),peers:list,totals:totals(list),events:events.slice(-120),messages:messages.slice(-120),ts:now()};}
function body(req){return new Promise(resolve=>{let s='',tooLarge=false;req.on('data',c=>{if(tooLarge)return;s+=c;if(s.length>8192)tooLarge=true});req.on('end',()=>{if(tooLarge)return resolve({__error:'body too large'});try{const parsed=JSON.parse(s||'{}');resolve(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{__error:'JSON body must be an object'})}catch{resolve({__error:'invalid JSON'})}})})}
const api=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
 if(req.method==='GET'&&req.url==='/state')return res.end(JSON.stringify(state()));
 if(req.method==='POST'&&req.url==='/chat'){
  const b=await body(req);if(b.__error){res.statusCode=400;return res.end(JSON.stringify({ok:false,error:b.__error}))}const text=String(b.text||'').trim().slice(0,500);if(!text){res.statusCode=400;return res.end(JSON.stringify({ok:false,error:'empty message'}))}
  const m={id:`${nodeId}-${now()}-${++seq}`,nodeId,name:displayName,text,room:ROOM,ts:now()};pushMessage(m);send({kind:'chat',node:localInfo(),message:m});return res.end(JSON.stringify({ok:true,message:m}));
 }
 res.statusCode=404;res.end(JSON.stringify({error:'not found'}));
});
// A second supervisor (dev run next to the packaged app, or an adopted engine) must not crash-loop
// on EADDRINUSE. Stand by quietly, stop broadcasting a duplicate presence, and retry until the
// other mesh goes away so the surviving process takes over.
function listenWithRetry(server,port,host,label,onUp,controlsStandby=false){
 server.on('error',e=>{
  if(e.code!=='EADDRINUSE'){console.error(`mesh ${label}`,e.message);return}
  if(controlsStandby&&!standby){standby=true;console.log(`MONEY PRINTER NETWORK ${label} port ${port} already served by another mesh; standing by`)}
  else if(!controlsStandby)console.log(`MONEY PRINTER NETWORK ${label} port ${port} in use; retrying in ${LISTEN_RETRY_MS/1000}s`);
  setTimeout(()=>{if(!server.listening)server.listen(port,host)},LISTEN_RETRY_MS).unref();
 });
 server.on('listening',()=>{if(controlsStandby){standby=false;send({kind:'presence',node:localInfo()})}onUp()});
 server.listen(port,host);
}
listenWithRetry(api,HTTP_PORT,'127.0.0.1','api',()=>console.log(`MONEY PRINTER NETWORK mesh udp:${UDP_PORT} api:${HTTP_PORT} room:${ROOM}`),true);

if(APP_ASAR){
 // Electron wraps fs calls for paths containing `.asar` and treats the archive path itself
 // as an archive *directory*. Toggle noAsar while reading the raw archive bytes so peers can
 // hash/download the actual package instead of crashing the mesh process on the empty path.
 function readRawAppAsar(){
  const previous=process.noAsar;process.noAsar=true;
  try{return fs.readFileSync(APP_ASAR)}finally{process.noAsar=previous}
 }
 // Hash once per archive version; peers poll the manifest and re-hashing a large asar each time is wasteful.
 let manifestCache={stamp:'',value:null};
 function manifest(){
  const previous=process.noAsar;process.noAsar=true;let stamp='';
  try{const st=fs.statSync(APP_ASAR);stamp=`${Math.trunc(st.mtimeMs)}:${st.size}`}finally{process.noAsar=previous}
  if(manifestCache.value&&manifestCache.stamp===stamp)return manifestCache.value;
  const buf=readRawAppAsar();
  manifestCache={stamp,value:{version:APP_VERSION,sha256:crypto.createHash('sha256').update(buf).digest('hex'),size:buf.length}};
  return manifestCache.value;
 }
 const update=http.createServer((req,res)=>{
  try{
   if(req.method==='GET'&&req.url==='/update/manifest'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});const m={...manifest()},key=process.env.CLUSTER_TOKEN||'';if(key)m.signature=crypto.createHmac('sha256',key).update(`${m.version}:${m.sha256}:${m.size}`).digest('hex');return res.end(JSON.stringify(m));
   }
   if(req.method==='GET'&&req.url==='/update/app.asar'){
    const buf=readRawAppAsar();res.writeHead(200,{'content-type':'application/octet-stream','content-length':buf.length,'cache-control':'no-store'});return res.end(buf);
   }
   res.writeHead(404);res.end('not found');
  }catch(e){console.error('mesh update',e.message);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'update unavailable'}));}
 });
 listenWithRetry(update,UPDATE_PORT,'0.0.0.0','update',()=>console.log(`MONEY PRINTER UPDATE peer:${UPDATE_PORT} version:${APP_VERSION}`));
}

if(process.env.MONEY_PRINTER_SUPERVISED==='1'){process.stdin.on('end',()=>process.exit(0));process.stdin.resume()}
