// Run with the installed Lab Electron executable and ELECTRON_RUN_AS_NODE=1.
// Start only the archived HTTP server with isolated data: no furnace, collectors or orders.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { validateLabSmoke } from './lab-smoke-contract.mjs';
if (!process.versions.electron) throw new Error('Run this verification with Electron as Node');
const at=process.argv.indexOf('--asar'),archive=at>=0&&process.argv[at+1]?path.resolve(process.argv[at+1]):'';
if (!archive || !fs.existsSync(archive)) throw new Error('--asar <Lab app.asar> required');
const manifest=JSON.parse(fs.readFileSync(archive+'.build.json','utf8'));
// Read the archive itself as bytes, not as an Electron virtual directory.
const priorNoAsar=process.noAsar;let archiveBytes;
try { process.noAsar=true;archiveBytes=fs.readFileSync(archive); } finally { process.noAsar=priorNoAsar; }
const archiveSha256=createHash('sha256').update(archiveBytes).digest('hex');
if (archiveSha256!==manifest.archiveSha256) throw new Error('Archive does not match its external build receipt');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-lab-archive-'));
Object.assign(process.env,{MPO_LAB_DATA_DIR:path.join(temp,'lab'),MONEY_PRINTER_DATA_DIR:path.join(temp,'lab'),MPO_LAB_TRADER_DATA_DIR:path.join(temp,'trader'),MPO_COMPUTE_BUDGET_FILE:path.join(temp,'budget.json'),MONEY_PRINTER_BRIDGE_DIR:'',MONEY_PRINTER_BRIDGE_KEY:''});
fs.mkdirSync(process.env.MPO_LAB_DATA_DIR,{recursive:true});fs.mkdirSync(process.env.MPO_LAB_TRADER_DATA_DIR,{recursive:true});
let server;
try {
  const {startLabServer}=await import(pathToFileURL(path.join(archive,'src','labServer.js')));
  const {labConfig}=await import(pathToFileURL(path.join(archive,'src','labConfig.js')));
  server=startLabServer({cfg:labConfig({refresh:true}),host:'127.0.0.1',port:0});
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const health=await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(10000)})).json();
  const dashboardStatus=(await fetch(base+'/',{signal:AbortSignal.timeout(10000)})).status;
  const validation=validateLabSmoke({health,manifest,archiveSha256,dashboardStatus});
  const result={at:new Date().toISOString(),archive,...validation,
    runtime:{node:process.versions.node,electron:process.versions.electron},dashboardStatus,health,
    isolated:true,collectorsStarted:false,installedDataTouched:false,testDataDirectory:temp};
  fs.writeFileSync(path.join(path.dirname(archive),'WINDOWS-ENGINE-SMOKE.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));if(!result.success)process.exitCode=1;
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  // Retain this isolated test directory for inspection; never delete installed or user data.
}
