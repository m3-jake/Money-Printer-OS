// Single source of truth for evolution scoring.
//
// The "legacy" section below is the original object-row scorer moved verbatim out of
// src/evolutionLoop.js. The only permitted edits were threading `rounds`/`rng` through
// bootstrapPass()/scoreVariant() instead of the hard-coded 120/Math.random, so tests and
// workers can pin a deterministic RNG stream. Production still passes Math.random.
//
// The packed section scores the same dataset from flat Float64Arrays (SharedArrayBuffer
// backed) so worker threads never receive a cloned copy of the row objects. It is exact:
// same coercions, same accumulation order, same selection order, and it shares the
// summarizeSelected()/aggregateWalk() helpers with the legacy path so the two cannot drift.

export const FEATURES=['edge','explosion','execution','momentum','liquidity','freshness','flow','volumeAccel','priceAccel'];
export const BASE={edge:.28,explosion:.20,execution:.16,momentum:.10,liquidity:.08,freshness:.04,flow:.06,volumeAccel:.04,priceAccel:.04};
// Pre-existing per-path constants, preserved rather than unified.
export const MC_ROUNDS_WORKER=90;
export const MC_ROUNDS_MAIN=120;

// Deterministic RNG for tests/benchmarks only; production scoring keeps Math.random.
export function mulberry32(seed){
  let a=seed>>>0;
  return function(){
    a=(a+0x6D2B79F5)>>>0;
    let t=a;
    t=Math.imul(t^(t>>>15),t|1);
    t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}

const mean=a=>a.length?a.reduce((q,x)=>q+Number(x||0),0)/a.length:0;
const median=a=>{if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b);const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
const std=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))};

export function modelScore(v,f={}){return FEATURES.reduce((q,k)=>q+Number(v.weights[k]||0)*Number(f[k]||0),0)*100}
export function executionAdjusted(ret, stress=0){
  // Outcomes are observed price returns. Stress deliberately removes optimistic edge.
  const friction = 0.35 + stress*1.45; // percent round-trip penalty
  const slip = stress * Math.max(0, Math.min(4, Math.abs(ret)*.045));
  return Math.max(-100, Number(ret||0)-friction-slip);
}

// Tail of the original metrics(): everything after the row loop. Shared by both paths.
export function summarizeSelected(v, selected, rowCount){
  const n=selected.length, avg=mean(selected), med=median(selected), win=n?selected.filter(x=>x>0).length/n*100:0;
  const downside=selected.filter(x=>x<0), draw=downside.length?Math.min(...downside):0;
  const velocity=n ? avg/Math.max(1,v.maxHoldMin) : -99;
  const sharpe=n>2 ? avg/(std(selected)||99)*Math.sqrt(n) : -9;
  const activityPct=rowCount ? n/rowCount*100 : 0;
  let wallet=1,peak=1,maxDrawdownPct=0;
  for(const r of selected){wallet*=Math.max(.01,1+r/100);peak=Math.max(peak,wallet);maxDrawdownPct=Math.min(maxDrawdownPct,(wallet/peak-1)*100)}
  const geometricMeanPct=n?(Math.pow(wallet,1/n)-1)*100:0;
  return {n,avg,median:med,winPct:win,worstPct:draw,velocity,sharpe,activityPct,geometricMeanPct,compoundedMultiple:wallet,maxDrawdownPct,returns:selected};
}

export function metrics(v, rows, stress=0){
  const selected=[];
  for(const r of rows){
    const score=modelScore(v,r.features||{});
    if(score < v.threshold) continue;
    let ret=executionAdjusted(r.returnPct,stress);
    // Coarse exit envelope so variants can explore faster profit vs downside.
    ret=Math.max(-v.stopPct,Math.min(v.takePct,ret));
    selected.push(ret);
  }
  return summarizeSelected(v, selected, rows.length);
}

export function folds(rows, n=4){
  const x=[...rows].sort((a,b)=>Number(a.ts)-Number(b.ts)),size=Math.floor(x.length/(n+1));
  const out=[]; if(size<15)return out;
  for(let i=1;i<=n;i++){const train=x.slice(0,size*i),test=x.slice(size*i,size*(i+1));if(test.length)out.push({train,test})}
  return out;
}

export function bootstrapPass(returns, rounds=MC_ROUNDS_MAIN, rng=Math.random){
  if(returns.length<12)return 0;
  let positive=0;
  for(let i=0;i<rounds;i++){let s=0;for(let j=0;j<returns.length;j++)s+=returns[Math.floor(rng()*returns.length)];if(s/returns.length>0)positive++}
  return positive/rounds*100;
}

// Tail of the original scoreVariant(): everything after the per-fold metrics. Shared by both paths.
export function aggregateWalk(walk, stress, {rounds=MC_ROUNDS_MAIN, rng=Math.random}={}){
  const held=walk.at(-1);
  const enough=walk.every(m=>m.n>=8);
  const consistency=walk.filter(m=>m.avg>0).length/walk.length;
  const avg=mean(walk.map(m=>m.avg)),velocity=mean(walk.map(m=>m.velocity));
  const activityPct=mean(walk.map(m=>m.activityPct));
  const geometricMeanPct=mean(walk.map(m=>m.geometricMeanPct));
  const compoundedMultiple=median(walk.map(m=>m.compoundedMultiple));
  const maxDrawdownPct=Math.min(...walk.map(m=>m.maxDrawdownPct));
  const totalSamples=walk.reduce((q,m)=>q+m.n,0);
  const mc=bootstrapPass(walk.flatMap(m=>m.returns), rounds, rng);
  // Explicit inactivity penalty: low-selectivity can be good, inactivity cannot win by merely avoiding drawdown.
  const inactivityPenalty=Math.max(0,10-activityPct)*2.2 + Math.max(0,32-totalSamples)*.65;
  const robust = avg*0.45 + geometricMeanPct*1.5 + velocity*30 + consistency*8 + Math.min(10,mc/10) + Math.max(-12,stress.avg*.30)
    + Math.min(8,activityPct*.35) + Math.max(-8,maxDrawdownPct*.06) - inactivityPenalty - (enough?0:18) - Math.max(0,-held.avg)*.30;
  return {robustScore:robust,walkAvgPct:avg,geometricMeanPct,compoundedMultiple,maxDrawdownPct,profitVelocityPctPerMin:velocity,consistencyPct:consistency*100,
    activityPct,inactivityPenalty,heldOutAvgPct:held.avg,heldOutN:held.n,stressAvgPct:stress.avg,monteCarloPassPct:mc,
    worstPct:Math.min(...walk.map(m=>m.worstPct)),samples:totalSamples};
}

export function scoreVariant(v, rows, {rounds=MC_ROUNDS_MAIN, rng=Math.random}={}){
  const fs=folds(rows,4); if(!fs.length)return null;
  const walk=fs.map(f=>metrics(v,f.test,.2));
  const stress=metrics(v,fs.at(-1).test,.85);
  return aggregateWalk(walk, stress, {rounds, rng});
}

// ---------------------------------------------------------------------------
// Packed dataset (fast path)
// ---------------------------------------------------------------------------

let packCounter=0;

export function packDataset(rows, {folds:nFolds=4, shared=true}={}){
  // Identical comparator to folds(); V8's sort is stable so already-sorted input (including
  // duplicate ts) keeps its original order, exactly like the legacy path.
  const sorted=[...rows].sort((a,b)=>Number(a.ts)-Number(b.ts));
  const n=sorted.length;
  const featureBytes=n*9*8, returnBytes=n*8;
  const features=new Float64Array(shared?new SharedArrayBuffer(featureBytes):new ArrayBuffer(featureBytes));
  const returns=new Float64Array(shared?new SharedArrayBuffer(returnBytes):new ArrayBuffer(returnBytes));
  for(let i=0;i<n;i++){
    const row=sorted[i], f=row.features||{}, base=i*9;
    // Exactly modelScore's coercion: Number(f[k] || 0).
    for(let k=0;k<9;k++) features[base+k]=Number(f[FEATURES[k]] || 0);
    // NOT ||0: executionAdjusted applies its own Number(ret||0) and Math.abs(ret), and
    // Math.abs/ToNumber make Number(returnPct) indistinguishable from the raw value there.
    returns[i]=Number(row.returnPct);
  }
  const size=Math.floor(n/(nFolds+1));
  const ranges=[];
  if(size>=15){
    for(let i=1;i<=nFolds;i++){
      const start=size*i, end=Math.min(n,size*(i+1));
      if(end>start) ranges.push({start,end});
    }
  }
  return {id:`${n}:${Date.now().toString(36)}:${packCounter++}`, n, features, returns, folds:ranges, sorted};
}

export function scoreVariantPacked(v, ds, {rounds=MC_ROUNDS_WORKER, rng=Math.random}={}){
  const ranges=ds.folds;
  if(!ranges.length) return null;
  const w=new Float64Array(9);
  for(let k=0;k<9;k++) w[k]=Number(v.weights[FEATURES[k]]||0);
  const features=ds.features, returns=ds.returns;
  const threshold=v.threshold, stopPct=v.stopPct, takePct=v.takePct;
  const last=ranges.length-1;
  const walk=new Array(ranges.length);
  let hits=null, hitRange=null;
  for(let fi=0; fi<ranges.length; fi++){
    const start=ranges[fi].start, end=ranges[fi].end;
    const selected=[];
    const keep=fi===last?[]:null;
    for(let i=start;i<end;i++){
      const b=i*9;
      let q=0;
      for(let k=0;k<9;k++) q+=w[k]*features[b+k];
      if(q*100 < threshold) continue;
      let ret=executionAdjusted(returns[i], .2);
      ret=Math.max(-stopPct,Math.min(takePct,ret));
      selected.push(ret);
      if(keep) keep.push(i);
    }
    walk[fi]=summarizeSelected(v, selected, end-start);
    if(keep){hits=keep;hitRange=ranges[fi]}
  }
  // The selection test does not depend on stress, so the stress pass reuses the last fold's
  // selected row indices; `selected` stays in row order, identical to a full rescan.
  const stressSelected=[];
  for(let h=0;h<hits.length;h++){
    const i=hits[h];
    let ret=executionAdjusted(returns[i], .85);
    ret=Math.max(-stopPct,Math.min(takePct,ret));
    stressSelected.push(ret);
  }
  const stress=summarizeSelected(v, stressSelected, hitRange.end-hitRange.start);
  return aggregateWalk(walk, stress, {rounds, rng});
}

// SharedArrayBuffer views are shared by reference through postMessage; `sorted` (the row
// objects) is deliberately dropped so worker messages never clone the dataset.
export function datasetToMessage(ds){
  return {id:ds.id, n:ds.n, features:ds.features, returns:ds.returns, folds:ds.folds};
}

export function datasetFromMessage(m){
  return {
    id:m.id, n:m.n,
    features:m.features instanceof Float64Array?m.features:new Float64Array(m.features),
    returns:m.returns instanceof Float64Array?m.returns:new Float64Array(m.returns),
    folds:m.folds||[], sorted:null,
  };
}
