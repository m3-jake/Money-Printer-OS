// Isolated hidden native Electron renderer, installed UI, read-only endpoints; no installed archive is launched.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const outDir=path.dirname(fileURLToPath(import.meta.url)),runtime=path.join(process.env.LOCALAPPDATA,'Programs','money-printer-os');
const scratchRoot='W:/money-printer-backups/renderer-checks';fs.mkdirSync(scratchRoot,{recursive:true});const scratch=fs.mkdtempSync(path.join(scratchRoot,'native-'));
const result=path.join(outDir,'native-renderer-metrics.json');
try{
 for(const f of fs.readdirSync(runtime,{withFileTypes:true}))if(f.name==='locales'||f.isFile()&&/\.(exe|dll|bin|pak|dat)$/.test(f.name))fs.cpSync(path.join(runtime,f.name),path.join(scratch,f.name),{recursive:true});
 const appDir=path.join(scratch,'resources','app');fs.mkdirSync(appDir,{recursive:true});fs.writeFileSync(path.join(appDir,'package.json'),JSON.stringify({name:'readonly-mpo-renderer',main:'main.cjs'}));
 const main=String.raw`
 const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
 const pause=ms=>new Promise(r=>setTimeout(r,ms));let win;
 app.setPath('userData',path.join(process.env.TEMP,'userdata'));
 app.commandLine.appendSwitch('disable-renderer-backgrounding');app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
 const stage=name=>fs.writeFileSync(process.env.MPO_CHECK_REPORT,JSON.stringify({stage:name,at:new Date().toISOString()}));
 app.whenReady().then(async()=>{stage('ready');
  win=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{offscreen:true,backgroundThrottling:false}});
  win.webContents.on('paint',()=>{});win.webContents.setFrameRate(60);
  const origin=process.env.MPO_CHECK_URL;
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:d.method!=='GET'||!d.url.startsWith(origin)&&!d.url.startsWith('data:')}));
  await win.loadURL(origin+'/');stage('loaded');await pause(3000);
  await win.webContents.executeJavaScript("(()=>{document.getElementById('bootOk')?.click();document.getElementById('logonOk')?.click();if(typeof openApp==='function')openApp('command');})()");
  stage('command-open');await pause(5000);
  stage('frames');const result=await win.webContents.executeJavaScript('('+(async function(){
   const percentile=(xs,p)=>{const s=xs.slice().sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(s.length*p))]??null;};
   const frames=[],interactions=[];let last=performance.now();
   await new Promise(resolve=>{const next=at=>{frames.push(at-last);last=at;if(frames.length>=120)resolve();else requestAnimationFrame(next);};requestAnimationFrame(next);});
   for(let i=0;i<12;i++){const el=document.querySelector('[data-cc-sys="'+(i%2?'modules':'books')+'"]'),t=performance.now();el?.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));interactions.push(performance.now()-t);}
   return {viewport:[innerWidth,innerHeight],frame:{n:frames.length,p50Ms:percentile(frames,.5),p95Ms:percentile(frames,.95)},interaction:{n:interactions.length,p50Ms:percentile(interactions,.5),p95Ms:percentile(interactions,.95)},charts:document.querySelectorAll('.pw canvas').length,status:document.querySelector('.cc-strip')?.textContent,hud:window.MPOHud?.metrics?.(),limitations:['Hidden native renderer, installed archive UI and real stored/live data; physical pointer latency and visible multi-monitor transitions unmeasured']};
  }).toString()+')()');
  await win.webContents.executeJavaScript("document.querySelector('[data-cc-sys=copy]')?.click()");await pause(2500);
  result.copy=await win.webContents.executeJavaScript("({text:document.querySelector('.cc-sys-body')?.textContent,selected:document.querySelector('[data-cc-sys=copy]')?.getAttribute('aria-selected')})");
  fs.writeFileSync(process.env.MPO_CHECK_REPORT.replace('.json','-copy.png'),(await win.webContents.capturePage()).toPNG());
  result.at=new Date().toISOString();result.electron=process.versions.electron;result.processes=app.getAppMetrics();
  fs.writeFileSync(process.env.MPO_CHECK_REPORT,JSON.stringify(result,null,2));app.quit();
 }).catch(e=>{fs.writeFileSync(process.env.MPO_CHECK_REPORT,JSON.stringify({error:e.message}));app.exit(1);});
 `;
 fs.writeFileSync(path.join(appDir,'main.cjs'),main);
 const child=spawn(path.join(scratch,'Money Printer OS.exe'),[],{cwd:scratch,windowsHide:true,stdio:'pipe',env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:scratch,TMP:scratch,APPDATA:scratch,LOCALAPPDATA:scratch,USERPROFILE:scratch,MPO_CHECK_URL:'http://127.0.0.1:8792',MPO_CHECK_REPORT:result}});
 child.stderr.on('data',b=>process.stderr.write(b));child.stdout.on('data',b=>process.stdout.write(b));
 const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('Native renderer check timed out'));},60000);child.once('exit',n=>{clearTimeout(timeout);resolve(n);});child.once('error',reject);});
 console.log(JSON.stringify({code,report:result}));process.exitCode=code||0;
}finally{if(!path.resolve(scratch).startsWith(path.resolve(scratchRoot)+path.sep))throw Error('Unexpected scratch cleanup path');try{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:250});}catch(e){console.error('Scratch retained for bounded cleanup: '+scratch+' '+e.message);}}
