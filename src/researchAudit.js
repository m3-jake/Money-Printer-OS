import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { packDataset, MC_ROUNDS_WORKER } from './evolutionScoring.js';
import { EvolutionPool } from './evolutionPool.js';
import { splitResearchRows } from './evolutionSearch.js';

const DATA_DIR=path.resolve(process.env.MONEY_PRINTER_DATA_DIR||'data');
const STATE_FILE=path.join(DATA_DIR,'state.json');
const OUT_FILE=path.join(DATA_DIR,'research-evidence','robustness-audit.ndjson');
const STATUS_FILE=path.join(DATA_DIR,'research-audit-status.json');
const WORKERS=Math.max(1,Math.min(Math.max(1,os.cpus().length-4),Number(process.env.MPO_AUDIT_WORKERS||12)));
const EVERY=Math.max(3,Number(process.env.MPO_AUDIT_EVERY_GENERATIONS||10));
const SEEDS=Math.max(2,Math.min(16,Number(process.env.MPO_AUDIT_SEEDS||8)));
const ROUNDS=Math.max(MC_ROUNDS_WORKER,Math.min(2000,Number(process.env.MPO_AUDIT_ROUNDS||500)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=()=>{try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return null}};
const atomic=(f,x)=>{fs.mkdirSync(path.dirname(f),{recursive:true});const t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(x,null,2));fs.renameSync(t,f)};
const append=x=>{fs.mkdirSync(path.dirname(OUT_FILE),{recursive:true});fs.appendFileSync(OUT_FILE,JSON.stringify(x)+'\n')};

export function auditVariantsFromState(s={}){
 const loop=s.evolutionLoop||s.evolution?.loop||{},out=[],seen=new Set();
 for(const x of [loop.champion,...(loop.challengers||[])]){const v=x?.variant;if(!v?.id||seen.has(v.id))continue;seen.add(v.id);out.push(v);if(out.length>=12)break}
 return out;
}
export function summarizeAudit(runs=[]){
 const by=new Map();
 for(const run of runs)for(const x of run||[]){if(!x?.variant?.id||!x.metrics)continue;const a=by.get(x.variant.id)||[];a.push(x.metrics);by.set(x.variant.id,a)}
 return [...by.entries()].map(([id,xs])=>({id,seeds:xs.length,
  robustAvg:xs.reduce((a,x)=>a+Number(x.robustScore||0),0)/xs.length,robustMin:Math.min(...xs.map(x=>Number(x.robustScore||0))),robustMax:Math.max(...xs.map(x=>Number(x.robustScore||0))),
  mcPassAvg:xs.reduce((a,x)=>a+Number(x.monteCarloPassPct||0),0)/xs.length,mcPassMin:Math.min(...xs.map(x=>Number(x.monteCarloPassPct||0))),
  heldOutAvg:xs.reduce((a,x)=>a+Number(x.heldOutAvgPct||0),0)/xs.length,stressMin:Math.min(...xs.map(x=>Number(x.stressAvgPct||0))),consistencyMin:Math.min(...xs.map(x=>Number(x.consistencyPct||0)))}));
}

async function main(){
 const pool=new EvolutionPool({size:WORKERS});let last=0;
 process.on('SIGTERM',async()=>{await pool.close();process.exit(0)});
 for(;;){
  const s=read(),loop=s?.evolutionLoop||s?.evolution?.loop||{},gen=Number(loop.generation||0);
  if(gen>=last+EVERY){
   const all=(s?.research?.learner?.outcomes||[]).filter(o=>o?.horizonMin===5&&Number.isFinite(Number(o.returnPct))&&o.features).sort((a,b)=>Number(a.ts)-Number(b.ts));
   const split=splitResearchRows(all,{sealedFraction:Number(loop.sealedSplit?.fraction||.15)}),vars=auditVariantsFromState(s);
   if(split.rankingRows.length>=60&&vars.length){
    const ds=packDataset(split.rankingRows),runs=[],started=Date.now();pool.resize(WORKERS);
    for(let seed=0;seed<SEEDS;seed++)runs.push(await pool.score(vars,ds,{rounds:ROUNDS,seed:100000+gen*31+seed*1009}));
    const row={schema:'mpo.robustness-audit.v1',ts:Date.now(),generation:gen,selectionUse:false,datasetRows:split.rankingRows.length,sealedRowsExcluded:split.sealedRows.length,workers:WORKERS,seeds:SEEDS,rounds:ROUNDS,wallMs:Date.now()-started,candidates:summarizeAudit(runs)};
    append(row);atomic(STATUS_FILE,{...row,status:'ACTIVE',lastAuditAt:row.ts});last=gen;
   }else{atomic(STATUS_FILE,{schema:'mpo.robustness-audit.v1',status:'WAITING',generation:gen,datasetRows:split.rankingRows.length,candidates:vars.length,updatedAt:Date.now()});last=Math.max(last,gen-EVERY+1)}
  }
  await sleep(1000);
 }
}
const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain)main().catch(e=>{console.error(e);process.exitCode=1});
