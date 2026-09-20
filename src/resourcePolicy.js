import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const dataDir=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const file=path.join(dataDir,'node-resource-policy.json');
export const TEST_LANES=['LAUNCH_SNIPE','EARLY_MOMENTUM','LIQUIDITY_FILTER','EXIT_TIMING','RISK_STRESS','BASELINE_CONTROL'];
let cpuPrev=null, memoryCache={at:0,pct:null};
function memoryPct(){
  const total=os.totalmem(),free=os.freemem();
  if(process.platform!=='darwin') return {pct:(1-free/total)*100,used:total-free};
  if(Date.now()-memoryCache.at>2500){
    try{const out=execFileSync('/usr/bin/memory_pressure',[],{encoding:'utf8',timeout:1200});const m=out.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/);if(m)memoryCache={at:Date.now(),pct:100-Number(m[1])}}catch{}
  }
  const pct=Number.isFinite(memoryCache.pct)?memoryCache.pct:(1-free/total)*100;
  return {pct,used:total*(pct/100)};
}

const clamp=(n,a,b)=>Math.max(a,Math.min(b,Number(n)||0));
function defaults(){const ramGB=os.totalmem()/1073741824;return{autoCoordinate:true,cpuPercent:65,memoryGB:+Math.max(.5,Math.min(ramGB*.35,8)).toFixed(1),diskGB:5,updatedAt:Date.now(),source:'default'}}
export function loadResourcePolicy(){let p=defaults();try{p={...p,...JSON.parse(fs.readFileSync(file,'utf8'))}}catch{};p.cpuPercent=clamp(p.cpuPercent,10,95);p.memoryGB=clamp(p.memoryGB,.25,Math.max(.25,os.totalmem()/1073741824*.8));p.diskGB=clamp(p.diskGB,.5,100);return p}
export function saveResourcePolicy(patch={},source='manual'){const prev=source==='hive'?defaults():loadResourcePolicy(),next={...prev,...Object.fromEntries(Object.entries(patch).filter(([k,v])=>['cpuPercent','memoryGB','diskGB'].includes(k)&&v!==undefined)),source,updatedAt:Date.now()};if(source==='manual')next.autoCoordinate=false;if(source==='hive')next.autoCoordinate=true;next.cpuPercent=clamp(next.cpuPercent,10,95);next.memoryGB=clamp(next.memoryGB,.25,Math.max(.25,os.totalmem()/1073741824*.8));next.diskGB=clamp(next.diskGB,.5,100);fs.mkdirSync(dataDir,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2));fs.renameSync(tmp,file);return next}
export function suggestedLane(id=os.hostname()){let h=2166136261;for(const c of String(id)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return TEST_LANES[Math.abs(h) % TEST_LANES.length]}
export function resourceSnapshot(id=os.hostname()){const p=loadResourcePolicy();return{...p,testLane:p.autoCoordinate?suggestedLane(id):'LOCAL_CUSTOM',maxWorkerSlots:Math.max(1,Math.min(16,Math.floor(Math.max(1,os.cpus().length-1)*p.cpuPercent/100),Math.max(1,Math.floor(p.memoryGB/.4))))}}
export function systemTelemetry(){const cpus=os.cpus(),cur=cpus.map(c=>{const t=c.times;return{idle:t.idle,total:t.user+t.nice+t.sys+t.idle+t.irq}});let cpuPct=0;if(cpuPrev&&cpuPrev.length===cur.length){let idle=0,total=0;for(let i=0;i<cur.length;i++){idle+=cur[i].idle-cpuPrev[i].idle;total+=cur[i].total-cpuPrev[i].total}cpuPct=total>0?(1-idle/total)*100:0}cpuPrev=cur;const totalMem=os.totalmem(),mem=memoryPct(),usedMem=mem.used;return{cpuPct:+clamp(cpuPct,0,100).toFixed(1),memoryPct:+clamp(mem.pct,0,100).toFixed(1),memoryUsedGB:+(usedMem/1073741824).toFixed(2),memoryTotalGB:+(totalMem/1073741824).toFixed(2),cpuThreads:cpus.length}}
