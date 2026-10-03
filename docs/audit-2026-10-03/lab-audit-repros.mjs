// Fresh audit reproductions. Synthetic invariant checks only; never trading evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root='W:/money-printer-evolution-lab';
const RH=await import(pathToFileURL(path.join(root,'src/robinhoodEvolve.js')));
const S=await import(pathToFileURL(path.join(root,'src/robinhoodStrategy.js')));
const E=await import(pathToFileURL(path.join(root,'src/labResearchEvidenceStore.js')));
const D=await import(pathToFileURL(path.join(root,'src/robinhoodDaily.js')));
const W=await import(pathToFileURL(path.join(root,'src/weatherReplay.js')));
const now=Date.UTC(2026,9,3), output={synthetic:true,qualificationEffect:'NONE'};
const window=RH.freezeProspective(S.STRATEGY_DEFAULTS,{'BTC-USD':[]},{now:now-1000,feeRatio:.0095,orderUsd:25,startUsd:1000});
window.rows=100;window.venueRows=100;
window.closes=Array.from({length:20},(_,i)=>({symbol:'BTC-USD',openedAt:now-900+i,closedAt:now-800+i,pnlUsd:1}));
window.symbols['BTC-USD'].cash=995;
window.symbols['BTC-USD'].position={costUsd:25,qty:1,fillPrice:25,feeUsd:0,openedAt:now-10,peakBid:25,trailStop:null};
const advanced=RH.advanceProspective(window,{}, {now});
assert.equal(advanced.gate.pass,true);
output.robinhoodOutstandingLoss={gatePass:advanced.gate.pass,gateRealizedPnl:advanced.gate.pnlUsd,openPositions:Object.values(advanced.window.symbols).filter(s=>s.position).length,terminalCash:995,illustrativeLiquidationValue:.05,liquidationNetPnl:995+.05-1000,gateHasDrawdown:Object.hasOwn(advanced.gate,'maxDrawdownPct')};
const multi=RH.freezeProspective(S.STRATEGY_DEFAULTS,Object.fromEntries(['BTC','ETH','SOL','DOGE','XRP','LINK','AVAX','ADA'].map(s=>[s+'-USD',[]])),{now,startUsd:1000});
output.robinhoodCapital={declaredStartUsd:multi.startUsd,symbolCount:Object.keys(multi.symbols).length,totalReplayCash:Object.values(multi.symbols).reduce((n,s)=>n+s.cash,0)};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-lab-audit-'));
try {
 const file=path.join(temp,'sealed.json'), record={module:'polymarket',datasetHash:'dataset-a',startAt:100,endAt:200,candidateHash:'candidate-a'};
 const first=E.consumeSealedWindow(file,record);
 const changedCandidate=E.consumeSealedWindow(file,{...record,candidateHash:'candidate-b'});
 const changedDataset=E.consumeSealedWindow(file,{...record,datasetHash:'dataset-b',candidateHash:'candidate-c'});
 assert.equal(changedCandidate.record.candidateHash,'candidate-a');
 assert.equal(changedCandidate.auditCount,1);
 assert.equal(changedDataset.consumedNow,true);
 output.sealedWindowReuse={firstConsumed:first.consumedNow,secondCandidateConsumed:changedCandidate.consumedNow,secondCandidateReturnedReceiptCandidate:changedCandidate.record.candidateHash,secondCandidateReturnedAuditCount:changedCandidate.auditCount,changedDatasetSameDatesConsumed:changedDataset.consumedNow};
} finally {fs.rmSync(temp,{recursive:true,force:true});}
const DAY=864e5,T0=Date.UTC(2016,0,1);
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function series(n,seed){const random=rng(seed),out=[];let p=100;for(let i=0;i<n;i++){const g=(random()+random()+random()-1.5)*.04+Math.sin(i/180)*.006,o=p,c=p*Math.exp(g),t=T0+(i+3000-n)*DAY;out.push({d:new Date(t).toISOString().slice(0,10),t,o,h:Math.max(o,c)*(1+random()*.01),l:Math.min(o,c)*(1-random()*.01),c,v:1});p=c;}return out;}
const bars={'BTC-USD':series(3000,1),'ETH-USD':series(2600,2),'SOL-USD':series(1500,3)};
const daily=D.researchDaily(bars), repeated=D.researchDaily(bars);
assert.equal(daily.paperPromotionAllowed,true);
assert.equal(repeated.proposal.id,daily.proposal.id);
output.dailyHistoricalQualification={phase:daily.phase,paperPromotionAllowed:daily.paperPromotionAllowed,traderExecutable:daily.proposal.traderExecutable,holdoutFrom:daily.split.holdoutFrom,holdoutTo:daily.split.holdoutTo,allDatesBeforeAudit:Date.parse(daily.split.holdoutTo)<now,frozenCandidateRecorded:Object.hasOwn(daily,'freeze'),accessReceiptRecorded:Object.hasOwn(daily,'holdoutAccess'),repeatProducesSamePaperProposal:repeated.proposal.id===daily.proposal.id};
const weather=W.replayVariant([{city:'test',date:'2026-10-01',f1:75,hours:[[1,[[null,null,true,.23,.24]]]]}],{test:{bias:0,sd:1}},{calibrationSafety:1,minEdge:.01,maxDisagreement:1});
const syntheticWeatherSpend=4-weather.pnl;
assert.ok(syntheticWeatherSpend>W.STAKE_USD);
output.weatherStake={declaredStakeUsd:W.STAKE_USD,modeledAskAfterSlip:.25,quantity:4,modeledSpendUsd:syntheticWeatherSpend,pnl:weather.pnl,researchOnly:true};
process.stdout.write(JSON.stringify(output,null,2)+'\n');
