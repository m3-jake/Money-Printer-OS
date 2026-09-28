import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreDatabase } from '../src/core/database.js';
import { MarketPlatform } from '../src/core/platform.js';
import { ResearchBudget } from '../src/core/researchBudget.js';
import { Intelligence } from '../src/core/intelligence.js';
import { MarketEventBus } from '../src/core/eventBus.js';
import { closeStats, scoreRow } from '../src/scoreboard.js';

test('reservations survive restart, failures and midnight; zero limits disable paid work', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpos-budget-')), file=path.join(dir,'core.db');
  let now=Date.UTC(2026,8,28),store=new CoreDatabase(file);
  const env={MPO_AI_DAILY_CALLS:'1',MPO_AI_DAILY_TOKEN_RESERVATIONS:'10000'};
  let b=new ResearchBudget(store,{now:()=>now,env});b.reserve('a','text',10);store.close();
  store=new CoreDatabase(file);b=new ResearchBudget(store,{now:()=>now,env});
  assert.equal(b.snapshot().uncertain,1);assert.throws(()=>b.reserve('b','text',10),/budget/);
  now+=86400000;const id=b.reserve('b','text',10);b.finish(id,null,new Error('lost response'));
  assert.throws(()=>b.reserve('c','text',10),/budget/);
  now+=86400000;env.MPO_AI_DAILY_CALLS='0';assert.throws(()=>b.reserve('c','text',10),/budget/);
  store.close();fs.rmSync(dir,{recursive:true});
});

test('concurrent filing requests share one local extraction; no model call even with credentials',async()=>{
  const saved=process.env.ANTHROPIC_API_KEY,limit=process.env.MPO_AI_DAILY_CALLS;
  process.env.ANTHROPIC_API_KEY='test-only';process.env.MPO_AI_DAILY_CALLS='1';
  const p=new MarketPlatform(),accession='0000320193-26-000101';let calls=0;
  p.store.put({kind:'Filing',provider:'sec',sourceId:accession,data:{url:'https://example.invalid/filing'}});
  p.edgar.document=async()=>'<p>'+('filing facts '.repeat(30))+'</p>';
  p.summarize=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {model:'test',status:'OK',usage:{input:20,output:10},blocks:[]};};
  try {
    const results=await Promise.all([p.edgarSummary({accession}),p.edgarSummary({accession,force:true})]);
    assert.equal(calls,0);assert.equal(results[0].kind,'LOCAL_EXTRACTIVE_SUMMARY');assert.deepEqual(results[0],results[1]);
    process.env.MPO_AI_DAILY_CALLS='0';assert.equal((await p.edgarSummary({accession})).cached,true);
    assert.equal((await p.edgarSummary({accession,force:true})).kind,'LOCAL_EXTRACTIVE_SUMMARY');assert.equal(calls,0);
    assert.equal(p.researchBudget.snapshot().actualTokens,0);assert.equal(p.researchBudget.snapshot().calls,0);
  }finally{p.close();if(saved===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=saved;if(limit===undefined)delete process.env.MPO_AI_DAILY_CALLS;else process.env.MPO_AI_DAILY_CALLS=limit;}
});

test('triage ignores unchanged heartbeats and backtests; new losses yield durable local findings',()=>{
  const store=new CoreDatabase(':memory:'),i=new Intelligence(store,new MarketEventBus());
  const row={id:'pumpfun-fair',module:'Pump.fun',book:'FAIR',kind:'paper',closes:25,minCloses:20,netPnl:-1,netWithoutBest:-2,freshness:{status:'FRESH'}};
  i.observe({at:1000,rows:[row,{...row,id:'lab',kind:'lab'}]});
  i.observe({at:2000,rows:[row]});assert.equal(i.snapshot().recentRuns,1);
  assert.equal(i.snapshot().research[0].status,'NEEDS_EVIDENCE');
  const restarted=new Intelligence(store,new MarketEventBus());restarted.observe({at:3000,rows:[row]});assert.equal(restarted.snapshot().recentRuns,1);
  restarted.observe({at:4000,rows:[{...row,closes:26}]});assert.equal(restarted.snapshot().recentRuns,2);store.close();
});

test('cross-market memory retains blockers, unknown EV and quote expiry',()=>{
  const store=new CoreDatabase(':memory:'),i=new Intelligence(store,new MarketEventBus());
  i.recordComparison({a:{id:'a',provider:'kalshi'},b:{id:'b',provider:'polymarket'},classification:'WEAK MATCH',directions:[{sideA:'YES',sideB:'NO',conditionalMatchedPayoff:null,capitalRequired:1,availableExecutableSize:1,executionRisks:['NON_ATOMIC_FILLS'],blocked:['TERMS_NOT_VERIFIED']}]},1000);
  const o=i.snapshot(32000).opportunities[0];assert.equal(o.expectedValue,null);assert.equal(o.actionable,false);assert.equal(o.stale,true);assert.deepEqual(o.contradictingEvidence,['TERMS_NOT_VERIFIED']);store.close();
});

test('closed-outcome measurements retain breakevens and never coerce unknown P/L to zero edge',()=>{
  const s=closeStats([{pnl:3,at:1},{pnl:-2,at:2},{pnl:0,at:3}]);
  assert.equal(s.losses,1);assert.equal(s.breakevens,1);assert.equal(s.averageLoss,-2);assert.equal(s.realizedDrawdown,2);
  assert.equal(scoreRow({stats:{netPnl:null},baseline:{netPnl:0}}).edgeVsBaseline,null);
});
