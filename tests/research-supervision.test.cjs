const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {researchServicePolicy}=require('../desktop/research-supervision.cjs');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'mpo-research-policy-'))}

test('collector defaults on; audit and BEAST never run in the trader (alpha.53: moved to the Evolution Lab)',()=>{
 const dir=tmp(),p=researchServicePolicy({env:{},dataDir:dir});
 assert.equal(p.collector,true);assert.equal(p.audit,false);assert.equal(p.beast,false);
 assert.equal(p.movedTo,'money-printer-evolution-lab');
});
test('a leftover research-beast.json or MPO_RESEARCH_BEAST flag is reported, not honoured',()=>{
 const dir=tmp();fs.writeFileSync(path.join(dir,'research-beast.json'),JSON.stringify({enabled:true}));
 let p=researchServicePolicy({env:{},dataDir:dir});assert.equal(p.audit,false);assert.equal(p.beast,false);assert.equal(p.legacyBeastRequested,true);
 p=researchServicePolicy({env:{MPO_RESEARCH_BEAST:'1'},dataDir:tmp()});assert.equal(p.audit,false);assert.equal(p.legacyBeastRequested,true);
});
test('the collector can still be switched off explicitly',()=>{
 const p=researchServicePolicy({env:{MPO_RESEARCH_COLLECTOR:'false',MPO_RESEARCH_AUDIT:'1'},dataDir:tmp()});
 assert.equal(p.collector,false);assert.equal(p.audit,false);
});
test('desktop supervisor starts the collector and nothing research-heavy',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','desktop','main.cjs'),'utf8');
  assert.match(main,/if \(procs\.researchCollector\) start\('researchCollector'\)/);
  assert.doesNotMatch(main,/researchAudit|evolutionLoop|clusterHub|clusterWorker/);
});
