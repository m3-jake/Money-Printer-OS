// Isolated visual/performance fixture: serves only synthetic read-only API responses.
// No trader modules, credentials, installed app data, or order transports are loaded.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../public/',import.meta.url));
const baseline=fs.readFileSync(path.join(root,'dashboard.html'),'utf8');
const port=Number(process.env.HUD_FIXTURE_PORT||18767);
const inject=`<script>
(()=>{const fault=new URLSearchParams(location.search).get('fault');
if(['corrupt','quota','denied'].includes(fault)){const data=new Map([['mpo-layout','{"trade":{"x":80,"y":"damaged","w":700,"h":600},"command":{"x":280,"y":100,"w":720,"h":600}}'],['mpo-open',fault==='corrupt'?'{}':'["trade","command"]'],['mpo-tabs','[]'],['mpo-detail','{}'],['mpo-size-migrated-0927','true']]);Object.defineProperty(window,'localStorage',{get(){if(fault==='denied')throw new DOMException('Access blocked','SecurityError');return{getItem:k=>data.get(k)??null,setItem(k,v){if(fault==='quota')throw new DOMException('Storage full','QuotaExceededError');data.set(k,v)},removeItem:k=>data.delete(k)}}})}
if(fault==='disconnect'){const original=window.fetch;let calls=0;window.fetch=(u,o)=>u==='/api/state'&&++calls>1?Promise.resolve(new Response('{"error":"fixture disconnect"}',{status:503,headers:{'content-type':'application/json'}})):original(u,o)}
})();
(()=>{const frames=[],feedback=[],renders=[],errors=[],longTasks=[];let last=0;
window.addEventListener('error',e=>errors.push(e.message));
try{new PerformanceObserver(l=>longTasks.push(...l.getEntries().map(x=>x.duration))).observe({entryTypes:['longtask']})}catch{}
const tick=t=>{if(last&&frames.length<10000)frames.push(t-last);last=t;requestAnimationFrame(tick)};requestAnimationFrame(tick);
document.addEventListener('click',()=>{const t=performance.now();requestAnimationFrame(()=>feedback.push(performance.now()-t))},true);
document.addEventListener('DOMContentLoaded',()=>{
const output=document.createElement('output');output.id='hud-fixture-metrics';output.style='position:fixed;right:8px;bottom:40px;z-index:999999;font:10px monospace;background:#fff;color:#000;max-width:480px;padding:4px';document.body.append(output);
if(typeof renderAll==='function'){const original=renderAll;renderAll=function(...a){const t=performance.now();try{return original(...a)}finally{renders.push(performance.now()-t)}}}
const pct=(a,p)=>a.length?+a.slice().sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*p))].toFixed(2):null;
setInterval(()=>{output.textContent=JSON.stringify({fixture:'SYNTHETIC / NO ORDERS',frames:frames.length,frameP50:pct(frames,.5),frameP95:pct(frames,.95),frameP99:pct(frames,.99),over50ms:frames.filter(x=>x>50).length,interactionCount:feedback.length,interactionP95:pct(feedback,.95),renders:renders.length,renderP95:pct(renders,.95),longTasks:longTasks.length,errors})},1000);
});})();</script>`;
const now=Date.now();
const state={mode:'paper',build:{version:'HUD-FIXTURE'},paperStartSol:10,portfolio:{equitySol:10,cashSol:10,positionsValueSol:0,unrealizedPnlSol:0},portfolioSeries:Array.from({length:800},(_,i)=>({ts:now-(800-i)*1000,equitySol:10,price:100+Math.sin(i/20)})),positions:[],watchlist:[],system:{health:'OK',metrics:{},lastCycle:now},config:{},runtime:{},evolutionLoop:{status:'WAITING FOR DATA'},walletIntel:{wallets:[]}};
const json=(res,v,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v))};
http.createServer((req,res)=>{
const url=new URL(req.url,'http://127.0.0.1');
if(req.method!=='GET')return json(res,{error:'Read-only fixture: mutations forbidden'},405);
if(url.pathname.startsWith('/api/')){
 if(url.pathname==='/api/state')return json(res,state);
 if(url.pathname==='/api/network')return json(res,{peers:[],messages:[],events:[]});
 if(url.pathname==='/api/journal')return json(res,[]);
 if(url.pathname==='/api/project-journal')return json(res,{rows:[]});
 if(url.pathname==='/api/platform/status')return json(res,{risk:{state:'PAPER_ONLY',stateReasons:['Synthetic fixture'],halted:false,limits:{}},portfolio:{accounts:[],positions:[],totalsByCurrency:{}},coverage:{note:'Synthetic read-only fixture.'},database:{status:'FIXTURE',ledgerEntries:0},eventBus:{},providers:[],strategies:[],modules:[],proposals:[],ledger:[],events:[]});
 if(url.pathname==='/api/platform/entities')return json(res,{entities:[]});
 if(url.pathname==='/api/platform/events')return json(res,{pages:[],errors:[],counts:{}});
 if(url.pathname==='/api/scoreboard')return json(res,{summary:{beating:0,notBeating:0,notEnoughData:0,outlierDriven:0,stale:0},rows:[],rules:'Synthetic fixture; no performance claim.'});
 if(url.pathname==='/api/platform/diagnostics')return json(res,{sources:[],eventBus:{},database:{tables:{}},caches:{},process:{}});
 return json(res,{});
}
const file=path.resolve(root,url.pathname==='/'||url.pathname==='/before'?'dashboard.html':'.'+decodeURIComponent(url.pathname));
if(!file.startsWith(root)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end()}
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});
if(file.endsWith('.html'))return res.end((url.pathname==='/before'?baseline:fs.readFileSync(file,'utf8')).replace('<head>','<head>'+inject));
fs.createReadStream(file).pipe(res);
}).listen(port,'127.0.0.1',()=>console.log('Isolated HUD fixture http://127.0.0.1:'+port));
