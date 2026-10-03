import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectSolanaTicks, filterPolymarketRecords, appendNdjson, atomicJson, acquireCollectorLock, releaseCollectorLock, isEntryModule } from '../src/researchCollector.js';

test('Solana evidence collector appends only unseen observed ticks',()=>{
  const state={tickHistory:{MINT:[{ts:100,price:1,liq:1000,v5:10,flow:1.2,score:70,buys:4,sells:2},{ts:200,price:1.1,liq:1100,v5:12,flow:1.4,score:75,buys:5,sells:2}]}};
  const a=collectSolanaTicks(state,{});
  assert.equal(a.rows.length,2);assert.equal(a.cursor.MINT,200);
  assert.equal(a.rows[0].coverage.depth,false);assert.equal(a.rows[0].provenance,'observed-state-tick');
  const b=collectSolanaTicks(state,a.cursor);assert.equal(b.rows.length,0);
});

test('Polymarket collector records observed depth, explicit fee coverage and heartbeat dedupe',()=>{
  const snap={records:[{tokenId:'T1',marketId:'M1',eventId:'E1',gameId:'G1',ts:1000,
    bids:Array.from({length:15},(_,i)=>({price:.5-i*.001,size:10+i})),asks:Array.from({length:15},(_,i)=>({price:.51+i*.001,size:11+i})),
    feeMeta:{feesEnabled:true,feeSchedule:{rate:.05,exponent:1},takerBaseFee:null}}]};
  const a=filterPolymarketRecords(snap,{},10_000);
  // Five levels per side by default since 2026-10-03 (MPO_POLY_CAPTURE_LEVELS restores more).
  assert.equal(a.rows.length,1);assert.equal(a.rows[0].bids.length,5);assert.equal(a.rows[0].asks.length,5);
  assert.equal(a.rows[0].coverage.depth,true);assert.equal(a.rows[0].coverage.costs,true);
  const b=filterPolymarketRecords(snap,{books:a.books},20_000);assert.equal(b.rows.length,0);
  const c=filterPolymarketRecords(snap,{books:a.books},50_001);assert.equal(c.rows.length,1);
});

test('Polymarket collector never invents fee coverage',()=>{
  const snap={records:[{tokenId:'T2',marketId:'M2',eventId:'E2',ts:1000,bids:[{price:.4,size:5}],asks:[{price:.6,size:5}],feeMeta:{feesEnabled:true,feeSchedule:null,takerBaseFee:null}}]};
  const a=filterPolymarketRecords(snap,{},10_000);
  assert.equal(a.rows[0].coverage.costs,false);
});

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mpo-collector-'));
const now=Date.UTC(2026,8,25,12);

test('append after a torn or NUL-extended tail starts a fresh line and never merges records',()=>{
  const dir=tmp(),f=path.join(dir,'polymarket-depth-2026-09-25.ndjson');
  fs.writeFileSync(f,'{"a":1}\n{"torn":');
  appendNdjson('polymarket-depth',[{b:2}],{dir,now});
  fs.appendFileSync(f,Buffer.alloc(8));
  appendNdjson('polymarket-depth',[{c:3}],{dir,now});
  const lines=fs.readFileSync(f,'utf8').split('\n').filter(Boolean);
  assert.deepEqual(JSON.parse(lines[0]),{a:1});
  assert.equal(lines[1],'{"torn":');
  assert.deepEqual(JSON.parse(lines[2]),{b:2});
  assert.deepEqual(JSON.parse(lines[4]),{c:3});
  const clean=path.join(dir,'x-2026-09-25.ndjson');
  appendNdjson('x',[{a:1}],{dir,now});appendNdjson('x',[{b:2}],{dir,now});
  assert.equal(fs.readFileSync(clean,'utf8'),'{"a":1}\n{"b":2}\n');
});

test('atomicJson replaces the file whole and leaves no temp file behind',()=>{
  const dir=tmp(),f=path.join(dir,'s.json');
  atomicJson(f,{v:1});atomicJson(f,{v:2});
  assert.deepEqual(JSON.parse(fs.readFileSync(f,'utf8')),{v:2});
  assert.deepEqual(fs.readdirSync(dir),['s.json']);
});

test('collector lock admits one owner, yields to a live holder and takes over stale or dead locks',()=>{
  const dir=tmp(),lock=path.join(dir,'collector.lock');
  assert.equal(acquireCollectorLock(lock,{pid:111,now:Date.now()}).ok,true);
  const held=acquireCollectorLock(lock,{pid:222,now:Date.now(),isAlive:()=>true});
  assert.equal(held.ok,false);assert.equal(held.heldBy,111);
  assert.equal(acquireCollectorLock(lock,{pid:222,now:Date.now(),isAlive:()=>false}).ok,true);
  assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,222);
  assert.equal(acquireCollectorLock(lock,{pid:333,now:Date.now()+120_000,staleMs:60_000,isAlive:()=>true}).ok,true);
  releaseCollectorLock(lock,222);assert.equal(fs.existsSync(lock),true,'a non-owner must not release the lock');
  releaseCollectorLock(lock,333);assert.equal(fs.existsSync(lock),false);
});

test('collector entry check survives symlinked install paths and trusts the desktop supervisor',t=>{
  const dir=tmp(),real=path.join(dir,'researchCollector.js');fs.writeFileSync(real,'');
  const url=pathToFileURL(fs.realpathSync(real)).href;
  assert.equal(isEntryModule(real,url,{}),true);
  assert.equal(isEntryModule(path.join(dir,'other.js'),url,{}),false);
  assert.equal(isEntryModule(undefined,url,{}),false);
  assert.equal(isEntryModule(undefined,url,{MONEY_PRINTER_SUPERVISED:'1'}),true);
  const link=path.join(dir,'linked');
  try{fs.symlinkSync(dir,link,'junction')}catch{t.diagnostic('symlinks unavailable; skipped link case');return}
  assert.equal(isEntryModule(path.join(link,'researchCollector.js'),url,{}),true);
});
