import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
import { generateRobinhoodKeyPair } from '../src/robinhoodSigner.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-rh-http-'));
Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:path.join(root,'data'),DASHBOARD_PORT:'0',DASHBOARD_HOST:'127.0.0.1',MODE:'paper',POLYMARKET_AUTOSTART:'false',POLYMARKET_AUTOPILOT:'false',ROBINHOOD_AUTOSTART:'false',ROBINHOOD_API_KEY:'',ROBINHOOD_PRIVATE_KEY:'',ROBINHOOD_REAL_ENABLED:'false'});
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,...rest)=>{
 const u=new URL(url);
 if(u.hostname==='127.0.0.1')return nativeFetch(url,...rest);
 if(u.hostname==='api.exchange.coinbase.com'){
  const init=rest[0]||{};assert.equal(init.method,'GET');
  const m=u.pathname.match(/^\/products\/([A-Z0-9-]+)(\/book)?$/);assert.ok(m,'Only public product/book reads are allowed');
  const symbol=m[1];if(m[2])return Promise.resolve({ok:true,status:200,json:async()=>({bids:[['100','1',1]],asks:[['100.1','1',1]],time:new Date().toISOString()})});
  return Promise.resolve({ok:true,status:200,json:async()=>({id:symbol,base_increment:'0.00000001',quote_increment:'0.01',status:'online',trading_disabled:false})});
 }
 assert.fail('External requests are disabled in HTTP tests: '+u.hostname);
};
const {startDashboard}=await import('../src/dashboard.js');
const server=startDashboard();if(!server.listening)await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
const post=(route,value={},headers={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));globalThis.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})});
test('snapshot and readiness endpoints work without keys and boot disarmed',async()=>{
 const r=await fetch(base+'/api/robinhood');assert.equal(r.status,200);const s=await r.json();assert.equal(s.readiness.execution,'paper-only');assert.equal(s.readiness.paperOnlyBuild,true);assert.equal(s.readiness.realEnabled,false);assert.deepEqual(s.strategy.primary,{symbol:'BTC-USD',weight:1.5,orderMult:1});assert.equal(s.readiness.sessionArmed,false);assert.equal(s.paper.cashUsd,25);
 assert.deepEqual(Object.keys(s),['at','readiness','outbound','account','pairs','quotes','tape','paper','practice','daily','journal','limits','qualificationThresholds','strategy','loop','equities','evolve','explore','gauges','lastError']);
 const readiness=await (await fetch(base+'/api/robinhood/readiness')).json();assert.equal(readiness.credentialsReady,false);
});
test('daily-bar book routes: read-only snapshot, reset needs the typed phrase, paper only',async()=>{
 const r=await fetch(base+'/api/robinhood/daily');assert.equal(r.status,200);const d=await r.json();
 assert.equal(d.execution,'paper-only');assert.equal(d.liveEligible,false);assert.equal(d.source.kind,'lab-default');assert.match(d.label,/NOT A QUALIFIED STRATEGY/);
 let p=await post('/api/robinhood/daily/reset',{confirmation:'reset'});assert.equal(p.status,400);assert.equal((await p.json()).code,'confirmation');
 p=await post('/api/robinhood/daily/reset',{confirmation:'RESET DAILY'});assert.equal(p.status,200);assert.equal((await p.json()).result.book.equityUsd,25);
 const s=await (await fetch(base+'/api/robinhood')).json();assert.equal(s.daily.execution,'paper-only');
});
test('real routes stay hard-locked while credential configuration remains paper-safe',async()=>{
 let r=await post('/api/robinhood/config',{apiKey:'x',privateKey:'y'});assert.equal(r.status,400);assert.equal((await r.json()).code,'validation');
 r=await post('/api/robinhood/config',{apiKey:'rh-api-11111111-2222-3333-4444-555555555555',privateKey:Buffer.alloc(16,1).toString('base64')});assert.equal(r.status,400);assert.equal((await r.json()).code,'badKey');assert.equal(process.env.ROBINHOOD_API_KEY,'');
 r=await post('/api/robinhood/order',{symbol:'BTC-USD',usd:10,confirmation:'PLACE REAL CRYPTO ORDER'});assert.equal(r.status,400);assert.equal((await r.json()).code,'paperOnly');
 r=await post('/api/robinhood/arm',{armed:true});assert.equal(r.status,400);assert.equal((await r.json()).code,'paperOnly');
 const pair=generateRobinhoodKeyPair();
 r=await post('/api/robinhood/config',{apiKey:'rh-api-11111111-2222-3333-4444-555555555555',privateKey:pair.privateKeyBase64,realEnabled:true});assert.equal(r.status,200);
 let body=await r.json();assert.equal(body.result.paperOnlyBuild,true);assert.equal(body.result.realEnabled,false);assert.equal(process.env.ROBINHOOD_REAL_ENABLED,'false');
 process.env.ROBINHOOD_REAL_ENABLED='true';
 r=await post('/api/robinhood/arm',{armed:true});assert.equal((await r.json()).code,'paperOnly');
 r=await post('/api/robinhood/order',{symbol:'BTC-USD',usd:10,confirmation:'PLACE REAL CRYPTO ORDER'});assert.equal((await r.json()).code,'paperOnly');
 r=await post('/api/robinhood/cancel-all',{confirmation:'CANCEL REAL CRYPTO ORDERS'});assert.equal((await r.json()).code,'paperOnly');
 r=await post('/api/robinhood/reconcile',{});assert.equal((await r.json()).code,'paperOnly');
 r=await post('/api/robinhood/autopilot',{enabled:true,confirmation:'ENABLE REAL CRYPTO AUTOPILOT'});assert.equal((await r.json()).code,'paperOnly');
 r=await post('/api/robinhood/autopilot/run',{});assert.equal(r.status,200);assert.equal((await r.json()).result.reason,'paperOnly');
 const s=await (await fetch(base+'/api/robinhood')).json();assert.equal(s.readiness.realEnabled,false);assert.equal(s.readiness.sessionArmed,false);assert.equal(JSON.stringify(s).includes(pair.privateKeyBase64),false);
 Object.assign(process.env,{ROBINHOOD_API_KEY:'',ROBINHOOD_PRIVATE_KEY:'',ROBINHOOD_REAL_ENABLED:'false'});
});
test('evolution routes: GET ledger view, manual run refuses without tape, apply refuses without a champion (paper-only)',async()=>{
 const r=await fetch(base+'/api/robinhood/evolve');assert.equal(r.status,200);const v=await r.json();
 for(const k of ['enabled','generation','champion','proposed','tapeDays','lastRunAt','autopromote','minGainPct','intervalMin','candidates','history','events','currentParamsHash'])assert.ok(k in v,k);
 assert.equal(v.autopromote,false);assert.equal(v.generation,0);assert.equal(v.proposed,null);assert.deepEqual(Object.keys(v.tapeDays),['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','XRP-USD','AVAX-USD','LINK-USD','ADA-USD']);
 let p=await post('/api/robinhood/evolve/run',{});assert.equal(p.status,200);const run=await p.json();assert.equal(run.ok,true);assert.equal(run.result.ran,false);assert.equal(run.result.reason,'insufficientTape');
 p=await post('/api/robinhood/evolve/apply',{});assert.equal(p.status,400);assert.equal((await p.json()).code,'notFound');
 p=await post('/api/robinhood/evolve/apply',{paramsHash:'abc'});assert.equal(p.status,400);assert.equal((await p.json()).code,'notFound');
 assert.equal((await fetch(base+'/api/robinhood/evolve/run')).status,404,'run is POST only');
 const s=await (await fetch(base+'/api/robinhood')).json();assert.equal(s.evolve.generation,0);assert.equal(s.paper.autopilot.enabled,false);
});
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
test('invalid JSON and unknown routes fail cleanly; missing Robinhood keys still permit simulated paper buys',async()=>{
 for(const body of ['{','['+'0,'.repeat(20000)+'0]']){const r=await fetch(base+'/api/robinhood/paper-order',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(r.status,400)}
 assert.equal((await post('/api/robinhood/does-not-exist')).status,404);
 const r=await post('/api/robinhood/paper-order',{symbol:'BTC-USD',usd:10});assert.equal(r.status,200);const body=await r.json();assert.equal(body.result.position.quoteSource,'coinbase-public-paper');
});
test('panel ships inline, preserves desktop layout and has no real-money routes (paper-only HUD, 2026-10-02)',async()=>{
 // Line endings are normalized before the marker split: the checkout may be CRLF (core.autocrlf=true),
 // which is not a difference in the panel itself (P1.4).
 const lf=s=>s.replace(/\r\n/g,'\n');
 const html=lf(await (await fetch(base+'/')).text()),panel=lf(fs.readFileSync(new URL('../public/assets/robinhood-panel.js',import.meta.url),'utf8'));
 const embedded=html.split('// BEGIN ROBINHOOD PAPER PANEL\n')[1].split('// END ROBINHOOD PAPER PANEL')[0];assert.equal(embedded.trim(),panel.trim());
 assert.match(html,/\['robinhood','Robinhood','RH','dark'\]/);assert.match(html,/DEFAULT_OPEN=\[\]/);assert.match(html,/LAYOUT_VERSION='2026-09-26-glance'/);
 for(const a of ['config','evolve/run','evolve/apply','paper-order','paper-reset'])assert.ok(panel.includes("rhAction('"+a+"'"),a);for(const a of ['order','cancel','cancel-all','forget','arm','preview','reconcile','autopilot','autopilot/run'])assert.ok(!panel.includes("rhAction('"+a+"'"),a);assert.match(panel,/confirmation==='RESET PAPER'/);
 for(const phrase of ['PLACE REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDERS','ENABLE REAL CRYPTO AUTOPILOT'])assert.doesNotMatch(panel,new RegExp('value="'+phrase+'"'),'phrases are never pre-filled');assert.doesNotMatch(panel,/sessionStorage/);assert.deepEqual([...panel.matchAll(/rhSave\('([^']+)'/g)].map(m=>m[1]).sort(),['mpo-rh-chart','mpo-rh-view']);assert.equal((panel.match(/localStorage\.setItem/g)||[]).length,1);assert.match(panel,/rhSave\('mpo-rh-chart',\{range:rhChart.range,symbol:rhChart.symbol\}\)/);assert.match(panel,/rhSave\('mpo-rh-view',rhView\)/);
 const code=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));assert.doesNotThrow(()=>new vm.Script(code));assert.doesNotThrow(()=>new vm.Script(panel));
});
test('automatic panel refresh cannot replace a focused input',()=>{
 const panel=fs.readFileSync(new URL('../public/assets/robinhood-panel.js',import.meta.url),'utf8');let renders=0;
 const context=vm.createContext({document:{getElementById:()=>({}),activeElement:{id:'rhUsd'}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0);
});
