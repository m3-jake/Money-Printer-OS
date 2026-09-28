import fs from 'node:fs';
import readline from 'node:readline';

export async function readShadowRows(file) {
  const rows = []; if (!fs.existsSync(file)) return rows;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { try { const x = JSON.parse(line); if (x.shadow === true) rows.push(x); } catch {} }
  return rows;
}

export function shadowDivergenceReport(rows = [], maxBps = 100) {
  const measured=rows.filter(x=>x.divergenceBps!=null&&Number.isFinite(Number(x.divergenceBps)));
  return { shadowTrades: rows.length, flagged: rows.filter(x => Number(x.divergenceBps) > maxBps).length,
    compared: measured.length, unavailable: rows.length-measured.length,
    maxDivergenceBps: measured.length ? Math.max(...measured.map(x => Number(x.divergenceBps))) : null,
    rows: rows.map(x => ({ tradeId: x.tradeId, source:x.source, side:x.side, reason:x.reason||null, feeTreatment:x.feeTreatment||null, paperFill: x.assumedPrice, shadowFill: x.shadowPrice, assumedSlippageBps: x.assumedSlippageBps, divergenceBps: x.divergenceBps, flagged: Number(x.divergenceBps) > maxBps })) };
}
