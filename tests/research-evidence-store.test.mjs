import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evidenceHash, makeFreezeManifest, writeFreezeManifest, appendTrial, trialLedgerInfo,
  consumeSealedWindow, groupedImprovementInterval, buildPairedStage, assembleEvidence,
  evidenceMonitorEntry, writeEvidenceMonitor, readEvidenceMonitor,
} from '../src/researchEvidenceStore.js';

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mpo-evidence-'));
const manifest=(at=1_700_000_100_000)=>makeFreezeManifest({module:'solana',candidate:{id:'C1',params:{x:2,y:1}},incumbent:{id:'I1',params:{x:1,y:1}},rankingWindowEnd:at-1,codeVersion:'test',frozenAt:at});

test('canonical evidence hash ignores object key order',()=>{
  assert.equal(evidenceHash({b:2,a:{z:3,y:4}}),evidenceHash({a:{y:4,z:3},b:2}));
});

test('freeze manifest is immutable and idempotent on disk',()=>{
  const d=tmp(),f=path.join(d,'freeze.json'),m=manifest();
  assert.equal(writeFreezeManifest(f,m).created,true);
  assert.equal(writeFreezeManifest(f,m).created,false);
  const changed=makeFreezeManifest({module:'solana',candidate:{id:'C1',params:{x:999}},incumbent:{id:'I1',params:{x:1}},rankingWindowEnd:m.rankingWindowEnd,codeVersion:'test',frozenAt:m.frozenAt});
  assert.throws(()=>writeFreezeManifest(f,changed),/IMMUTABLE/);
});

test('trial ledger is append-only and complete hash covers every recorded trial',()=>{
  const f=path.join(tmp(),'trials.ndjson');
  const a=appendTrial(f,{id:'t1',score:1,recordedAt:10});
  const b=appendTrial(f,{id:'t2',score:2,recordedAt:11});
  assert.equal(a.trials,1);assert.equal(b.trials,2);assert.notEqual(a.ledgerHash,b.ledgerHash);
  assert.deepEqual(trialLedgerInfo(f).rows.map(x=>x.id),['t1','t2']);
});
test('sealed registry survives restart and permits exactly one audit',()=>{
  const f=path.join(tmp(),'sealed.json'),r={module:'solana',datasetHash:'abc',startAt:10,endAt:20,candidateHash:'c'};
  const first=consumeSealedWindow(f,r),second=consumeSealedWindow(f,r);
  assert.equal(first.consumedNow,true);assert.equal(second.consumedNow,false);
  assert.equal(second.auditCount,1);assert.equal(JSON.parse(fs.readFileSync(f,'utf8')).windows[first.key].auditCount,1);
});

test('sealed registry is atomic under competing processes',async()=>{
  const d=tmp(),f=path.join(d,'sealed.json'),helper=path.join(d,'consume.mjs');
  const modulePath=fileURLToPath(new URL('../src/researchEvidenceStore.js',import.meta.url));
  fs.writeFileSync(helper,`import {consumeSealedWindow} from ${JSON.stringify('file://'+modulePath)};\ntry{const x=consumeSealedWindow(process.argv[2],{module:'solana',datasetHash:'race',startAt:1,endAt:2},{lockTimeoutMs:5000});console.log(JSON.stringify(x))}catch(e){console.log(JSON.stringify({error:e.message}))}`);
  const run=()=>new Promise(resolve=>{const p=spawn(process.execPath,[helper,f]);let out='';p.stdout.on('data',x=>out+=x);p.on('close',()=>resolve(JSON.parse(out.trim())))});
  const xs=await Promise.all(Array.from({length:6},run));
  assert.equal(xs.filter(x=>x.consumedNow===true).length,1);
  const reg=JSON.parse(fs.readFileSync(f,'utf8'));assert.equal(Object.keys(reg.windows).length,1);
  assert.equal(Object.values(reg.windows)[0].auditCount,1);
});

test('grouped interval preserves within-event dependence and widens for more search trials',()=>{
  const groups=Array.from({length:120},(_,i)=>({id:`e${i}`,candidateReturnPct:2+(i%5)*.02,incumbentReturnPct:.5+(i%3)*.01}));
  groups.push({id:'e1',candidateReturnPct:2.1,incumbentReturnPct:.6});
  const a=groupedImprovementInterval(groups,{trials:1}),b=groupedImprovementInterval(groups,{trials:1000});
  assert.equal(a.independentGroups,120);assert.equal(b.adjustedForTrials,1000);
  assert.ok(b.lowerPct<a.lowerPct);assert.ok(b.level>.999);
});
test('paired stage derives actual independent groups and trial-adjusted interval',()=>{
  const m=manifest(),groups=Array.from({length:100},(_,i)=>({id:`g${i}`,candidateReturnPct:3+(i%4)*.01,incumbentReturnPct:1}));
  const s=buildPairedStage({manifest:m,datasetHash:'d',opportunitySetHash:'o',startAt:m.frozenAt+1,endAt:m.frozenAt+1000,
    summary:{sameOpportunities:true,sameStartingCapital:true,netReturnPct:3,incumbentNetReturnPct:1,maxDrawdownPct:4,stressNetReturnPct:1.2,trials:500},groups,stressModel:{slippage:'2x'}});
  assert.equal(s.independentGroups,100);assert.equal(s.improvementInterval.adjustedForTrials,500);
  assert.equal(s.candidateHash,m.candidate.hash);assert.ok(s.improvementInterval.lowerPct>0);
});

test('incomplete real-data packet remains RESEARCH_ONLY with concrete blockers',()=>{
  const m=manifest(),ledger={trials:12,ledgerHash:'ledger'};
  const b=assembleEvidence({module:'solana',manifest:m,ledger,evaluator:{kind:'executable-path',version:'1'},coverage:{},sealed:null,forward:null});
  assert.equal(b.gate.stage,'RESEARCH_ONLY');assert.equal(b.gate.livePromotionAllowed,false);
  assert.ok(b.gate.reasons.some(x=>x.code.startsWith('COVERAGE_')));
});

test('monitor projection exposes stage, interval, groups, coverage, trials and blocked reasons',()=>{
  const m=manifest(),bundle=assembleEvidence({module:'polymarket',manifest:{...m,module:'polymarket'},ledger:{trials:7,ledgerHash:'x'},coverage:{},evaluator:{kind:'executable-path',version:'1'}});
  const row=evidenceMonitorEntry(bundle);assert.equal(row.stage,'RESEARCH_ONLY');assert.equal(row.trials,7);assert.ok(Array.isArray(row.reasons));
  const f=path.join(tmp(),'monitor.json');writeEvidenceMonitor(f,[bundle]);const reread=readEvidenceMonitor(f);
  assert.equal(reread.modules.length,1);assert.equal(reread.livePromotionAllowed,false);
});
