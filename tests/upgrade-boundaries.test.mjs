import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const {navigationPolicy}=createRequire(import.meta.url)('../desktop/navigation-policy.cjs');
test('Electron navigation uses exact local origins and a safe external protocol allowlist',()=>{
 const base='http://127.0.0.1:8792';
 assert.equal(navigationPolicy(base+'/','http://127.0.0.1:8792'),'local');
 assert.equal(navigationPolicy('https://docs.kalshi.com',base),'external');
 assert.notEqual(navigationPolicy(base+'0/',base),'local');
 for(const u of ['file:///C:/Windows/system32/calc.exe','javascript:alert(1)','ms-settings:privacy','data:text/html,evil','https://user:pass@example.com'])assert.equal(navigationPolicy(u,base),'deny');
});
test('legacy dashboard mutations refuse foreign origins, rebinding hosts and non-JSON before side effects',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-boundary-'));
 Object.assign(process.env,{MONEY_PRINTER_DATA_DIR:dir,MPO_COMPUTE_BUDGET_FILE:path.join(dir,'lease.json'),DASHBOARD_PORT:'0',DASHBOARD_HOST:'127.0.0.1',MODE:'paper',POLYMARKET_AUTOSTART:'false',ROBINHOOD_AUTOSTART:'false',ROBINHOOD_PRACTICE_AUTOSTART:'false',POLYMARKET_US_COMBO_BBO:'false'});
 const native=globalThis.fetch;let outbound=0;globalThis.fetch=(url,init)=>{if(new URL(url).hostname!=='127.0.0.1'){outbound++;throw Error('Unexpected external call')}return native(url,init)};
 const {startDashboard}=await import('../src/dashboard.js'),{productEconomics}=await import('../src/productEconomics.js');
 const server=startDashboard();if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));productEconomics().close();globalThis.fetch=native;fs.rmSync(dir,{recursive:true,force:true})});
 for(const route of ['/api/pause','/api/kill','/api/reset','/api/runtime','/api/enter?mint=x','/api/exit?mint=x','/api/update/install','/api/polymarket-us/combos/place']){
  for(const patch of [{origin:'https://example.com'},{'content-type':'text/plain'},{host:'rebound.example'},{origin:base,'sec-fetch-site':'cross-site'}]){
   const status=await new Promise((resolve,reject)=>{const req=http.request(base+route,{method:'POST',headers:{'content-type':'application/json',...patch}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end('{}')});
   assert.equal(status,403,route+' '+JSON.stringify(patch));
  }
 }
 const ok=await fetch(base+'/api/desktop-prefs',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({runInBackground:false,autoStartLab:false})});
 assert.equal(ok.status,200);const prefs=(await ok.json()).prefs;assert.equal(prefs.runInBackground,false);assert.equal(prefs.autoStartLab,false);assert.equal(outbound,0);
 assert.equal(fs.existsSync(path.join(dir,'update-request.json')),false);
});
