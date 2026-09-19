#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BASE, FEATURES, MC_ROUNDS_WORKER, mulberry32, packDataset, scoreVariant, scoreVariantPacked } from '../src/evolutionScoring.js';
import { mutate } from '../src/evolutionEngine.js';
import { TEST_LANES } from '../src/resourcePolicy.js';
import { buildGpuFixture } from '../src/gpuFurnaceContract.js';

const out=path.resolve(process.argv[2]||'/Users/bing/Dropbox/MPO-BEAST-same-corpus.json');
const report=path.resolve(process.argv[3]||'/Users/bing/Dropbox/MPO-BEAST-same-corpus-mac-report.json');
const ROWS=3000, VARIANTS=2048, SEED=424242, ROUNDS=MC_ROUNDS_WORKER;
function rows(n,seed){const r=mulberry32(seed),xs=[];let ts=1_780_000_000_000;for(let i=0;i<n;i++){ts+=60_000;const f={};for(const k of FEATURES)f[k]=r();const u=r(),ret=u<.62?r()*24-18:u<.93?r()*60-20:r()*250-40;xs.push({ts,horizonMin:5,returnPct:Math.max(-70,Math.min(250,ret)),features:f})}return xs}
function variants(n,seed){const r=mulberry32(seed),p={id:'BASE',weights:BASE,threshold:60,stopPct:8,takePct:16,maxHoldMin:30};return[p,...Array.from({length:n-1},(_,i)=>mutate(p,TEST_LANES[i%TEST_LANES.length],r))]}
function deterministic(m){return m?{...m,robustScoreDeterministic:m.robustScore-Math.min(10,m.monteCarloPassPct/10)}:null}
const rs=rows(ROWS,SEED),vs=variants(VARIANTS,SEED+1),ds=packDataset(rs,{shared:false});
let t=performance.now();
const legacy=vs.map((v,i)=>deterministic(scoreVariant(v,rs,{rounds:ROUNDS,rng:mulberry32(SEED+i)})));
const legacyMs=performance.now()-t;
t=performance.now();
const packed=vs.map((v,i)=>deterministic(scoreVariantPacked(v,ds,{rounds:ROUNDS,rng:mulberry32(SEED+i)})));
const packedMs=performance.now()-t;
let maxAbs=0,mismatch=0;
const keys=['walkAvgPct','geometricMeanPct','compoundedMultiple','maxDrawdownPct','profitVelocityPctPerMin','consistencyPct','activityPct','inactivityPenalty','heldOutAvgPct','heldOutN','stressAvgPct','worstPct','samples','robustScoreDeterministic'];
for(let i=0;i<vs.length;i++){for(const k of keys){const a=Number(legacy[i]?.[k]),b=Number(packed[i]?.[k]),e=Math.abs(a-b);if(e>maxAbs)maxAbs=e;if(e>1e-9)mismatch++}}
const rank=x=>vs.map((v,i)=>({id:v.id,s:Number(x[i]?.robustScoreDeterministic??-Infinity)})).sort((a,b)=>b.s-a.s).map(x=>x.id);
const lr=rank(legacy),pr=rank(packed);
const fixture=buildGpuFixture({rows:rs,variants:vs,seed:SEED,bootstrapRounds:ROUNDS,source:'beast-same-corpus'});
fixture.cpu={metrics:legacy,node:process.version,timing:{legacyMs,packedMs},ranking:lr};
fs.writeFileSync(out,JSON.stringify(fixture));
fs.writeFileSync(report,JSON.stringify({schema:'mpo.beast.same-corpus.mac.v1',rows:ROWS,variants:VARIANTS,rounds:ROUNDS,seed:SEED,legacyMs,packedMs,legacyVps:VARIANTS/(legacyMs/1000),packedVps:VARIANTS/(packedMs/1000),speedup:legacyMs/packedMs,maxAbs,mismatch,rankingExact:JSON.stringify(lr)===JSON.stringify(pr),top10:lr.slice(0,10)},null,2));
console.log(fs.readFileSync(report,'utf8'));
console.error(`fixture ${out}`);