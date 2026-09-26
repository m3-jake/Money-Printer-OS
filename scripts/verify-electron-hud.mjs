// Copy only the installed Electron runtime to a disposable harness. Never launch its app.asar.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'win32') throw new Error('Windows native renderer harness');
const runtime = path.join(process.env.LOCALAPPDATA, 'Programs', 'money-printer-os');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-native-hud-'));
const report = path.join(root, 'reports', 'upgrade-electron-hud-2026-09-26.json');
const port = Number(process.env.HUD_NATIVE_PORT || 18769);
const processes = [];
try {
  for (const f of fs.readdirSync(runtime, {withFileTypes:true})) {
    if (f.name === 'locales' || (f.isFile() && /\.(exe|dll|bin|pak|dat)$/.test(f.name)))
      fs.cpSync(path.join(runtime,f.name),path.join(temp,f.name),{recursive:true});
  }
  const app = path.join(temp, 'resources', 'app'); fs.mkdirSync(app,{recursive:true});
  fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'isolated-hud-check',main:'main.cjs'}));
  fs.copyFileSync(path.join(root,'tests','helpers','electron-hud-main.cjs'),path.join(app,'main.cjs'));
  const fixture = spawn(process.execPath,[path.join(root,'tests','helpers','hud-fixture-server.mjs')],{env:{...process.env,HUD_FIXTURE_PORT:String(port)},windowsHide:true,stdio:'pipe'}); processes.push(fixture);
  await new Promise((resolve,reject)=>{fixture.stdout.once('data',resolve);fixture.once('error',reject);fixture.once('exit',code=>reject(Error('Fixture exited '+code)))});
  const load = spawn(process.execPath,[path.join(root,'tests','helpers','hud-cpu-load.mjs'),'4','60000'],{windowsHide:true,stdio:'ignore'}); processes.push(load);
  const env={PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:temp,TMP:temp,APPDATA:temp,LOCALAPPDATA:temp,USERPROFILE:temp,HOME:temp,MPO_HUD_URL:`http://127.0.0.1:${port}`,MPO_HUD_REPORT:report};
  const child=spawn(path.join(temp,'Money Printer OS.exe'),[],{cwd:temp,env,windowsHide:true,stdio:'pipe'}); processes.push(child);
  child.stderr.on('data',b=>process.stderr.write(b));
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
  const result=JSON.parse(fs.readFileSync(report,'utf8'));
  console.log(JSON.stringify({report,exitCode:code,success:result.success,phases:result.phases.map(p=>({size:p.size,fault:p.fault,frames:p.fixture.frames,frameP95:p.fixture.frameP95,interactionP95:p.fixture.interactionP95,errors:p.fixture.errors,status:p.status}))},null,2));
  process.exitCode=result.success&&code===0?0:1;
} finally {
  for(const child of processes)if(child.exitCode===null){child.kill();await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}
  // The absolute target is created by mkdtemp under the system temp directory above.
  if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unexpected cleanup target');
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
