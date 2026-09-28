// Executable-price tape for Solana (self-improving loop plan, batch F item 5). Paper fills are simulated
// from marks, so nothing yet says what a round trip would really cost. This samples Jupiter's public quote
// API for open positions and the top watchlist tokens: a fixed-notional buy (SOL -> token) and the matching
// sell of that exact output (token -> SOL). Quotes only: no wallet, no taker, no signing, no transaction.
// Rows go to <data>/research-evidence/raw/jupiter-quotes-<date>.ndjson via the collector.
export const JUP_QUOTE_SCHEMA = 'mpo.jupiter-quote.v1';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const jupQuoteUrl = (env = process.env) => env.MPO_JUP_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote';

// Open positions first (their exits are what matters), then the best-ranked watchlist tokens.
export function sampleTargets(state = {}, { limit = 6 } = {}) {
  const out = [], seen = new Set([SOL_MINT]);
  const push = (x, reason) => { const mint = String(x?.mint || ''); if (!MINT_RE.test(mint) || seen.has(mint) || out.length >= limit) return; seen.add(mint); out.push({ mint, symbol: x.symbol || null, reason, markUsd: Number(x.priceUsd) > 0 ? Number(x.priceUsd) : null }); };
  for (const p of Array.isArray(state.positions) ? state.positions : []) push(p, 'position');
  const wl = (Array.isArray(state.watchlist) ? state.watchlist : []).slice().sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0));
  for (const w of wl) push(w, 'watchlist');
  return out;
}

async function quote({ inputMint, outputMint, amount, slippageBps, fetchImpl, url, timeoutMs, apiKey }) {
  const u = new URL(url);
  for (const [k, v] of Object.entries({ inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps), swapMode: 'ExactIn' })) u.searchParams.set(k, v);
  const t0 = Date.now(), signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  const r = await fetchImpl(u, { headers: { accept: 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) }, signal });
  const ms = Date.now() - t0;
  if (r.status === 429) throw Object.assign(new Error('Jupiter quote rate limited'), { code: 'RATE_LIMITED' });
  if (!r.ok) throw Object.assign(new Error(`Jupiter quote HTTP ${r.status}`), { code: 'HTTP' });
  const j = await r.json();
  if (!/^\d+$/.test(String(j?.outAmount || ''))) throw Object.assign(new Error('Jupiter quote without outAmount'), { code: 'MALFORMED' });
  return { outAmount: String(j.outAmount), priceImpactPct: Number.isFinite(Number(j.priceImpactPct)) ? Number(j.priceImpactPct) : null, hops: Array.isArray(j.routePlan) ? j.routePlan.length : null, ms };
}

export function quoteExactInput({ inputMint, outputMint, amount, slippageBps = 100, fetchImpl = globalThis.fetch, url = jupQuoteUrl(), timeoutMs = 6000, apiKey = process.env.JUPITER_API_KEY || '' } = {}) {
  if (!MINT_RE.test(String(inputMint)) || !MINT_RE.test(String(outputMint)) || !/^\d+$/.test(String(amount)) || BigInt(amount) <= 0n || !(slippageBps >= 0 && slippageBps <= 1000)) throw new Error('Valid read-only Jupiter quote inputs required');
  return quote({ inputMint, outputMint, amount, slippageBps, fetchImpl, url, timeoutMs, apiKey });
}

// One target: buy notional SOL of the token, then quote selling exactly what the buy returns.
export async function quoteRoundTrip(target, { notionalSol = 0.1, slippageBps = 100, fetchImpl = globalThis.fetch, url = jupQuoteUrl(), timeoutMs = 6000, apiKey = process.env.JUPITER_API_KEY || '', now = Date.now() } = {}) {
  const lamports = Math.round(notionalSol * 1e9);
  const buy = await quote({ inputMint: SOL_MINT, outputMint: target.mint, amount: lamports, slippageBps, fetchImpl, url, timeoutMs, apiKey });
  const sell = await quote({ inputMint: target.mint, outputMint: SOL_MINT, amount: buy.outAmount, slippageBps, fetchImpl, url, timeoutMs, apiKey });
  const back = Number(sell.outAmount);
  return { schema: JUP_QUOTE_SCHEMA, t: now, source: 'jupiter-quote', mint: target.mint, symbol: target.symbol, reason: target.reason, markUsd: target.markUsd,
    notionalSol, slippageBps, buy: { inLamports: lamports, outRaw: buy.outAmount, priceImpactPct: buy.priceImpactPct, hops: buy.hops, ms: buy.ms },
    sell: { inRaw: buy.outAmount, outLamports: sell.outAmount, priceImpactPct: sell.priceImpactPct, hops: sell.hops, ms: sell.ms },
    roundTripPct: lamports > 0 ? Math.round((1 - back / lamports) * 1e6) / 1e4 : null };
}

// One pass, bounded by callsLeft (2 calls per target). Stops at the first rate limit.
export async function sampleJupiterQuotes({ state = {}, limit = 6, callsLeft = Infinity, now = Date.now(), ...opts } = {}) {
  const out = { rows: [], calls: 0, errors: [], rateLimited: false };
  for (const target of sampleTargets(state, { limit })) {
    if (out.calls + 2 > callsLeft) break;
    try { out.rows.push(await quoteRoundTrip(target, { now, ...opts })); out.calls += 2; }
    catch (e) {
      out.calls += 1; out.errors.push({ mint: target.mint, code: e.code || 'ERROR', message: String(e.message || e).slice(0, 160) });
      if (e.code === 'RATE_LIMITED') { out.rateLimited = true; break; }
    }
  }
  return out;
}
