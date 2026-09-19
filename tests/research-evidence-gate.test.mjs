import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateResearchEvidence as gate,EVIDENCE_SCHEMA} from '../src/researchEvidenceGate.js';
function fixture() {
 const stage = {candidateHash:'candidate',incumbentHash:'incumbent',datasetHash:'sealed',opportunitySetHash:'opportunities',sameOpportunities:true,sameStartingCapital:true,startAt:200,endAt:300,usedForSelection:false,independentGroups:120,netReturnPct:4,incumbentNetReturnPct:2,maxDrawdownPct:5,stressNetReturnPct:1,stressModelHash:'stress',improvementInterval:{lowerPct:0.1,upperPct:4,level:0.95,method:'external-validated-grouped-interval',grouped:true,adjustedForTrials:1000}};
 return {schema:EVIDENCE_SCHEMA,module:'solana',candidate:{id:'candidate',hash:'candidate',frozenAt:100},incumbentHash:'incumbent',search:{trials:1000,ledgerHash:'ledger',rankingWindowEnd:90},provenance:'observed',evaluator:{kind:'executable-path',version:'1'},coverage:{asOfSignals:true,costs:true,depth:true,latency:true,sharedCapital:true,eventGrouping:true},sealed:{...structuredClone(stage),auditCount:1,consumed:true},forward:{...structuredClone(stage),mode:'paper',datasetHash:'forward',startAt:400,endAt:500}};
}
test('complete evidence is review-ready but cannot enable live orders',()=>{for(const module of ['solana','polymarket']){const e=fixture();e.module=module;const r=gate(e,600);assert.equal(r.stage,'REVIEW_READY');assert.equal(r.livePromotionAllowed,false);assert.equal(r.improvementPct,2);}});
test('legacy score, null, arrays and absent input fail closed',()=>{for(const e of [undefined,null,[],{heldOutAvgPct:99,monteCarloPassPct:100}])assert.equal(gate(e,600).stage,'RESEARCH_ONLY');});
test('valid sealed evidence starts paper comparison, not live',()=>{const e=fixture();delete e.forward;assert.equal(gate(e,600).stage,'PAPER_COMPARISON');});
const mutations = {
 'proxy endpoint evaluation':e=>e.evaluator.kind='endpoint',
 'synthetic data':e=>e.provenance='synthetic',
 'holdout used to choose winner':e=>e.sealed.usedForSelection=true,
 'repeat holdout audit':e=>e.sealed.auditCount=2,
 'unretired audit window':e=>e.sealed.consumed=false,
 'future evidence':e=>e.sealed.endAt=700,
 'unfrozen candidate':e=>e.candidate.frozenAt=250,
 'different candidate':e=>e.sealed.candidateHash='other',
 'correlated count insufficient':e=>e.sealed.independentGroups=10,
 'null costs result':e=>e.sealed.netReturnPct=null,
 'missing executable depth':e=>delete e.coverage.depth,
 'gross profit only':e=>e.coverage.costs=false,
 'missing concurrent capital model':e=>e.coverage.sharedCapital=false,
 'selection pressure unaccounted':e=>e.sealed.improvementInterval.adjustedForTrials=1,
 'interval includes no improvement':e=>e.sealed.improvementInterval.lowerPct=-1,
 'invalid interval order':e=>e.sealed.improvementInterval.upperPct=-1,
 'stress loss':e=>e.sealed.stressNetReturnPct=-1,
 'incumbent wins':e=>e.sealed.incumbentNetReturnPct=5,
 'ranking after freeze':e=>e.search.rankingWindowEnd=150
};
for(const [name,mutate] of Object.entries(mutations))test(name,()=>{const e=fixture();mutate(e);assert.equal(gate(e,600).stage,'RESEARCH_ONLY');});
test('forward data reuse blocks review',()=>{const e=fixture();e.forward.datasetHash=e.sealed.datasetHash;assert.equal(gate(e,600).stage,'PAPER_COMPARISON');});
test('candidate change during forward comparison blocks review',()=>{const e=fixture();e.forward.candidateHash='mutated';assert.equal(gate(e,600).stage,'PAPER_COMPARISON');});
test('gate does not mutate evidence',()=>{const e=fixture(),copy=structuredClone(e);gate(e,600);assert.deepEqual(e,copy);});
