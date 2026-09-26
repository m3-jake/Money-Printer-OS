#!/usr/bin/env node
// Read-only Robinhood tape statistics (reports/SOLANA-ROBINHOOD-LAB-REVIEW-2026-09-26.md, batch 12).
// Answers "can the default strategy trade at all at these costs?" before anyone searches parameters:
// coverage, quote sources, spread p50/p90, how often the expected move clears costMultiple x round-trip cost,
// and the trades/day a default-params replay produces. Reads <data>/robinhood-tape/*.ndjson only; no network.
//   node scripts/rh-tape-stats.mjs --data "%APPDATA%\Money Printer OS\data" [--fee 0.0085] [--json]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STRATEGY_DEFAULTS, normalizeParams, computeFeatures, roundTripCost } from '../src/robinhoodStrategy.js';
import { backtestTape } from '../src/robinhoodBacktest.js';

const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const round = (v, d = 2) => v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const pct = v => v === null ? null : round(v * 100, 3);

// Pure: rows are [{t,bid,ask,mid,src}] oldest first. `stride` evaluates the volatility gate every Nth sample.
export function tapeStats(rows, { params = STRATEGY_DEFAULTS, feeRatio = 0.0085, stride = 20, window = 720 } = {}) {
  const p = normalizeParams(params), sources = {}, spreads = [];
  for (const r of rows) { sources[r.src || 'unknown'] = (sources[r.src || 'unknown'] || 0) + 1; if (r.src !== 'coinbase-candles') spreads.push((r.ask - r.bid) / ((r.ask + r.bid) / 2) * 1e4); } // candle rows carry no book
  let checked = 0, clears = 0; const costs = [], moves = [];
  for (let i = p.warmupSamples; i < rows.length; i += stride) {
    const f = computeFeatures(rows.slice(Math.max(0, i + 1 - window), i + 1), p, rows[i].t);
    if (!f.ok) continue;
    const c = roundTripCost(feeRatio, f.spreadPct, p);
    checked++; costs.push(c); moves.push(f.expectedMovePct);
    if (f.expectedMovePct >= p.costMultiple * c) clears++;
  }
  const days = rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / 864e5 : 0;
  const bt = rows.length > p.warmupSamples ? backtestTape(rows, { params: p, feeRatio }).metrics : null;
  return {
    rows: rows.length, days: round(days), sources,
    spreadBps: { p50: round(quantile(spreads, 0.5)), p90: round(quantile(spreads, 0.9)) },
    roundTripCostPct: { p50: pct(quantile(costs, 0.5)) },
    expectedMovePct: { p50: pct(quantile(moves, 0.5)), p90: pct(quantile(moves, 0.9)) },
    volGateOpenPct: checked ? round(clears / checked * 100, 1) : null, gateChecks: checked,
    replay: bt && { closes: bt.closes, tradesPerDay: round(bt.tradesPerDay), hitRate: round(bt.hitRate, 3), profitFactor: round(bt.profitFactor), pnlUsd: round(bt.pnlUsd) },
  };
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }

async function main() {
  const data = arg('--data', process.env.MONEY_PRINTER_DATA_DIR);
  if (!data) { console.error('usage: node scripts/rh-tape-stats.mjs --data <data dir> [--fee 0.0085] [--json]'); process.exit(2); }
  process.env.MONEY_PRINTER_DATA_DIR = path.resolve(data);
  const T = await import('../src/robinhoodTape.js');
  const fee = Number(arg('--fee', '0.0085'));
  const out = {};
  for (const sym of T.listTapeSymbols()) out[sym] = tapeStats(T.loadTape(sym, 0), { feeRatio: fee });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  if (!Object.keys(out).length) { console.log(`no tape under ${T.TAPE_DIR}`); return; }
  for (const [sym, s] of Object.entries(out)) {
    const src = Object.entries(s.sources).map(([k, n]) => `${k}:${n}`).join(',');
    const rp = s.replay ? `replay ${s.replay.closes} closes ${s.replay.tradesPerDay}/day PF ${s.replay.profitFactor}` : 'replay n/a';
    console.log(`${sym} ${s.rows} rows ${s.days}d [${src}] spread p50 ${s.spreadBps.p50} p90 ${s.spreadBps.p90} bps | cost p50 ${s.roundTripCostPct.p50}% | move p50 ${s.expectedMovePct.p50}% | vol gate open ${s.volGateOpenPct ?? 'n/a'}% of ${s.gateChecks} | ${rp}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(e => { console.error(e?.message || e); process.exit(1); });
export const __file = fileURLToPath(import.meta.url);
