import fs from 'node:fs';
import readline from 'node:readline';

export async function readShadowRows(file) {
  const rows = []; if (!fs.existsSync(file)) return rows;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { try { const x = JSON.parse(line); if (x.shadow === true) rows.push(x); } catch {} }
  return rows;
}

export function shadowDivergenceReport(rows = [], maxBps = 100) {
  return { shadowTrades: rows.length, flagged: rows.filter(x => Number(x.divergenceBps) > maxBps).length,
    maxDivergenceBps: rows.length ? Math.max(...rows.map(x => Number(x.divergenceBps) || 0)) : null,
    rows: rows.map(x => ({ tradeId: x.tradeId, paperFill: x.assumedPrice, shadowFill: x.shadowPrice, assumedSlippageBps: x.assumedSlippageBps, divergenceBps: x.divergenceBps, flagged: Number(x.divergenceBps) > maxBps })) };
}
