// Run with the installed Lab Electron executable and ELECTRON_RUN_AS_NODE=1.
// This starts only the archived HTTP server, with no collectors, scheduler, orders or installed data.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
if(!process.versions.electron)throw new Error('Run this verification with Electron as Node');
const at=process.argv.indexOf('--asar'),archive=path.resolve(process.argv[at+1]||'');
if(at<0||!fs.existsSync(archive))throw new Error('--asar <Lab app.asar> required');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-lab-archive-'));
Object.assign(process.env,{MPO_LAB_DATA_DIR:path.join(temp,'lab'),MONEY_PRINTER_DATA_DIR:path.join(temp,'lab'),MPO_LAB_TRADER_DATA_DIR:path.join(temp,'trader'),MPO_COMPUTE_BUDGET_FILE:path.join(temp,'budget.json'),MONEY_PRINTER_BRIDGE_DIR:'',MONEY_PRINTER_BRIDGE_KEY:''});
fs.mkdirSync(process.env.MPO_LAB_DATA_DIR,{recursive:true});fs.mkdirSync(process.env.MPO_LAB_TRADER_DATA_DIR,{recursive:true});
let server;
try{
 const {startLabServer}=await import(pathToFileURL(path.join(archive,'src','labServer.js')));
 const {labConfig}=await import(pathToFileURL(path.join(archive,'src','labConfig.js')));
 server=startLabServer({cfg:labConfig({refresh:true}),host:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port,health=await(await fetch(base+'/api/health')).json(),status=(await fetch(base+'/')).status;
 const result={at:new Date().toISOString(),archive,success:health.ok===true&&health.version==='0.1.0-alpha.7'&&health.build.commit==='abc16cec35bb8957d7fb6f7b8a4791c0bad0fbdb'&&health.build.sourceDirty===false&&status===200,
  runtime:{node:process.versions.node,electron:process.versions.electron},dashboardStatus:status,health,isolated:true,collectorsStarted:false,installedDataTouched:false};
 fs.writeFileSync(path.join(path.dirname(archive),'WINDOWS-ENGINE-SMOKE.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.success)process.exitCode=1;
}finally{
 if(server)await new Promise(r=>server.close(r));
 if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unexpected cleanup directory');
 fs.rmSync(temp,{recursive:true,force:true});
}
