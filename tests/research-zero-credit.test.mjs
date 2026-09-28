import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreDatabase } from '../src/core/database.js';
import { MarketPlatform } from '../src/core/platform.js';
import { MarketEventBus } from '../src/core/eventBus.js';
import { ResearchBudget } from '../src/core/researchBudget.js';
import { summarizeFiling } from '../src/core/aiSummary.js';
import { PAID_AI_BUILD_ENABLED, ResearchCache, localFilingSummary } from '../src/core/localResearch.js';
const flush = () => new Promise(resolve => setImmediate(resolve));
const text = 'Example Company reported revenue of $94.9 million for the quarter. The company disclosed liquidity risks associated with its debt agreements. The board appointed a new chief financial officer during the reporting period.';

test('zero-credit build denies the provider boundary even with an explicitly injected client', async () => {
  let calls=0;const client={beta:{messages:{create:async()=>{calls++;throw Error('must never run');}}}};
  assert.equal(PAID_AI_BUILD_ENABLED,false);
  await assert.rejects(summarizeFiling({text,client}),e=>e.code==='PAID_AI_DISABLED');
  assert.equal(calls,0);
  const db=new CoreDatabase(':memory:');
  try {const b=new ResearchBudget(db,{env:{}});assert.deepEqual(b.limits(),{calls:0,tokens:0});assert.throws(()=>b.reserve('x',text,2048),e=>e.code==='RESEARCH_BUDGET');assert.equal(b.snapshot().calls,0);} finally {db.close();}
});

test('local excerpts preserve exact source ranges, decimal figures and explicit scope',()=>{
  const r=localFilingSummary({text,facts:{accession:'example',ticker:'EX',url:'https://example.invalid/filing'},now:1000});
  assert.equal(r.kind,'LOCAL_EXTRACTIVE_SUMMARY');assert.equal(r.cost.modelCalls,0);assert.equal(r.contentHash.length,64);
  for(const b of r.blocks)for(const c of b.citations){assert.equal(c.quote,text.slice(c.start,c.end));assert.equal(b.text,c.quote);}
  assert.ok(r.blocks.some(b=>b.text.includes('$94.9 million')));assert.match(r.scope,/not a complete summary/);assert.equal(r.confidence,null);
});
test('research cache survives restart, records reuse, and refuses expired evidence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-local-cache-'));let now=1000,db=new CoreDatabase(path.join(dir,'cache.db'));
  try {
    let cache=new ResearchCache(db,{now:()=>now});cache.put('filing',localFilingSummary({text,now}));
    assert.equal(cache.get('filing').reuseCount,1);db.close();db=new CoreDatabase(path.join(dir,'cache.db'));
    cache=new ResearchCache(db,{now:()=>now});assert.equal(cache.get('filing').reuseCount,2);
    cache.put('quote',{contentHash:'q1',expiresAt:1100,source:'fixture'});now=1100;assert.equal(cache.get('quote'),null);
    assert.throws(()=>cache.put('invalid',{contentHash:'x',expiresAt:NaN}),/expiry/);
    assert.equal(cache.snapshot().entries,1);assert.equal(cache.snapshot().paidModelsEnabled,false);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('historical AI cache remains readable without provider calls or new document fetches',async()=>{
  const p=new MarketPlatform(),accession='0000320193-26-000101';
  try {
    const result={status:'OK',model:'historical-fixture',blocks:[{text:'Stored result',citations:[]}]};
    p.store.db.prepare('INSERT INTO ai_summaries VALUES(?,?,?,?,?,?)').run(accession,1000,result.model,result.status,100,JSON.stringify(result));
    p.summarize=async()=>{throw Error('provider should not run');};p.edgar.document=async()=>{throw Error('document should not refetch');};
    const cached=await p.edgarSummary({accession});assert.equal(cached.kind,'AI_GENERATED_ANALYSIS');assert.equal(cached.cached,true);assert.equal(cached.model,'historical-fixture');assert.equal(p.researchBudget.snapshot().calls,0);
  }finally{p.close();}
});

test('event identities dedupe source retries but never confuse two fills on one order',async()=>{
  let now=1000;const bus=new MarketEventBus({now:()=>now,dedupeCapacity:2,dedupeTtlMs:100}),events=[];
  bus.on('ORDER_FILLED',e=>events.push(e));
  assert.equal(bus.publish('ORDER_FILLED',{orderId:'o',quantity:1},{id:'fill-1',source:'fixture',observedAt:990,expiresAt:1200,confidence:.8,marketRelevance:['stock:EX']}),true);
  assert.equal(bus.publish('ORDER_FILLED',{orderId:'o',quantity:1},{id:'fill-1',source:'fixture'}),false);
  assert.equal(bus.publish('ORDER_FILLED',{orderId:'o',quantity:1},{id:'fill-2',source:'fixture'}),true);
  await flush();assert.equal(events.length,2);assert.equal(events[0].schema,'mpo.market-event.v1');assert.equal(events[0].freshness,'FRESH');assert.equal(events[0].confidence,.8);assert.deepEqual(events[0].marketRelevance,['stock:EX']);
  now=1101;assert.equal(bus.publish('ORDER_FILLED',{orderId:'o'},{id:'fill-1',source:'fixture'}),true);await flush();assert.equal(bus.snapshot().duplicates,1);assert.ok(bus.snapshot().dedupeEntries<=2);
});

test('event overflow never poisons a retry identity and observer failures are isolated',async()=>{
  const bus=new MarketEventBus({capacity:1}),events=[];
  bus.on('NEWS_RECEIVED',()=>{throw Error('broken observer');});bus.on('NEWS_RECEIVED',e=>events.push(e));
  bus.publish('NEWS_RECEIVED',{headline:'first'},{id:'first'});
  assert.equal(bus.publish('NEWS_RECEIVED',{headline:'second'},{id:'second'}),false);
  await flush();assert.equal(bus.publish('NEWS_RECEIVED',{headline:'second'},{id:'second'}),true);await flush();
  assert.equal(events.length,2);assert.equal(events[0].confidence,null);assert.deepEqual(events[0].marketRelevance,[]);
  assert.equal(bus.snapshot().listenerErrors,2);assert.equal(bus.snapshot().dropped,1);
});
