import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POLYMARKET_KEY_ID='test-key-id-123456';
process.env.POLYMARKET_SECRET_KEY='test-secret-key-that-is-deliberately-not-real-123456789';
process.env.POLYMARKET_US_REAL_ENABLED='true';
const us=await import('../src/polymarketUS.js');

test('real execution starts disarmed even when credentials exist',()=>{
 const r=us.usReadiness();
 assert.equal(r.credentialsReady,true);
 assert.equal(r.sessionArmed,false);
 assert.equal(r.execution,'manual-confirm-only');
});

test('real order refuses while session is disarmed',async()=>{
 await assert.rejects(
  us.submitPolymarketUSOrder({marketSlug:'fake-market',price:.5,quantity:1,confirmation:'PLACE REAL ORDER'}),
  /not armed/i,
 );
});

test('armed session still requires exact explicit confirmation',async()=>{
 us.armPolymarketUS(true);
 await assert.rejects(
  us.submitPolymarketUSOrder({marketSlug:'fake-market',price:.5,quantity:1,confirmation:'yes'}),
  /explicit PLACE REAL ORDER confirmation required/i,
 );
 us.armPolymarketUS(false);
});

test('account: key is NOT VERIFIED until a signed call succeeds, then VERIFIED with SDK balance shape',async()=>{
 us.noteUSAuthResult({code:'network',message:'offline'});
 assert.equal(us.usKeyStatus(),'NOT_VERIFIED');
 us.resetUSAccountCacheForTests();
 let calls=0;
 const fake={account:{balances:async()=>{calls++;return {balances:[{currentBalance:10.5,buyingPower:9.25,currency:'USD',mysteryField:1}]}}},orders:{list:async()=>({orders:[{},{}]})}};
 const a=await us.polymarketUSAccount({clientOverride:fake,now:1000});
 assert.equal(a.ok,true);assert.equal(a.keyStatus,'VERIFIED');
 assert.deepEqual([a.balance.currentBalance,a.balance.buyingPower,a.openOrders],[10.5,9.25,2]);
 assert.deepEqual(a.unknownFields,['mysteryField']);
 assert.equal(us.usReadiness().keyVerified,true);
 const b=await us.polymarketUSAccount({clientOverride:fake,now:5000});
 assert.equal(b.cached,true);assert.equal(calls,1,'cached for 15 s');
 await us.polymarketUSAccount({clientOverride:fake,now:20000});
 assert.equal(calls,2);
});

test('account: 401 marks the key REJECTED and exposes no balance',async()=>{
 us.resetUSAccountCacheForTests();
 const err=Object.assign(new Error('API key not found'),{status:401});
 const fake={account:{balances:async()=>{throw err}},orders:{list:async()=>({orders:[]})}};
 const a=await us.polymarketUSAccount({clientOverride:fake,now:1});
 assert.equal(a.ok,false);assert.equal(a.keyStatus,'REJECTED');assert.equal(a.balance,null);
 assert.equal(us.usKeyStatus(),'REJECTED');
});
