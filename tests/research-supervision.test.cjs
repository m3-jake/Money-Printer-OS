const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {researchServicePolicy}=require('../desktop/research-supervision.cjs');
const {localLabStartDecision,RETRY_MS,WINDOW_MS}=require('../desktop/local-lab-supervision.cjs');

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
  assert.ok(main.indexOf("if (procs.researchCollector) start('researchCollector')")>main.indexOf('boot: adopting an engine'), 'adopted engines also get a supervised collector');
  assert.match(main,/prefsSeen = null/, 'the first launch applies default login preferences even without a saved file');
  assert.doesNotMatch(main,/researchAudit|evolutionLoop|clusterHub|clusterWorker/);
});

test('local Lab starts only when installed and absent, with cooldown and an hourly retry cap',()=>{
  const now=1_000_000;
  const ready={enabled:true,installed:true,portBusy:false,now,attempts:[]};
  assert.equal(localLabStartDecision({...ready,enabled:false}).reason,'disabled');
  assert.equal(localLabStartDecision({...ready,installed:false}).reason,'not-installed');
  assert.deepEqual(localLabStartDecision({...ready,portBusy:true,attempts:[now-1000]}).attempts,[]);
  const first=localLabStartDecision(ready);
  assert.equal(first.launch,true);
  assert.equal(localLabStartDecision({...ready,now:now+RETRY_MS-1,attempts:first.attempts}).reason,'cooldown');
  const second=localLabStartDecision({...ready,now:now+RETRY_MS,attempts:first.attempts});
  const third=localLabStartDecision({...ready,now:now+2*RETRY_MS,attempts:second.attempts});
  assert.equal(localLabStartDecision({...ready,now:now+3*RETRY_MS,attempts:third.attempts}).reason,'retry-budget');
  assert.equal(localLabStartDecision({...ready,now:now+WINDOW_MS+1,attempts:third.attempts}).launch,true);
});
