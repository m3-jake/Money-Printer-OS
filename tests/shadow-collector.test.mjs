import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShadowCollector, recordUSSingleShadow } from '../src/shadowCollector.js';
import { shadowFill, appendShadowRowOnce } from '../src/shadowLive.js';
import { readShadowRows, shadowDivergenceReport } from '../src/shadowReport.js';
import { markPaperSingles } from '../src/polymarketUSSinglesPaper.js';

test('unknown books/fees never manufacture a comparison; dedupe includes output and side',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-missing-'));
  try {
    const row=shadowFill({trade:{id:'missing',price:1},data:{observedAt:1000}});
    assert.equal(row.shadowPrice,null);assert.equal(row.divergenceBps,null);
    assert.equal(shadowFill({trade:{price:1},data:{ask:2},feesBps:null}).divergenceBps,null);
    for(const name of ['a','b'])assert.equal(appendShadowRowOnce(row,{file:path.join(dir,name)}).written,true);
    assert.equal(appendShadowRowOnce({...row,side:'SELL'},{file:path.join(dir,'a')}).written,true);
    const report=shadowDivergenceReport(await readShadowRows(path.join(dir,'a')));
    assert.equal(report.compared,0);assert.equal(report.unavailable,2);assert.equal(report.maxDivergenceBps,null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('US No shadows and marks use complementary Yes BBO with honest modeled fee provenance',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-no-')),file=path.join(dir,'shadow');
  try{
    const p={id:'no',marketId:'m',outcome:'No',ask:.3,quantity:10,costUsd:3};
    const market={slug:'m',bid:.6,ask:.7};
    const [row]=recordUSSingleShadow([p],{at:1000,opportunities:[market]},{file,now:1000});
    assert.ok(Math.abs(row.shadowPrice-(.4+.05*.4*.6))<1e-9);
    assert.equal(row.depthVerified,false);assert.match(row.feeTreatment,/MODELED/);
    fs.writeFileSync(path.join(dir,'book'),JSON.stringify({open:[p]}));
    assert.ok(Math.abs(markPaperSingles([market],{file:path.join(dir,'book')})[0].markBid-.3)<1e-9);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('recurring collector reads books and depth, refuses live, places zero orders, rotates bounded work',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-collect-'));let at=100000,reads=0,submitted=0;
  const write=(name,x)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(x));
  write('arbitrage-paper.json',{open:[{id:'pair',quantity:2,legs:[{venue:'kalshi',marketId:'k',outcome:'YES',price:.4},{venue:'polymarket',marketId:'p',outcome:'NO',price:.5}]}]});
  write('kalshi-paper.json',{open:[{id:'old',ticker:'x',side:'yes',price:null}]});
  const platform={book:async()=>{reads++;return {contract:{data:{feeModel:{rate:.07,rounding:'CENT_PER_ORDER'}}},book:{observedAt:at,yes:{asks:[{price:.45,quantity:10}]},no:{asks:[{price:.55,quantity:10}]}}};},
    executePaper(){submitted++;throw Error('unexpected order');}};
  try{
    const collector=createShadowCollector({platform,dataDir:dir,now:()=>at,maxPositions:2});
    assert.equal((await collector.tick({mode:'live'})).enabled,false);assert.equal(reads,0);
    const first=await collector.tick({mode:'paper'});assert.equal(first.compared,2);assert.equal(reads,2);
    assert.equal((await collector.tick({mode:'paper'})).cached,true);
    at+=60000;await collector.tick({mode:'paper'});
    const rows=await readShadowRows(collector.file);
    assert.ok(rows.some(r=>r.reason==='paper-reference-unavailable'));
    assert.ok(rows.every(r=>r.shadow&&r.orderPlaced===false));assert.equal(submitted,0);
    at+=60000;platform.book=async()=>({contract:{data:{}},book:{observedAt:at,yes:{asks:[{price:.45,quantity:10}]},no:{asks:[{price:.55,quantity:10}]}}});
    await collector.tick({mode:'paper'});
    assert.ok((await readShadowRows(collector.file)).some(r=>r.reason==='venue-fee-unavailable'&&r.divergenceBps===null));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('native, Solana, equity and crypto observations call only injected quote readers',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-lanes-')),at=100000,calls=[];
  const write=(name,x)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(x));
  write('pumpfun-sniper-paper.json',{open:[{id:'native',mint:'M',user:'U',rawAmount:'100',entryPriceSolPerRaw:.01}]});
  write('robinhood-paper.json',{positions:[{id:'crypto',symbol:'BTC-USD',qty:1,entryPrice:100}]});
  write('robinhood-equities-paper.json',{positions:{SPY:{qty:2,avgPx:500}}});
  try {
    const c=createShadowCollector({dataDir:dir,now:()=>at,maxPositions:8,
      platform:{stocks:{quoteSource:{quotes:async s=>{calls.push(['equity',s]);return [{bid:501,bidSize:10,quoteAt:at}];}}}},
      nativeAdapter:{quote:async q=>{calls.push(['native',q.action]);return {solAmount:1.1,observedAt:at};}},
      cryptoQuote:async symbol=>{calls.push(['crypto',symbol]);return {bid:101,bidSize:10,at};},
      jupiterQuote:async q=>{calls.push(['jupiter',q.amount]);return {outAmount:'1100000000'};}});
    const result=await c.tick({mode:'paper',state:{runtime:{profile:'AGGRESSIVE_PAPER'},market:{solUsd:100},positions:[{id:'sol',mint:'S',paperTokenQuantity:10,decimals:6,entryPrice:10}]}});
    assert.equal(result.observations,4);assert.equal(result.compared,3);assert.equal(result.ordersSubmitted,0);
    assert.deepEqual(calls.map(c=>c[0]).sort(),['crypto','equity','jupiter','native']);
    assert.equal(calls.find(c=>c[0]==='jupiter')[1],'10000000');
    const rows=await readShadowRows(c.file);assert.equal(rows.find(r=>r.tradeId==='crypto').shadowPrice,null);
    assert.ok(rows.find(r=>r.tradeId==='equity:SPY').shadowPrice>500);
    assert.ok(rows.every(r=>r.orderPlaced===false));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
