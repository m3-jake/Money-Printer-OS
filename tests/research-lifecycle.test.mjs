import test from "node:test";
import assert from "node:assert/strict";
import { createResearchLifecycle, applyEvidenceGate, requestCanaryReview, approveCanary, assessCanary, approveLive, RESEARCH_STAGES } from "../src/researchLifecycle.js";

test("evidence advances research to paper/review but never auto-live",()=>{
 let x=createResearchLifecycle({module:"solana",candidateId:"c1",gate:{stage:"RESEARCH_ONLY"},now:1});
 assert.equal(x.stage,RESEARCH_STAGES.RESEARCH);
 x=applyEvidenceGate(x,{stage:"PAPER_COMPARISON",paperEligible:true},2);
 assert.equal(x.stage,RESEARCH_STAGES.PAPER);
 x=applyEvidenceGate(x,{stage:"REVIEW_READY",paperEligible:true,reviewReady:true},3);
 assert.equal(x.stage,RESEARCH_STAGES.REVIEW_READY);
 assert.equal(x.automaticLivePromotionAllowed,false);
 assert.equal(x.humanApprovalRequiredForLive,true);
});

test("canary and live require explicit human approvals and hard risk caps",()=>{
 let x=createResearchLifecycle({module:"polymarket",candidateId:"p1",gate:{stage:"REVIEW_READY",paperEligible:true,reviewReady:true},now:1});
 x=requestCanaryReview(x,{now:2});
 assert.throws(()=>approveCanary(x,{humanApproved:false,riskBudget:{maxCapitalFraction:.01,maxOpenExposureFraction:.005,maxDailyLossFraction:.0025}}),/human approval/i);
 assert.throws(()=>approveCanary(x,{humanApproved:true,riskBudget:{maxCapitalFraction:.02,maxOpenExposureFraction:.005,maxDailyLossFraction:.0025}}),/capital fraction/i);
 x=approveCanary(x,{humanApproved:true,approvedBy:"owner",riskBudget:{maxCapitalFraction:.01,maxOpenExposureFraction:.005,maxDailyLossFraction:.0025},now:3});
 assert.equal(x.stage,RESEARCH_STAGES.CANARY);
 x=assessCanary(x,{closedGroups:20,netReturnPct:2,maxDrawdownPct:4},4);
 assert.equal(x.stage,RESEARCH_STAGES.LIVE_REVIEW_READY);
 assert.throws(()=>approveLive(x,{humanApproved:false}),/human approval/i);
 x=approveLive(x,{humanApproved:true,approvedBy:"owner",now:5});
 assert.equal(x.stage,RESEARCH_STAGES.LIVE_APPROVED);
 assert.equal(x.automaticLivePromotionAllowed,false);
});
