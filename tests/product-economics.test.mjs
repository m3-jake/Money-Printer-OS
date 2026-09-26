import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProductEconomics, productIngestionAuthorized, productReadAuthorized } from '../src/productEconomics.js';

const DAY = 86400000, BASE = Date.UTC(2026, 0, 1);
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-product-'));
  const ledger=new ProductEconomics(dir);
  t.after(()=>{ledger.close();fs.rmSync(dir,{recursive:true,force:true})});
  return ledger;
}
function event(ledger, type, eventId, patch={}) { return ledger.record({type,eventId,userId:'u1',timestamp:BASE,...patch}); }
const payment = {currency:'USD',amountUsd:100,provider:'verified-provider',reference:'payment-1'};

test('first non-direct acquisition follows anonymous visitors into a verified identity', t=>{
  const l=fixture(t);
  event(l,'visit','visit-0',{userId:null,anonymousId:'a',timestamp:BASE});
  event(l,'visit','visit-1',{userId:null,anonymousId:'a',timestamp:BASE+1,attribution:{source:'newsletter',channel:'email',campaign:'pilot'}});
  event(l,'identify','identify',{anonymousId:'a',timestamp:BASE+2});
  event(l,'visit','visit-2',{timestamp:BASE+3,attribution:{source:'search',channel:'organic'}});
  event(l,'activation','activate',{timestamp:BASE+4});
  event(l,'signup','signup',{timestamp:BASE+5});
  event(l,'payment','paid',{...payment,timestamp:BASE+6});
  const s=l.summary();
  assert.equal(s.totals.visitors,1);assert.equal(s.totals.activatedUsers,1);assert.equal(s.totals.payingUsers,1);assert.equal(s.totals.signups,1);
  assert.equal(s.bySource.length,1);assert.equal(s.bySource[0].attribution.source,'newsletter');assert.equal(s.bySource[0].netRevenueUsd,100);
  assert.equal(s.byUser[0].label,'user:u1');
  assert.throws(()=>event(l,'identify','steal',{anonymousId:'a',userId:'u2'}),/already assigned/);
});

test('immutable IDs and provider references prevent duplicate money, even after restart',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-product-restart-'));
  let l=new ProductEconomics(dir);
  t.after(()=>{l.close();fs.rmSync(dir,{recursive:true,force:true})});
  const input={type:'payment',eventId:'pay',userId:'u1',...payment};
  l.record(input);l.close();l=new ProductEconomics(dir);
  assert.equal(l.record(input).duplicate,true);
  assert.throws(()=>l.record({...input,amountUsd:101}),/different content/);
  assert.throws(()=>l.record({...input,eventId:'retry-with-new-id'}),/reference already/);
  assert.equal(l.summary().totals.grossRevenueUsd,100);
});

test('refunds must match a real payment and cannot exceed paid amounts',t=>{
  const l=fixture(t);event(l,'payment','paid',payment);
  event(l,'refund','refund',{...payment,amountUsd:20,reference:'refund-1',originalEventId:'paid'});
  assert.throws(()=>event(l,'refund','refund-2',{...payment,amountUsd:81,reference:'refund-2',originalEventId:'paid'}),/exceeds/);
  assert.throws(()=>event(l,'refund','refund-user',{...payment,amountUsd:10,userId:'u2',reference:'refund-3',originalEventId:'paid'}),/this user/);
  assert.equal(l.summary().totals.netRevenueUsd,80);
});

test('unpriced and absent costs never silently become profitable contribution',t=>{
  const l=fixture(t);event(l,'payment','paid',payment);
  assert.equal(l.summary().totals.contributionUsd,null);
  event(l,'visit','visit');event(l,'activation','activation');
  event(l,'serving_cost','unpriced',{currency:'USD',amountUsd:null,unknownReason:'provider invoice not received'});
  event(l,'acquisition_cost','acquisition',{currency:'USD',amountUsd:10});
  event(l,'payment_fee','fee',{currency:'USD',amountUsd:3});
  event(l,'support_cost','support',{currency:'USD',amountUsd:5,supportMinutes:15});
  let s=l.summary();assert.equal(s.totals.knownCostContributionUsd,82);assert.equal(s.totals.contributionMargin,null);assert.equal(s.totals.unpricedCosts,1);
  event(l,'serving_cost','resolved',{currency:'USD',amountUsd:2,replacesEventId:'unpriced'});
  s=l.summary();assert.equal(s.totals.contributionUsd,80);assert.equal(s.totals.contributionMargin,.8);assert.equal(s.totals.unpricedCosts,0);assert.equal(s.totals.cacUsd,10);assert.equal(s.totals.supportMinutes,15);assert.equal(s.byUser[0].contributionUsd,80);
  assert.throws(()=>event(l,'serving_cost','resolve-again',{currency:'USD',amountUsd:2,replacesEventId:'unpriced'}),/already resolved/);
});

test('source acquisition costs are not invented per-user costs or trading PnL',t=>{
  const l=fixture(t);
  event(l,'acquisition_cost','ad',{userId:null,currency:'USD',amountUsd:42,attribution:{source:'newsletter',channel:'email'}});
  assert.equal(l.summary().bySource[0].acquisitionCostUsd,42);assert.equal(l.summary().byUser.length,0);
  for(const type of ['trading_pnl','trading_fee','paper_win']) assert.throws(()=>event(l,type,type,{amountUsd:500}),/Unsupported product event/);
  for(const amountUsd of [-1,NaN,'100']) assert.throws(()=>event(l,'payment',String(amountUsd),{...payment,amountUsd}),/Invalid amount/);
  assert.throws(()=>event(l,'payment','eur',{...payment,currency:'EUR'}),/USD/);
  assert.throws(()=>event(l,'payment','anon',{...payment,userId:null,anonymousId:'a'}),/verified userId/);
  assert.throws(()=>event(l,'visit','money-visit',{amountUsd:100}),/cannot carry money/);
  assert.throws(()=>event(l,'visit',' '),/required/);
});

test('pricing an unknown support cost preserves its recorded effort and rejects conflicting effort',t=>{
  const l=fixture(t);
  event(l,'support_cost','support-unknown',{currency:'USD',amountUsd:null,unknownReason:'invoice pending',supportMinutes:35});
  assert.equal(l.summary().totals.supportMinutes,35);
  assert.throws(()=>event(l,'support_cost','conflict',{currency:'USD',amountUsd:12,replacesEventId:'support-unknown',supportMinutes:34}),/cannot change recorded support minutes/);
  const resolution={currency:'USD',amountUsd:12,replacesEventId:'support-unknown'};
  event(l,'support_cost','resolved-support',resolution);
  assert.equal(event(l,'support_cost','resolved-support',resolution).duplicate,true);
  const s=l.summary();
  for(const row of [s.totals,...s.bySource,...s.byUser]) { assert.equal(row.supportMinutes,35); assert.equal(row.supportCostUsd,12); assert.equal(row.unpricedCosts,0); }
});

test('unpriced categories only suppress ratios whose numerator is incomplete',t=>{
  const l=fixture(t);
  event(l,'visit','v');event(l,'activation','a');event(l,'payment','p',payment);
  event(l,'acquisition_cost','priced-acquisition',{currency:'USD',amountUsd:10});
  event(l,'serving_cost','priced-serving',{currency:'USD',amountUsd:2});
  event(l,'support_cost','unknown-support',{currency:'USD',amountUsd:null,unknownReason:'invoice pending'});
  let s=l.summary();
  for(const row of [s.totals,...s.bySource,...s.byUser]) {
    assert.equal(row.cacUsd,10);assert.equal(row.costPerActivationUsd,10);assert.equal(row.servingCostPerActiveUserUsd,2);
    assert.equal(row.contributionUsd,null);assert.equal(row.unpricedCostsByCategory.support_cost,1);
  }
  event(l,'serving_cost','unknown-serving',{currency:'USD',amountUsd:null,unknownReason:'invoice pending'});
  s=l.summary();assert.equal(s.totals.cacUsd,10);assert.equal(s.totals.costPerActivationUsd,10);assert.equal(s.totals.servingCostPerActiveUserUsd,null);
  event(l,'acquisition_cost','unknown-acquisition',{currency:'USD',amountUsd:null,unknownReason:'invoice pending'});
  s=l.summary();assert.equal(s.totals.cacUsd,null);assert.equal(s.totals.costPerActivationUsd,null);
});

test('late non-direct visits cannot rewrite an already converted direct acquisition cohort',t=>{
  for(const conversion of ['signup','activation','payment']) {
    const l=fixture(t);
    event(l,'visit','visit-direct',{timestamp:BASE,userId:null,anonymousId:'visitor'});
    event(l,conversion,'convert',{...(conversion==='payment'?payment:{}),timestamp:BASE+1,anonymousId:'visitor'});
    if(conversion!=='payment')event(l,'payment','payment',{...payment,timestamp:BASE+2});
    event(l,'acquisition_cost','acquisition',{currency:'USD',amountUsd:9,timestamp:BASE+3});
    const before=l.summary();
    event(l,'visit','later-campaign',{timestamp:BASE+4,attribution:{source:'later-ad',channel:'paid'}});
    const after=l.summary();
    assert.equal(after.bySource.length,1);assert.equal(after.bySource[0].attribution.source,'direct');
    assert.equal(after.bySource[0].netRevenueUsd,before.bySource[0].netRevenueUsd);
    assert.equal(after.bySource[0].acquisitionCostUsd,before.bySource[0].acquisitionCostUsd);
  }
});

test('attribution respects event order when conversion and campaign visit share a timestamp',t=>{
  const l=fixture(t);
  event(l,'visit','z-direct');event(l,'activation','z-activation');
  event(l,'visit','a-late-campaign',{attribution:{source:'late',channel:'paid'}});
  assert.equal(l.summary().byUser[0].attribution.source,'direct');
});

test('retention uses mature activation cohorts and real return days, not future activity',t=>{
  const l=fixture(t);
  event(l,'visit','v');event(l,'activation','a');
  event(l,'visit','d1',{timestamp:BASE+DAY});event(l,'visit','d7',{timestamp:BASE+7*DAY});
  event(l,'activation','recent',{userId:'recent',timestamp:BASE+8*DAY});
  const s=l.summary({now:BASE+9*DAY});
  assert.deepEqual(s.retention.d7,{eligibleUsers:1,returnedUsers:1,rate:1});
  assert.equal(s.retention.d30.rate,null);assert.equal(s.retention.d1.eligibleUsers,1);
  assert.equal(l.summary({now:BASE}).eventCount,2);
});

test('cookie persists visits and server-confirmed combo-build activation without recording fake money',t=>{
  const l=fixture(t),headers={},res={setHeader:(k,v)=>headers[k]=v};
  const req={headers:{host:'127.0.0.1:8792'},socket:{}};
  l.recordVisit(req,res,new URL('http://127.0.0.1/?utm_source=pilot&utm_medium=referral'));
  assert.match(headers['set-cookie'],/HttpOnly; SameSite=Strict/);
  req.headers.cookie=headers['set-cookie'].split(';')[0];
  l.recordVisit(req,res,new URL('http://127.0.0.1/'));
  l.recordComboBuildActivation(req,{ok:false});assert.equal(l.summary().totals.activatedUsers,0);
  l.recordComboBuildActivation(req,{ok:true,combo:{legs:[{}]}});assert.equal(l.summary().totals.activatedUsers,0);
  l.recordComboBuildActivation(req,{ok:true,combo:{legs:[{},{}]}});
  l.recordComboBuildActivation(req,{ok:true,combo:{legs:[{},{},{}]}});
  const s=l.summary();assert.equal(s.totals.visitors,1);assert.equal(s.totals.activatedUsers,1);assert.equal(s.totals.netRevenueUsd,0);assert.equal(s.totals.payingUsers,0);assert.equal(s.bySource[0].attribution.source,'pilot');
  const forged={headers:{cookie:req.headers.cookie.replace(/.$/,'z')},socket:{}};
  assert.equal(l.visitor(forged,null),null);
});

test('revenue ingestion fails closed with missing/weak tokens and every browser Origin',()=>{
  const token='a'.repeat(40), req={headers:{authorization:`Bearer ${token}`},socket:{remoteAddress:'10.0.0.1'}};
  assert.equal(productIngestionAuthorized(req,token),true);
  assert.equal(productIngestionAuthorized(req,''),false);assert.equal(productIngestionAuthorized(req,'weak'),false);
  assert.equal(productIngestionAuthorized({...req,headers:{...req.headers,origin:'http://localhost'}},token),false);
  assert.equal(productIngestionAuthorized({headers:{authorization:'Bearer wrong'}},token),false);
  assert.equal(productReadAuthorized({headers:{},socket:{remoteAddress:'10.0.0.1'}}),false);
  assert.equal(productReadAuthorized({headers:{},socket:{remoteAddress:'127.0.0.1'}}),true);
});
