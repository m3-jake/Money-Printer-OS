import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MarketAdapter, FrictionModel, OrderSimulator, PortfolioTracker,
  frictionConfigFor, seededRandom,
} from '../src/core/paperTrading.js';

test('MarketAdapter normalizes depth and marks stale/future observations',()=>{
 const a=new MarketAdapter({venue:'kalshi',staleMs:500});
 const fresh=a.normalize({symbol:'X',bids:[{price:.49,size:4}],asks:[{price:.51,size:3}],timestamp:1000},{now:1200});
 assert.equal(fresh.venue,'kalshi');assert.equal(fresh.bid,.49);assert.equal(fresh.ask,.51);
 assert.equal(fresh.stale,false);assert.equal(fresh.depth.asks[0].quantity,3);
 assert.equal(a.normalize({ask:.5,bid:.4,timestamp:1000},{now:1600}).stale,true);
 assert.equal(a.normalize({ask:.5,bid:.4,timestamp:3000},{now:1000}).stale,true);
});

test('OrderSimulator walks the executable side, then applies configured friction',()=>{
 const market=new MarketAdapter({venue:'test',staleMs:1000}).normalize({
  symbol:'ABC',bids:[{price:99,size:5}],asks:[{price:101,size:1},{price:102,size:3}],timestamp:1000,
 },{now:1000});
 const friction=new FrictionModel({fee:{kind:'bps',bps:100},slippage:{kind:'fixed-bps',bps:10},
  latency:{kind:'fixed',ms:250},partialFill:{enabled:false,rejectProbability:0},maxStaleMs:1000});
 const fill=new OrderSimulator().simulate({order:{side:'BUY',quantity:2},market,friction,now:1000,seed:'exact'});
 assert.equal(fill.status,'FILLED');assert.equal(fill.filledQuantity,2);assert.equal(fill.latencyMs,250);
 assert.ok(Math.abs(fill.fillPrice-101.5*1.001)<1e-12);
 assert.ok(Math.abs(fill.feeUsd-fill.gross*.01)<1e-12);
 assert.ok(fill.fillPrice>market.ask,'paper fill must not idealize at mid/best ask when depth/slippage says otherwise');
});
test('depth shortage is an honest partial fill or a rejection when partials are disabled',()=>{
 const market=new MarketAdapter({venue:'poly',staleMs:1000}).normalize({
  symbol:'YES',bids:[{price:.4,size:10}],asks:[{price:.5,size:2}],timestamp:1000,
 },{now:1000});
 const partial=new OrderSimulator().simulate({order:{side:'BUY',quantity:5},market,
  friction:new FrictionModel({latency:{kind:'fixed',ms:0},partialFill:{enabled:false,rejectProbability:0},allowDepthPartial:true,maxStaleMs:1000}),now:1000});
 assert.equal(partial.status,'PARTIAL');assert.equal(partial.reason,'depth-partial');assert.equal(partial.filledQuantity,2);
 const blocked=new OrderSimulator().simulate({order:{side:'BUY',quantity:5},market,
  friction:new FrictionModel({latency:{kind:'fixed',ms:0},partialFill:{enabled:false,rejectProbability:0},allowDepthPartial:false,maxStaleMs:1000}),now:1000});
 assert.equal(blocked.status,'REJECTED');assert.equal(blocked.reason,'insufficient-depth');
});

test('configured no-fill and seeded randomness are deterministic',()=>{
 const market=new MarketAdapter({venue:'x'}).normalize({asks:[{price:1,size:5}],bids:[{price:.9,size:5}],timestamp:1000},{now:1000});
 const friction=new FrictionModel({partialFill:{enabled:true,probability:0,rejectProbability:1},maxStaleMs:1000});
 const a=new OrderSimulator().simulate({order:{side:'BUY',quantity:1},market,friction,now:1000,seed:'same'});
 const b=new OrderSimulator().simulate({order:{side:'BUY',quantity:1},market,friction,now:1000,seed:'same'});
 assert.deepEqual(a,b);assert.equal(a.reason,'simulated-no-fill');
 const r1=seededRandom('stable'),r2=seededRandom('stable');assert.deepEqual([r1(),r1(),r1()],[r2(),r2(),r2()]);
});

test('venue friction is tunable through scoped PAPER configuration',()=>{
 const f=frictionConfigFor('polymarket',{env:{
  MPO_PAPER_POLYMARKET_FEE_BPS:'37',MPO_PAPER_POLYMARKET_SLIPPAGE_BPS:'12',
  MPO_PAPER_POLYMARKET_LATENCY_MIN_MS:'350',MPO_PAPER_POLYMARKET_LATENCY_MAX_MS:'700',
  MPO_PAPER_POLYMARKET_PARTIAL_PROBABILITY:'0.2',MPO_PAPER_POLYMARKET_MIN_NOTIONAL:'1.25',
 }});
 assert.equal(f.fee.bps,37);assert.equal(f.slippage.bps,12);assert.equal(f.latency.minMs,350);
 assert.equal(f.latency.maxMs,700);assert.equal(f.partialFill.probability,.2);assert.equal(f.minNotional,1.25);
});
test('PortfolioTracker persists PAPER cost basis and realized P&L, and refuses LIVE mode',()=>{
 const saves=[];const p=new PortfolioTracker({mode:'PAPER',cash:20,save:s=>saves.push(s)});
 p.applyFill({mode:'PAPER',status:'FILLED',side:'BUY',symbol:'A',filledQuantity:2,gross:10,feeUsd:1});
 let s=p.applyFill({mode:'PAPER',status:'FILLED',side:'SELL',symbol:'A',filledQuantity:1,gross:7,feeUsd:.5});
 assert.equal(s.pnlLabel,'PAPER');assert.equal(s.cash,15.5);assert.equal(s.realizedPnl,1);
 assert.equal(s.fees,1.5);assert.equal(s.positions[0].quantity,1);assert.equal(s.positions[0].costBasis,5.5);
 assert.equal(saves.length,2);
 assert.throws(()=>new PortfolioTracker({mode:'LIVE'}),/simulation-only/);
});


test('OrderSimulator and PortfolioTracker preserve BACKTEST provenance',()=>{
 const market=new MarketAdapter({venue:'test'}).normalize({symbol:'BT',asks:[{price:2,size:10}],bids:[{price:1.9,size:10}],timestamp:1000},{now:1000});
 const fill=new OrderSimulator().simulate({order:{side:'BUY',quantity:2},market,friction:new FrictionModel({latency:{kind:'fixed',ms:0},partialFill:{enabled:false,rejectProbability:0}}),now:1000,mode:'BACKTEST'});
 assert.equal(fill.mode,'BACKTEST');assert.equal(fill.status,'FILLED');
 const p=new PortfolioTracker({mode:'BACKTEST',cash:10});
 const snap=p.applyFill(fill);
 assert.equal(snap.mode,'BACKTEST');assert.equal(snap.pnlLabel,'BACKTEST');assert.equal(snap.positions.length,1);
 assert.throws(()=>new OrderSimulator().simulate({order:{side:'BUY',quantity:1},market,mode:'LIVE'}),/simulation-only/);
});
