import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { commandMarketSnapshot, commandCenterSummary } from '../src/commandCenter.js';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
function ui(){const window={},document={addEventListener(){}};const ctx=vm.createContext({window,document,Date,Intl,console});for(const file of ['mpo-chart-kit.js','mpo-price-workspace.js','mpo-command-graphs.js'])vm.runInContext(read('public/js/'+file),ctx);return window;}
test('stock BBO current values retain the session-history identity',()=>{
 const markets=commandMarketSnapshot({equities:{bars:{SPY:[{d:'2026-10-02',c:100}]}},stockQuotes:[{symbol:'SPY',last:101,bid:100,ask:102,quoteAt:1234,source:'alpaca-iex'}]});
 assert.equal(markets.assets[0].id,'equity:SPY');assert.equal(markets.assets[0].kind,'BBO');assert.equal(markets.assets[0].price,101);
});
test('summary omits growing membership but accounts for durable members',()=>{
 const full={markets:{assets:[],predictions:[]},copy:{catalogue:{membership:{a:{firstObservedAt:1},b:{firstObservedAt:2}},candidates:[]}}};const compact=commandCenterSummary(full);
 assert.equal(compact.copy.catalogue.membership,undefined);assert.equal(compact.copy.catalogue.membershipCount,2);assert.equal(Object.keys(full.copy.catalogue.membership).length,2);
});
test('chart normalization preserves observation source, availability and gaps without filling missing sides',()=>{
 const {MPOChartKit:k}=ui();const s=k.normalizeSeries({id:'c',unit:'PROB',sources:[{id:'listing',quote:false}],points:[[100,0.1,null,null,110,0,0.1,0.1],[200,0.2,0.4,0.3,210,0,0.3,0.3]],gaps:[[100,200,'no-observation']]});
 assert.equal(s.points[0].mid,null);assert.equal(s.points[0].ask,null);assert.equal(s.points[0].source.quote,false);assert.equal(s.points[1].avail,210);assert.equal(s.gaps.length,1);
});
test('coordination maps global CLOB and copy to separate objectives and truthful waiting loops',()=>{
 const {MPOCommandGraphs:g}=ui();const data={lab:{modules:[{id:'polymarket',state:'NO_EDGE'}]},loops:{'polymarket-copy':{state:'WAITING',lastOkAt:null}},books:[]};
 const coord={modules:[{id:'polymarket-clob',nextAction:'Collect CLOB'}, {id:'polymarket-copy',nextAction:'Evaluate followers',plain:{doing:'Waiting for follower closes',needs:'Executable receipt',changed:'No new experiment'},retry:{reason:'No new exits'}}]};
 const rows=g.moduleRows(data,coord);assert.equal(rows.find(r=>r.m.id==='polymarket-clob').next,'Collect CLOB');const copy=rows.find(r=>r.m.id==='polymarket-copy');assert.equal(copy.next,'Evaluate followers');assert.equal(copy.lab,null);assert.match(copy.feed.label,/waiting/);assert.notEqual(copy.feed.tone,'up');assert.equal(copy.retry,'No new exits');
 const html=g.modules(data,coord);assert.match(html,/Executable receipt/);assert.match(html,/No new experiment/);
});
test('copy funnel displays every retained policy, unknown counts, separate currencies and loss pauses',()=>{
 const {MPOCommandGraphs:g}=ui();const funnel={books:[{id:'a',platform:'pumpfun',policy:'strict-wallet-copy',unit:'SOL',qualification:'UNQUALIFIED',paused:true,funnel:{candidates:null,eligible:0,followed:0,evaluated:2},afterCost:{netPnl:-0.2,baselineNoTrade:0,independentPositions:2},reasons:{NO_RECEIPT:4},reasonsScope:{retained:4}},{id:'b',platform:'polymarket-global',policy:'<unsafe>',unit:'USD',funnel:{candidates:3,evaluated:1},afterCost:{netPnl:1}}]};
 const html=g.copy({},funnel);assert.match(html,/0.200 SOL/);assert.match(html,/\+\$1.00/);assert.match(html,/Loss pause/);assert.match(html,/No receipt \(4\)/);assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/<unsafe>/);assert.match(html,/>\?<\/strong> Candidates/);
});
