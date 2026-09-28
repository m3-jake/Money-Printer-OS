import fs from 'node:fs';
import path from 'node:path';

export function shadowFill({ trade = {}, liveBook = {}, latency = {}, feesBps = 0, data = {} } = {}) {
  const side = String(trade.side || 'BUY').toUpperCase(), reference=Number(trade.price), rawPrice=(side==='BUY'?data.ask:data.bid) ?? data.price, price = rawPrice == null ? NaN : Number(rawPrice), bid = price;
  const observed = Number(data.observedAt || data.ts || Date.now()), delay = Math.max(0, Number(latency.p50Ms || latency.medianMs || 0));
  const slip = side === 'BUY' ? price-reference : reference-Number(bid);
  const fillPrice = Number.isFinite(price) && price > 0 && feesBps != null && Number.isFinite(Number(feesBps)) ? price * (side === 'BUY' ? 1 + Number(feesBps) / 10_000 : 1 - Number(feesBps) / 10_000) : null;
  return { shadow: true, tradeId: trade.id || null, mint: trade.mint || null, side, assumedPrice: Number(trade.price || 0), shadowPrice: fillPrice,
    assumedSlippageBps: Number(trade.slippageBps || 0), shadowSlippageBps: price > 0 && Number.isFinite(slip) ? slip / price * 10_000 : null,
    divergenceBps: fillPrice !== null && reference > 0 ? Math.abs(fillPrice - reference) / reference * 10_000 : null,
    observedAt: observed, estimatedFillAt: observed + delay, latencyMs: delay, feesBps: feesBps == null ? null : Number(feesBps), liveBook: Boolean(Object.keys(liveBook).length), orderPlaced: false };
}

const shadowSeen=new Set();
export function appendShadowRow(row, { file = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'shadow-live.ndjson') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ ...row, shadow: true, orderPlaced: false }) + '\n'); return file;
}

export function appendShadowRowOnce(row,options={}){
 const key=JSON.stringify([path.resolve(options.file || path.join(process.env.MONEY_PRINTER_DATA_DIR || 'data','shadow-live.ndjson')),row?.source,row?.tradeId||row?.mint,row?.side,Math.floor(Number(row?.observedAt??Date.now())/60_000)]);
 if(shadowSeen.has(key))return {written:false,key};
 appendShadowRow(row,options);shadowSeen.add(key);if(shadowSeen.size>5000)shadowSeen.delete(shadowSeen.values().next().value);return {written:true,key};
}

export function compareShadowFill(trade, shadow, { maxDivergenceBps = 100 } = {}) {
  const divergenceBps = shadow?.divergenceBps == null ? NaN : Number(shadow.divergenceBps);
  return { tradeId: trade?.id || shadow?.tradeId || null, paperFill: Number(trade?.price || 0), shadowFill: shadow?.shadowPrice ?? null,
    assumedSlippageBps: Number(trade?.slippageBps || 0), divergenceBps: Number.isFinite(divergenceBps) ? divergenceBps : null,
    flagged: Number.isFinite(divergenceBps) && divergenceBps > maxDivergenceBps };
}
