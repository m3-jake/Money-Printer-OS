const cache = new Map();
import { alphaDb } from './alphaDb.js';
export const FLOW_CACHE_MS = 60_000;
const num = x => Number.isFinite(Number(x)) ? Number(x) : 0;

export function deriveFlowSignals(rows = [], { windowMs = 60 * 60_000, now = Date.now(), whaleSol = 10 } = {}) {
  const cutoff = now - windowMs, recent = (Array.isArray(rows) ? rows : []).filter(x => Number(x.ts) >= cutoff && Number(x.ts) <= now);
  const mints = new Map();
  for (const x of recent) {
    const asset = String(x.asset || x.symbol || x.mint || 'SOL'), flow = mints.get(asset) || { asset, inflowSol: 0, outflowSol: 0, netflowSol: 0, whaleBuysSol: 0, whaleSellsSol: 0, events: 0 };
    const amount = Math.abs(num(x.amountSol ?? x.solDelta));
    if (x.side === 'BUY' || x.direction === 'INFLOW') flow.inflowSol += amount;
    if (x.side === 'SELL' || x.direction === 'OUTFLOW') flow.outflowSol += amount;
    if (x.side === 'BUY' && amount >= whaleSol) flow.whaleBuysSol += amount;
    if (x.side === 'SELL' && amount >= whaleSol) flow.whaleSellsSol += amount;
    flow.netflowSol = flow.inflowSol - flow.outflowSol; flow.events++; mints.set(asset, flow);
  }
  return [...mints.values()].map(x => ({ ...x, signals: [
    ...(x.netflowSol > 0 ? [{ source: 'onchain:netflow', bias: 'BEARISH', strength: x.netflowSol }] : x.netflowSol < 0 ? [{ source: 'onchain:netflow', bias: 'BULLISH', strength: -x.netflowSol }] : []),
    ...(x.whaleBuysSol > x.whaleSellsSol ? [{ source: 'onchain:whale', bias: 'BULLISH', strength: x.whaleBuysSol - x.whaleSellsSol }] : x.whaleSellsSol > x.whaleBuysSol ? [{ source: 'onchain:whale', bias: 'BEARISH', strength: x.whaleSellsSol - x.whaleBuysSol }] : []),
  ] }));
}

export async function cachedFlowSnapshot(key, loader, { now = Date.now(), ttlMs = FLOW_CACHE_MS } = {}) {
  const hit = cache.get(String(key)); if (hit && now - hit.at < ttlMs) return { ...hit, cached: true };
  const value = await loader(); const result = { at: now, value, cached: false }; cache.set(String(key), result);
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= ttlMs) cache.delete(k);
  return result;
}

export function clearFlowCache() { cache.clear(); }

export function readIndexedFlowRows({now=Date.now(),windowMs=60*60_000,maxRows=5000,db=alphaDb()}={}){
  const rows=db.prepare('SELECT ts,mint,side,sol_delta solDelta FROM tx_events WHERE ts>=? AND ts<=? ORDER BY ts DESC LIMIT ?').all(now-windowMs,now,Math.max(1,Math.min(20000,Math.floor(maxRows))));
  const out=[];
  for(const row of rows){
    const amount=Math.abs(Number(row.solDelta)||0);if(!amount)continue;
    out.push({ts:Number(row.ts),asset:String(row.mint||'unknown'),side:String(row.side||'').toUpperCase(),amountSol:amount,source:row.source||'indexed-solana-swap'});
    out.push({ts:Number(row.ts),asset:'SOL',side:Number(row.solDelta)<0?'SELL':'BUY',direction:Number(row.solDelta)<0?'OUTFLOW':'INFLOW',amountSol:amount,source:row.source||'indexed-solana-swap'});
  }
  return out;
}

export async function indexedFlowSnapshot({now=Date.now(),windowMs=60*60_000,maxRows=5000,loader=readIndexedFlowRows,whaleSol=10,ttlMs=FLOW_CACHE_MS}={}){
  return cachedFlowSnapshot('indexed-solana-flow',async()=>deriveFlowSignals(await loader({now,windowMs,maxRows}),{windowMs,now,whaleSol}),{now,ttlMs});
}
