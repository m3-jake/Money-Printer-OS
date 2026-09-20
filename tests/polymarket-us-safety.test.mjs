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
