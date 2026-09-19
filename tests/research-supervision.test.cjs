const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {researchServicePolicy}=require('../desktop/research-supervision.cjs');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'mpo-research-policy-'))}

test('collector defaults on while audit stays off without BEAST',()=>{
 const dir=tmp(),p=researchServicePolicy({env:{},dataDir:dir});
 assert.equal(p.collector,true);assert.equal(p.audit,false);assert.equal(p.beast,false);
 assert.equal(p.auditEnv.MPO_AUDIT_WORKERS,'4');assert.equal(p.auditEnv.MPO_AUDIT_EVERY_GENERATIONS,'25');
});
test('BEAST enables bounded audit by default',()=>{
 const dir=tmp();fs.writeFileSync(path.join(dir,'research-beast.json'),JSON.stringify({enabled:true}));
 const p=researchServicePolicy({env:{},dataDir:dir});assert.equal(p.audit,true);assert.equal(p.beast,true);
});
test('BEAST environment flag enables bounded audit without a profile file',()=>{
 const dir=tmp(),p=researchServicePolicy({env:{MPO_RESEARCH_BEAST:'1'},dataDir:dir});
 assert.equal(p.audit,true);assert.equal(p.beast,true);assert.equal(p.auditEnv.MPO_AUDIT_WORKERS,'4');
});
test('explicit flags override defaults and resource knobs are preserved',()=>{
 const dir=tmp();fs.writeFileSync(path.join(dir,'research-beast.json'),JSON.stringify({enabled:true}));
 const p=researchServicePolicy({env:{MPO_RESEARCH_COLLECTOR:'false',MPO_RESEARCH_AUDIT:'0',MPO_AUDIT_WORKERS:'7'},dataDir:dir});
 assert.equal(p.collector,false);assert.equal(p.audit,false);assert.equal(p.auditEnv.MPO_AUDIT_WORKERS,'7');
});


test('desktop supervisor starts enabled research services',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','desktop','main.cjs'),'utf8');
  assert.match(main,/if \(procs\.researchCollector\) start\('researchCollector'\)/);
  assert.match(main,/if \(procs\.researchAudit\) start\('researchAudit'\)/);
});
