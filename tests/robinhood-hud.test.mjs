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
// Line endings are normalized at the read boundary: a CRLF checkout (core.autocrlf=true on Windows) is
// not a difference in the panel, and the marker split below would find nothing (P1.4).
const lf=s=>s.replace(/\r\n/g,'\n');
const html=lf(read('public/dashboard.html')),panel=lf(read('public/assets/robinhood-panel.js'));
const rx=s=>new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
// 2026-10-02 (bing): the Robinhood HUD is paper-only; every live/real-money control was removed. The backend lock
// (tests/robinhood-http.test.mjs, tests/live-gate.test.mjs) still refuses real mutations on its own.
const PHRASES=['PLACE REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDER','CANCEL REAL CRYPTO ORDERS','ENABLE REAL CRYPTO AUTOPILOT'];
const LIVE_IDS=['rhArm','rhRealSymbol','rhRealUsd','rhRealType','rhPreviewBtn','rhPreviewOut','rhConfirm','rhPlace','rhCancelAll','rhReconcile','rhApOrderUsd','rhApMaxOpen','rhApLossCap','rhApSymbols','rhApType','rhAutoConfirm','rhApEnable','rhApDisable','rhApRun'];

test('the synced panel source is embedded byte-for-byte and parses',()=>{
 const embedded=html.split('// BEGIN ROBINHOOD PAPER PANEL\n')[1].split('// END ROBINHOOD PAPER PANEL')[0];
 assert.equal(embedded.trim(),panel.trim(),'run npm run sync:robinhood-panel');
 assert.doesNotThrow(()=>new vm.Script(panel,{filename:'robinhood-panel.js'}));
 const code=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));assert.doesNotThrow(()=>new vm.Script(code,{filename:'dashboard-inline.js'}));
});
test('the panel has no live or real-money controls, phrases or numbers',()=>{
 for(const p of PHRASES){assert.doesNotMatch(panel,rx(p));assert.doesNotMatch(html,rx(p))}
 for(const id of LIVE_IDS)assert.doesNotMatch(panel,new RegExp('id="'+id+'"'),id);
 for(const attr of ['data-rh-sell','data-rh-cancel','data-rh-forget'])assert.doesNotMatch(panel,rx(attr),attr);
 for(const a of ['arm','preview','order','cancel','cancel-all','forget','reconcile','autopilot','autopilot/run'])assert.ok(!panel.includes("rhAction('"+a+"'"),a);
 assert.doesNotMatch(panel,/buyingPowerUsd|LIVE\/read-only|LIVE open|LIVE realized|REAL AUTOPILOT|LIVE LOCKED|rhState\.journal/);
 assert.match(panel,/confirmation==='RESET PAPER'/);
 assert.doesNotMatch(panel,/sessionStorage/);assert.deepEqual([...panel.matchAll(/rhSave\('([^']+)'/g)].map(m=>m[1]).sort(),['mpo-rh-chart','mpo-rh-view']);assert.equal((panel.match(/localStorage\.setItem/g)||[]).length,1);assert.match(panel,/rhSave\('mpo-rh-chart',\{range:rhChart.range,symbol:rhChart.symbol\}\)/);assert.match(panel,/rhSave\('mpo-rh-view',rhView\)/);
});
test('required controls, fieldsets and routes are present',()=>{
 for(const id of ['rhApiKey','rhSecret','rhConfigure','rhSymbol','rhUsd','rhBuy','rhSymbols','rhOrderUsd','rhMaxOpen','rhSave','rhToggle','rhTick','rhParams','rhBank','rhResetConfirm','rhReset','rhEvolveRun','rhEvolveApply','rhReadiness','rhStocks','rhEqStatus','rhEqNeedKey','rhEqReplay','rhEqWeights','rhEqPositions','rhEqDecision','rhPractice','rhPrDecision','rhPrPositions','rhPrMode','rhPrStrategy','rhPrSymbols','rhPrOrderUsd','rhPrMaxOpen','rhPrLossCap','rhPrSave','rhPrAuto','rhPrRun','rhPrSymbol','rhPrBuy','rhPrBudget','rhPrReset'])assert.match(panel,new RegExp('id="'+id+'"'),id);
 assert.match(panel,/cid=o\.id\|\|'rhEqCurve'/,'the stocks curve keeps id rhEqCurve (the daily book reuses the helper with rhDailyCurve)');for(const id of ['rhDaily','rhDailyLabel','rhDailyVerdict','rhDailyPositions','rhDailyDecision','rhDailyQual','rhDailyTrades','rhDailyRun','rhDailyReset'])assert.match(panel,new RegExp('id="'+id+'"'),id);
 for(const attr of ['data-rh-close','data-rh-pr-close'])assert.match(panel,rx(attr));
 for(const a of ['config','paper-order','paper-close','paper-reset','paper-autopilot','paper-autopilot/run','evolve/run','evolve/apply','practice/config','practice/run','practice/order','practice/close','practice/reset'])assert.ok(panel.includes("rhAction('"+a+"'"),a);
 assert.match(panel,/fetch\('\/api\/robinhood'\)/);
 assert.match(panel,/<legend>Robinhood API keys · market data only<\/legend>/);assert.match(panel,/This build cannot place, cancel or reconcile real orders/);assert.doesNotMatch(panel,/mpo-danger-fieldset/);assert.match(panel,/Evolution Lab · Robinhood research lane/);assert.match(panel,/Apply Lab candidate to paper/);assert.match(panel,/Lab runs automatically/);
 assert.doesNotMatch(panel,/Agentic Trading MCP/);assert.match(panel,/PRIMARY x/);
 assert.match(panel,/rhAction\('evolve\/apply',\{paramsHash:ev\.proposed\.paramsHash\}/,'apply posts the proposed hash the server validates');
 assert.match(panel,/!ev\.proposed\|\|!evReady/,'Lab proposals stay unapplicable until paper-review gates pass');
 assert.match(panel,/Live Robinhood execution stays locked/);
 assert.doesNotMatch(panel,/#ff7a3d|#1a0e06|mpo-brand-title/);
});
test('desktop shell registers the window, keeps the layout version and leaves Polymarket modules alone',()=>{
 assert.match(html,/\['robinhood','Robinhood','RH','dark'\]/);assert.match(html,/robinhood:\{x:200,y:90,w:880,h:720\}/);
 assert.match(html,/LAYOUT_VERSION='2026-09-26-glance'/);assert.match(html,/DEFAULT_OPEN=\['trade'\]/);
 assert.match(html,/const POLY_MODS=\['combos'\]/);assert.match(html,/windowShown\('robinhood'\)\)refreshRobinhood\(\)/);
 assert.equal((html.match(/mpo-brand-title/g)||[]).length,2,'brand title count unchanged');
});
test('automatic refresh never replaces a focused input or a typed secret',()=>{
 for(const active of ['rhUsd','rhSecret']){let renders=0;const context=vm.createContext({document:{getElementById:()=>({}),activeElement:{id:active}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0,active)}
 let renders=0;const context=vm.createContext({document:{getElementById:id=>id==='rhSecret'?{value:'abc'}:{},activeElement:{id:'other'}},setBody:()=>renders++});vm.runInContext(panel,context);vm.runInContext('renderRobinhood()',context);assert.equal(renders,0,'a half-typed secret blocks the refresh');
});
test('gauge and exploration sections render both books, label EXPLORATION (NOT A STRATEGY) and never offer promotion',()=>{
 assert.match(panel,/\$\{rhGaugeSection\(rhState\)\}/);assert.match(panel,/\$\{rhExploreSection\(rhState\)\}/);
 const ctx=vm.createContext({document:{getElementById:()=>null},polyEscape:s=>String(s??''),money:n=>'$'+Number(n).toFixed(2),fmt:(n,d)=>Number(n).toFixed(d)});vm.runInContext(panel,ctx);
 const g={warmup:{n:90,need:120,pct:0.75},spread:{bps:3,capBps:40,ok:true},move:{expectedPct:0.01,requiredPct:0.028,ratio:0.36,ok:false},breakout:{mid:1,level:1.01,distancePct:-0.0099,ok:false},trend:{ok:true},cooldownUntil:null,blocking:'warmup',blockingText:'warming up',ready:false};
 ctx.st={loop:{alwaysOn:true,warmStart:{ran:true,bySymbol:{'BTC-USD':{disk:200,candles:520}}}},gauges:{strict:{'BTC-USD':g},explore:{'BTC-USD':{...g,blocking:null,blockingText:'ready: breakout signal',ready:true}}},
  explore:{label:'EXPLORATION (NOT A STRATEGY)',enabled:true,startUsd:1000,equityUsd:990,overrides:{costMultiple:0.5,lookbackSamples:40,maxHoldMin:120},stats:{closes:3,pnlUsd:-4.2,feesUsd:1.3,hitRate:1/3,profitFactor:0.4},positions:[],history:[{symbol:'BTC-USD',exit:{reason:'stop'},pnlUsd:-2}]}};
 const gs=vm.runInContext('rhGaugeSection(st)',ctx),ex=vm.runInContext('rhExploreSection(st)',ctx);
 assert.match(gs,/data-rh-gauge="strict:BTC-USD"/);assert.match(gs,/data-rh-gauge="explore:BTC-USD"/);assert.match(gs,/90<\/small>|90\/120/);assert.match(gs,/warming up/);assert.match(gs,/200 tape \+ 520 candle rows/);
 assert.match(ex,/EXPLORATION \(NOT A STRATEGY\)/);assert.match(ex,/NEVER COUNTS TOWARD QUALIFICATION OR PROMOTION/);assert.match(ex,/PAPER net P\/L after fees/);
 assert.doesNotMatch(ex,/rhAction\(|evolve\/apply|Apply to paper/,'no control on the exploration book can promote it');
});
test('multi-asset suite: crypto views keep their parts, stocks & ETFs and practice get their own tabs',()=>{
 assert.match(panel,/const RH_VIEWS=\{paper:\['head','cryptohead','live','order','autopilot','qual','positions','closes'\],why:\['head','cryptohead','live','signals','gauges'\],charts:\['head','cryptohead','charts'\],explore:\['head','cryptohead','explore'\],daily:\['head','cryptohead','daily'\],stocks:\['head','stocks'\],practice:\['head','practice'\],more:\['head','cryptohead','connection','keys','evolution','reset'\]\}/);
 assert.match(panel,/fetch\('\/api\/robinhood-equities'\)/,'stocks tab reads the read-only equities lane');
 assert.match(panel,/Date\.now\(\)-rhEqAt<60000/,'equities polled at most once a minute');
 assert.match(panel,/rhPrompt\('RESET PRACTICE'/,'practice reset needs a typed phrase');
 assert.doesNotMatch(panel,/\/api\/robinhood-equities'[^)]*method/,'the stocks lane is never POSTed');
 assert.match(html,/const suite=`<div class="g-rows">\$\{gRow\('Stocks & ETFs'/,'glance shows the stocks line');assert.match(html,/gRow\('Practice',/,'glance shows the practice line');
 assert.match(html,/rhEq\?\.data\?\.status,rhEq\?\.book\?\.equityUsd,r\.practice\?\.equityUsd/,'glance re-renders when the suite changes');
 assert.match(html,/MPOViz\.canvas\('rh-edge',90,'edge meter · expected move vs required'\)/,'the glance keeps its graphs');
});
const suiteCtx=()=>{const ctx=vm.createContext({document:{getElementById:()=>null},window:{innerWidth:1200},polyEscape:s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),money:n=>'$'+Number(n).toFixed(2),fmt:(n,d)=>Number(n).toFixed(d)});vm.runInContext(panel,ctx);return ctx};
test('readiness text is honest about fees, data and the unwired Agentic MCP',()=>{
 const ctx=suiteCtx();
 const t=vm.runInContext('rhReadinessText({})',ctx);
 assert.match(t,/fee 0\.95%\/side \(fallback until keys authenticate\)/);assert.match(t,/1\.9% round trip/);
 assert.match(t,/Alpaca public end-of-day bars, not Robinhood quotes/);assert.match(t,/Nothing here places real orders/);assert.doesNotMatch(t,/Agentic Trading MCP/);
 assert.match(vm.runInContext('rhReadinessText({account:{feeRatio:0.006}})',ctx),/fee 0\.60%\/side, so about 1\.2% round trip/);
});
test('stocks & ETFs tab: status, target weights, positions, curve vs SPY and cash, last decision and next session',()=>{
 const ctx=suiteCtx();
 ctx.noKey={data:{status:'NO_DATA',configured:false},book:{startUsd:1000,equityUsd:1000,returnPct:0,positions:{},equityDaily:[]},strategy:{id:'tactical-a'},market:{state:'CLOSED',nextSession:'2026-09-28'},benchmark:{live:null,replay:null},readiness:{text:'Paper only.'}};
 const a=vm.runInContext('rhStocksSection(noKey)',ctx);
 assert.match(a,/id="rhEqStatus"><b class="red">NO DATA · ADD A FREE ALPACA KEY/);assert.match(a,/id="rhEqNeedKey"/);assert.match(a,/ALPACA_KEY_ID/);assert.match(a,/No target yet/);assert.match(a,/No stock or ETF positions/);assert.match(a,/next session<\/b> 2026-09-28/);assert.match(a,/The equity curve starts at the first marked session close/);
 for(const s of ['FRESH','STALE'])assert.match(vm.runInContext(`rhEqStatusHtml({data:{status:'${s}',configured:true}})`,ctx),new RegExp('>'+s+'<'));
 ctx.full={data:{status:'FRESH',configured:true,providerLabel:'Alpaca',latestBar:'2026-09-25'},market:{state:'CLOSED',lastCompletedSession:'2026-09-25',nextSession:'2026-09-28'},
  book:{startUsd:1000,equityUsd:1012.5,returnPct:1.25,cashUsd:3,settledCashUsd:3,positions:{SPY:{qty:0.75,avgPx:600,lastPx:610},GLD:{qty:1,avgPx:200,lastPx:205}},
   equityDaily:[{d:'2026-09-24',equityUsd:1000,benchUsd:1000,cashUsd:1000},{d:'2026-09-25',equityUsd:1012.5,benchUsd:1008,cashUsd:1000}],pending:null,lastFill:{session:'2026-09-25',late:false},missedSessions:0,costs:{slippageBps:2,settlement:'T+1'}},
  strategy:{id:'tactical-a',title:'Tactical A',lastDecision:{session:'2026-09-25',ready:true,reasons:[],weights:{SPY:0.5,GLD:0.1667}}},
  benchmark:{live:{buyHoldSpyUsd:1008,buyHoldSpyReturnPct:0.8,cashUsd:1000,since:'2026-09-24'},replay:{from:'2025-01-02',strategy:{returnPct:12,cagrPct:11,maxDrawdownPct:-9,sharpe:0.8},buyHoldSpy:{returnPct:15,cagrPct:14,maxDrawdownPct:-18,sharpe:0.7},cash:{returnPct:0,cagrPct:0,maxDrawdownPct:0,sharpe:null}}},readiness:{text:'Paper only.'}};
 const b=vm.runInContext('rhStocksSection(full)',ctx);
 assert.match(b,/<b class="green">FRESH<\/b>/);assert.doesNotMatch(b,/rhEqNeedKey/);
 assert.match(b,/<svg id="rhEqCurve"/);for(const c of ['rh-eq-strategy','rh-eq-spy','rh-eq-cash'])assert.match(b,new RegExp('class="'+c+'"'),c);
 assert.match(b,/<td>SPY<\/td><td>50\.0%<\/td>/);assert.match(b,/<td>GLD<\/td><td>1\.0000<\/td><td>\$200\.00<\/td><td>\$205\.00<\/td><td>\$205\.00<\/td>/);
 assert.match(b,/Last decision:<\/b> 2026-09-25 · ready/);assert.match(b,/Buy-and-hold SPY/);assert.match(b,/\+12\.00%/);assert.match(b,/\$1012\.50/);
});
test('practice panel renders the isolated ledger with its controls and never offers promotion',()=>{
 const ctx=suiteCtx();
 ctx.pr={budgetUsd:500,cashUsd:475,equityUsd:499.1,realizedPnlUsd:-0.4,unrealizedPnlUsd:-0.5,settingsHash:'abc',settings:{mode:'PRACTICE',strategyMode:'MOMENTUM',symbols:['BTC-USD','ETH-USD'],orderUsd:25,maxOpenPositions:3,dailyLossCapUsd:25,feeBps:95,slippageBps:8,autopilot:false},
  telemetry:{loopStatus:'IDLE',lastSource:'coinbase-public',lastDecision:{action:'WAIT',reason:'autopilot disabled'},blockingReason:'autopilot disabled',rejectionReasons:{},fills:3,feesUsd:0.7},
  positions:[{id:'rhp-1',symbol:'BTC-USD',qty:0.0002,costUsd:25.2,unrealizedPnlUsd:-0.5,ageMs:60000}],history:[{status:'CLOSED',symbol:'ETH-USD',pnlUsd:-0.4,feeUsd:0.24,closedAt:2000,at:1000,exit:{reason:'manual',feeUsd:0.23}}]};
 const h=vm.runInContext('rhPracticeSection(pr)',ctx);
 assert.match(h,/NEVER COUNTS TOWARD QUALIFICATION, PROMOTION OR REAL AUTHORITY/);assert.match(h,/fee 0\.95%\/side/);assert.match(h,/data-rh-pr-close="rhp-1"/);assert.match(h,/<svg id="rhPrEquity"/);assert.match(h,/LOOP IDLE/);assert.match(h,/Start practice autopilot/);
 assert.match(h,/<option value="PRACTICE" selected>/);assert.doesNotMatch(h,/value="STRICT"/,'strict mode belongs to the qualified book');
 assert.doesNotMatch(h,/evolve\/apply|Apply Lab|paper-autopilot/,'no control in the sandbox touches the strict book or promotion');
});
