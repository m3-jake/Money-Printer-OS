import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-validate-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
process.env.MONEY_PRINTER_DATA_DIR=root;

const {validateColdLiquidity,trainLiquidityCut,scoreLiquiditySplit,splitRanges} = await import('../tools/alphaValidate.js');
const {featureValueOf,economicLiquidityOf} = await import('../src/hypothesisMiner.js');

function hash(s=''){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function holdoutMint(prefix,i){let n=i;for(;;){const m=`${prefix}${n++}`;if(hash(m)%5===0)return m}}

function coldRow(i,{liq=10_000,adj=-40,raw=-30,ts=null}={}){
  const mint=holdoutMint('C',i*17);
  return {mint,cluster_id:mint,cluster:mint,horizon_min:30,regime:'COLD',entry_ts:ts??(1_000+i*60_000),liquidity:liq,obs_liquidity:0,adjusted_return:adj,raw_return:raw,edge:50,execution:50};
}

test('featureValueOf prefers entry-time liquidity over first-observation shadow',()=>{
  assert.equal(featureValueOf({liquidity:50000,obs_liquidity:0},'liquidity'),50000);
  assert.equal(featureValueOf({obs_liquidity:9},'liquidity'),9);
  assert.ok(Number.isNaN(featureValueOf({liquidity:1},'liquidity')));
  assert.ok(Number.isNaN(economicLiquidityOf({liquidity:900})));
  assert.equal(economicLiquidityOf({liquidity:1500}),1500);
});

test('COLD liquidity top-quartile vs rest passes on a clean train-derived split',()=>{
  const rows=[];
  for(let i=0;i<240;i++){
    const top=i%3===0;
    rows.push(coldRow(i,{liq:top?80_000:8_000,adj:top?12:-20,raw:top?18:-15,ts:1000+i*60_000}));
  }
  const v=validateColdLiquidity(rows,{split:'chronological'});
  assert.equal(v.quarantined,0);
  assert.ok(v.overall.nHi>=20);
  assert.ok(v.overall.delta>0);
  assert.equal(v.overall.contaminated,false);
  assert.equal(v.pass,true,JSON.stringify(v.fail));
  assert.deepEqual(v.fail,[]);
});

test('impossible raw returns are quarantined and do not create a pass',()=>{
  const rows=[coldRow(0,{liq:80_000,adj:12,raw:25000}),...Array.from({length:30},(_,i)=>coldRow(i+1,{liq:5_000,adj:-10,raw:-8}))];
  const v=validateColdLiquidity(rows,{split:'chronological'});
  assert.ok(v.quarantined>=1);
  assert.equal(v.n,30);
});

test('train cut uses only the train window and ignores sentinel $1 liquidity',()=>{
  const train=[{liquidity:10000},{liquidity:10000},{liquidity:10000},{liquidity:40000},{liquidity:1}];
  const cut=trainLiquidityCut(train);
  assert.equal(cut,10000);
  const scored=scoreLiquiditySplit([...train,{liquidity:40000,adjusted_return:5,cluster_id:'Z',mint:'Z'}],cut);
  assert.ok(scored.nHi>=1);
  assert.equal(scored.nLo+scored.nHi,5);
});

test('count-based walk-forward keeps folds filled across a multi-day COLD gap',()=>{
  const rows=[];
  for(let i=0;i<90;i++){
    const top=i%3===0;
    rows.push(coldRow(i,{liq:top?80_000:8_000,adj:top?12:-20,raw:top?18:-15,ts:1_000+i*60_000}));
  }
  const gap=100*3600_000;
  for(let i=0;i<180;i++){
    const top=i%3===0;
    rows.push(coldRow(200+i,{liq:top?80_000:8_000,adj:top?12:-20,raw:top?18:-15,ts:gap+i*60_000}));
  }
  const ranges=splitRanges(rows,'walk');
  assert.equal(ranges.length,3);
  const v=validateColdLiquidity(rows,{split:'walk'});
  assert.equal(v.measuredSplits,3);
  assert.ok(v.splits.every(s=>s.nTrain>=40&&s.nTest>=30));
  assert.equal(v.fail.includes('no-valid-splits'),false);
  assert.equal(v.pass,true,JSON.stringify(v.fail));
});

test('sentinel and sub-economic liquidity are excluded from the COLD universe',()=>{
  const rows=[];
  for(let i=0;i<200;i++)rows.push(coldRow(i,{liq:1,adj:-40,raw:0,ts:1000+i*1000}));
  for(let i=0;i<240;i++){
    const top=i%3===0;
    rows.push(coldRow(400+i,{liq:top?80_000:8_000,adj:top?12:-20,raw:top?18:-15,ts:2_000_000+i*60_000}));
  }
  const v=validateColdLiquidity(rows,{split:'chronological'});
  assert.equal(v.sentinelLiquidity,200);
  assert.equal(v.n,240);
  assert.ok(v.overall.nHi>=20);
  assert.ok(v.overall.nLo>=40);
  assert.equal(v.pass,true,JSON.stringify({fail:v.fail,overall:v.overall}));
});

test('import fence keeps alphaValidate off live modules',()=>{
  const s=fs.readFileSync(new URL('../tools/alphaValidate.js',import.meta.url),'utf8').toLowerCase();
  for(const bad of ['jupiter','./rpc','polymarket','from \'ws\'','from \'./store','from \'./index'])assert.equal(s.includes(bad),false,`forbidden ${bad}`);
});


test('less negative than the rest is not a profitable COLD lead',()=>{
 const rows=Array.from({length:240},(_,i)=>coldRow(i,{liq:i%3===0?80000:8000,adj:i%3===0?-2:-20,raw:i%3===0?0:-15}));
 const v=validateColdLiquidity(rows);
 assert.ok(v.overall.delta>0);assert.ok(v.overall.ciLow>0);
 assert.equal(v.pass,false);assert.ok(v.fail.includes('top-median-not-positive'));
});
