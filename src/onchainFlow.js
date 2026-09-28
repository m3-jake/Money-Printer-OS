const cache = new Map();
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
