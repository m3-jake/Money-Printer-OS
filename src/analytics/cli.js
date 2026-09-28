import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { journalReport, renderJournalTable } from './journalReport.js';
import { attributePnl } from './attribution.js';
import { edgeBySignal } from './edge.js';
import { edgeDecay } from './decay.js';

export async function readTradeJournal(dataDir = process.env.MONEY_PRINTER_DATA_DIR || 'data') {
  const rows = [];
  for (const name of ['market.ndjson.2', 'market.ndjson.1', 'market.ndjson']) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) { try { rows.push(JSON.parse(line)); } catch {} }
  }
  return rows;
}

export function parseWindow(value) {
  if (!value) return null;
  const parts = String(value).split(',');
  if (parts.length !== 2) throw new Error('--window must be <start,end>');
  const [start, end] = parts.map(x => Number.isFinite(Number(x)) ? Number(x) : Date.parse(x));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('--window has invalid or reversed bounds');
  return { start, end };
}

export async function analyticsReport({ dataDir, window } = {}) {
  let rows = await readTradeJournal(dataDir);
  if (window) rows = rows.filter(x => { const t = x?.trade || x; const at = Number(t?.closedAt ?? x?.ts); return at >= window.start && at <= window.end; });
  const report = journalReport(rows);
  return { ...report, attribution: attributePnl(rows), edge: edgeBySignal(rows), decay: edgeDecay(rows) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2); let dataDir = process.env.MONEY_PRINTER_DATA_DIR || 'data', window = null;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--data') dataDir = args[++i]; else if (args[i] === '--window') window = parseWindow(args[++i]); }
  const report = await analyticsReport({ dataDir, window });
  if (command === 'report') { console.log(renderJournalTable(report)); console.log(JSON.stringify(report, null, 2)); }
  else if (command === 'replay') console.log(JSON.stringify({ mode: 'journal-replay-window', window, ...report }, null, 2));
  else throw new Error('Usage: node src/analytics/cli.js <report|replay> [--window <start,end>] [--data <dir>]');
}

const entry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (entry) main().catch(err => { console.error(err.message); process.exitCode = 1; });
