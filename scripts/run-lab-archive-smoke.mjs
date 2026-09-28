// Windows GUI executables do not reliably provide a waited exit code to PowerShell.
// A Node child process owns the archived Electron test and requires fresh evidence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const archive=option('--asar'),exe=option('--exe');
if(!archive||!exe||!fs.existsSync(archive)||!fs.existsSync(exe))throw Error('Existing --asar and --exe paths are required');
const started=Date.now(),script=fileURLToPath(new URL('./smoke-lab-archive.mjs',import.meta.url));
const run=spawnSync(exe,[script,'--asar',path.resolve(archive)],{
  env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024,
});
const log=path.join(path.dirname(path.resolve(archive)),'lab-engine-smoke.log');
fs.writeFileSync(log,String(run.stdout||'')+'\n'+String(run.stderr||''));
if(run.error||run.status!==0)throw Error('Lab archive test process failed: '+(run.error?.message||'exit '+run.status)+'; see '+log);
const receipt=path.join(path.dirname(path.resolve(archive)),'WINDOWS-ENGINE-SMOKE.json');
if(!fs.existsSync(receipt))throw Error('Lab smoke process returned without a verification receipt; see '+log);
const result=JSON.parse(fs.readFileSync(receipt,'utf8'));
if(result.success!==true||!Number.isFinite(Date.parse(result.at))||Date.parse(result.at)<started||path.resolve(result.archive||'')!==path.resolve(archive))throw Error('Lab smoke receipt is unsuccessful, stale, or belongs to another archive');
console.log(JSON.stringify({success:true,receipt,version:result.health.version,commit:result.health.build.commit,checks:result.checks},null,2));
