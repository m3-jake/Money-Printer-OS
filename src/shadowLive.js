import fs from 'node:fs';
import path from 'node:path';

export function shadowFill({ trade = {}, liveBook = {}, latency = {}, feesBps = 0, data = {} } = {}) {
  const side = String(trade.side || 'BUY').toUpperCase(), price = Number(data.ask ?? data.price ?? trade.price), bid = Number(data.bid ?? price);
  const observed = Number(data.observedAt || data.ts || Date.now()), delay = Math.max(0, Number(latency.p50Ms || latency.medianMs || 0));
  const slip = side === 'BUY' ? Number(price) : Number(price) - Number(bid);
  const fillPrice = Number.isFinite(price) && price > 0 ? price * (side === 'BUY' ? 1 : 1 - Number(feesBps) / 10_000) : null;
  return { shadow: true, tradeId: trade.id || null, mint: trade.mint || null, side, assumedPrice: Number(trade.price || 0), shadowPrice: fillPrice,
    assumedSlippageBps: Number(trade.slippageBps || 0), shadowSlippageBps: price > 0 ? slip / price * 10_000 : null,
    divergenceBps: price > 0 && Number(trade.price) > 0 ? Math.abs(price - Number(trade.price)) / Number(trade.price) * 10_000 : null,
    observedAt: observed, estimatedFillAt: observed + delay, latencyMs: delay, feesBps: Number(feesBps), liveBook: Boolean(Object.keys(liveBook).length), orderPlaced: false };
}

export function appendShadowRow(row, { file = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'shadow-live.ndjson') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ ...row, shadow: true, orderPlaced: false }) + '\n'); return file;
}

export function compareShadowFill(trade, shadow, { maxDivergenceBps = 100 } = {}) {
  const divergenceBps = Number(shadow?.divergenceBps);
  return { tradeId: trade?.id || shadow?.tradeId || null, paperFill: Number(trade?.price || 0), shadowFill: shadow?.shadowPrice ?? null,
    assumedSlippageBps: Number(trade?.slippageBps || 0), divergenceBps: Number.isFinite(divergenceBps) ? divergenceBps : null,
    flagged: Number.isFinite(divergenceBps) && divergenceBps > maxDivergenceBps };
}
