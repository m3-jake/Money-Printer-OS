#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { evaluateResearchEvidence, EVIDENCE_SCHEMA } from '../src/researchEvidenceGate.js';
import { writeEvidenceMonitor } from '../src/researchEvidenceStore.js';

const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null};
const out=arg('--out');
const monitor=arg('--monitor');
const now=Date.now();

function canary(module,version,note){
  const evidence={schema:EVIDENCE_SCHEMA,module,provenance:'unverified',evaluator:{kind:'executable-path',version},coverage:{
    asOfSignals:false,costs:false,depth:false,latency:false,sharedCapital:false,eventGrouping:false,
  }};
  return {evidence,gate:evaluateResearchEvidence(evidence,now),note};
}

const bundles=[
  canary('solana','executable-replay-v1','Executable path evaluator exists; promotion evidence still requires frozen candidates and observed path coverage.'),
  canary('polymarket','independent-research-v1','Evaluator exists, but no historical as-of quote/depth/fee tape is available yet.'),
];
const report={schema:'mpo.research-evidence-canary.v1',generatedAt:now,researchOnly:true,livePromotionAllowed:false,
  modules:bundles.map(x=>({module:x.evidence.module,stage:x.gate.stage,note:x.note,blocked:x.gate.reasons.map(r=>({code:r.code,message:r.message}))}))};
if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n')}
if(monitor)writeEvidenceMonitor(monitor,bundles);
process.stdout.write(JSON.stringify(report,null,2)+'\n');