// Isolated browser smoke test. All venue responses are synthetic GETs; no real app data is loaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateRobinhoodKeyPair} from '../src/robinhoodSigner.js';
const root=fileURLToPath(new URL('../',import.meta.url)),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-browser-'));
const output=path.resolve(process.argv[2]||path.join(root,'reports','robinhood-paper-smoke.png'));
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
 await command('Page.enable');await command('Runtime.enable');await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await command('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('mpo-layout-version','2026-09-14-alpha40-consolidated');localStorage.setItem('mpo-open',JSON.stringify(['robinhood']));"});
 await command('Page.navigate',{url:base});await waitFor("typeof rhState!=='undefined' && rhState?.paper && typeof openApp==='function'");
 await evaluate("document.getElementById('boot').style.display='none';openApp('robinhood');renderRobinhood(true);");
 await evaluate("document.getElementById('rhBuy').click()");await waitFor('!rhSubmitting && rhState.paper.positions.length===1');
 await evaluate("document.getElementById('rhUsd').focus();document.getElementById('rhUsd').value='17';refreshRobinhood()");await waitFor('!rhRefreshBusy');
 assert.equal(await evaluate("document.activeElement.id==='rhUsd' && document.getElementById('rhUsd').value==='17'"),true,'Refresh replaced a focused draft');
 await evaluate("document.getElementById('rhBuy').click()");await waitFor('!rhSubmitting && /already exists/.test(rhMessage)');
 assert.equal(await evaluate('rhState.paper.positions.length'),1);
 await evaluate("document.querySelector('[data-rh-close]').click()");await waitFor('!rhSubmitting && rhState.paper.positions.length===0 && rhState.paper.history.length===1');
 assert.equal(await evaluate('rhState.paper.qualification.closes'),0,'Manual trades counted toward research qualification');
 await evaluate("document.getElementById('rhToggle').click()");await waitFor('!rhSubmitting && rhState.paper.autopilot.enabled');
 await evaluate("document.getElementById('rhTick').click()");await waitFor('!rhSubmitting && rhState.tape[\'BTC-USD\'].n===1');
 await evaluate("document.getElementById('rhToggle').click()");await waitFor('!rhSubmitting && !rhState.paper.autopilot.enabled');
 await evaluate("document.getElementById('rhBank').value='2000';document.getElementById('rhResetConfirm').value='RESET PAPER';document.getElementById('rhReset').click()");
 await waitFor('!rhSubmitting && rhState.paper.cashUsd===2000 && rhState.paper.history.length===0');
 assert.equal(await evaluate('rhState.readiness.liveExecutionAvailable'),false);
 await evaluate("const w=document.querySelector('.window[data-app=robinhood]');Object.assign(w.style,{left:'110px',top:'30px',width:'1210px',height:'1000px'});w.style.zIndex='99';document.getElementById('body-robinhood').scrollTop=0;");
 fs.mkdirSync(path.dirname(output),{recursive:true});const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(output,Buffer.from(shot.data,'base64'));
 assert.equal(errors.length,0,'Browser runtime errors: '+errors.join('; '));
 console.log(JSON.stringify({ok:true,checks:['panel renders','paper buy','focused draft survives refresh','duplicate refused','paper close','manual history excluded from qualification','paper start/sample/stop','confirmed reset','live execution unavailable','no browser runtime exceptions'],venueRequests:venueRequests.length,venueWrites:0,screenshot:output},null,2));
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
