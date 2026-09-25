import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-http-'));
Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:path.join(root,'data'),DASHBOARD_PORT:'0',DASHBOARD_HOST:'127.0.0.1',MODE:'paper',POLYMARKET_AUTOSTART:'false',POLYMARKET_AUTOPILOT:'false',ROBINHOOD_AUTOSTART:'false',ROBINHOOD_API_KEY:'',ROBINHOOD_PRIVATE_KEY:'',ROBINHOOD_REAL_ENABLED:'false'});
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,...rest)=>{assert.equal(new URL(url).hostname,'127.0.0.1','External requests are disabled in HTTP tests');return nativeFetch(url,...rest)};
const {startDashboard}=await import('../src/dashboard.js');
const {productEconomics}=await import('../src/productEconomics.js');
const server=startDashboard();if(!server.listening)await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
const post=(route,value={},headers={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));productEconomics().close();globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});
test('snapshot and readiness endpoints work without keys and keep live execution unavailable',async()=>{
 const r=await fetch(base+'/api/robinhood');assert.equal(r.status,200);const s=await r.json();assert.equal(s.readiness.execution,'paper-only');assert.equal(s.readiness.sessionArmed,false);assert.equal(s.paper.cashUsd,1000);
 assert.deepEqual(Object.keys(s),['at','readiness','account','pairs','quotes','tape','paper','journal','limits','qualificationThresholds','strategy','loop','equities','lastError']);
 const readiness=await (await fetch(base+'/api/robinhood/readiness')).json();assert.equal(readiness.credentialsReady,false);
});
test('unsupported live actions cannot dispatch orders or change credentials',async()=>{for(const action of ['order','arm','cancel','cancel-all','forget','autopilot','autopilot/run','config']){const r=await post('/api/robinhood/'+action,{armed:true,enabled:true});assert.equal(r.status,404)}assert.equal(process.env.ROBINHOOD_API_KEY,'')});
test('cross-origin, DNS-rebinding hosts and non-JSON mutations are rejected',async()=>{
 assert.equal((await post('/api/robinhood/paper-reset',{}, {origin:'https://example.com'})).status,403);
 const reboundStatus=await new Promise((resolve,reject)=>{http.get(base+'/api/robinhood',{headers:{Host:'example.com'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))}).on('error',reject)});assert.equal(reboundStatus,403);
 assert.equal((await fetch(base+'/api/robinhood/paper-reset',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,403);
});
test('paper reset requires exact confirmation and preserves its new starting bank',async()=>{
 assert.equal((await post('/api/robinhood/paper-reset',{amountUsd:2000})).status,400);
 const r=await post('/api/robinhood/paper-reset',{amountUsd:2000,confirmation:'RESET PAPER'});assert.equal(r.status,200);assert.equal((await r.json()).result.cashUsd,2000);
 const s=await (await fetch(base+'/api/robinhood')).json();assert.equal(s.paper.startUsd,2000);assert.equal(s.paper.autopilot.enabled,false);
});
test('invalid JSON, oversized bodies, unknown routes and missing-key paper buys fail cleanly',async()=>{
 for(const body of ['{','['+'0,'.repeat(20000)+'0]']){const r=await fetch(base+'/api/robinhood/paper-order',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(r.status,400)}
 assert.equal((await post('/api/robinhood/does-not-exist')).status,404);
 const r=await post('/api/robinhood/paper-order',{symbol:'BTC-USD',usd:10});assert.equal(r.status,400);assert.equal((await r.json()).code,'noCredentials');
});
test('paper panel ships inline, preserves desktop layout and has no live-order buttons',async()=>{
 const html=await (await fetch(base+'/')).text();const panel=fs.readFileSync(new URL('../public/assets/robinhood-panel.js',import.meta.url),'utf8');
 const embedded=html.split('// BEGIN ROBINHOOD PAPER PANEL\n')[1].split('// END ROBINHOOD PAPER PANEL')[0];assert.equal(embedded.trim(),panel.trim());
 assert.match(html,/\['robinhood','Robinhood Auto Trader','RH','dark'\]/);assert.match(html,/DEFAULT_OPEN=\['trade','sportsbook','system'\]/);assert.match(html,/LAYOUT_VERSION='2026-09-14-alpha40-consolidated'/);
 assert.doesNotMatch(panel,/rhAction\('(order|cancel|arm|autopilot)'/);assert.match(panel,/REAL EXECUTION UNAVAILABLE/);assert.match(panel,/confirmation==='RESET PAPER'/);
 const code=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));assert.doesNotThrow(()=>new vm.Script(code));assert.doesNotThrow(()=>new vm.Script(panel));
});
test('automatic panel refresh cannot replace a focused input',()=>{
 const panel=fs.readFileSync(new URL('../public/assets/robinhood-panel.js',import.meta.url),'utf8');let renders=0;
 const context=vm.createContext({document:{getElementById:()=>({}),activeElement:{id:'rhUsd'}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0);
});
