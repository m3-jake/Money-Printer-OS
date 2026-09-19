import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, scoreVariant, mulberry32 } from '../src/evolutionScoring.js';
import { globalVariant, splitResearchRows, searchCoverage, effectiveBatchSize, sealedAudit, buildResearchVariants } from '../src/evolutionSearch.js';

const parent={id:'BASE',weights:BASE,threshold:60,stopPct:8,takePct:16,maxHoldMin:30};
function rows(n=300){
  return Array.from({length:n},(_,i)=>({ts:1_700_000_000_000+i*60_000,returnPct:Math.sin(i/7)*3+.25,features:{edge:(i%11)/10,explosion:(i%7)/6,execution:(i%5)/4,momentum:(i%13)/12,liquidity:(i%17)/16,freshness:(i%3)/2,flow:(i%19)/18,volumeAccel:(i%23)/22,priceAccel:(i%29)/28}}));
}

test('Halton global exploration is deterministic and reaches distant 13-D regions',()=>{
  const a=Array.from({length:512},(_,i)=>globalVariant({generation:7,index:i}));
  const b=Array.from({length:512},(_,i)=>globalVariant({generation:7,index:i}));
  assert.deepEqual(a,b);
  const c=searchCoverage(a,{steps:8});
  assert.equal(c.dimensions,13);
  assert.equal(c.duplicates,0);
  assert.ok(c.cells>480,`cells=${c.cells}`);
  const thresholds=a.map(x=>x.threshold), holds=a.map(x=>x.maxHoldMin);
  assert.ok(Math.min(...thresholds)<35 && Math.max(...thresholds)>87);
  assert.ok(Math.min(...holds)<15 && Math.max(...holds)>225);
  // Every feature gets at least one strongly dominant global sample.
  for(const k of Object.keys(BASE)) assert.ok(Math.max(...a.map(v=>v.weights[k]))>.35,`${k} never reached a distant region`);
});

test('changing sealed returns cannot change ranking data or ranking scores',()=>{
  const original=rows(300);
  const mutated=structuredClone(original);
  for(let i=255;i<300;i++) mutated[i].returnPct = i%2?99:-99;
  const x=splitResearchRows(original,{sealedFraction:.15});
  const y=splitResearchRows(mutated,{sealedFraction:.15});
  assert.equal(x.rankingRows.length,255);
  assert.deepEqual(x.rankingRows,y.rankingRows);
  assert.notDeepEqual(x.sealedRows,y.sealedRows);
  const sx=scoreVariant(parent,x.rankingRows,{rounds:20,rng:mulberry32(123)});
  const sy=scoreVariant(parent,y.rankingRows,{rounds:20,rng:mulberry32(123)});
  assert.deepEqual(sx,sy);
});

test('sealed audit is explicitly observational and hashes the sealed dataset',()=>{
  const s=splitResearchRows(rows(300),{sealedFraction:.15});
  const a=sealedAudit(parent,s.sealedRows), b=sealedAudit(parent,s.sealedRows);
  assert.equal(a.selectionUse,false);
  assert.equal(a.datasetHash,b.datasetHash);
  assert.equal(a.rows,45);
});

test('larger furnace batches require recorded throughput verification',()=>{
  assert.equal(effectiveBatchSize({enabled:true,batchSize:16384,throughputVerifiedBatchSize:4096}),4096);
  assert.equal(effectiveBatchSize({enabled:true,batchSize:16384,throughputVerifiedBatchSize:8192}),8192);
  assert.equal(effectiveBatchSize({enabled:true,batchSize:4096,throughputVerifiedBatchSize:8192}),4096);
});

test('mixed batch contains parent, global exploration, crossover and local mutation',()=>{
  const other={variant:{...parent,id:'OTHER',threshold:70,weights:{...BASE,edge:.08,explosion:.4}}};
  let i=0; const mutate=(p,lane)=>({...p,id:`LOCAL-${++i}`,testLane:lane,searchOrigin:'LOCAL'});
  const v=buildResearchVariants({parent,batchSize:100,generation:3,priorChallengers:[other],lanes:['A','B'],mutate,rng:mulberry32(9),globalShare:.30,crossoverShare:.10});
  assert.equal(v.length,101);
  assert.equal(v.filter(x=>x.searchOrigin==='GLOBAL_HALTON').length,30);
  assert.equal(v.filter(x=>x.searchOrigin==='CROSSOVER').length,10);
  assert.equal(v.filter(x=>x.searchOrigin==='LOCAL').length,60);
});

test('small datasets fail closed to no sealed peek rather than stealing ranking rows',()=>{
  const s=splitResearchRows(rows(90),{sealedFraction:.2,minRanking:75,minSealed:30});
  assert.equal(s.meta.available,false);
  assert.equal(s.rankingRows.length,90);
  assert.equal(s.sealedRows.length,0);
});
