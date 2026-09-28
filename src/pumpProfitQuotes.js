// Only keyless public GET quotes. No API credentials, wallets, signing, swap construction or submission.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { policyHash } from './pumpProfitPolicy.js';
import { SOL_MINT } from './pumpProfitExperiments.js';
export const PROFIT_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function collectPumpProfitQuotes({ dir, fetchImpl = globalThis.fetch, now = Date.now(), sleep = wait, maxBatch = 4 } = {}) {
  if (String(process.env.MODE || 'paper').toLowerCase() !== 'paper') return { calls: 0, reason: 'paper-only' };
  const requests = read(path.join(dir, 'pump-profit-requests.json'), null);
  if (requests?.mode !== 'PAPER' || requests.liveExecutionAllowed !== false || requests.expiresAt < now || !requests.protocolHash) return { calls: 0, reason: 'no-active-paper-batch' };
  const file = path.join(dir, 'pump-profit-quotes.json'), prior = read(file, null);
  const cache = prior?.protocolHash === requests.protocolHash ? prior : { schema: 'mpo.pump-profit-quotes.v1', protocolHash: requests.protocolHash, calls: 0, quotes: [], errors: [], hour: 0, callsThisHour: 0, backoffUntil: 0, lastCallAt: 0 };
  const hour = Math.floor(now / 3600000); if (cache.hour !== hour) { cache.hour = hour; cache.callsThisHour = 0; }
  if (now < cache.backoffUntil) return { calls: 0, reason: 'provider-backoff' };
  const budget = Math.max(0, Math.min(4096 - cache.calls, 180 - cache.callsThisHour, maxBatch, 4));
  const pending = (requests.requests || []).filter(o => o.expiresAt >= now && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.mint) && /^\d+$/.test(o.amountRaw) && BigInt(o.amountRaw) > 0n && ['BUY', 'SELL'].includes(o.side));
  let calls = 0, rows = 0;
  for (const o of pending) {
    if (calls >= budget) break;
    if (cache.quotes.some(q => q.mint === o.mint && q.side === o.side && q.inAmount === o.amountRaw && q.requestedAt >= o.submittedAt && now - q.receivedAt < 25000)) continue;
    await sleep(Math.max(0, 2100 - (Date.now() - cache.lastCallAt)));
    const requestedAt = Date.now(); if (requestedAt > o.expiresAt) continue;
    const u = new URL(PROFIT_QUOTE_URL);
    for (const [key, value] of Object.entries({ inputMint: o.side === 'BUY' ? SOL_MINT : o.mint, outputMint: o.side === 'BUY' ? o.mint : SOL_MINT,
      amount: o.amountRaw, slippageBps: '100', swapMode: 'ExactIn' })) u.searchParams.set(key, value);
    cache.calls++; cache.callsThisHour++; cache.lastCallAt = requestedAt; calls++;
    try {
      const response = await fetchImpl(u, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) { const error = new Error(`Keyless quote HTTP ${response.status}`); error.status = response.status; throw error; }
      const q = await response.json(), receivedAt = Date.now();
      if (q.inAmount !== o.amountRaw || !/^\d+$/.test(String(q.outAmount)) || !/^\d+$/.test(String(q.otherAmountThreshold)) || !q.routePlan?.length || q.routePlan.length > 16 || !Number.isSafeInteger(q.contextSlot)) throw new Error('Incomplete exact-size route quote');
      const row = { source: 'jupiter-keyless-quote', mint: o.mint, side: o.side, requestedAt, receivedAt, inputMint: q.inputMint, outputMint: q.outputMint,
        inAmount: q.inAmount, outAmount: q.outAmount, otherAmountThreshold: q.otherAmountThreshold, swapMode: q.swapMode, contextSlot: q.contextSlot,
        routePlan: q.routePlan, platformFee: q.platformFee || null, priceImpactPct: q.priceImpactPct, timeTaken: q.timeTaken,
        quoteOnly: true, transactionSubmitted: false, allCostsKnown: false, networkFeeEvidence: 'NOT_INCLUDED_IN_ROUTE_QUOTE', paidApiCallsAllowed: false };
      row.id = policyHash(row);
      const archive=path.join(dir,'research-evidence','raw',`pump-profit-quotes-${requests.protocolHash}.ndjson`);
      fs.mkdirSync(path.dirname(archive),{recursive:true});fs.appendFileSync(archive,JSON.stringify(row)+'\n');
      const retained=path.join(dir,'pump-profit-evidence',requests.protocolHash,'quotes.ndjson');fs.mkdirSync(path.dirname(retained),{recursive:true});fs.appendFileSync(retained,JSON.stringify(row)+'\n');
      cache.quotes.push(row); rows++;
    } catch (error) {
      cache.errors.push({ at: Date.now(), key: o.key, message: String(error.message || error) });
      if ([401, 403, 429].includes(error.status)) { cache.backoffUntil = Date.now() + 300000; break; }
    }
  }
  cache.quotes = cache.quotes.slice(-512); cache.errors = cache.errors.slice(-20); cache.updatedAt = Date.now();
  fs.mkdirSync(dir, { recursive: true }); writeFileAtomicSync(file, JSON.stringify(cache));
  return { calls, rows, totalCalls: cache.calls, hourCalls: cache.callsThisHour, maxCalls: 4096, keyless: true, paidCalls: 0, liveExecutionAllowed: false, errors: cache.errors.slice(-3) };
}
