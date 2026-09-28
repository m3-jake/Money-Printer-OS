import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateLabSmoke } from '../scripts/lab-smoke-contract.mjs';
const fixture=()=>{
  const manifest={packageVersion:'0.1.0-alpha.999',commit:'a'.repeat(40),archiveSha256:'b'.repeat(64),sourceFingerprint:'c'.repeat(64),sourceDirty:false,compatibility:{labLink:'mpo.lab-status.v1'}};
  return {manifest,archiveSha256:manifest.archiveSha256,dashboardStatus:200,health:{ok:true,service:'money-printer-evolution-lab',version:manifest.packageVersion,build:{...manifest},switches:{liveActivationAllowed:false,automaticLivePromotionAllowed:false}}};
};
test('Lab smoke contract accepts matching future versions instead of pinning an obsolete release',()=>{
  const input=fixture();assert.equal(validateLabSmoke(input).success,true);
  input.manifest.packageVersion='0.2.0-alpha.1';input.health.version=input.manifest.packageVersion;assert.equal(validateLabSmoke(input).success,true);
});
test('Lab smoke fails on wrong bytes, provenance, service, dirty source and live authority',()=>{
  for(const mutate of [x=>x.archiveSha256='d'.repeat(64),x=>x.health.build.commit='e'.repeat(40),x=>x.health.version='old',x=>x.health.service='other-app',x=>x.health.build.sourceDirty=true,x=>x.health.switches.liveActivationAllowed=true,x=>x.dashboardStatus=500,x=>delete x.health.switches]){
    const input=fixture();mutate(input);assert.equal(validateLabSmoke(input).success,false);
  }
  assert.equal(validateLabSmoke({}).success,false);
});
test('paired updater checks both archives and zero-credit state before accepting a release',()=>{
  const source=fs.readFileSync(new URL('../scripts/update-local-install.ps1',import.meta.url),'utf8');
  assert.match(source,/scripts\\run-lab-archive-smoke\.mjs/);assert.match(source,/\[switch\]\$NonInteractive/);
  assert.match(source,/researchState\.budget\.paidModelsEnabled/);assert.match(source,/researchState\.cache\.paidModelsEnabled/);
  assert.ok(source.indexOf('run-lab-archive-smoke.mjs')<source.indexOf("Stop-App 'Money Printer OS'"));
});

test('Lab process wrapper rejects zero exit without evidence, stale receipts and failed children',async()=>{
  const os=await import('node:os'),path=await import('node:path'),{spawnSync}=await import('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-smoke-wrapper-test-'));
  try {
    for(const [name,stub,expected] of [
      ['missing','process.exit(0);',/without a verification receipt/],
      ['failed','process.exit(9);',/process failed: exit 9/],
      ['stale',"import fs from 'node:fs';import path from 'node:path';const archive=process.argv[3];fs.writeFileSync(path.join(path.dirname(archive),'WINDOWS-ENGINE-SMOKE.json'),JSON.stringify({success:true,at:'2000-01-01T00:00:00Z',archive}));",/stale/]
    ]) {
      const dir=path.join(root,name);fs.mkdirSync(dir);const archive=path.join(dir,'fixture.asar');fs.writeFileSync(archive,'synthetic test archive');
      const wrapper=path.join(dir,'run-lab-archive-smoke.mjs');fs.copyFileSync(new URL('../scripts/run-lab-archive-smoke.mjs',import.meta.url),wrapper);
      fs.writeFileSync(path.join(dir,'smoke-lab-archive.mjs'),stub);
      const result=spawnSync(process.execPath,[wrapper,'--asar',archive,'--exe',process.execPath],{encoding:'utf8',timeout:10000,windowsHide:true});
      assert.notEqual(result.status,0);assert.match(result.stderr,expected);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
