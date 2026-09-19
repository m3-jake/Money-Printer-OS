// Throughput benchmark for the evolution scorer: fast (persistent pool + packed
// SharedArrayBuffer dataset) vs legacy (spawn-per-generation + cloned object rows).
// Synthetic data only; it never calls loadState() and never reads or writes ./data.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const argv=process.argv.slice(2);
const args=Object.fromEntries(argv.filter(a=>a.startsWith('--')).map(a=>{const [k,...r]=a.replace(/^--/,'').split('=');return [k,r.length?r.join('='):'1']}));
const num=(k,d)=>{const v=Number(args[k]);return Number.isFinite(v)&&v>0?v:d};
const ROWS=Math.floor(num('rows',3000));
const VARIANTS=Math.floor(num('variants',2048));
const GENERATIONS=Math.floor(num('generations',3));
const WORKERS_REQUESTED=Math.floor(num('workers',Math.max(1,os.cpus().length-1)));
const MODE=String(args.mode||'both').toLowerCase();
const SEED=Math.floor(num('seed',1));
const CORES=os.cpus().length;

// Isolated environment: the benchmark must never touch the live data directory.
const benchDir=fs.mkdtempSync(path.join(os.tmpdir(),'mpo-bench-'));
process.env.MONEY_PRINTER_DATA_DIR=benchDir;
process.env.EVOLUTION_WORKERS=String(WORKERS_REQUESTED);
process.env.EVOLUTION_SCORER='fast';
delete process.env.CLUSTER_HUB_URL;
delete process.env.MPO_RESEARCH_FURNACE;
delete process.env.MPO_RESEARCH_BEAST;
delete process.env.MPO_RESEARCH_GPU;
if(args.chunk)process.env.EVOLUTION_CHUNK=String(Math.floor(Number(args.chunk)||0));
fs.writeFileSync(path.join(benchDir,'node-resource-policy.json'),JSON.stringify({
  cpuPercent:95, memoryGB:Math.max(.25,Math.min(os.totalmem()/1073741824*.8,WORKERS_REQUESTED*.4)),
  diskGB:5, autoCoordinate:false, source:'bench', updatedAt:Date.now(),
}));

const {mulberry32,packDataset,scoreVariant,scoreVariantPacked,BASE,MC_ROUNDS_MAIN,MC_ROUNDS_WORKER,FEATURES}=await import('./evolutionScoring.js');
const {mutate,localWorkerCount,getPool,closePool,scoreInWorkersLegacy}=await import('./evolutionEngine.js');
const {TEST_LANES}=await import('./resourcePolicy.js');

const WORKERS=localWorkerCount();

function syntheticRows(n,seed){
  const r=mulberry32(seed),out=[];
  let ts=Date.now()-n*60_000;
  for(let i=0;i<n;i++){
    ts+=Math.floor(r()*90_000)+1_000;
    const f={};
    for(const k of FEATURES)f[k]=r();
    // Heavy tail: mostly small moves, a few large winners, in [-70, 250].
    const u=r();
    const ret=u<.62?(r()*24-18):(u<.93?(r()*60-20):(r()*250-40));
    out.push({ts,horizonMin:5,returnPct:Math.max(-70,Math.min(250,ret)),features:f});
  }
  return out;
}

function syntheticVariants(count,seed){
  const r=mulberry32(seed);
  const parent={id:'BASE',weights:BASE,threshold:60,stopPct:8,takePct:16,maxHoldMin:30};
  return [parent,...Array.from({length:Math.max(0,count-1)},(_,i)=>mutate(parent,TEST_LANES[i%TEST_LANES.length],r))];
}

async function measure(fn){
  let rssPeak=process.memoryUsage().rss;
  const sampler=setInterval(()=>{const r=process.memoryUsage().rss;if(r>rssPeak)rssPeak=r},25);
  const cpu0=process.cpuUsage(),t0=performance.now();
  let value;
  try{value=await fn()}finally{clearInterval(sampler)}
  const wallMs=performance.now()-t0,cpu=process.cpuUsage(cpu0);
  const cpuMs=(cpu.user+cpu.system)/1000;
  const mem=process.memoryUsage();
  if(mem.rss>rssPeak)rssPeak=mem.rss;
  return {value,wallMs,cpuMs,cpuCoresBusy:cpuMs/wallMs,cpuUtilPct:cpuMs/wallMs/CORES*100,
    rssPeakMB:rssPeak/1048576,heapUsedMB:mem.heapUsed/1048576};
}

async function runFast(rows,variants){
  const pool=getPool();
  pool.resize(WORKERS);
  const ds=packDataset(rows);
  return pool.score(variants,ds,{rounds:WORKERS<=1?MC_ROUNDS_MAIN:MC_ROUNDS_WORKER});
}
const runLegacy=(rows,variants)=>scoreInWorkersLegacy(variants,rows,()=>{});
// Single-threaded A/B that isolates the scorer itself (no pool, no transport, no spawns):
// legacy object rows + per-variant fold sort vs the packed Float64Array dataset.
const runScorerLegacy=(rows,variants)=>variants.map(v=>({variant:v,metrics:scoreVariant(v,rows,{rounds:MC_ROUNDS_WORKER})}));
const runScorerPacked=(rows,variants)=>{const ds=packDataset(rows,{shared:false});return variants.map(v=>({variant:v,metrics:scoreVariantPacked(v,ds,{rounds:MC_ROUNDS_WORKER})}))};
const RUNNERS={fast:runFast,legacy:runLegacy,'scorer-legacy':runScorerLegacy,'scorer-packed':runScorerPacked};

async function benchMode(mode,rows,variants){
  const run=RUNNERS[mode];
  const warm=await measure(()=>run(rows,variants));
  const scoredOk=(warm.value||[]).filter(x=>x&&x.metrics).length;
  const gens=[];
  for(let g=1;g<=GENERATIONS;g++){
    const m=await measure(()=>run(rows,variants));
    gens.push({generation:g,wallMs:+m.wallMs.toFixed(1),variantsPerSec:+(variants.length/(m.wallMs/1000)).toFixed(1),
      cpuUtilPct:+m.cpuUtilPct.toFixed(1),cpuCoresBusy:+m.cpuCoresBusy.toFixed(2),
      rssPeakMB:+m.rssPeakMB.toFixed(1),heapUsedMB:+m.heapUsedMB.toFixed(1)});
  }
  const avg=k=>gens.reduce((q,x)=>q+x[k],0)/gens.length;
  return {mode,workers:mode.startsWith('scorer')?1:WORKERS,variants:variants.length,warmupMs:+warm.wallMs.toFixed(1),scoredVariants:scoredOk,generations:gens,
    summary:{wallMs:+avg('wallMs').toFixed(1),variantsPerSec:+avg('variantsPerSec').toFixed(1),
      cpuUtilPct:+avg('cpuUtilPct').toFixed(1),cpuCoresBusy:+avg('cpuCoresBusy').toFixed(2),
      rssPeakMB:+Math.max(...gens.map(x=>x.rssPeakMB)).toFixed(1),heapUsedMB:+avg('heapUsedMB').toFixed(1)}};
}

const pad=(s,n)=>String(s).padStart(n);
function printTable(results){
  console.log(`${pad('mode',14)} ${pad('gen',4)} ${pad('wallMs',10)} ${pad('variants/s',11)} ${pad('cpuUtil%',9)} ${pad('cores',6)} ${pad('rssPeakMB',10)} ${pad('heapMB',8)}`);
  for(const r of results)for(const g of r.generations)
    console.log(`${pad(r.mode,14)} ${pad(g.generation,4)} ${pad(g.wallMs,10)} ${pad(g.variantsPerSec,11)} ${pad(g.cpuUtilPct,9)} ${pad(g.cpuCoresBusy,6)} ${pad(g.rssPeakMB,10)} ${pad(g.heapUsedMB,8)}`);
}

const rows=syntheticRows(ROWS,SEED);
const variants=syntheticVariants(VARIANTS,SEED+1);
const SCORER_VARIANTS=Math.floor(num('scorer-variants',Math.min(variants.length,256)));
const modes=MODE==='both'?['legacy','fast']:MODE==='scorer'?['scorer-legacy','scorer-packed']:MODE==='all'?['legacy','fast','scorer-legacy','scorer-packed']:[MODE];
const variantsFor=mode=>mode.startsWith('scorer')?variants.slice(0,SCORER_VARIANTS):variants;

console.log(`MONEY PRINTER OS // EVOLUTION THROUGHPUT BENCH`);
console.log(`host ${os.cpus().length} cores, ${(os.totalmem()/1073741824).toFixed(1)} GB RAM, node ${process.version}`);
console.log(`rows=${ROWS} variants=${variants.length} generations=${GENERATIONS} workers=${WORKERS} (requested ${WORKERS_REQUESTED}) seed=${SEED}`);
console.log('');

const results=[];
for(const mode of modes)results.push(await benchMode(mode,rows,variantsFor(mode)));
printTable(results);
console.log('');
for(const r of results)console.log(`SUMMARY ${r.mode.padEnd(13)} wall ${r.summary.wallMs} ms · ${r.summary.variantsPerSec} variants/sec · cpuUtil ${r.summary.cpuUtilPct}% (${r.summary.cpuCoresBusy} cores busy) · rssPeak ${r.summary.rssPeakMB} MB · heap ${r.summary.heapUsedMB} MB · workers ${r.workers}`);
const fast=results.find(r=>r.mode==='fast'),legacy=results.find(r=>r.mode==='legacy');
const speedup=fast&&legacy?{throughputX:+(fast.summary.variantsPerSec/legacy.summary.variantsPerSec).toFixed(2),
  wallX:+(fast.summary.wallMs/legacy.summary.wallMs).toFixed(2),rssX:+(fast.summary.rssPeakMB/legacy.summary.rssPeakMB).toFixed(2)}:null;
if(speedup)console.log(`SPEEDUP fast vs legacy: ${speedup.throughputX}x throughput · ${speedup.wallX}x wall time · ${speedup.rssX}x peak RSS`);
const sl=results.find(r=>r.mode==='scorer-legacy'),sp=results.find(r=>r.mode==='scorer-packed');
const scorerSpeedup=sl&&sp?+(sp.summary.variantsPerSec/sl.summary.variantsPerSec).toFixed(2):null;
if(scorerSpeedup)console.log(`SPEEDUP packed vs legacy scorer (single thread, ${sp.variants} variants): ${scorerSpeedup}x throughput`);

const blob={host:{cores:CORES,totalMemGB:+(os.totalmem()/1073741824).toFixed(1),node:process.version},
  config:{rows:ROWS,variants:variants.length,generations:GENERATIONS,workers:WORKERS,workersRequested:WORKERS_REQUESTED,seed:SEED,chunk:process.env.EVOLUTION_CHUNK||null},
  results,speedup,scorerSpeedup,at:new Date().toISOString()};
if(args.json)console.log(JSON.stringify(blob,null,2));
if(args.out){fs.writeFileSync(path.resolve(String(args.out)),JSON.stringify(blob,null,2));console.log(`wrote ${path.resolve(String(args.out))}`)}

await closePool();
try{fs.rmSync(benchDir,{recursive:true,force:true})}catch{}
