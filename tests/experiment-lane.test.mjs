import test from 'node:test';import assert from 'node:assert/strict';import {createExperiment,addChallenger,recordResult,promotionDecision,machineRole,hashObject,assertNoLiveChallengers,setStableMetrics} from '../src/experimentLane.js';
test('stable config hash is deterministic and stable snapshot is immutable',()=>{const c={profile:'FAST',aggression:72};const e=createExperiment({stableConfig:c,datasetHash:'d',versionHash:'v',createdAt:1});c.aggression=99;assert.equal(e.stable.config.aggression,72);assert.equal(e.stable.configHash,hashObject({profile:'FAST',aggression:72}))});
test('challenger can never be created in live mode',()=>{const e=createExperiment({stableConfig:{a:1},datasetHash:'d',versionHash:'v'});assert.throws(()=>addChallenger(e,{config:{a:2},mode:'live'}),/only run/)});
test('promotion produces shadow candidate, never live promotion',()=>{const e=createExperiment({stableConfig:{a:1},datasetHash:'d',versionHash:'v'});const c=addChallenger(e,{config:{a:2},mode:'backtest'});recordResult(e,c.id,{n:100,realizedPnl:.2,expectancy:.002,profitFactor:1.4,maxDrawdownPct:4,positiveSplits:3,totalSplits:3,top3PnlConcentrationPct:30});assert.deepEqual(promotionDecision(e,c.id),{eligible:true,reason:'shadow-candidate',nextMode:'shadow',live:false});assertNoLiveChallengers(e)});
test('weak/small challenger is rejected',()=>{const e=createExperiment({stableConfig:{a:1},datasetHash:'d',versionHash:'v'});const c=addChallenger(e,{config:{a:2}});recordResult(e,c.id,{n:10,realizedPnl:10,expectancy:1,maxDrawdownPct:1});assert.equal(promotionDecision(e,c.id).reason,'sample-too-small')});
test('Windows becomes compute workhorse and leaves four threads free',()=>{assert.deepEqual(machineRole({platform:'win32',cpus:32}).maxReplayWorkers,28);assert.equal(machineRole({platform:'win32',cpus:32}).role,'compute-qa');assert.equal(machineRole({platform:'darwin',cpus:12}).role,'orchestrator-stable')});

test('walk-forward inconsistency blocks promotion',()=>{const e=createExperiment({stableConfig:{a:1},datasetHash:'d',versionHash:'v'});const c=addChallenger(e,{config:{a:2}});recordResult(e,c.id,{n:154,realizedPnl:.0068,expectancy:.00001,profitFactor:1.2,maxDrawdownPct:6.8,positiveSplits:1,totalSplits:3,top3PnlConcentrationPct:20});assert.equal(promotionDecision(e,c.id).reason,'split-inconsistent')});
test('top-trade concentration blocks a fragile winner',()=>{const e=createExperiment({stableConfig:{a:1},datasetHash:'d',versionHash:'v'});const c=addChallenger(e,{config:{a:2}});recordResult(e,c.id,{n:154,realizedPnl:.0068,expectancy:.00001,profitFactor:1.2,maxDrawdownPct:6.8,positiveSplits:3,totalSplits:3,top3PnlConcentrationPct:952});assert.equal(promotionDecision(e,c.id).reason,'top-trade-concentration')});

test('stable config remains immutable while stable metrics can be recorded',()=>{const e=createExperiment({stableConfig:{profile:'FAST',aggression:72},datasetHash:'d',versionHash:'v'});assert.throws(()=>{e.stable.config.aggression=99});setStableMetrics(e,{n:145,realizedPnl:.0026});assert.equal(e.stable.config.aggression,72);assert.equal(e.stable.metrics.n,145)});

test('promotable:false challenger cannot become a shadow candidate or live',()=>{
 const e=createExperiment({stableConfig:{a:1},datasetHash:'d',versionHash:'v'});
 const c=addChallenger(e,{config:{filter:'cold-topq',promotable:false},mode:'paper'});
 recordResult(e,c.id,{n:200,realizedPnl:4,expectancy:.02,profitFactor:3,maxDrawdownPct:1,positiveSplits:5,totalSplits:5,top3PnlConcentrationPct:10});
 const d=promotionDecision(e,c.id);
 assert.equal(d.eligible,false);
 assert.equal(d.reason,'not-promotable');
 assert.equal(d.live,false);
 assert.equal(d.nextMode,null);
 assertNoLiveChallengers(e);
});
