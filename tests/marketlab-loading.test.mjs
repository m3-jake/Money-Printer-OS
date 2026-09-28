import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/js/mpo-marketlab.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const state={now:1000,fail:false,calls:[]};
  const root={id:'body-marketlab',innerHTML:'',scrollTop:0,classList:{contains:v=>v==='on'},contains:()=>false};
  const win={classList:{contains:()=>false}},window={addEventListener(){}};
  const document={querySelector:()=>win,getElementById:()=>root,addEventListener(){},hidden:false};
  const payload={
    '/api/platform/lab/sources':{ok:true,tape:[],books:[],alpaca:{configured:false,note:'No configured source'},strategies:{momentum:{label:'Momentum',params:{}}}},
    '/api/platform/lab/runs':{ok:true,runs:[]},'/api/platform/strategies':{ok:true,strategies:[]},
  };
  const fetch=async(url,options)=>{state.calls.push(url);assert.ok(options.signal);return {ok:!state.fail,status:state.fail?503:200,json:async()=>state.fail?{ok:false,error:'fixture offline'}:payload[url]};};
  const context={window,document,fetch,AbortSignal,setInterval,clearInterval,Date:class extends Date{static now(){return state.now;}}};
  vm.runInNewContext(source,context);return {state,root,render:()=>window.MPOMarketLab.render()};
}

test('Market Lab initial source load clears the Working indicator after the asynchronous response',async()=>{
  const f=fixture();f.render();assert.match(f.root.innerHTML,/Working/);await settle();
  assert.equal(f.state.calls.length,3);assert.doesNotMatch(f.root.innerHTML,/Working/);assert.match(f.root.innerHTML,/MARKET LAB/);
  f.render();assert.equal(f.state.calls.length,3,'already-loaded sources are reused');
});

test('Market Lab offline retries are bounded and recover without staying visually busy',async()=>{
  const f=fixture();f.state.fail=true;f.render();await settle();
  assert.match(f.root.innerHTML,/fixture offline/);assert.doesNotMatch(f.root.innerHTML,/Working/);
  for(let n=0;n<20;n++)f.render();assert.equal(f.state.calls.length,3,'render calls cannot become an uncontrolled retry loop');
  f.state.now+=30001;f.state.fail=false;f.render();await settle();
  assert.equal(f.state.calls.length,6);assert.match(f.root.innerHTML,/MARKET LAB/);assert.doesNotMatch(f.root.innerHTML,/Working|fixture offline/);
});
