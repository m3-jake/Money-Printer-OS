import { tradeRows, mean } from './shared.js';

const round = (x, n = 6) => x == null ? null : Number(x.toFixed(n));
export function maxDrawdown(pnls) {
  let equity = 0, peak = 0, dd = 0;
  for (const pnl of pnls) { equity += pnl; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); }
  return dd;
}

export function rollingSharpe(pnls, window = 20) {
  if (!pnls.length) return null;
  const values = [];
  for (let i = 0; i < pnls.length; i++) {
    const sample = pnls.slice(Math.max(0, i - window + 1), i + 1);
    if (sample.length < 2) continue;
    const avg = mean(sample), variance = sample.reduce((s, x) => s + (x - avg) ** 2, 0) / (sample.length - 1);
    if (variance > 0) values.push(avg / Math.sqrt(variance));
  }
  return values.length ? round(mean(values)) : null;
}

export function journalReport(rows = [], { now = Date.now(), sharpeWindow = 20 } = {}) {
  const trades = tradeRows(rows), groups = new Map();
  for (const t of trades) { if (!groups.has(t.strategy)) groups.set(t.strategy, []); groups.get(t.strategy).push(t); }
  const strategies = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([strategy, ts]) => {
    const pnls = ts.map(t => t.pnl), wins = pnls.filter(x => x > 0), losses = pnls.filter(x => x < 0);
    return { strategy, tradeCount: ts.length, winRate: round(wins.length / ts.length), expectancy: round(mean(pnls)),
      avgWin: round(mean(wins)), avgLoss: round(mean(losses)), maxDD: round(maxDrawdown(pnls)),
      rollingSharpe: rollingSharpe(pnls, sharpeWindow), samples: ts.length,
      daysObserved: round(Math.max(0, (Math.min(now, ts.at(-1).closedAt) - ts[0].closedAt) / 86_400_000), 3) };
  });
  return { asOf: now, tradeCount: trades.length, strategies };
}

export function renderJournalTable(report) {
  const lines = ['| Strategy | Trades | Win rate | Expectancy | Avg win | Avg loss | Max DD | Rolling Sharpe | Samples | Days |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of report.strategies) lines.push(`| ${r.strategy} | ${r.tradeCount} | ${r.winRate ?? '—'} | ${r.expectancy ?? '—'} | ${r.avgWin ?? '—'} | ${r.avgLoss ?? '—'} | ${r.maxDD ?? '—'} | ${r.rollingSharpe ?? '—'} | ${r.samples} | ${r.daysObserved} |`);
  return lines.join('\n');
}
