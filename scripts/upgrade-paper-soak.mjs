#!/usr/bin/env node
// Bounded source soak against a throwaway book and a free localhost port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-upgrade-soak-'));
const data=path.join(temp,'data');fs.mkdirSync(data);
const reportPath=path.join(root,'reports','upgrade-paper-soak.json');
const logPath=path.join(root,'reports','upgrade-paper-soak.log');
const durationMs=Math.max(15_000,Math.min(300_000,Number(process.argv[2])||90_000));
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:temp,TMP:temp,APPDATA:temp,LOCALAPPDATA:temp,USERPROFILE:temp,
 MONEY_PRINTER_USER_ROOT:temp,MONEY_PRINTER_DATA_DIR:data,DASHBOARD_HOST:'127.0.0.1',DASHBOARD_PORT:String(port),MODE:'paper',OPEN_DASHBOARD:'false',
 MPO_LAB_LINK:'false',MPO_LAB_MODULES:'',POLYMARKET_AUTOSTART:'true',ROBINHOOD_AUTOSTART:'false',ROBINHOOD_EQUITIES_AUTOSTART:'false',
 ROBINHOOD_PRACTICE_AUTOSTART:'false',ALPHA_WORKER_ENABLED:'false',DIRECT_STREAM_ENABLED:'false',ENABLE_LIVE_TRADING:'false',ROBINHOOD_REAL_ENABLED:'false'};
const log=fs.createWriteStream(logPath,{flags:'w'});
const child=spawn(process.execPath,[path.join(root,'src','index.js'),'--dashboard-only'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
const get=async p=>{const res=await fetch(`http://127.0.0.1:${port}${p}`,{signal:AbortSignal.timeout(8000)});return {status:res.status,body:await res.json()}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={schema:'mpo.upgrade-paper-soak.v1',mode:'source-isolated',startedAt:new Date().toISOString(),durationRequestedMs:durationMs,
 dataDirectory:'temporary isolated directory removed after report',port,source:'Polymarket US public events and BBO; no credentials or real transport',samples:[],failures:[],childPid:child.pid};
try{
 let ready=false;
 for(let i=0;i<40;i++){if(child.exitCode!==null)throw Error(`child exited ${child.exitCode}`);try{const h=await get('/api/health');if(h.status===200){ready=true;break}}catch{}await sleep(500)}
 if(!ready)throw Error('dashboard did not become ready');
 const until=Date.now()+durationMs;
 while(Date.now()<until){
  try{const [p,c]=await Promise.all([get('/api/polymarket-us/paper'),get('/api/polymarket-us/combos')]);
   const b=p.body,s=c.body;report.samples.push({at:new Date().toISOString(),paperStatus:p.status,feed:s.feed,
    evaluationAt:b.evaluation?.at||null,evaluated:b.evaluation?.rows?.length||0,selected:b.evaluation?.rows?.filter(x=>x.decision==='SELECTED').length||0,
    rejected:b.evaluation?.rows?.filter(x=>x.decision==='REJECTED').length||0,decision:b.decisions?.[0]||null,
    open:b.open?.length||0,settled:b.stats?.settled||0,settledPnlUsd:b.stats?.pnlUsd||0,
    cashUsd:b.cashUsd,openCostUsd:b.openCostUsd,markupEvidence:b.markupEvidence,lastLoopError:b.lastLoopError,lastSettlementError:b.lastSettlementError});
   if(p.status!==200||!s.feed?.ok||b.lastLoopError||b.lastSettlementError)report.failures.push(report.samples.at(-1));
  }catch(e){report.failures.push({at:new Date().toISOString(),error:String(e.message||e)})}
  await sleep(Math.min(10_000,Math.max(0,until-Date.now())));
 }
}catch(e){report.failures.push({at:new Date().toISOString(),error:String(e.message||e)})}
finally{
 child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]);
 log.end();report.endedAt=new Date().toISOString();report.observedMs=Date.parse(report.endedAt)-Date.parse(report.startedAt);
 report.exitCode=child.exitCode;report.success=report.samples.length>=2&&report.failures.length===0;
 fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
 if(path.dirname(temp)===os.tmpdir()&&path.basename(temp).startsWith('mpo-upgrade-soak-'))fs.rmSync(temp,{recursive:true,force:true});
 console.log(JSON.stringify({success:report.success,observedMs:report.observedMs,samples:report.samples.length,failures:report.failures.length,
  last:report.samples.at(-1)||null,report:reportPath,log:logPath},null,2));
}
if(!report.success)process.exitCode=1;
