import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMarketRequester} from '../src/marketRequests.js';
import {apiUnitEconomicsSnapshot,resetApiUnitEconomicsForTests,persistApiUnitEconomics,readApiUnitEconomics} from '../src/apiUnitEconomics.js';

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
