import { queueOutcomeSamples, settleOutcomeSamples, learnerSnapshot, fastEdgeScore, ensureLearner } from './learner.js';
import { estimatePaperExecution, estimateRoundTripFrictionPct } from './executionSim.js';
import { proveRows } from './edgeProof.js';
import { updateExperiments, calibrate, recordUniverse, missedOpportunityScan } from './research.js';

function assert(ok,msg){if(!ok)throw new Error(msg)}
function candidate(mint='MINT', priceUsd=1){return {mint,symbol:'TEST',priceUsd,edgeScore:80,score:80,explosionScore:88,executionScore:72,momentumScore:78,liquidityScore:65,freshnessScore:90,flow5:2,volumeDelta:35,priceAccel:9,stage:'READY',entryThreshold:60}}
const originalNow=Date.now;
try{
 let now=1_700_000_000_000;Date.now=()=>now;
 const s={research:{}};const a=candidate();queueOutcomeSamples(s,[a]);
 now+=5*60_000;settleOutcomeSamples(s,[candidate('MINT',1.15)],new Map());
 now+=25*60_000;settleOutcomeSamples(s,[candidate('MINT',1.6)],new Map());
 now+=90*60_000;settleOutcomeSamples(s,[candidate('MINT',2.1)],new Map());
 const snap=learnerSnapshot(s);assert(snap.horizons[5].samples===1,'5m outcome missing');assert(snap.horizons[30].samples===1,'30m outcome missing');assert(snap.horizons[120].samples===1,'2h outcome missing');assert(snap.horizons[120].hit100Pct===100,'2h runner label wrong');
 const stale={research:{}};queueOutcomeSamples(stale,[candidate('STALE')]);now+=12*60_000;settleOutcomeSamples(stale,[candidate('STALE',2)],new Map());assert(learnerSnapshot(stale).horizons[5].samples===0,'stale 5m label contaminated learner');
 const deep=estimatePaperExecution({liq:200000,executionScore:90,micro:{p10:1},priceAccel:1},.1,150,80,25);const thin=estimatePaperExecution({liq:1800,executionScore:25,micro:{p10:15},priceAccel:15},.1,150,80,25);assert(thin.slippageBps>deep.slippageBps,'thin pool slippage not worse');assert(thin.failurePct>deep.failurePct,'thin pool failure risk not worse');
 assert(Number.isFinite(fastEdgeScore(s,a)),'FAST EDGE produced invalid score');
 // Research experiments/calibration must ignore 30m/2h labels when evaluating 5m hypotheses.
 const rs={research:{experiments:[{id:'e',status:'RUNNING',patch:{label:'x'},minSamples:999,samples:0,controlN:0,testN:0,controlSum:0,testSum:0,controlWins:0,testWins:0,lastOutcomeTs:0}]}};ensureLearner(rs);rs.research.learner.outcomes=[{ts:10,horizonMin:5,returnPct:10,predicted:80,entryThreshold:60,features:{}},{ts:11,horizonMin:30,returnPct:-90,predicted:80,entryThreshold:60,features:{}},{ts:12,horizonMin:120,returnPct:-90,predicted:80,entryThreshold:60,features:{}}];
 updateExperiments(rs);assert(rs.research.experiments[0].samples===1,'experiment mixed outcome horizons');calibrate(rs);assert(rs.research.modelHealth.samples===1,'calibration mixed outcome horizons');
 // Authority profiles count unique mints, not repeated scan observations.
 const prof={research:{},discoveryStats:{sources:{},discovered:0,analyzed:0,rejected:0,watch:0,ready:0,held:0}};const ra={mint:'U1',symbol:'U',priceUsd:1,fastEdgeScore:70,stage:'WATCH',risk:{largest:[],mintAuthority:'AUTHX'},discovery:{sources:['test']}};recordUniverse(prof,ra);recordUniverse(prof,ra);assert(prof.research.deployerProfiles.AUTHX.tokens===1,'authority profile inflated repeated observations');recordUniverse(prof,{...ra,mint:'U2'});assert(prof.research.deployerProfiles.AUTHX.tokens===2,'authority profile did not count unique mint');
 // Missed-runner detection uses elapsed time, not an arbitrary number of ticks.
 const mr={research:{},watchlist:[{mint:'MR',symbol:'MR',fastEdgeScore:70,stage:'WATCH',warnings:[]}],positions:[],history:[],tickHistory:{MR:[{ts:now-5*60_000,price:1},{ts:now-4*60_000,price:1.05},{ts:now-60_000,price:1.2},{ts:now,price:1.6}]}};missedOpportunityScan(mr);assert(Object.values(mr.research.edgeRegistry||{}).some(x=>x.type==='missed-runner'),'time-based missed runner not detected');

 // EDGE PROVER must detect a deliberately strong out-of-sample relationship while keeping clusters independent.
 const proofRows=[];for(let i=0;i<500;i++){const edge=i%4===0?94:55+(i%20);proofRows.push({mint:`P${i}`,proof_cluster:`C${i}`,horizon_min:30,entry_ts:i,edge,adjusted_return:edge>=90?12+(i%5):(-1+(i%3))});}
 const proof=proveRows(proofRows,30);assert(proof.holdout>40,'edge prover holdout too small');assert(proof.deltaPct>5,'edge prover failed strong synthetic edge');assert(proof.ciLow>0,'edge prover confidence interval failed positive synthetic edge');
 const rtDeep=estimateRoundTripFrictionPct({liquidity:200000,executionScore:90,rawReturnPct:20}),rtThin=estimateRoundTripFrictionPct({liquidity:1800,executionScore:25,rawReturnPct:20});assert(rtThin>rtDeep,'round-trip friction not harsher for thin pool');
 console.log('SELFTEST PASS');console.log(JSON.stringify({multiHorizon:snap.horizons,execution:{deep,thin}},null,2));
} finally {Date.now=originalNow}
