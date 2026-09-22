import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMarketRequester} from '../src/marketRequests.js';
import {apiUnitEconomicsSnapshot,resetApiUnitEconomicsForTests,persistApiUnitEconomics,readApiUnitEconomics,configureApiSpendPolicy,evaluateRoiGuard,evaluateDailySpendCap,admitApiSpend,attributeScanCycle,strategyNetPnlAfterDataCost,recordApiRequest,recordApiCacheHit} from '../src/apiUnitEconomics.js';

test.beforeEach(()=>resetApiUnitEconomicsForTests());

test('counts provider requests, cache hits, coalescing, and configured request cost without guessing unpriced cost',async()=>{
  let now=1000,calls=0,release;
  const gate=new Promise(r=>release=r);
  const requester=createMarketRequester({now:()=>now,requestsPerMinute:10,fetcher:async()=>{calls++;await gate;return Response.json({ok:true})}});
  const a=requester.get('https://api.dexscreener.com/x','dex',{ttlMs:1000,costPerRequestUsd:.002});
  const b=requester.get('https://api.dexscreener.com/x','dex',{ttlMs:1000,costPerRequestUsd:.002});
  release();await Promise.all([a,b]);
  await requester.get('https://api.dexscreener.com/x','dex',{ttlMs:1000,costPerRequestUsd:.002});
  now+=2000;await requester.get('https://api.dexscreener.com/y','dex',{ttlMs:1000});
  const x=apiUnitEconomicsSnapshot().providers.dexscreener;
  assert.equal(calls,2);assert.equal(x.requests,2);assert.equal(x.coalescedHits,1);assert.equal(x.cacheHits,1);
  assert.equal(x.pricedRequests,1);assert.equal(x.unpricedRequests,1);assert.equal(x.configuredCostUsd,.002);
  assert.equal(x.cacheAvoidanceRate,.5);
  assert.equal(x.avoidedCostUsd,.004);
  assert.equal(x.purposes.other.requests,2);
  assert.equal(x.purposes.scan.configuredCostUsd,0);
  const snap=apiUnitEconomicsSnapshot();
  assert.equal(snap.totals.avoidedCostUsd,.004);
});

test('purpose tags attribute spend to scan vs research vs index without inventing unpriced cost',async()=>{
  const requester=createMarketRequester({requestsPerMinute:10,fetcher:async()=>Response.json({ok:true})});
  await requester.get('https://api.dexscreener.com/scan','dex',{ttlMs:0,costPerRequestUsd:.002,purpose:'scan'});
  await requester.get('https://api.dexscreener.com/research','dex',{ttlMs:0,costPerRequestUsd:.003,purpose:'research'});
  await requester.get('https://api.helius.xyz/index','h',{ttlMs:0,purpose:'index'});
  const snap=apiUnitEconomicsSnapshot();
  assert.equal(snap.providers.dexscreener.purposes.scan.configuredCostUsd,.002);
  assert.equal(snap.providers.dexscreener.purposes.research.configuredCostUsd,.003);
  assert.equal(snap.providers.helius.purposes.index.requests,1);
  assert.equal(snap.providers.helius.purposes.index.unpricedRequests,1);
  assert.equal(snap.providers.helius.purposes.index.configuredCostUsd,0);
  assert.equal(snap.totals.purposes.scan.configuredCostUsd,.002);
  assert.equal(snap.totals.purposes.research.configuredCostUsd,.003);
});

test('configurable request cap rejects before transport and is measurable',async()=>{
  let now=1000,calls=0;
  const requester=createMarketRequester({now:()=>now,requestsPerMinute:2,fetcher:async()=>{calls++;return Response.json({ok:true})}});
  await requester.get('https://api.helius.xyz/a','h',{ttlMs:0});
  await requester.get('https://api.helius.xyz/b','h',{ttlMs:0});
  await assert.rejects(requester.get('https://api.helius.xyz/c','h',{ttlMs:0}),/budget exhausted \(2\/min\)/);
  assert.equal(calls,2);assert.equal(requester.health().budgetRejects,1);
  assert.equal(apiUnitEconomicsSnapshot().providers.helius.capRejects,1);
  now+=60001;await requester.get('https://api.helius.xyz/c','h',{ttlMs:0});assert.equal(calls,3);
});

test('zero request cap means unlimited so historical Helius behavior is preserved by default',async()=>{
  let calls=0;
  const requester=createMarketRequester({requestsPerMinute:0,fetcher:async()=>{calls++;return Response.json({})}});
  for(let i=0;i<130;i++)await requester.get(`https://api.helius.xyz/${i}`,'h',{ttlMs:0});
  assert.equal(calls,130);assert.equal(requester.health().requestsPerMinute,null);
});

test('persisted role snapshots merge across trader and worker without fabricating costs',async()=>{
  const old=process.env.MONEY_PRINTER_DATA_DIR;
  // Module data directory is bound at import time, so use its default path under cwd and clean only our test roles.
  resetApiUnitEconomicsForTests();
  const r=createMarketRequester({requestsPerMinute:5,fetcher:async()=>Response.json({})});
  await r.get('https://api.geckoterminal.com/a','g',{ttlMs:0,costPerRequestUsd:.001});
  const role=`test-${process.pid}`;const snap=persistApiUnitEconomics(role);assert.equal(snap.providers.geckoterminal.requests,1);
  const merged=readApiUnitEconomics({maxAgeMs:60000});assert.equal(merged.roles[role].providers.geckoterminal.configuredCostUsd,.001);
  try{fs.rmSync(path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data','api-unit-economics',`${role}.json`),{force:true})}catch{}
  if(old===undefined)delete process.env.MONEY_PRINTER_DATA_DIR;else process.env.MONEY_PRINTER_DATA_DIR=old;
});

test('unpriced cache hits do not invent avoided cost',async()=>{
  const requester=createMarketRequester({requestsPerMinute:10,fetcher:async()=>Response.json({})});
  await requester.get('https://api.dexscreener.com/x','dex',{ttlMs:1000});
  await requester.get('https://api.dexscreener.com/x','dex',{ttlMs:1000});
  const x=apiUnitEconomicsSnapshot().providers.dexscreener;
  assert.equal(x.cacheHits,1);assert.equal(x.avoidedCostUsd,0);assert.equal(x.unpricedRequests,1);
});

test('daily USD spend cap rejects priced requests and leaves unpriced and default-unlimited behavior intact',async()=>{
  configureApiSpendPolicy({dailySpendCapUsd:.005});
  let calls=0;
  const requester=createMarketRequester({requestsPerMinute:20,fetcher:async()=>{calls++;return Response.json({ok:true})}});
  await requester.get('https://api.dexscreener.com/a','dex',{ttlMs:0,costPerRequestUsd:.003,purpose:'scan'});
  await requester.get('https://api.dexscreener.com/b','dex',{ttlMs:0,costPerRequestUsd:.002,purpose:'scan'});
  await assert.rejects(requester.get('https://api.dexscreener.com/c','dex',{ttlMs:0,costPerRequestUsd:.002,purpose:'scan'}),/daily USD spend cap exhausted/);
  await requester.get('https://api.dexscreener.com/d','dex',{ttlMs:0,purpose:'scan'});
  assert.equal(calls,3);
  const snap=apiUnitEconomicsSnapshot();
  assert.equal(snap.providers.dexscreener.spendCapRejects,1);
  assert.equal(snap.providers.dexscreener.pricedRequests,2);
  assert.equal(snap.providers.dexscreener.unpricedRequests,1);
  assert.equal(snap.daily.spentUsd,.005);
  assert.equal(requester.health().spendCapRejects,1);
  resetApiUnitEconomicsForTests();
  const unlimited=createMarketRequester({requestsPerMinute:0,fetcher:async()=>{calls++;return Response.json({})}});
  for(let i=0;i<5;i++)await unlimited.get(`https://api.dexscreener.com/u${i}`,'dex',{ttlMs:0,costPerRequestUsd:1});
  assert.equal(apiUnitEconomicsSnapshot().providers.dexscreener.pricedRequests,5);
  assert.equal(evaluateDailySpendCap({costUsd:1}).ok,true);
  assert.equal(evaluateDailySpendCap({costUsd:1}).active,false);
});

test('ROI guard is inactive without explicit cost and value and only blocks priced spend when both exist',async()=>{
  assert.equal(evaluateRoiGuard({}).active,false);
  assert.equal(evaluateRoiGuard({costUsd:.01}).active,false);
  assert.equal(evaluateRoiGuard({valueUsd:5}).active,false);
  assert.equal(evaluateRoiGuard({costUsd:.01,valueUsd:5}).ok,true);
  assert.equal(evaluateRoiGuard({costUsd:6,valueUsd:5,minRoi:1}).ok,false);
  assert.equal(evaluateRoiGuard({costUsd:6,valueUsd:5,minRoi:1}).reason,'roi-below-min');
  configureApiSpendPolicy({roiValueUsd:.004,roiMinRoi:1});
  let calls=0;
  const requester=createMarketRequester({requestsPerMinute:20,fetcher:async()=>{calls++;return Response.json({ok:true})}});
  await requester.get('https://api.dexscreener.com/a','dex',{ttlMs:0,costPerRequestUsd:.003,purpose:'research'});
  await assert.rejects(requester.get('https://api.dexscreener.com/b','dex',{ttlMs:0,costPerRequestUsd:.005,purpose:'research'}),/ROI guard blocked spend/);
  await requester.get('https://api.dexscreener.com/c','dex',{ttlMs:0,purpose:'research'});
  assert.equal(calls,2);
  assert.equal(apiUnitEconomicsSnapshot().providers.dexscreener.roiGuardRejects,1);
  assert.equal(requester.health().roiGuardRejects,1);
  resetApiUnitEconomicsForTests();
  configureApiSpendPolicy({roiValueUsd:1,roiMinRoi:1});
  assert.equal(admitApiSpend({costUsd:.01,purpose:'research'}).ok,true);
  assert.equal(admitApiSpend({costUsd:2,purpose:'research'}).ok,false);
  assert.equal(admitApiSpend({costUsd:2,purpose:'scan'}).ok,true);
  assert.equal(admitApiSpend({costUsd:2,purpose:'research',valueUsd:null}).ok,true);
});

test('scan-cycle attribution and net strategy P&L after data costs leave gross trading P&L untouched',()=>{
  recordApiRequest('dexscreener',{costPerRequestUsd:.01,purpose:'scan'});
  const attr=attributeScanCycle({candidates:10,ready:2,watch:3,outcomesSettled:4});
  assert.equal(attr.scans,1);assert.equal(attr.candidates,10);assert.equal(attr.outcomesSettled,4);
  assert.equal(attr.configuredCostUsd,.01);assert.equal(attr.costPerCandidate,.001);assert.equal(attr.costPerOutcome,.0025);
  const net=strategyNetPnlAfterDataCost({grossPnlSol:1,dataCostUsd:20,solUsd:200});
  assert.equal(net.grossPnlSol,1);assert.equal(net.dataCostUsd,20);assert.equal(net.dataCostSol,.1);assert.equal(net.netPnlSol,.9);assert.equal(net.adjusted,true);
  const unknown=strategyNetPnlAfterDataCost({grossPnlSol:-0.4,dataCostUsd:null,solUsd:200});
  assert.equal(unknown.netPnlSol,-0.4);assert.equal(unknown.adjusted,false);assert.equal(unknown.dataCostUsd,null);
  const noFx=strategyNetPnlAfterDataCost({grossPnlSol:1,dataCostUsd:20,solUsd:null});
  assert.equal(noFx.netPnlSol,null);assert.equal(noFx.dataCostUsd,20);
});

test('scan outcome costs use scan-purpose spend only while strategy net P&L stays on total priced data cost',()=>{
  recordApiRequest('dexscreener',{costPerRequestUsd:.01,purpose:'scan'});
  recordApiRequest('dexscreener',{costPerRequestUsd:.05,purpose:'research'});
  recordApiRequest('helius',{costPerRequestUsd:.02,purpose:'index'});
  recordApiCacheHit('dexscreener',{costPerRequestUsd:.01,purpose:'scan'});
  recordApiCacheHit('dexscreener',{costPerRequestUsd:.04,purpose:'research'});
  recordApiCacheHit('helius',{costPerRequestUsd:.03,purpose:'index'});
  const attr=attributeScanCycle({candidates:10,ready:2,watch:1,outcomesSettled:5});
  assert.equal(attr.configuredCostUsd,.01);
  assert.equal(attr.costPerScan,.01);
  assert.equal(attr.costPerCandidate,.001);
  assert.equal(attr.costPerReady,.005);
  assert.equal(attr.costPerOutcome,.002);
  assert.equal(attr.costBasis,'scan-purpose-configured-spend');
  recordApiRequest('dexscreener',{costPerRequestUsd:.02,purpose:'scan'});
  recordApiRequest('dexscreener',{costPerRequestUsd:.09,purpose:'research'});
  const attr2=attributeScanCycle({candidates:5,ready:1,watch:0,outcomesSettled:1});
  assert.equal(attr2.configuredCostUsd,.03);
  assert.equal(attr2.scans,2);
  assert.equal(attr2.costPerScan,.015);
  const snap=apiUnitEconomicsSnapshot();
  assert.equal(snap.schema,'mpo.api-unit-economics.v1');
  assert.equal(snap.totals.configuredCostUsd,.19);
  assert.equal(snap.totals.avoidedCostUsd,.08);
  assert.equal(snap.purposeSpend.scan.configuredCostUsd,.03);
  assert.equal(snap.purposeSpend.scan.avoidedCostUsd,.01);
  assert.equal(snap.purposeSpend.scan.efficiency,.25);
  assert.equal(snap.purposeSpend.research.configuredCostUsd,.14);
  assert.equal(snap.purposeSpend.research.avoidedCostUsd,.04);
  assert.equal(snap.purposeSpend.research.efficiency,.222222);
  assert.equal(snap.purposeSpend.index.configuredCostUsd,.02);
  assert.equal(snap.purposeSpend.index.avoidedCostUsd,.03);
  assert.equal(snap.purposeSpend.index.efficiency,.6);
  assert.equal(snap.totals.purposes.scan.efficiency,.25);
  const net=strategyNetPnlAfterDataCost({grossPnlSol:1,dataCostUsd:snap.totals.configuredCostUsd,solUsd:200});
  assert.equal(net.dataCostUsd,.19);
  assert.equal(net.dataCostSol,.00095);
  assert.equal(net.netPnlSol,.99905);
  assert.equal(net.grossPnlSol,1);
  assert.notEqual(net.dataCostUsd,attr2.configuredCostUsd);
});

test('unit-economics snapshot keeps v1 keys and extends with purposeSpend',()=>{
  const snap=apiUnitEconomicsSnapshot();
  for(const k of ['schema','startedAt','updatedAt','providers','totals','daily','scanAttribution','roiGuard','spendPolicy','costSemantics']){
    assert.ok(k in snap,k);
  }
  assert.equal(snap.schema,'mpo.api-unit-economics.v1');
  for(const k of ['scans','candidates','ready','watch','outcomesSettled','configuredCostUsd','costPerScan','costPerCandidate','costPerReady','costPerOutcome']){
    assert.ok(k in snap.scanAttribution,k);
  }
  for(const k of ['scan','research','index']){
    assert.equal(snap.purposeSpend[k].configuredCostUsd,0);
    assert.equal(snap.purposeSpend[k].avoidedCostUsd,0);
    assert.equal(snap.purposeSpend[k].efficiency,0);
  }
});

test('persisted role snapshots merge purpose spend without mixing scan outcome cost',()=>{
  const role=`test-purpose-${process.pid}`;
  recordApiRequest('dexscreener',{costPerRequestUsd:.004,purpose:'scan'});
  recordApiRequest('dexscreener',{costPerRequestUsd:.006,purpose:'research'});
  recordApiCacheHit('dexscreener',{costPerRequestUsd:.002,purpose:'scan'});
  attributeScanCycle({candidates:2,ready:1,watch:0,outcomesSettled:1});
  persistApiUnitEconomics(role);
  const merged=readApiUnitEconomics({maxAgeMs:60000});
  assert.equal(merged.schema,'mpo.api-unit-economics.v1');
  assert.equal(merged.scanAttribution.configuredCostUsd,.004);
  assert.equal(merged.scanAttribution.costPerOutcome,.004);
  assert.equal(merged.purposeSpend.scan.configuredCostUsd,.004);
  assert.equal(merged.purposeSpend.scan.avoidedCostUsd,.002);
  assert.equal(merged.purposeSpend.scan.efficiency,.333333);
  assert.equal(merged.purposeSpend.research.configuredCostUsd,.006);
  assert.equal(merged.totals.configuredCostUsd,.01);
  try{fs.rmSync(path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data','api-unit-economics',`${role}.json`),{force:true})}catch{}
});

test('daily spend cap rolls over at UTC day boundary',()=>{
  let t=Date.parse('2026-09-21T23:59:59.000Z');
  configureApiSpendPolicy({dailySpendCapUsd:.002,now:()=>t});
  assert.equal(admitApiSpend({costUsd:.002,now:t}).ok,true);
  recordApiRequest('dexscreener',{costPerRequestUsd:.002,purpose:'scan',now:t});
  assert.equal(admitApiSpend({costUsd:.001,now:t}).ok,false);
  t=Date.parse('2026-09-22T00:00:01.000Z');
  configureApiSpendPolicy({now:()=>t});
  assert.equal(admitApiSpend({costUsd:.002,now:t}).ok,true);
});
