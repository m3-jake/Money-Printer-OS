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
 assert.match(panel,/<legend>ROBINHOOD CRYPTO · REAL MONEY<\/legend>/);assert.match(panel,/mpo-danger-fieldset/);assert.match(panel,/Evolution \(paper-only self-improvement\)/);assert.match(panel,/Apply to paper/);assert.match(panel,/Run now/);
 assert.match(panel,/Agentic Trading MCP/);assert.match(panel,/PRIMARY x/);
 assert.match(panel,/rhAction\('evolve\/apply',\{paramsHash:ev\.proposed\.paramsHash\}/,'apply posts the proposed hash the server validates');
 assert.match(panel,/ROBINHOOD_EVOLVE_AUTOPROMOTE=true/);
 assert.doesNotMatch(panel,/#ff7a3d|#1a0e06|mpo-brand-title/);
});
test('desktop shell registers the window, keeps the layout version and leaves Polymarket modules alone',()=>{
 assert.match(html,/\['robinhood','Robinhood Auto Trader','RH','dark'\]/);assert.match(html,/robinhood:\{x:200,y:90,w:880,h:620\}/);
 assert.match(html,/LAYOUT_VERSION='2026-09-14-alpha40-consolidated'/);assert.match(html,/DEFAULT_OPEN=\['trade','sportsbook','system'\]/);
 assert.match(html,/const POLY_MODS=\['combos','us','paper'\]/);assert.match(html,/windowVisible\('robinhood'\)\)refreshRobinhood\(\)/);
 assert.equal((html.match(/mpo-brand-title/g)||[]).length,2,'brand title count unchanged');
});
test('automatic refresh never replaces a focused input or a typed secret',()=>{
 for(const active of ['rhUsd','rhConfirm','rhSecret']){let renders=0;const context=vm.createContext({document:{getElementById:()=>({}),activeElement:{id:active}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0,active)}
 let renders=0;const context=vm.createContext({document:{getElementById:id=>id==='rhConfirm'?{value:'PLACE'}:{},activeElement:{id:'other'}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0,'a half-typed phrase blocks the refresh');
});
