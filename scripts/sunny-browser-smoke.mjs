// Isolated browser smoke test. All venue responses are synthetic GETs; no real app data is loaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateRobinhoodKeyPair} from '../src/robinhoodSigner.js';
const root=fileURLToPath(new URL('../',import.meta.url)),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-layout-browser-'));
const output=path.resolve(process.argv[2]||path.join(root,'reports','sunny-desktop-smoke.png'));
const nativeFetch=globalThis.fetch,venueRequests=[];let browser,server,ws;
Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:path.join(scratch,'data'),ROBINHOOD_API:'https://rh.test',ROBINHOOD_API_KEY:'browser-test-only',ROBINHOOD_PRIVATE_KEY:generateRobinhoodKeyPair().privateKeyBase64,ROBINHOOD_AUTOSTART:'false',POLYMARKET_AUTOSTART:'false',ROBINHOOD_REAL_ENABLED:'false'});
globalThis.fetch=async(url,init={})=>{
 const u=new URL(url);assert.equal(u.origin,'https://rh.test');assert.equal(init.method,'GET');venueRequests.push(u.pathname);let data;
 if(u.pathname.endsWith('/accounts/'))data={results:[{account_number:'SIMULATED-1234',status:'active',buying_power:'500',is_api_tradable:true,fee_tier_status:{fee_ratio:0.0085}}]};
 else if(u.pathname.endsWith('/trading_pairs/'))data={results:u.searchParams.getAll('symbol').map(symbol=>({symbol,asset_code:symbol.split('-')[0],asset_increment:'0.000001',quote_increment:'0.01',min_order_amount:'1',max_order_size:'100',status:'tradable',is_api_tradable:true}))};
 else if(u.pathname.endsWith('/best_bid_ask/'))data={results:u.searchParams.getAll('symbol').map(symbol=>({symbol,bid:100,ask:100.1}))};
 else throw Error('Unexpected mock request '+u.pathname);
 return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(data)};
};
const RH=await import('../src/robinhoodHttp.js');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))};
const body=async req=>{let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)return {__error:'body too large'}}try{return JSON.parse(text||'{}')}catch{return {__error:'invalid JSON'}}};
const errors=[],pending=new Map();let seq=0;
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value}
async function waitFor(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(100)}throw Error('UI timeout: '+expression)}
try{
 server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://127.0.0.1');if(u.pathname.startsWith('/api/robinhood'))return await RH.handleRobinhoodRequest(req,res,u,{json,body});
  if(u.pathname.startsWith('/api/'))return json(res,u.pathname==='/api/journal'?[]:{});
  const base=path.join(root,'public'),file=path.resolve(base,u.pathname==='/'?'dashboard.html':'.'+decodeURIComponent(u.pathname));
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end()}
  const types={'.html':'text/html','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
  res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);
 }catch(e){json(res,{error:String(e)},500)}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const candidates=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];const chrome=candidates.find(x=>x&&fs.existsSync(x));if(!chrome)throw Error('Set CHROME_PATH to an installed Chromium browser');
 const profile=path.join(scratch,'profile');
 browser=spawn(chrome,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','--disable-extensions','--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost','about:blank'],{stdio:'ignore'});
 const active=path.join(profile,'DevToolsActivePort');for(let i=0;i<100&&!fs.existsSync(active);i++)await delay(100);assert.ok(fs.existsSync(active),'Browser debug endpoint did not start');
 const port=Number(fs.readFileSync(active,'utf8').split('\n')[0]),targets=await (await nativeFetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)});
 await command('Page.enable');await command('Runtime.enable');
 const viewport=async(width,height)=>{await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(200)};
 await viewport(2560,1440);
 await command('Page.navigate',{url:base});await waitFor("typeof openApp==='function' && document.querySelectorAll('.window').length>0");
 await evaluate("document.getElementById('boot').style.display='none';openApp('trade');openApp('robinhood')");
 assert.equal(await evaluate("document.getAnimations().filter(a=>a.animationName==='skyDrift').length"),11);
 // Exercise actual pointer handlers; geometry is saved only after a user drag/resize.
 const drag=async(x,y,toX,toY)=>{await command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:toX,y:toY,button:'left',buttons:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:toX,y:toY,button:'left',clickCount:1})};
 const box=()=>evaluate("(()=>{const r=document.querySelector('.window[data-app=robinhood]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()");
 let r=await box();await drag(r.x+120,r.y+12,r.x+600,r.y+112);
 r=await box();await drag(r.x+r.w-3,r.y+r.h-3,r.x+r.w+57,r.y+r.h+37);
 const expected=await evaluate("JSON.parse(localStorage.getItem('mpo-layout')).robinhood");
 assert.ok(expected.x>1000,'drag did not save the new spot');
 await evaluate("chartView.range='h1';chartView.zoom=3;saveChartView();rhView='charts';rhSave('mpo-rh-view',rhView);rhChart.range='24h';rhChart.symbol='ETH-USD';rhSaveChart()");
 await command('Page.reload');await delay(700);await waitFor("typeof openApp==='function' && document.querySelectorAll('.window').length>0");
 assert.equal(await evaluate("['trade','robinhood'].every(id=>!document.querySelector('.window[data-app='+id+']').classList.contains('hidden'))"),true);
 assert.deepEqual(await box(),{x:expected.x,y:expected.y,w:expected.w,h:expected.h});
 assert.deepEqual(await evaluate("({range:chartView.range,zoom:chartView.zoom,rhView,rhRange:rhChart.range,symbol:rhChart.symbol})"),{range:'h1',zoom:3,rhView:'charts',rhRange:'24h',symbol:'ETH-USD'});
 await viewport(1536,1024);await evaluate('persist()');
 assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('mpo-layout')).robinhood"),expected,'viewport clamp changed saved geometry');
 await viewport(2560,1440);assert.deepEqual(await box(),{x:expected.x,y:expected.y,w:expected.w,h:expected.h});
 await evaluate("document.querySelector('.window[data-app=robinhood] [data-act=max]').click();persist()");
 assert.equal(await evaluate("JSON.parse(localStorage.getItem('mpo-layout')).robinhood.w"),expected.w,'maximize replaced normal width');
 await command('Page.reload');await delay(700);await waitFor("typeof openApp==='function' && document.querySelectorAll('.window').length>0");
 assert.equal(await evaluate("document.querySelector('.window[data-app=robinhood]').classList.contains('max')"),true);
 await evaluate("document.querySelector('.window[data-app=robinhood] [data-act=max]').click();document.getElementById('boot').style.display='none'");
 assert.deepEqual(await box(),{x:expected.x,y:expected.y,w:expected.w,h:expected.h});
 await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 assert.equal(await evaluate("[...document.querySelectorAll('.sky-cloud')].every(e=>getComputedStyle(e).animationPlayState==='paused')"),true);
 await command('Emulation.setEmulatedMedia',{features:[]});await delay(300);
 fs.mkdirSync(path.dirname(output),{recursive:true});const shot=await command('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:2560,height:1440,scale:0.5}});fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
 assert.equal(errors.length,0,'Browser runtime errors: '+errors.join('; '));
 console.log(JSON.stringify({ok:true,checks:['11 animated clouds','pointer drag/resize persists','two windows reopen','chart choices restore','small viewport preserves intended layout','maximize/reload/restore keeps normal size','reduced motion pauses clouds','no browser exceptions'],screenshot:output},null,2));

}catch(e){
 console.error(e.stack||String(e));console.error('BROWSER_ERRORS',JSON.stringify(errors));
 try{console.error('PAGE',JSON.stringify(await evaluate("({url:location.href,title:document.title,text:document.body.innerText.slice(0,1500),state:typeof rhState,message:typeof rhMessage==='undefined'?null:rhMessage})")));const shot=await command('Page.captureScreenshot',{format:'png'});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,Buffer.from(shot.data,'base64'))}catch{}
 process.exitCode=1;
}
finally{
 RH.stopRobinhoodLoops();if(ws?.readyState===1){try{await command('Browser.close')}catch{}ws.close()}else browser?.kill();
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
 globalThis.fetch=nativeFetch;await delay(500);try{fs.rmSync(scratch,{recursive:true,force:true})}catch{}
}
