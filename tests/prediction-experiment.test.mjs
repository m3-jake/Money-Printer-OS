import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePredictionEpisodes} from '../src/predictionExperiment.js';
import {arbitrageQuote} from '../src/core/contracts.js';
import {termsFingerprint} from '../src/core/contractTerms.js';
import {MarketPlatform} from '../src/core/platform.js';
const episode=(id='one',patch={})=>({id,eventId:id,venue:'kalshi',rulesFingerprint:'rules',closeAt:4000,quotes:[{at:1000,quantity:1,ask:.4,feeUsd:.02,feesKnown:true,executable:true,rulesFingerprint:'rules'},{at:2000,quantity:1,ask:.41,feeUsd:.02,feesKnown:true,executable:true,rulesFingerprint:'rules'}],settlement:{outcome:'YES',observedAt:5000,rulesFingerprint:'rules'},...patch});
test('prediction evaluator uses a future offer and retains capital until observed settlement',()=>{
 const r=evaluatePredictionEpisodes({episodes:[episode(),episode('two')],capital:.5,now:6000});
 assert.equal(r.closedOutcomes,1);assert.equal(r.trades[0].entryAsk,.41);assert.equal(r.trades[0].signalAt,1000);
 assert.ok(Math.abs(r.netPnl-.57)<1e-10);assert.ok(r.refusals.some(x=>x.reason==='CAPITAL_TIED_UP'));
 assert.equal(r.paperPromotionAllowed,false);assert.equal(r.trades[0].fillKind,'COUNTERFACTUAL_DEPTH_SIMULATION');
});
test('unobserved outcomes, changed rules, wrong venue, unknown fees and event duplicates cannot qualify',()=>{
 const e=episode(),unpriced=e.quotes.map(q=>({...q,feesKnown:false}));
 const r=evaluatePredictionEpisodes({episodes:[episode('settlement',{settlement:null}),episode('us',{venue:'polymarket-us'}),episode('fees',{quotes:unpriced}),episode('rule',{rulesFingerprint:'changed'}),e,episode('correlated',{eventId:e.eventId})],now:6000});
 assert.equal(r.closedOutcomes,1);assert.equal(r.effectiveIndependentObservations,1);assert.equal(r.refusals.length,5);
 const no=evaluatePredictionEpisodes({episodes:[episode('loss',{settlement:{...e.settlement,outcome:'NO'}})],now:6000});assert.equal(no.status,'NO_EDGE');
});
test('unsupported Kalshi history remains waiting and fixed policy results are stored append-only',()=>{
 const p=new MarketPlatform();try{const r=p.predictionResearch();assert.equal(r.status,'WAITING_FOR_DATA');assert.equal(p.labRuns()[0].result.evaluatorVersion,'prediction-episodes.v1');assert.throws(()=>p.store.db.prepare('DELETE FROM lab_runs').run(),/append-only/);}finally{p.close()}
});
test('cross-venue quote is conditional and includes failed-leg loss even when rules match',()=>{
 const b={observedAt:1000,yes:{asks:[{price:.4,quantity:2}],bids:[{price:.39,quantity:2}]},no:{asks:[{price:.5,quantity:2}],bids:[{price:.49,quantity:2}]}};
 const options={now:1000,feeA:.01,feeB:.01,match:{classification:'EXACT MATCH'}};
 const d=arbitrageQuote({venue:'a'},{venue:'b'},b,b,options).directions[0];
 assert.ok(d.conditionalMatchedPayoff>0);assert.equal(d.theoreticalLockedReturn,null);assert.ok(Math.abs(d.failureScenarios[0].capitalAtRisk-.41)<1e-10);assert.equal(d.riskFree,false);
 const stale=arbitrageQuote({venue:'a'},{venue:'b'},b,{...b,observedAt:3000},{...options,now:3000}).directions[0];assert.ok(stale.blocked.includes('UNSYNCHRONIZED_BOOKS'));
});
test('every settlement-relevant field invalidates a prior contract attestation',()=>{
 const original={title:'A wins',currency:'USD',payout:1};for(const field of ['payout','currency','timeZone','tieTreatment','voidRules','settlementTiming','collateral','closeAt'])assert.notEqual(termsFingerprint(original),termsFingerprint({...original,[field]:'changed'}),field);
});
