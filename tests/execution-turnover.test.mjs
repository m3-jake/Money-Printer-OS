import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMarketRequester} from '../src/marketRequests.js';
import {paperExitQuote,reviewPositionPrice,exitSimulation,emptyPriceReviewTally,tallyPriceReview,recentTickMedian,TICK_BAND_MAX_RATIO} from '../src/positionExecution.js';

test('concurrent reads share transport and cache preserves original observation time',async()=>{
 let at=100000,calls=0;
 const r=createMarketRequester({now:()=>at,fetcher:async()=>{calls++;return Response.json({price:1});}});
 const [a,b]=await Promise.all([r.get('https://test.local/a'),r.get('https://test.local/a')]);
 assert.equal(calls,1);assert.equal(a.fetchedAt,b.fetchedAt);
 at+=5000;assert.equal((await r.get('https://test.local/a')).fetchedAt,100000);
 at+=20000;await r.get('https://test.local/a');assert.equal(calls,2);
});

test('429 backs off the whole host, respects Retry-After and resumes after the window',async()=>{
 let at=100000,calls=0;
 const r=createMarketRequester({now:()=>at,fetcher:async()=>{calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'45'}}):Response.json({ok:true});}});
 await assert.rejects(r.get('https://test.local/a'),/429/);
 await assert.rejects(r.get('https://test.local/b'),/backoff/);assert.equal(calls,1);
 at+=44999;await assert.rejects(r.get('https://test.local/b'),/backoff/);
 at++;await r.get('https://test.local/b');assert.equal(calls,2);
 assert.equal(r.health().ok,true);
});

test('timeout cancels the underlying request instead of leaving it running',async()=>{
 let aborted=false;
 const r=createMarketRequester({timeoutMs:10,fetcher:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));}))});
 await assert.rejects(r.get('https://test.local/a'),/timed out/);
 assert.equal(aborted,true);assert.equal(r.health().inFlight,0);
});

test('request budget bounds fresh URL churn',async()=>{
 let calls=0;
 const r=createMarketRequester({now:()=>100000,fetcher:async()=>{calls++;return Response.json({});}});
 for(let i=0;i<120;i++)await r.get('https://test.local/'+i);
 await assert.rejects(r.get('https://test.local/extra'),/request budget/);assert.equal(calls,120);
});

const position=()=>({mint:'mint',pairAddress:'pool',entryPrice:1,lastPrice:1,sizeSol:1,remainingSol:1,realizedSol:-.0025});
const pair=(price,at,over={})=>({baseToken:{address:'mint'},pairAddress:'pool',priceUsd:price,priceObservedAt:at,...over});
test('paper crash correction needs distinct exact-pool observations across 15 seconds',()=>{
 const p=position();let now=100000;
 assert.equal(reviewPositionPrice(p,pair(.01,now),{paper:true,now}).accepted,false);
 for(let i=0;i<10;i++)reviewPositionPrice(p,pair(.01,now),{paper:true,now:now+1000});
 assert.equal(p.priceReview.count,1,'cached ticks do not corroborate a crash');
 assert.equal(reviewPositionPrice(p,pair(.0101,now+5000),{paper:true,now:now+5000}).accepted,false);
 const reviewed=reviewPositionPrice(p,pair(.0099,now+15000),{paper:true,now:now+15000});
 assert.equal(reviewed.accepted,true);assert.equal(reviewed.corrected,true);
});

test('missing pools, stale prices, huge windfalls and live jumps stay quarantined',()=>{
 for(const over of [{baseToken:{address:'other'}},{pairAddress:'other'},{priceObservedAt:1000},{priceUsd:Infinity}])
  assert.equal(reviewPositionPrice(position(),pair(1,100000,over),{paper:true,now:100000}).accepted,false);
 for(const paper of [true,false]){
  const p=position();for(const now of [100000,110000,120000])assert.equal(reviewPositionPrice(p,pair(100,now),{paper,now}).accepted,false);
 }
 const p=position();for(const now of [100000,110000,120000])assert.equal(reviewPositionPrice(p,pair(.01,now),{paper:false,now}).accepted,false);
});

test('P1.5 the funnel counts what the price review rejected, band included', () => {
  // V8: the band only rejects a price ABOVE 5x the recent tick median. The counter has to make that
  // visible (and its one-sidedness measurable) before anyone changes the band itself.
  const tally = emptyPriceReviewTally();
  assert.deepEqual(tally, { reviewed: 0, accepted: 0, rejected: 0, reasons: {}, bandRejects: 0, bandMedianRatioMin: null, bandMedianRatioMax: null, lastBandAt: null });
  const p = position(), now = 100000;
  const median = recentTickMedian([...Array(6)].map((_, i) => ({ ts: now - 1000, price: .01 })), now);
  assert.equal(median, .01);
  const above = reviewPositionPrice(p, pair(.1, now), { paper: true, now, ticks: [...Array(6)].map(() => ({ ts: now - 1000, price: .01 })) });
  assert.equal(above.accepted, false); assert.equal(above.reason, 'price-outside-tick-band');
  tallyPriceReview(tally, above, now);
  assert.equal(tally.bandRejects, 1); assert.equal(tally.rejected, 1); assert.equal(tally.accepted, 0);
  assert.equal(tally.reasons['price-outside-tick-band'], 1); assert.equal(tally.lastBandAt, now);
  assert.equal(tally.bandMedianRatioMin, 10); assert.equal(tally.bandMedianRatioMax, 10);
  // The asymmetry itself: a crash far BELOW the median is never a band rejection, so the minimum ratio
  // the counter can ever record stays above the band maximum.
  const crash = reviewPositionPrice(p, pair(.0005, now), { paper: true, now, ticks: [...Array(6)].map(() => ({ ts: now - 1000, price: .01 })) });
  assert.notEqual(crash.reason, 'price-outside-tick-band');
  tallyPriceReview(tally, crash, now);
  assert.equal(tally.bandRejects, 1, 'a downward multiple is not a band rejection');
  assert.equal(tally.reasons[crash.reason], 1);
  // Stale/missing prices and accepted reviews land in the same tally, so the funnel shows the whole review.
  tallyPriceReview(tally, { accepted: false, reason: 'missing-or-stale-price' });
  tallyPriceReview(tally, { accepted: true });
  assert.equal(tally.reviewed, 4); assert.equal(tally.accepted, 1); assert.equal(tally.rejected, 3);
  assert.equal(tally.bandMedianRatioMin > TICK_BAND_MAX_RATIO, true, 'the band never rejects downward');
  // A second, bigger rejection widens the recorded ratio range without changing the count baseline.
  tallyPriceReview(tally, { accepted: false, reason: 'price-outside-tick-band', medianRatio: 40 }, 200000);
  assert.equal(tally.bandRejects, 2); assert.equal(tally.bandMedianRatioMax, 40); assert.equal(tally.bandMedianRatioMin, 10);
  assert.equal(tally.lastBandAt, 200000);
  assert.equal(tallyPriceReview(null, { accepted: true }).accepted, 1, 'a missing tally is created, not thrown on');
  // The engine publishes it on the funnel and the HUD shows it.
  const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /const priceReviews=emptyPriceReviewTally\(\);/);
  assert.match(indexSource, /await updatePositions\(s, priceReviews\)/);
  assert.equal((indexSource.match(/await updatePositions\(/g) || []).length, 1, 'one call site, so the tally cannot be left unpassed elsewhere');
  assert.match(indexSource, /priceReviews:\{\.\.\.priceReviews,reasons:\{\.\.\.priceReviews\.reasons\}\}/);
  assert.match(indexSource, /if \(reviewTally\) tallyPriceReview\(reviewTally, review, Date\.now\(\)\);/);
  const hud = fs.readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  assert.match(hud, /const rv=s\.system\?\.opportunityFunnel\?\.priceReviews;/);
  assert.match(hud, /rv&&rv\.rejected\?`price rejects \$\{rv\.rejected\} · band \$\{rv\.bandRejects\}`:null/);
});

test('exit net return includes entry fee, exit slippage and fee on sale proceeds',()=>{
 const p=position(),q=paperExitQuote(p,1.01,{slippageBps:80,feeBps:25});
 assert.ok(1.01>p.entryPrice&&q.netReturnPct<0,'a green quote can still lose cash');
 assert.equal(q.fee,(1.01*.992)*.0025);
 const winner=paperExitQuote(p,2,{slippageBps:0,feeBps:25});
 assert.equal(winner.proceeds,1.995);assert.ok(Math.abs(winner.pnlSol-.9925)<1e-12);
 const partial=paperExitQuote(p,2,{slippageBps:0,feeBps:25},.5);
 assert.equal(partial.basis,.5);assert.equal(partial.proceeds,.9975);
});

test('exit impact grows with sale value and never creates negative proceeds on a crash',()=>{
 const p=position();p.lastLiquidityUsd=20000;
 const low=exitSimulation(p,{priceUsd:1},100,80,25),high=exitSimulation(p,{priceUsd:10},100,80,25);
 assert.ok(high.slippageBps>low.slippageBps);
 assert.ok(paperExitQuote(p,.000001,high).proceeds>=0);
});

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-execution-'));
process.env.MONEY_PRINTER_DATA_DIR=dir;process.env.POLYMARKET_AUTOSTART='false';
const savedFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('Unexpected external request in test');};
const poly=await import('../src/polymarket.js');
const dex=await import('../src/dexscreener.js');
test.after(()=>{globalThis.fetch=savedFetch;poly.stopPolymarketLoops();fs.rmSync(dir,{recursive:true,force:true});});

test('buy quote spends the stated budget across depth levels',()=>{
 const q=poly.fillQuote([{price:.8,size:1},{price:.9,size:10}],2);
 assert.ok(Math.abs(q.sharesFilled-(1+1.2/.9))<1e-10);
 assert.ok(Math.abs(q.fillPrice*q.sharesFilled-2)<1e-10);
 assert.equal(poly.fillQuote([{price:.9,size:1}],2).fillPrice,null);
});

test('cash-out walks bid depth, charges fees and refuses insufficient depth',()=>{
 assert.equal(poly.sellQuote([{price:.99,size:1}],10),null);
 const q=poly.sellQuote([{price:.99,size:1},{price:.9,size:9}],10,{feesEnabled:false});
 assert.ok(Math.abs(q.payout-9.09)<1e-10);assert.ok(q.price<.99);
 assert.ok(poly.sellQuote([{price:.99,size:10}],10,{feeSchedule:{rate:.05,exponent:1}}).payout<9.9);
});

test('16 held positions use one request and exact base/pool matching',async()=>{
 let calls=0;
 const positions=Array.from({length:16},(_,i)=>({mint:'m'+i,pairAddress:'p'+i}));
 globalThis.fetch=async(url)=>{
  calls++;assert.match(url,/latest\/dex\/pairs\/solana\/p0,/);
  return Response.json({pairs:positions.slice(0,15).map((p,i)=>({chainId:'solana',pairAddress:p.pairAddress,baseToken:{address:i===1?'wrong':p.mint},priceUsd:'1'}))});
 };
 const rows=await dex.refreshPositionPairs(positions);
 assert.equal(calls,1);assert.ok(rows[0].pair);assert.equal(rows[1].pair,null);assert.equal(rows[15].pair,null);
 await dex.refreshPositionPairs(positions);assert.equal(calls,1,'5 second cache avoids a duplicate request');
});
