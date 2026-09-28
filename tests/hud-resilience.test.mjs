import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../public/js/mpo-hud-runtime.js',import.meta.url),'utf8');
const ctx=vm.createContext({Response,DOMException,AbortController,Event,Map,Set,setTimeout,clearTimeout});vm.runInContext(code,ctx);
const {createPreferences,sanitizeLayout,createTransport}=ctx.MPOHud;
const response=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('damaged JSON, wrong shapes and blocked storage recover without losing valid preferences',()=>{
 const data=new Map([['layout','{oops'],['open','{}'],['tabs','[]'],['detail','null'],['good','["trade","command"]']]),warnings=[];
 const prefs=createPreferences(()=>({getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}),k=>warnings.push(k));
 assert.deepEqual(prefs.read('layout',{}),{});assert.deepEqual(prefs.read('open',[]),[]);assert.deepEqual(prefs.read('tabs',{}),{});assert.deepEqual(prefs.read('detail',[]),[]);assert.deepEqual([...prefs.read('good',[])],['trade','command']);
 const denied=createPreferences(()=>{throw Error('SecurityError')});assert.equal(denied.read('open',false),false);assert.equal(denied.write('open',['trade']),false);assert.deepEqual([...denied.read('open',[])],['trade']);
 assert.equal(denied.remove('open'),false);
 const quota=createPreferences(()=>({getItem:()=>null,setItem:()=>{throw Error('QuotaExceededError')}}));assert.equal(quota.write('x',{tab:'risk'}),false);assert.equal(quota.read('x',{}).tab,'risk');
});
test('layout preserves good fields while repairing invalid geometry and unsupported ids',()=>{
 const r=sanitizeLayout({trade:{x:123,y:'bad',w:900,h:null,max:'true'},command:{x:100,y:5,w:800,h:450,max:true},obsolete:{x:1}},['trade','command'],()=>({x:0,y:40,w:640,h:500}));
 assert.equal(r.trade.x,123);assert.equal(r.trade.y,40);assert.equal(r.trade.w,900);assert.equal(r.trade.h,500);assert.equal(r.trade.max,false);assert.equal(r.command.max,true);assert.equal(r.obsolete,undefined);
});
test('single flight shares a complete body with separate readable responses',async()=>{
 let calls=0;const transport=createTransport(async()=>{calls++;await sleep(10);return response({ok:true})});
 const results=await Promise.all([transport.fetch('/api/state'),transport.fetch('/api/state')]);assert.equal(calls,1);assert.deepEqual(await results[0].json(),{ok:true});assert.deepEqual(await results[1].json(),{ok:true});assert.equal(transport.status().pending,0);transport.dispose();
});
test('read admission is bounded and all queued and running callers settle on cancellation',async()=>{
 let active=0,peak=0;const transport=createTransport(async(_,o)=>{active++;peak=Math.max(peak,active);return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{active--;reject(o.signal.reason)},{once:true}))},{concurrency:2,maxQueue:2,timeoutMs:1000});
 const promises=[0,1,2,3,4].map(i=>transport.fetch('/api/'+i).then(()=>null,e=>e));await sleep(5);assert.equal(peak,2);assert.equal(transport.status().queued,2);transport.cancel();const errors=await Promise.all(promises);assert.equal(errors.filter(e=>e.name==='AbortError').length,4);assert.match(errors[4].message,/queue full/);assert.equal(transport.status().pending,0);transport.dispose();
});
test('deadline includes body download and failure retains last successful timestamp',async()=>{
 let now=100,mode='good';const transport=createTransport(async()=>mode==='good'?response({value:7}):({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),text:()=>new Promise(()=>{})}),{timeoutMs:25,now:()=>now});
 await transport.fetch('/api/state');assert.equal(transport.state('/api/state').lastSuccess,100);mode='hung';now=200;
 await assert.rejects(transport.fetch('/api/state'),/timed out/);assert.equal(transport.state('/api/state').lastSuccess,100);assert.match(transport.state('/api/state').error,/timed out/);assert.equal(transport.status().active,0);transport.dispose();
});
test('malformed/HTTP error data never marks stale values fresh, retries back off, and recovery clears errors',async()=>{
 let calls=0,now=1,mode='good';const transport=createTransport(async()=>{calls++;return mode==='good'?response({}):mode==='bad'?new Response('{',{headers:{'content-type':'application/json'}}):new Response('{}',{status:503})},{now:()=>now});
 await transport.fetch('/api/state');mode='bad';now=2;await assert.rejects(transport.fetch('/api/state'));assert.equal(transport.state('/api/state').lastSuccess,1);await assert.rejects(transport.fetch('/api/state'));assert.equal(calls,2);
 now=10000;mode='http';await assert.rejects(transport.fetch('/api/state'),/HTTP 503/);assert.equal(transport.state('/api/state').lastSuccess,1);
 now=20000;mode='good';await transport.fetch('/api/state');assert.equal(transport.state('/api/state').error,null);assert.equal(transport.state('/api/state').lastSuccess,20000);transport.dispose();
});
test('late completion after cancel cannot overwrite a newer successful snapshot',async()=>{
 let finishOld,calls=0,now=1;const transport=createTransport(()=>++calls===1?new Promise(r=>finishOld=r):Promise.resolve(response({value:'new'})),{now:()=>now});
 const old=transport.fetch('/api/state').catch(e=>e);transport.cancel();assert.equal((await old).name,'AbortError');now=20;assert.deepEqual(await (await transport.fetch('/api/state')).json(),{value:'new'});now=30;finishOld(response({value:'old'}));await sleep(1);assert.equal(transport.state('/api/state').lastSuccess,20);transport.dispose();
});
test('POST requests stay distinct and never retry through the read transport',async()=>{
 let calls=0;const transport=createTransport(async()=>{calls++;return response({ok:true})});await Promise.all([transport.fetch('/api/paper',{method:'POST'}),transport.fetch('/api/paper',{method:'POST'})]);assert.equal(calls,2);assert.equal(transport.status().pending,0);transport.dispose();
});
test('a superseded chart request cannot reset the chosen pair or range',async()=>{
 const panel=fs.readFileSync(new URL('../public/assets/robinhood-panel.js',import.meta.url),'utf8');let finish;
 const chart=vm.createContext({document:{getElementById:()=>null},fetch:()=>new Promise(r=>finish=r),windowVisible:()=>false,Date,JSON});vm.runInContext(panel,chart);
 const pending=vm.runInContext("rhChart.symbol='BTC-USD';rhChart.range='1h';rhLoadChart(true)",chart);
 vm.runInContext("rhChart.symbol='ETH-USD';rhChart.range='24h'",chart);finish(response({symbol:'BTC-USD',range:'1h',points:[]}));await pending;
 assert.equal(vm.runInContext('rhChart.symbol',chart),'ETH-USD');assert.equal(vm.runInContext('rhChart.range',chart),'24h');assert.equal(vm.runInContext('rhChart.data',chart),null);assert.equal(vm.runInContext('rhChart.busy',chart),false);
});
test('Command Center renders unknown marked equity and exclusions without invented totals',()=>{
 const source=fs.readFileSync(new URL('../public/js/mpo-platform.js',import.meta.url),'utf8').replace('return {install,render};','return {install,render,markedRiskCard,capabilityCard};');
 const env=vm.createContext({window:{},document:{}});vm.runInContext(source,env);const card=env.window.MPOSPlatform.markedRiskCard({scope:'CORE_LEDGER_USD',complete:false,consolidatedComplete:false,equityUsd:null,drawdownPct:null,cashUsd:30,limitations:[{venue:'test',reason:'STALE_MARK'}],excludedAccounts:[{currency:'SOL',reason:'NO_VERIFIED_FX_CONVERSION'}]});
 assert.match(card,/PAPER equity Unknown/);assert.match(card,/PAPER cash \$30/);assert.match(card,/PAPER unrealized P\/L Unknown/);assert.match(card,/PAPER daily P\/L Unknown/);assert.match(card,/PAPER high-water drawdown Unknown/);assert.match(card,/STALE_MARK/);assert.match(card,/Excluded from USD totals: SOL/);assert.doesNotMatch(card,/PAPER equity \$0|drawdown 0\.00/);
 const readiness=env.window.MPOSPlatform.capabilityCard([{id:'test',role:'TRADING',collection:{state:'STALE'},evaluator:'v2',paper:'PAPER',decision:'WAIT',blockers:['missing outcomes'],appliedStrategy:{paramsHash:'applied-123'},proposal:{paramsHash:'new-proposal'}}]);
 assert.match(readiness,/applied-123/);assert.match(readiness,/missing outcomes/);assert.doesNotMatch(readiness,/new-proposal/);
});
test('arbitrage explains failed legs from each direction and never labels conditional outcomes locked',()=>{
 const source=fs.readFileSync(new URL('../public/js/mpo-platform.js',import.meta.url),'utf8').replace('return {install,render};','return {install,render,executionRiskCard};');
 const env=vm.createContext({window:{},document:{}});vm.runInContext(source,env);
 const card=env.window.MPOSPlatform.executionRiskCard({directions:[{sideA:'YES',sideB:'NO',executionRisks:['NON_ATOMIC_FILLS'],blocked:[],failureScenarios:[{scenario:'A_FILLS_OTHER_REJECTS',capitalAtRisk:3,observedImmediateUnwindPnl:-1,reason:'Depth may disappear'}]}]});
 assert.match(card,/NON_ATOMIC_FILLS/);assert.match(card,/A_FILLS_OTHER_REJECTS/);assert.match(card,/\$3/);assert.match(card,/\$-1/);assert.match(card,/Not guaranteed/);assert.doesNotMatch(card,/Locked|risk.free/i);
});
