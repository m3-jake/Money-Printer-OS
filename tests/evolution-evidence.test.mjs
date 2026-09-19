import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordEvolutionEvidence } from '../src/evolutionEvidence.js';
import { readEvidenceMonitor } from '../src/researchEvidenceStore.js';

const variant=(id,x)=>({id,parentId:'BASE',testLane:'BASELINE_CONTROL',weights:{momentum:x},threshold:60,stopPct:8,takePct:16,maxHoldMin:30});
const metric=robustScore=>({robustScore,heldOutAvgPct:2,heldOutN:20,samples:60,activityPct:20,stressAvgPct:1,monteCarloPassPct:90,consistencyPct:70});

test('evolution evidence ledger counts represented variants, dedupes retries, and freezes only promoted shadows',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-evo-evidence-'));
  const vs=[variant('BASE',.1),variant('C1',.2),variant('C2',.3)];
  const rows=[{ts:100,returnPct:1,features:{momentum:.1}},{ts:200,returnPct:2,features:{momentum:.2}}];
  const incumbent={variant:vs[0],metrics:metric(10)}, winner={variant:vs[1],metrics:metric(12)};
  const a=recordEvolutionEvidence({dataDir:d,generation:1,variants:vs,rows,winner,incumbent,improves:false,codeVersion:'test'});
  assert.equal(a.ledger.trials,3); assert.equal(a.ledger.records,1); assert.equal(a.manifest,null);
  const retry=recordEvolutionEvidence({dataDir:d,generation:1,variants:vs,rows,winner,incumbent,improves:false,codeVersion:'test'});
  assert.equal(retry.ledger.trials,3); assert.equal(retry.ledger.records,1);
  const b=recordEvolutionEvidence({dataDir:d,generation:2,variants:vs,rows,winner,incumbent,improves:true,codeVersion:'test'});
  assert.equal(b.ledger.trials,6); assert.equal(b.ledger.records,2); assert.equal(b.manifest.candidate.id,'C1'); assert.equal(b.gate.stage,'RESEARCH_ONLY');
  assert.ok(fs.existsSync(b.freezeFile));
  const mon=readEvidenceMonitor(path.join(d,'research-evidence-monitor.json'));
  assert.equal(mon.modules[0].module,'solana'); assert.equal(mon.modules[0].trials,6); assert.equal(mon.modules[0].livePromotionAllowed,false);
  assert.ok(mon.modules[0].reasons.some(r=>r.code==='PROXY_ONLY'));
});
