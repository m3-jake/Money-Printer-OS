import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicPaperMarket, fetchPublicPaperPair, fetchPublicPaperQuote } from '../src/robinhoodPaperFeed.js';

const now=()=>1700000000000;
function mockFetch(calls){
 return async (url,init={})=>{
  const u=new URL(url);calls.push({url:u.toString(),method:init.method,headers:init.headers});
  assert.equal(u.origin,'https://api.exchange.coinbase.com');
  assert.equal(init.method,'GET');
  assert.equal(init.headers?.['x-api-key'],undefined);
  if(u.pathname==='/products/BTC-USD/book')return {ok:true,status:200,json:async()=>({bids:[['100.00','1',1]],asks:[['100.10','1',1]],time:new Date(now()+10000).toISOString()})};
  if(u.pathname==='/products/BTC-USD')return {ok:true,status:200,json:async()=>({id:'BTC-USD',base_increment:'0.00000001',quote_increment:'0.01',status:'online',trading_disabled:false})};
  if(u.pathname==='/products/ETH-USD/book')return {ok:true,status:200,json:async()=>({bids:[['50.00','1',1]],asks:[['50.05','1',1]],time:new Date(now()-1000).toISOString()})};
  if(u.pathname==='/products/ETH-USD')return {ok:true,status:200,json:async()=>({id:'ETH-USD',base_increment:'0.0000001',quote_increment:'0.01',status:'online',trading_disabled:false})};
  throw Error('unexpected '+u);
 };
}

test('public paper quote is read-only, validates BBO, preserves observed depth and exposes future venue time',async()=>{
 const calls=[],q=await fetchPublicPaperQuote('BTC-USD',{fetchFn:mockFetch(calls),now});
 assert.deepEqual(q,{symbol:'BTC-USD',bid:100,ask:100.1,bidSize:1,askSize:1,at:now()+10000,venueAt:now()+10000,receivedAt:now(),timeQuality:'FUTURE_VENUE_TIME',depthQuality:'OBSERVED_L1',auctionMode:false,source:'coinbase-public-paper'});
 assert.equal(calls.length,1);assert.match(calls[0].url,/\/book\?level=1$/);
});
test('public paper pair exposes only simulation sizing metadata',async()=>{
 const calls=[],p=await fetchPublicPaperPair('BTC-USD',{fetchFn:mockFetch(calls)});
 assert.deepEqual(p,{symbol:'BTC-USD',assetCode:'BTC',assetIncrement:'0.00000001',quoteIncrement:'0.01',maxOrderSize:null,minOrderAmountUsd:1,status:'online',isApiTradable:true});
 assert.equal(calls.length,1);
});
test('public paper market batches symbols and contains no account or order routes',async()=>{
 const calls=[],m=await fetchPublicPaperMarket(['BTC-USD','ETH-USD','BTC-USD'],{fetchFn:mockFetch(calls),now});
 assert.equal(m.source,'coinbase-public-paper');assert.equal(m.quotes.length,2);assert.equal(m.pairs.length,2);
 assert.ok(calls.every(c=>!new URL(c.url).pathname.includes('/accounts')&&!new URL(c.url).pathname.includes('/orders')));
});
test('invalid/crossed public books fail closed',async()=>{
 await assert.rejects(fetchPublicPaperQuote('BTC-USD',{now,fetchFn:async()=>({ok:true,status:200,json:async()=>({bids:[['101']],asks:[['100']]})})}),/invalid book/);
 await assert.rejects(fetchPublicPaperQuote('AAPL',{now,fetchFn:mockFetch([])}),/invalid paper-feed symbol/);
});
