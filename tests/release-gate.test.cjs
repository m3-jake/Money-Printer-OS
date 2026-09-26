const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateSafety, releaseRecord, promotionGate, promoteRelease } = require('../desktop/release-gate.cjs');
function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),'mpo-release-')); }
function artifacts(d){ const m=path.join(d,'mac'),w=path.join(d,'win'); fs.writeFileSync(m,'mac');fs.writeFileSync(w,'win');return{mac:m,windows:w}; }

test('update allowed when no real combo exposure exists',()=>{const d=tmp();fs.writeFileSync(path.join(d,'combo-engine.json'),JSON.stringify({open:[]}));fs.writeFileSync(path.join(d,'polymarket-us-combos.json'),JSON.stringify({open:[]}));assert.equal(updateSafety(d).safe,true);fs.rmSync(d,{recursive:true,force:true})});
test('real Combo Engine exposure blocks updater restart',()=>{const d=tmp();fs.writeFileSync(path.join(d,'combo-engine.json'),JSON.stringify({open:[{mode:'real',status:'OPEN'}]}));const g=updateSafety(d);assert.equal(g.safe,false);assert.match(g.reasons.join(' '),/real Combo/);fs.rmSync(d,{recursive:true,force:true})});
test('unverified/open US order or RFQ blocks updater restart',()=>{const d=tmp();fs.writeFileSync(path.join(d,'polymarket-us-combos.json'),JSON.stringify({open:[{id:'x',submissionState:'UNCERTAIN'}]}));assert.equal(updateSafety(d).safe,false);fs.rmSync(d,{recursive:true,force:true})});
test('corrupt trading state fails closed instead of allowing restart',()=>{const d=tmp();fs.writeFileSync(path.join(d,'combo-engine.json'),'{bad');const g=updateSafety(d);assert.equal(g.safe,false);assert.match(g.reasons.join(' '),/unreadable/);fs.rmSync(d,{recursive:true,force:true})});
test('recovery-required trading state blocks updater',()=>{const d=tmp();fs.writeFileSync(path.join(d,'combo-engine.json'),JSON.stringify({recoveryRequired:true,open:[]}));assert.equal(updateSafety(d).safe,false);fs.rmSync(d,{recursive:true,force:true})});
test('release must progress main -> candidate -> tested -> stable with signed evidence',()=>{
  const d=tmp(),rollback={version:'0.5.0-alpha.41',sha256:'oldhash',file:'app.asar.previous'};
  let r=releaseRecord({version:'0.5.0-alpha.43',commit:'abc',artifacts:artifacts(d),signed:false,rollback,tests:{testAll:true,selftest:true,macBoot:true,windowsBoot:false}});
  assert.equal(r.stage,'main');
  assert.deepEqual(promotionGate(r,'candidate').missing,['signed']);
  r.signed=true;
  r=promoteRelease(r,'candidate');
  assert.equal(r.stage,'candidate');
  assert.equal(promotionGate(r,'stable').ok,false);
  assert.deepEqual(promotionGate(r,'stable').missing,['stageOrder']);
  assert.deepEqual(promotionGate(r,'tested').missing,['windowsBoot']);
  r.tests.windowsBoot=true;
  r=promoteRelease(r,'tested');
  assert.equal(r.stage,'tested');
  assert.equal(promotionGate(r,'stable').ok,true);
  r=promoteRelease(r,'stable');
  assert.equal(r.stage,'stable');
  assert.deepEqual(r.rollback,rollback);
  fs.rmSync(d,{recursive:true,force:true});
});

test('Robinhood journal exposure and malformed state block updates without touching balances',()=>{
 const d=tmp(),file=path.join(d,'robinhood-auto-trader.json');
 try{
  for(const value of [{version:1,open:[{id:'rh-test',status:'SUBMITTED_UNCERTAIN'}]},{version:1,open:[],recoveryRequired:true},{version:1,open:'invalid'},null]){
   const text=JSON.stringify(value);fs.writeFileSync(file,text);const gate=updateSafety(d);assert.equal(gate.safe,false);assert.match(gate.reasons.join(' '),/Robinhood/);assert.equal(fs.readFileSync(file,'utf8'),text);
  }
  fs.writeFileSync(file,'{broken');assert.equal(updateSafety(d).safe,false);
  fs.writeFileSync(file,JSON.stringify({version:1,open:[]}));assert.equal(updateSafety(d).safe,true);assert.equal(updateSafety(d).robinhoodOpen,0);
  fs.writeFileSync(file,JSON.stringify({version:1,open:[{id:'a',status:'OPEN'},{id:'b',status:'CLOSING'}]}));const two=updateSafety(d);assert.equal(two.robinhoodOpen,2);assert.match(two.reasons.join(' '),/2 Robinhood crypto order exposure\(s\) open/);
  fs.writeFileSync(path.join(d,'robinhood-paper.json'),JSON.stringify({version:1,positions:[{id:'p',status:'OPEN'}]}));fs.writeFileSync(file,JSON.stringify({version:1,open:[]}));assert.equal(updateSafety(d).safe,true,'paper positions are not exposure');
 }finally{fs.rmSync(d,{recursive:true,force:true})}
});
