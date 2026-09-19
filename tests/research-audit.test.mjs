import test from 'node:test';
import assert from 'node:assert/strict';
import { auditVariantsFromState, summarizeAudit } from '../src/researchAudit.js';

test('audit candidate extraction dedupes champion and challengers',()=>{
  const v={id:'A',weights:{x:1}},s={evolutionLoop:{champion:{variant:v},challengers:[{variant:v},{variant:{id:'B'}}]}};
  assert.deepEqual(auditVariantsFromState(s).map(x=>x.id),['A','B']);
});

test('robustness audit summary preserves worst seeded diagnostics',()=>{
  const mk=(id,r,mc,stress,cons)=>({variant:{id},metrics:{robustScore:r,monteCarloPassPct:mc,heldOutAvgPct:2,stressAvgPct:stress,consistencyPct:cons}});
  const out=summarizeAudit([[mk('A',10,80,-1,60)],[mk('A',14,70,-3,55)]]).find(x=>x.id==='A');
  assert.equal(out.robustAvg,12);assert.equal(out.robustMin,10);assert.equal(out.robustMax,14);
  assert.equal(out.mcPassMin,70);assert.equal(out.stressMin,-3);assert.equal(out.consistencyMin,55);
});
