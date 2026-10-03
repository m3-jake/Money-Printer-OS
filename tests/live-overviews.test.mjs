import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const vizSource = read('public/js/mpo-viz.js');
const platformSource = read('public/js/mpo-platform.js');
const plain = v => JSON.parse(JSON.stringify(v));

function harness({ reduced = true } = {}) {
  let now = 1000000, clears = 0, path = [];
  const frames = [], listeners = {}, texts = [], strokes = [], fills = [];
  const context2d = new Proxy({
    clearRect() { clears++; }, beginPath() { path = []; }, moveTo(x,y) { path.push(['M',x,y]); }, lineTo(x,y) { path.push(['L',x,y]); },
    stroke() { strokes.push(path.slice()); }, fillText(text) { texts.push(String(text)); }, fillRect(...args) { fills.push(args); },
    createLinearGradient() { return { addColorStop() {} }; }, measureText(text) { return { width: String(text).length * 6 }; },
  }, { get(target,key) { return key in target ? target[key] : () => {}; } });
  const canvas = { dataset: { viz: 'plot' }, isConnected: true, offsetParent: {}, clientWidth: 400, clientHeight: 180, width: 0, height: 0,
    getContext: () => context2d, getBoundingClientRect: () => ({ top: 0, left: 0, right: 400, bottom: 180 }),
  };
  const document = { hidden: false, documentElement: { classList: { contains: () => false } }, querySelectorAll: () => [canvas], addEventListener(type,fn) { listeners[type] = fn; } };
  const window = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, matchMedia: () => ({ matches: reduced }), addEventListener(type,fn) { listeners[type] = fn; } };
  const context = vm.createContext({ window, document, Date: class extends Date { static now() { return now; } }, performance: { now: () => 0 },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, console,
  });
  vm.runInContext(vizSource, context);
  return { viz: window.MPOViz, window, document, canvas, frames, listeners, texts, strokes, fills, clears: () => clears,
    clock: value => { now = value; }, frame: time => { const fn = frames.shift(); if (fn) fn(time); },
  };
}

test('observation histories retain actual timestamps, replace duplicate observations and reject future or stale samples', () => {
  const h = harness();
  const sample = (at,value) => h.viz.observe('cash', { at, series: [{ id: 'a', label: 'Paper cash', unit: 'USD', value }] });
  sample(999000, 12); sample(999000, 13); sample(999500, null);
  sample(998000, 88); sample(1000001, 99); sample(null, 99);
  const data = plain(h.viz.samples('cash'));
  assert.deepEqual(data.series[0].times, [999000,999500]);
  assert.deepEqual(data.series[0].points, [13,null]);
  const detached = h.viz.samples('cash'); detached.series[0].points[0] = 777;
  assert.equal(h.viz.samples('cash').series[0].points[0], 13);
  assert.match(h.viz.history('cash', { height: 210, title: '<cash>' }), /height:210px/);
  assert.doesNotMatch(h.viz.history('cash', { title: '<cash>' }), /<cash>/);
});

test('history retention is bounded, reset epochs do not join accounts, and differing units never share a chart', () => {
  const h = harness();
  for(let i=0;i<400;i++)h.viz.observe('cash',{at:900000+i, maxPoints:99999, series:[{id:'a',value:i,unit:'USD',epoch:'one'}]});
  assert.equal(h.viz.samples('cash').series[0].points.length,360);
  h.viz.observe('cash',{at:999000,series:[{id:'a',value:25,unit:'USD',epoch:'two'}]});
  assert.deepEqual(plain(h.viz.samples('cash').series[0].points),[25]);
  h.viz.observe('cash',{at:999100,series:[{id:'a',value:1,unit:'SOL',epoch:'two'}]});
  assert.deepEqual(plain(h.viz.samples('cash').series[0].points),[25]);
  for(let i=0;i<100;i++)h.viz.observe('stream-'+i,{at:999000,series:[{id:'a',value:i}]});
  assert.equal(h.viz.samples('stream-0').series.length,0);
  assert.equal(h.viz.samples('stream-99').series.length,1);
});

test('time charts break missing observations and space their x-axis by observed time', () => {
  const h=harness();
  h.viz.set('plot','lines',{zero:false,legend:false,observationOnly:true,series:[{label:'Observed',points:[1,null,2,3],times:[1000,2000,3000,5000]}]});
  h.frame(10);
  const line=h.strokes.find(p=>p.length===3&&p[0][0]==='M');
  assert.ok(line); assert.deepEqual(line.map(p=>p[0]),['M','M','L'],'the null sample starts a new path');
  assert.equal(line[0][1],40); assert.equal(line[1][1],215); assert.equal(line[2][1],390);
  assert.ok(h.texts.every(text=>!text.includes('NaN')));
});

test('unchanged chart payloads do not animate again and reduced motion draws only observed changes', () => {
  const h=harness(),data={observationOnly:true,series:[{label:'Paper',points:[1,2]}]};
  h.viz.set('plot','lines',data);h.frame(10);assert.equal(h.clears(),1);assert.equal(h.frames.length,0);
  h.viz.set('plot','lines',plain(data));h.frame(20);assert.equal(h.clears(),1);
  h.viz.set('plot','lines',{...data,series:[{label:'Paper',points:[1,3]}]});h.frame(30);assert.equal(h.clears(),2);assert.equal(h.frames.length,0);
});

test('normal-motion charts ease new observations then stop instead of manufacturing idle price motion',()=>{
  const h=harness({reduced:false});h.viz.set('plot','gauge',{value:50});h.frame(10);
  for(const at of [100,300,600,900,1300,1600])h.frame(at);
  const draws=h.clears();assert.equal(h.frames.length,0);
  h.viz.set('plot','gauge',{value:50});h.frame(1800);assert.equal(h.clears(),draws);
  h.viz.set('plot','gauge',{value:60});h.frame(1900);assert.equal(h.clears(),draws+1);
});
test('a live history animates only its marker while source values stay identical',()=>{
  const h=harness({reduced:false});h.viz.observe('plot',{at:999000,series:[{id:'paper',unit:'USD',value:2}]});h.viz.history('plot');
  const before=plain(h.viz.samples('plot'));h.frame(10);h.frame(1700);h.frame(1900);
  assert.ok(h.frames.length>0);assert.deepEqual(plain(h.viz.samples('plot')),before);
  h.document.hidden=true;h.frame(2100);assert.equal(h.frames.length,0);
});
test('known tickers continue scrolling and reduced motion freezes their presentation',()=>{
  for(const reduced of [false,true]){const h=harness({reduced});h.viz.set('plot','ticker',{items:[{text:'BTC $100',color:'#fff'}]});h.frame(10);h.frame(1700);h.frame(1900);assert.equal(h.frames.length>0,!reduced);}
});

test('offscreen and background canvases pause, then paint their actual data when visible', () => {
  const h=harness();h.canvas.getBoundingClientRect=()=>({top:900,left:0,bottom:1100,right:400});
  h.viz.set('plot','bars',{rows:[{label:'A',value:3}],observationOnly:true});h.frame(10);assert.equal(h.clears(),0);assert.equal(h.frames.length,0);
  h.canvas.getBoundingClientRect=()=>({top:0,left:0,bottom:180,right:400});h.listeners.scroll();h.frame(20);assert.equal(h.clears(),1);
  h.document.hidden=true;h.viz.set('plot','bars',{rows:[{label:'A',value:4}],observationOnly:true});h.frame(30);assert.equal(h.clears(),1);
  h.document.hidden=false;h.listeners.visibilitychange();h.frame(40);assert.equal(h.clears(),2);
});

test('unknown gauges and cost meters show unavailable states instead of fabricated zeros', () => {
  const h=harness();h.viz.set('plot','gauge',{value:null});h.frame(10);
  assert.ok(h.texts.some(t=>t.includes('Waiting')));assert.ok(!h.texts.includes('0'));
  h.viz.set('plot','edge',{rows:[{label:'BTC',spark:[1,null,3],required:null,move:null}],observationOnly:true});h.frame(20);
  assert.ok(h.texts.includes('move / cost unavailable'));assert.equal(h.fills.length,0);
  const path=h.strokes.find(p=>p.length===2);assert.deepEqual(path.map(p=>p[0]),['M','M']);
});

function platformHarness(seed={},bots=null){
  const h=harness(), specs=new Map(),window={MPOViz:h.viz,MPOBots:{data:bots}};h.clock(Date.now());
  const set=h.viz.set;h.viz.set=(key,type,data)=>{specs.set(key,{type,data:plain(data)});set(key,type,data);};
  const source=platformSource.replace('return {install,render};',`return {install,render,commandOverview,kalshiOverview,seed(v){snapshot=v.snapshot??null;scoreboard=v.scoreboard??null;diag=v.diag??null;contracts=v.contracts??[];kalshiWx=v.kalshiWx??null;}};`);
  const context=vm.createContext({window,document:{},addEventListener(){},Date});
  vm.runInContext(source,context);window.MPOSPlatform.seed(seed);
  return {platform:window.MPOSPlatform,viz:h.viz,specs};
}

test('Command graphs keep paper USD and SOL apart and never include live or research returns', () => {
  const at=Date.now(),p=platformHarness({snapshot:{at},scoreboard:{at,paperSummary:{books:2},rows:[
    {id:'usd',book:'Dollar book',unit:'USD',mode:'PAPER',netPnl:2},
    {id:'sol',book:'SOL book',unit:'SOL',mode:'PAPER',netPnl:.2},
    {id:'live',book:'Real balance',unit:'USD',mode:'LIVE',netPnl:999},
    {id:'lab',book:'Research',unit:'USD',kind:'lab',netPnl:777},
  ]}});
  const html=p.platform.commandOverview();
  assert.match(html,/live-main-chart/);assert.match(html,/data-viz="command-results-USD"/);assert.match(html,/data-viz="command-results-SOL"/);
  assert.match(html,/<details class="overview-help">/);
  const usd=plain(p.viz.samples('command-results-USD')),sol=plain(p.viz.samples('command-results-SOL'));
  assert.equal(usd.series.length,1);assert.equal(sol.series.length,1);
  assert.deepEqual(usd.series[0].points,[2]);assert.deepEqual(sol.series[0].points,[.2]);
  assert.equal(usd.series[0].label,'Dollar book');assert.equal(sol.series[0].label,'SOL book');
});

test('Kalshi graphs use actual settled timestamps, preserve recovery unknowns and price distributions', () => {
  const now=Date.now(),p=platformHarness({snapshot:{at:now},kalshiWx:{cities:[{id:'chi',label:'Chicago',markets:[{date:'2026-10-03',closeAt:now+3600000,nwsHigh:70,buckets:[{lo:69,hi:70,p:.4},{lo:71,hi:72,p:.6}]}]}]}},{at:now,kalshi:{weather:{equityUsd:12.25,curve:[{at:null,equityUsd:12.5},{at:now-60000,equityUsd:12.25}],stats:{settled:1},settings:{}},btc:{equityUsd:null,curve:[],recoveryRequired:true,stats:{},settings:{}}}});
  const html=p.platform.kalshiOverview();
  assert.match(html,/data-viz="kalshi-paper-equity"/);assert.match(html,/data-viz="kalshi-weather-0"/);assert.match(html,/data-viz="kalshi-forward-results"/);
  assert.match(html,/no combined balance/);assert.match(html,/Unavailable/);
  assert.doesNotMatch(html,/\$0\.00|NaN/);
  const curve=p.specs.get('kalshi-paper-equity').data.series;
  assert.deepEqual(curve[0].times,[now-60000,now]);assert.deepEqual(curve[0].points,[12.25,12.25]);
  assert.deepEqual(curve[2].points,[],'recovery unknown is not a zero balance');
  assert.deepEqual(p.specs.get('kalshi-weather-0').data.bins.map(b=>b.count),[40,60]);
});

test('event beats accept only increasing actual source timestamps and never invent idle events',()=>{
  const h=harness();
  for(const at of [null,false,true,-1,1000001,Infinity,999000.5])assert.deepEqual(plain(h.viz.beat('scan',at)),[]);
  h.viz.beat('scan',999000);h.viz.beat('scan',999000);h.viz.beat('scan',998000);h.viz.beat('scan',999100);
  assert.deepEqual(plain(h.viz.beat('scan',null)),[999000,999100]);
});
