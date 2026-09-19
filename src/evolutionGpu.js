// Opt-in GPU research scorer. Dense ranking may use the sidecar; promotion always
// uses CPU-rescored finalists. Any sidecar/parity failure falls back to CPU.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, MC_ROUNDS_MAIN, MC_ROUNDS_WORKER, packDataset, scoreVariantPacked, mulberry32 } from './evolutionScoring.js';
import { buildGpuFixture, deterministicParity, deterministicRobustScore, SCORES_SCHEMA } from './gpuFurnaceContract.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SIDECAR = path.join(REPO, 'research', 'gpu-furnace', 'sidecar.py');

let probeCache = null;
let gpuServer = null;
let gpuRequestSeq = 0;

export function resetGpuProbe() { probeCache = null; }
export async function closeGpuSidecar(){
  const s=gpuServer; gpuServer=null; probeCache=null;
  if(!s)return;
  for(const p of s.pending.values())p.resolve({ok:false,reason:'sidecar-closed'});
  s.pending.clear();
  try{s.child.stdin.end()}catch{}
  try{s.child.kill()}catch{}
}

export function sidecarPath() {
  return process.env.MPO_GPU_SIDECAR || DEFAULT_SIDECAR;
}

function pythonBin() {
  return process.env.MPO_GPU_PYTHON || process.env.PYTHON || 'python3';
}

function runProcess(bin, args, { input = '', timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, code: null, stdout, stderr: stderr || 'timeout', timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(err.message || err), timedOut: false });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, timedOut: false });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function ensureGpuServer({ timeoutMs = 120000 } = {}) {
  if (gpuServer?.ready) return gpuServer;
  const script = sidecarPath();
  if (!fs.existsSync(script)) return null;
  const child = spawn(pythonBin(), [script, '--server'], { env: process.env, stdio: ['pipe','pipe','pipe'] });
  const state = { child, pending:new Map(), buffer:'', stderr:'', ready:false, info:null };
  gpuServer = state;
  const ready = new Promise(resolve => {
    const timer=setTimeout(()=>resolve(null),timeoutMs);
    const finish=x=>{clearTimeout(timer);resolve(x)};
    child.stdout.on('data',d=>{
      state.buffer+=d.toString();
      for(;;){
        const i=state.buffer.indexOf('\n'); if(i<0)break;
        const line=state.buffer.slice(0,i).trim(); state.buffer=state.buffer.slice(i+1); if(!line)continue;
        let msg; try{msg=JSON.parse(line)}catch{continue}
        if(msg.schema==='mpo.gpu-furnace.server.v1'&&msg.ready){state.ready=true;state.info=msg;probeCache={ok:true,available:true,...msg};finish(state);continue}
        const p=state.pending.get(String(msg.requestId)); if(p){state.pending.delete(String(msg.requestId));clearTimeout(p.timer);p.resolve(msg)}
      }
    });
    child.stderr.on('data',d=>{state.stderr=(state.stderr+d.toString()).slice(-1000)});
    const dead=()=>{if(gpuServer===state)gpuServer=null;for(const p of state.pending.values()){clearTimeout(p.timer);p.resolve({ok:false,reason:'sidecar-exited',stderr:state.stderr})}state.pending.clear();finish(null)};
    child.on('error',dead); child.on('close',dead);
  });
  return await ready;
}

export async function probeGpu({ timeoutMs = 8000 } = {}) {
  if (probeCache?.available) return probeCache;
  if (probeCache && !probeCache.available) probeCache=null;
  const started=Date.now(),s=await ensureGpuServer({timeoutMs});
  if(!s){probeCache={ok:false,available:false,reason:'gpu-server-unavailable',probeMs:Date.now()-started};return probeCache}
  probeCache={ok:true,available:true,probeMs:Date.now()-started,...s.info};
  return probeCache;
}

export async function invokeGpuSidecar(fixture, { timeoutMs = 120000, vramMb = 2048, device = 'auto', dtype = 'float64', seed = 1 } = {}) {
  const s=await ensureGpuServer({timeoutMs});
  if(!s)return {ok:false,reason:'gpu-server-unavailable'};
  const requestId=String(++gpuRequestSeq);
  const response=new Promise(resolve=>{
    const timer=setTimeout(()=>{s.pending.delete(requestId);resolve({ok:false,reason:'sidecar-timeout'})},timeoutMs);
    s.pending.set(requestId,{resolve,timer});
  });
  try{s.child.stdin.write(JSON.stringify({requestId,fixture,opts:{vramMb,device,dtype,seed}})+'\n')}catch(e){s.pending.delete(requestId);return {ok:false,reason:`sidecar-write:${e.message||e}`}}
  const parsed=await response;
  if(!parsed?.ok)return {ok:false,reason:parsed?.reason||'sidecar-failed',stderr:parsed?.stderr||parsed?.error};
  if(parsed.schema!==SCORES_SCHEMA)return {ok:false,reason:'unexpected-schema'};
  if(!Array.isArray(parsed.metrics)||parsed.metrics.length!==fixture.variants.length)return {ok:false,reason:'metrics-length-mismatch'};
  return {ok:true,result:parsed};
}

function cpuMetricsFor(variant, ds, { rounds, seed, index }) {
  const rng = seed == null ? Math.random : mulberry32((seed + index) >>> 0);
  return scoreVariantPacked(variant, ds, { rounds, rng });
}

export function finalistSelection(scored, { finalists = 12, parentId = null } = {}) {
  const ranked = scored
    .map((entry, index) => ({ ...entry, index, det: deterministicRobustScore(entry.metrics) }))
    .filter(x => x.metrics && Number.isFinite(x.det))
    .sort((a, b) => b.det - a.det);
  if (!ranked.length) return { indices: [], deterministicFloor: null, reason: 'missing-deterministic-score' };
  const floor = ranked[0].det - 10;
  const keep = new Set(ranked.filter(x => x.det >= floor).map(x => x.index));
  for (const x of ranked.slice(0, Math.max(4, finalists))) keep.add(x.index);
  if (parentId) {
    const inc = scored.findIndex(x => x.variant?.id === parentId);
    if (inc >= 0) keep.add(inc);
  }
  return { indices: [...keep].sort((a,b)=>a-b), deterministicFloor: floor };
}

export function rescoreFinalistsCpu(scored, dataset, { finalists = 12, rounds = MC_ROUNDS_WORKER, seed = null, parentId = null } = {}) {
  const selected = finalistSelection(scored, { finalists, parentId });
  if (!selected.indices.length) return { scored: [], rescored: 0, recomputeRate: 1, reason: selected.reason || 'missing-deterministic-score' };
  const keep = new Set(selected.indices);
  const out = scored.map((entry, index) => {
    if (!keep.has(index)) return { variant: entry.variant, metrics: null, source: 'gpu-screened', gpuMetrics: entry.metrics };
    return { variant: entry.variant, metrics: cpuMetricsFor(entry.variant, dataset, { rounds, seed, index }), source: 'cpu-finalist', gpuMetrics: entry.metrics };
  });
  return { scored: out, rescored: keep.size, recomputeRate: scored.length ? keep.size / scored.length : 0, deterministicFloor: selected.deterministicFloor };
}
export async function scoreBeastGpu(variants, rows, {
  onProgress = () => {},
  dataset = null,
  beast = {},
  sidecar = invokeGpuSidecar,
  seed = 1,
  cpuSeed = null,
  cpuRescore = null,
  parentId = null,
} = {}) {
  const list = Array.from(variants || []);
  const started = Date.now();
  const probe = sidecar === invokeGpuSidecar
    ? await probeGpu({ timeoutMs: Math.min(8000, beast.gpuTimeoutMs || 8000) })
    : {ok:true,available:true,cuda:true,device:'mock',deviceName:'mock'};
  if (sidecar === invokeGpuSidecar && !probe.available) {
    return { ok: false, reason: probe.reason || 'gpu-unavailable', probe, fallback: 'cpu', wallMs: Date.now() - started };
  }
  const cudaReady=probe.cuda===true||probe.cudaAvailable===true||probe.device==='cuda';
  if (sidecar === invokeGpuSidecar && (beast.gpuDevice || 'auto') === 'auto' && !cudaReady) {
    return { ok: false, reason: 'cuda-unavailable', probe, fallback: 'cpu', wallMs: Date.now() - started };
  }
  const ds = dataset || packDataset(rows);
  const rounds = Number(beast.gpuRounds || (Number(beast.workers || 2) <= 1 ? MC_ROUNDS_MAIN : MC_ROUNDS_WORKER));
  const fixture = buildGpuFixture({ rows, variants: list, seed, bootstrapRounds: rounds, source: 'beast-gpu' });
  const sidecarStarted = Date.now();
  const invoked = await sidecar(fixture, {
    timeoutMs: beast.gpuTimeoutMs || 120000,
    vramMb: beast.gpuVramMb || 2048,
    device: beast.gpuDevice || 'auto',
    dtype: beast.gpuDtype || 'float64',
    seed,
  });
  const sidecarMs = Date.now() - sidecarStarted;
  if (!invoked.ok) return { ok: false, reason: invoked.reason || 'sidecar-failed', probe, sidecarMs, fallback: 'cpu', wallMs: Date.now() - started };

  const gpuScored = list.map((variant, i) => ({ variant, metrics: invoked.result.metrics[i], source: 'gpu' }));
  const sampleN = Math.min(list.length, Math.max(2, Number(beast.gpuParitySample || 8)));
  const mismatches = [];
  let maxAbs = 0;
  for (let i = 0; i < sampleN; i++) {
    const cpu = cpuMetricsFor(list[i], ds, { rounds, seed, index: i });
    const parity = deterministicParity(cpu, gpuScored[i].metrics);
    if (parity.maxAbs > maxAbs) maxAbs = parity.maxAbs;
    if (!parity.ok) mismatches.push({ id: list[i].id, keys: parity.mismatches, maxAbs: parity.maxAbs });
  }
  if (mismatches.length) {
    return {
      ok: false, reason: 'parity-failure', probe, sidecarMs, maxAbs, mismatches: mismatches.slice(0, 8),
      fallback: 'cpu', wallMs: Date.now() - started,
    };
  }

  const incumbentId = parentId || list.find(v => v?.id === 'BASE')?.id || list[0]?.id;
  let rescored;
  if (typeof cpuRescore === 'function') {
    const selected = finalistSelection(gpuScored, { finalists: beast.gpuFinalists || 12, parentId: incumbentId });
    if (!selected.indices.length) return { ok: false, reason: selected.reason || 'cpu-rescore-empty', probe, sidecarMs, fallback: 'cpu', wallMs: Date.now() - started };
    const finalistVariants = selected.indices.map(i => list[i]);
    let cpuRows;
    try { cpuRows = await cpuRescore(finalistVariants, ds, { rounds, seed: cpuSeed }); }
    catch (e) { return { ok:false, reason:`cpu-rescore:${e?.message||e}`, probe, sidecarMs, fallback:'cpu', wallMs:Date.now()-started }; }
    if (!Array.isArray(cpuRows) || cpuRows.length !== finalistVariants.length) return { ok:false, reason:'cpu-rescore-length', probe, sidecarMs, fallback:'cpu', wallMs:Date.now()-started };
    const byIndex = new Map(selected.indices.map((idx,j)=>[idx,cpuRows[j]?.metrics??null]));
    const keep = new Set(selected.indices);
    const out = gpuScored.map((entry,index)=>keep.has(index)
      ? {variant:entry.variant,metrics:byIndex.get(index),source:'cpu-finalist',gpuMetrics:entry.metrics}
      : {variant:entry.variant,metrics:null,source:'gpu-screened',gpuMetrics:entry.metrics});
    rescored={scored:out,rescored:selected.indices.length,recomputeRate:selected.indices.length/list.length,deterministicFloor:selected.deterministicFloor};
  } else {
    rescored = rescoreFinalistsCpu(gpuScored, ds, { finalists: beast.gpuFinalists || 12, rounds, seed: cpuSeed, parentId: incumbentId });
  }
  if (!rescored.scored.length || rescored.reason) {
    return { ok: false, reason: rescored.reason || 'cpu-rescore-empty', probe, sidecarMs, fallback: 'cpu', wallMs: Date.now() - started };
  }
  onProgress({ completed: list.length, total: list.length, workers: 0, gpu: true, device: invoked.result.device || probe.device });
  return {
    ok: true,
    scored: rescored.scored,
    probe,
    sidecarMs,
    peakMemoryMb: invoked.result.peakMemoryMb ?? null,
    device: invoked.result.device || probe.device || null,
    deviceName: invoked.result.deviceName || probe.deviceName || null,
    dtype: invoked.result.dtype || beast.gpuDtype || 'float64',
    vramBudgetMb: invoked.result.vramBudgetMb || beast.gpuVramMb || 2048,
    chunkVariants: invoked.result.chunkVariants ?? null,
    recomputeRate: rescored.recomputeRate,
    rescored: rescored.rescored,
    parityMaxAbs: maxAbs,
    wallMs: Date.now() - started,
    fallback: null,
  };
}

export const GPU_FEATURE_ORDER = FEATURES;
