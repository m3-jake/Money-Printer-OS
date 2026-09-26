// HUD contract (docs/ROBINHOOD-AUTO-TRADER.md §12, §14 E, §22): the editable panel and its inline desktop copy stay
// byte-identical, the confirmation phrases appear verbatim, every required control and route is present, the desktop
// shell registers the window without touching the layout version, and both scripts parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('public/dashboard.html'),panel=read('public/assets/robinhood-panel.js');
const rx=s=>new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
const PHRASES=['PLACE REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDERS','ENABLE REAL CRYPTO AUTOPILOT'];

test('the synced panel source is embedded byte-for-byte and parses',()=>{
 const embedded=html.split('// BEGIN ROBINHOOD PAPER PANEL\n')[1].split('// END ROBINHOOD PAPER PANEL')[0];
 assert.equal(embedded.trim(),panel.trim(),'run npm run sync:robinhood-panel');
 assert.doesNotThrow(()=>new vm.Script(panel,{filename:'robinhood-panel.js'}));
 const code=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));assert.doesNotThrow(()=>new vm.Script(code,{filename:'dashboard-inline.js'}));
});
test('confirmation phrases appear verbatim, are typed by the operator and never pre-filled',()=>{
 for(const p of PHRASES){assert.match(panel,rx(p));assert.match(html,rx(p));assert.doesNotMatch(panel,new RegExp('value="'+p+'"'))}
 assert.match(panel,/RH_PHRASES=\{place:'PLACE REAL CRYPTO ORDER',cancel:'CANCEL REAL CRYPTO ORDER',cancelAll:'CANCEL REAL CRYPTO ORDERS',autopilot:'ENABLE REAL CRYPTO AUTOPILOT',forget:'FORGET'\}/);
 assert.match(panel,/placeholder="Type PLACE REAL CRYPTO ORDER"/);assert.match(panel,/placeholder="Type ENABLE REAL CRYPTO AUTOPILOT"/);
 assert.match(panel,/confirmation==='RESET PAPER'/);assert.match(panel,/does NOT cancel anything on Robinhood; the coin stays in your account/);
 assert.match(panel,/confirm\.value===RH_PHRASES\.place/,'the Place button gates on the exact phrase client-side too');
 assert.doesNotMatch(panel,/localStorage|sessionStorage/);
});
test('required controls, fieldsets and routes are present',()=>{
 for(const id of ['rhApiKey','rhSecret','rhConfigure','rhArm','rhRealSymbol','rhRealUsd','rhRealType','rhPreviewBtn','rhPreviewOut','rhConfirm','rhPlace','rhCancelAll','rhReconcile','rhApOrderUsd','rhApMaxOpen','rhApLossCap','rhApSymbols','rhAutoConfirm','rhApEnable','rhApDisable','rhApRun','rhSymbol','rhUsd','rhBuy','rhSymbols','rhOrderUsd','rhMaxOpen','rhSave','rhToggle','rhTick','rhParams','rhBank','rhResetConfirm','rhReset','rhEvolveRun','rhEvolveApply'])assert.match(panel,new RegExp('id="'+id+'"'),id);
 for(const attr of ['data-rh-close','data-rh-sell','data-rh-cancel','data-rh-forget'])assert.match(panel,rx(attr));
 for(const a of ['config','arm','preview','order','cancel','cancel-all','forget','reconcile','autopilot','autopilot/run','paper-order','paper-close','paper-reset','paper-autopilot','paper-autopilot/run','evolve/run','evolve/apply'])assert.ok(panel.includes("rhAction('"+a+"'"),a);
 assert.match(panel,/fetch\('\/api\/robinhood'\)/);
 assert.match(panel,/<legend>ROBINHOOD CONNECTION · PAPER-ONLY LOCK<\/legend>/);assert.match(panel,/PAPER-ONLY BUILD/);assert.match(panel,/mpo-danger-fieldset/);assert.match(panel,/Evolution Lab · Robinhood research lane/);assert.match(panel,/Apply Lab candidate to paper/);assert.match(panel,/Lab runs automatically/);
 assert.match(panel,/Agentic Trading MCP/);assert.match(panel,/PRIMARY x/);
 assert.match(panel,/rhAction\('evolve\/apply',\{paramsHash:ev\.proposed\.paramsHash\}/,'apply posts the proposed hash the server validates');
 assert.match(panel,/!ev\.proposed\|\|!evReady/,'Lab proposals stay unapplicable until paper-review gates pass');
 assert.match(panel,/Live Robinhood execution stays locked/);
 assert.doesNotMatch(panel,/#ff7a3d|#1a0e06|mpo-brand-title/);
});
test('desktop shell registers the window, keeps the layout version and leaves Polymarket modules alone',()=>{
 assert.match(html,/\['robinhood','Robinhood','RH','dark'\]/);assert.match(html,/robinhood:\{x:200,y:90,w:880,h:720\}/);
 assert.match(html,/LAYOUT_VERSION='2026-09-26-alpha58-live-visuals'/);assert.match(html,/DEFAULT_OPEN=\['trade','sportsbook','system'\]/);
 assert.match(html,/const POLY_MODS=\['combos'\]/);assert.match(html,/windowVisible\('robinhood'\)\)refreshRobinhood\(\)/);
 assert.equal((html.match(/mpo-brand-title/g)||[]).length,2,'brand title count unchanged');
});
test('automatic refresh never replaces a focused input or a typed secret',()=>{
 for(const active of ['rhUsd','rhConfirm','rhSecret']){let renders=0;const context=vm.createContext({document:{getElementById:()=>({}),activeElement:{id:active}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0,active)}
 let renders=0;const context=vm.createContext({document:{getElementById:id=>id==='rhConfirm'?{value:'PLACE'}:{},activeElement:{id:'other'}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0,'a half-typed phrase blocks the refresh');
});
test('gauge and exploration sections render both books, label EXPLORATION (NOT A STRATEGY) and never offer promotion',()=>{
 assert.match(panel,/\$\{rhGaugeSection\(rhState\)\}/);assert.match(panel,/\$\{rhExploreSection\(rhState\)\}/);
 const ctx=vm.createContext({document:{getElementById:()=>null},polyEscape:s=>String(s??''),money:n=>'$'+Number(n).toFixed(2),fmt:(n,d)=>Number(n).toFixed(d)});vm.runInContext(panel,ctx);
 const g={warmup:{n:90,need:120,pct:0.75},spread:{bps:3,capBps:40,ok:true},move:{expectedPct:0.01,requiredPct:0.028,ratio:0.36,ok:false},breakout:{mid:1,level:1.01,distancePct:-0.0099,ok:false},trend:{ok:true},cooldownUntil:null,blocking:'warmup',blockingText:'warming up',ready:false};
 ctx.st={loop:{alwaysOn:true,warmStart:{ran:true,bySymbol:{'BTC-USD':{disk:200,candles:520}}}},gauges:{strict:{'BTC-USD':g},explore:{'BTC-USD':{...g,blocking:null,blockingText:'ready: breakout signal',ready:true}}},
  explore:{label:'EXPLORATION (NOT A STRATEGY)',enabled:true,startUsd:1000,equityUsd:990,overrides:{costMultiple:0.5,lookbackSamples:40,maxHoldMin:120},stats:{closes:3,pnlUsd:-4.2,feesUsd:1.3,hitRate:1/3,profitFactor:0.4},positions:[],history:[{symbol:'BTC-USD',exit:{reason:'stop'},pnlUsd:-2}]}};
 const gs=vm.runInContext('rhGaugeSection(st)',ctx),ex=vm.runInContext('rhExploreSection(st)',ctx);
 assert.match(gs,/data-rh-gauge="strict:BTC-USD"/);assert.match(gs,/data-rh-gauge="explore:BTC-USD"/);assert.match(gs,/90<\/small>|90\/120/);assert.match(gs,/warming up/);assert.match(gs,/200 tape \+ 520 candle rows/);
 assert.match(ex,/EXPLORATION \(NOT A STRATEGY\)/);assert.match(ex,/NEVER COUNTS TOWARD QUALIFICATION OR PROMOTION/);assert.match(ex,/Net P\/L after fees/);
 assert.doesNotMatch(ex,/rhAction\(|evolve\/apply|Apply to paper/,'no control on the exploration book can promote it');
});
