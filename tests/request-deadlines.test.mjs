import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketRequester } from '../src/marketRequests.js';
import { JsonProvider } from '../src/core/provider.js';

test('market deadline releases signal-ignoring fetch and accepts a subsequent fresh request', async () => {
  let calls=0;
  const requester=createMarketRequester({timeoutMs:20,fetcher:()=>++calls===1?new Promise(()=>{}):Promise.resolve({ok:true,json:async()=>({fresh:true})})});
  await assert.rejects(requester.get('https://fixture.test/book'),/timed out/);
  assert.equal(requester.health().inFlight,0);
  assert.deepEqual((await requester.get('https://fixture.test/book')).data,{fresh:true});
});
test('late provider body cannot become a cached executable observation',async()=>{
  let resolveBody;
  const provider=new JsonProvider('fixture',{timeoutMs:20,fetchImpl:async()=>({ok:true,json:()=>new Promise(resolve=>{resolveBody=resolve;})})});
  await assert.rejects(provider.get('https://fixture.test/book'),{code:'TIMEOUT'});
  assert.equal(provider.inflight.size,0);
  resolveBody({price:.5});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(provider.cache.size,0);
  assert.equal(provider.health.lastSuccess,null);
});
test('cycle cancellation releases a coalesced waiter without cancelling another lane',async()=>{
  let release;
  const requester=createMarketRequester({timeoutMs:1000,fetcher:()=>new Promise(resolve=>{release=resolve;})});
  const independent=requester.get('https://fixture.test/book');
  const controller=new AbortController();
  const cancelled=requester.get('https://fixture.test/book','cycle',{signal:controller.signal});
  controller.abort(new Error('cycle finished'));
  await assert.rejects(cancelled,/cycle finished/);
  release({ok:true,json:async()=>({fresh:true})});
  assert.deepEqual((await independent).data,{fresh:true});
});
