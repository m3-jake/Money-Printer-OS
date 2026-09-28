#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finite, timestamp, summarizeTrades, drawdown } from './edge.js';
import { signalAtEntry, groupMetrics, attributeSignals } from './attribution.js';

const JOURNALS = ['market.ndjson.2', 'market.ndjson.1', 'market.ndjson'];
const BOOKS = [
  ['robinhood-paper.json', 'robinhood-crypto', 'crypto-unattributed'],
  ['robinhood-paper-practice.json', 'robinhood-practice', 'practice'],
  ['robinhood-daily-paper.json', 'robinhood-daily', 'daily'],
  ['robinhood-equities-paper.json', 'robinhood-equities', 'equities'],
  ['polymarket-us-paper.json', 'polymarket-us', 'combo'],
  ['polymarket-paper.json', 'polymarket-legacy', 'legacy-separate-book'],
];
const bump = (q, key) => { q[key] = (q[key] || 0) + 1; };
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { file: path.basename(file), bytes: fs.statSync(file).size, sha256: hash.digest('hex') };
}
export function normalizeTrade(raw, { venue = 'pumpfun', currency = 'SOL', strategy = 'UNATTRIBUTED' } = {}, quarantine = {}) {
  if (!raw || typeof raw !== 'object') { bump(quarantine, 'invalidTrade'); return null; }
  const mode = String(raw.mode || raw.pnlMode || 'PAPER').toUpperCase();
  if (mode !== 'PAPER' || String(raw.pnlMode || 'PAPER').toUpperCase() !== 'PAPER' || raw.signature || raw.remainingRaw) { bump(quarantine, 'nonPaper'); return null; }
  const closedAt = timestamp(raw.closedAt ?? raw.settledAt), openedAt = timestamp(raw.openedAt ?? raw.at);
  const pnl = finite(currency === 'SOL' ? raw.pnlSol : raw.pnlUsd);
  if (/CANCEL|REJECT|PENDING|OPEN|VOID/.test(String(raw.status || '').toUpperCase())) { bump(quarantine, 'notCompleted'); return null; }
  if (pnl === null || closedAt === null || (openedAt !== null && openedAt > closedAt)) { bump(quarantine, 'invalidPnlOrTime'); return null; }
  if (!raw.mode && !raw.pnlMode) bump(quarantine, 'paperModeInferredFromPaperSource');
  return { id: String(raw.id || `${raw.mint || raw.symbol || 'unknown'}:${openedAt}:${closedAt}`),
    venue, currency, strategyId: String(raw.strategyId || raw.strategy || raw.strategyVersion || strategy),
    mint: raw.mint, symbol: raw.symbol, openedAt, closedAt, pnl,
    basis: finite(currency === 'SOL' ? raw.sizeSol : raw.costUsd),
    profile: raw.profile ?? null, championId: raw.championId ?? null,
    dominantSignal: raw.dominantSignal, signalSource: raw.signalSource,
    cashCoverage: raw.paperCashCoverage ?? 'MISSING', executionModel: raw.paperExecution?.model ?? 'UNRECORDED' };
}
export function deduplicateTrades(trades, quarantine = {}) {
  const found = new Map();
  for (const trade of trades) {
    const key = `${trade.venue}:${trade.id}`;
    if (!found.has(key)) { found.set(key, trade); continue; }
    const previous = found.get(key);
    if (previous.pnl !== trade.pnl || previous.closedAt !== trade.closedAt) bump(quarantine, 'conflictingDuplicate');
    else bump(quarantine, 'duplicateTrade');
  }
  return [...found.values()].sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
}
export async function loadJournal(dataDir) {
  const byMint = new Map(), closes = [], resets = [], inventory = [], quarantine = {}, types = {};
  let minTs = Infinity, maxTs = -Infinity;
  for (const name of JOURNALS) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    inventory.push(await fingerprint(file));
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); }
      catch { bump(quarantine, 'invalidJsonLine'); continue; }
      bump(types, row.type || 'unknown');
      const ts = timestamp(row.ts);
      if (ts === null) { bump(quarantine, 'invalidEventTime'); continue; }
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
      if (row.type === 'paper-reset') resets.push({ ts, amountSol: finite(row.amountSol) });
      if (row.type === 'trade-close') {
        const raw = { ...row.trade, mode: row.trade?.mode || row.mode };
        const trade = normalizeTrade(raw, {}, quarantine);
        if (trade) closes.push(trade);
      }
      if (['scan', 'scan-candidate'].includes(row.type) && row.a?.mint) {
        const mint = String(row.a.mint);
        if (!byMint.has(mint)) byMint.set(mint, []);
        byMint.get(mint).push({ ts, dominantSignal: row.a.dominantSignal });
      }
    }
  }
  for (const rows of byMint.values()) rows.sort((a, b) => a.ts - b.ts);
  const trades = deduplicateTrades(closes, quarantine).map(t => ({ ...t, ...signalAtEntry(t, byMint) }));
  const uniqueResets = [...new Map(resets.map(r => [r.ts, r])).values()].sort((a, b) => a.ts - b.ts);
  return { byMint, trades, resets: uniqueResets, inventory, quarantine, types,
    start: Number.isFinite(minTs) ? minTs : null, end: Number.isFinite(maxTs) ? maxTs + 1 : null };
}
function tally(rows, key) {
  return rows.reduce((out, row) => { const value = String(row[key] ?? 'UNKNOWN'); out[value] = (out[value] || 0) + 1; return out; }, {});
}
export function epochReports(journal, start, end) {
  const resets = journal.resets.filter(r => r.ts >= start && r.ts < end);
  const eras = [{ ts: start, amountSol: null }, ...resets];
  return eras.map((era, index) => {
    const to = eras[index + 1]?.ts ?? end, rows = journal.trades.filter(t => t.closedAt >= era.ts && t.closedAt < to);
    const crossing = rows.filter(t => t.openedAt !== null && t.openedAt < era.ts).length;
    return { epoch: index, start: era.ts, end: to, startingCapital: era.amountSol, crossingBoundaryTrades: crossing,
      metrics: groupMetrics(rows, t => t.strategyId, { start: era.ts, end: to, startingCapital: crossing ? null : era.amountSol }) };
  });
}
export async function journalReport({ dataDir, from = null, to = null } = {}) {
  if (!dataDir) throw new Error('--data-dir is required; the report never loads runtime configuration');
  const journal = await loadJournal(dataDir), stateFile = path.join(dataDir, 'state.json');
  const state = readJson(stateFile), quarantine = {};
  if (String(state.mode || state.pnlMode || 'PAPER').toUpperCase() !== 'PAPER') throw new Error('Current source is not a paper book');
  const asOf = timestamp(state.system?.lastCycle) ?? journal.end;
  const start = from ?? journal.start, end = to ?? Math.min(journal.end, asOf + 1);
  if (!(end > start)) throw new Error('No valid journal window; use explicit --from and --to for an empty journal');
  const inWindow = t => t.closedAt >= start && t.closedAt < end;
  const rawCurrent = (state.history || []).map(t => normalizeTrade(t, {}, quarantine)).filter(Boolean);
  const current = deduplicateTrades(rawCurrent, quarantine).filter(inWindow).map(t => ({ ...t, ...signalAtEntry(t, journal.byMint) }));
  const retained = journal.trades.filter(inWindow), lastReset = journal.resets.filter(r => r.ts <= asOf).at(-1);
  const bookStart = lastReset?.ts ?? timestamp(state.portfolioSeries?.[0]?.ts) ?? Math.min(...rawCurrent.map(t => t.openedAt ?? t.closedAt));
  const covered = start <= bookStart, fullCapital = covered ? finite(state.paperStartSol) : null;
  const currentOptions = { start: Math.max(start, bookStart), end: Math.min(end, asOf), startingCapital: fullCapital };
  const positions = state.positions || [], openBasis = positions.reduce((n, p) => n + (finite(p.remainingSol ?? p.sizeSol) ?? 0), 0);
  const openRealized = positions.reduce((n, p) => n + (finite(p.realizedSol) ?? 0), 0);
  const closedPnl = rawCurrent.reduce((n, t) => n + t.pnl, 0), cash = finite(state.cashSol), capital = finite(state.paperStartSol);
  const markMissing = positions.filter(p => !(finite(p.entryPrice) > 0) || !(finite(p.lastPrice) > 0)).length;
  const markedValue = markMissing ? null : positions.reduce((n, p) => n + Number(p.remainingSol ?? p.sizeSol) * p.lastPrice / p.entryPrice, 0);
  const currentById = new Map(rawCurrent.map(t => [t.id, t]));
  const conflicts = journal.trades.filter(t => currentById.has(t.id) && Math.abs(currentById.get(t.id).pnl - t.pnl) > 1e-10);
  const missingInJournal = rawCurrent.filter(t => !journal.trades.some(j => j.id === t.id));
  const strategyCount = new Set(current.map(t => t.strategyId)).size;
  const metrics = groupMetrics(current, t => t.strategyId, { ...currentOptions, startingCapital: strategyCount === 1 ? fullCapital : null });
  if (!metrics.length) metrics.push({ strategyId: 'UNIFIED_EDGE', currency: 'SOL', ...summarizeTrades([], currentOptions) });
  const inventory = [...journal.inventory, await fingerprint(stateFile)], platforms = [];
  for (const [name, venue, strategy] of BOOKS) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) { platforms.push({ venue, missing: true }); continue; }
    const book = readJson(file), q = {};
    inventory.push(await fingerprint(file));
    const all = deduplicateTrades((book.history || []).map(t => normalizeTrade(t, { venue, currency: 'USD', strategy }, q)).filter(Boolean), q);
    const rows = all.filter(t => (from === null || t.closedAt >= from) && t.closedAt < end);
    const observedFrom = timestamp(book.createdAt) ?? (all.length ? Math.min(...all.map(t => t.openedAt ?? t.closedAt)) : end);
    const options = { start: Math.max(from ?? observedFrom, observedFrom), end,
      startingCapital: from === null || from <= observedFrom ? finite(book.startUsd) : null };
    const groups = groupMetrics(rows, t => t.strategyId, { ...options, startingCapital: new Set(rows.map(t => t.strategyId)).size > 1 ? null : options.startingCapital });
    if (!groups.length) groups.push({ strategyId: strategy, currency: 'USD', ...summarizeTrades([], options) });
    platforms.push({ venue, file: name, metrics: groups, quarantine: q, openCount: (book.positions || book.open || []).length,
      note: 'Independent paper ledger; do not sum across overlapping practice/legacy views.' });
  }
  const series = (state.portfolioSeries || []).filter(p => p.ts >= start && p.ts < end && finite(p.equitySol) !== null);
  const markedDD = drawdown(series.map(p => p.equitySol), series[0]?.equitySol);
  return { schema: 'mpo.phase0.journal-report.v1', readOnly: true,
    window: { start, end, convention: '[start,end)', stateAsOf: asOf }, sources: inventory,
    definitions: { pnl: 'Recorded completed-trade P&L after modeled fees/slippage; do not subtract costs again.',
      winRate: 'strictly positive net P&L / valid completed trades; breakeven is not a win',
      sampleCount: 'valid deduplicated completed trades, not scan count or tested variants', avgLoss: 'signed negative mean',
      sharpe: 'last 24 complete UTC hourly realized-only returns, zero benchmark, sample SD, unannualized; at least 3 periods',
      drawdown: 'closed-trade net-PnL drawdown; marked open risk is reported separately',
      attribution: 'one dominant signal observed at/before entry, maximum 30 seconds old; association, not causation' },
    currentBook: { venue: 'pumpfun', metrics, quarantine, runtime: state.runtime,
      startingCapital: capital, cash, openCount: positions.length, openBasis, openRealizedPnl: openRealized,
      closedPnl, windowClosedPnl: current.reduce((sum, trade) => sum + trade.pnl, 0), closedPnlScope: 'entire current history for accounting', markedOpenValue: markedValue, missingMarks: markMissing,
      markedEquity: markedValue === null || cash === null ? null : cash + markedValue,
      accountingGap: cash === null || capital === null ? null : cash + openBasis - capital - closedPnl - openRealized,
      lifetimePnlDifference: finite(state.realizedLifetimePnlSol) === null ? null : state.realizedLifetimePnlSol - closedPnl,
      currentVsJournalConflicts: conflicts.length, currentClosesMissingFromRetainedJournal: missingInJournal.length,
      recordedCashCoverage: tally(current, 'cashCoverage'), executionModels: tally(current, 'executionModel'), profiles: tally(current, 'profile'), champions: tally(current, 'championId'),
      attribution: attributeSignals(current), markedDrawdown: { ...markedDD, observations: series.length,
        start: series[0]?.ts ?? null, end: series.at(-1)?.ts ?? null, kind: 'captured total-book marked-equity series; not per-strategy' } },
    retainedJournal: { types: journal.types, quarantine: journal.quarantine, tradeCount: retained.length,
      totalClosedPnlSol: retained.reduce((n, t) => n + t.pnl, 0), resets: journal.resets,
      epochs: epochReports(journal, start, end), attribution: attributeSignals(retained),
      note: 'All retained reset eras preserved. This sum is NOT current bankroll profit or a continuous equity curve.' },
    platforms, verdict: 'EDGE_NOT_PROVEN', warnings: [
      'A profitable current epoch is not proof of a repeatable or live-executable edge.',
      'Open risk, censoring, historical resets, missing execution inputs and outcome concentration must remain visible.',
      'Missing signal snapshots stay UNKNOWN. Dominant-signal attribution is observational, not causal.',
      'Days observed measures elapsed source-window span, not a guarantee of uninterrupted feeds or independent samples.',
      'Current profile names may not describe champion-overridden exits. No policy or routing changed.' ] };
}
function number(value, digits = 6) { return value === null || value === undefined ? 'N/A' : Number(value).toFixed(digits); }
function table(rows) {
  const head = '| Strategy | Unit | Trades | Win % | Expectancy | Avg win | Avg loss | Max DD | Rolling Sharpe | Samples | Days |';
  return [head, '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|', ...rows.map(r =>
    `| ${r.strategyId} | ${r.currency} | ${r.tradeCount} | ${number(r.winRate === null ? null : r.winRate * 100, 2)} | ${number(r.expectancy)} | ${number(r.avgWin)} | ${number(r.avgLoss)} | ${number(r.maxDrawdown)} | ${number(r.rollingSharpe, 3)} | ${r.sampleCount} | ${number(r.daysObserved, 4)} |`)].join('\n');
}
export function renderReport(report) {
  const lines = ['# Phase 0: truth and instrumentation', '', `Window: ${new Date(report.window.start).toISOString()} to ${new Date(report.window.end).toISOString()} [end exclusive]`, ''];
  if (report.kind === 'replay') {
    lines.push('## Pessimistic historical reference replay', table(report.metrics), '',
      `Censored positions: ${report.censored}; exit failures: ${report.exitFailures}; final marked equity: ${number(report.finalEquity)} SOL.`,
      'This uses the existing historical replay policy, NOT exact installed FAIR/LAB_AUTO behavior.', ...report.limitations.map(s => '- ' + s));
  } else {
    lines.push('## Current authoritative Pump.fun paper book', table(report.currentBook.metrics), '',
      `Net closed P&L: ${number(report.currentBook.windowClosedPnl)} SOL; open positions: ${report.currentBook.openCount}; open basis: ${number(report.currentBook.openBasis)} SOL.`,
      `Accounting gap: ${number(report.currentBook.accountingGap, 12)} SOL. Current/history conflicts: ${report.currentBook.currentVsJournalConflicts}.`,
      '## Other independent paper books');
    for (const p of report.platforms) lines.push(`### ${p.venue}`, p.missing ? 'Missing source; no results invented.' : table(p.metrics));
    lines.push('## Retained journal: separate reset eras', `Retained closes: ${report.retainedJournal.tradeCount}; resets: ${report.retainedJournal.resets.length}. Do not read the sum as current bankroll profit.`);
    for (const epoch of report.retainedJournal.epochs) lines.push(`### Era ${epoch.epoch}: ${new Date(epoch.start).toISOString()}`, table(epoch.metrics));
    lines.push('## Current-book signal attribution', table(report.currentBook.attribution.rows), '',
      `Unknown signal evidence: ${report.currentBook.attribution.unknownTradeCount} trades. One signal per trade; no causal claim.`,
      '## Verdict', report.verdict, ...report.warnings.map(s => '- ' + s));
  }
  lines.push('', 'Sharpe: unannualized, last 24 complete hourly realized-only returns, minimum 3 periods; N/A is not zero.',
    'Max DD: absolute closed-trade P&L decline in the stated currency. It excludes open positions and is not portfolio drawdown.',
    'Days: elapsed covered observation time, not the number of distinct calendar dates. No new trading decisions were executed.');
  return lines.join('\n') + '\n';
}
export function parseArgs(argv) {
  const args = { command: argv[0] || 'help' }, allowed = new Set(['data-dir', 'out', 'from', 'to', 'preset', 'start-sol', 'sol-usd']);
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, ''), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || value === undefined || value.startsWith('--')) throw new Error('Unknown or incomplete option: ' + argv[i]);
    if (key in args) throw new Error('Duplicate option: ' + key);
    args[key] = value;
  }
  for (const key of ['from', 'to']) if (args[key] !== undefined) {
    const ts = timestamp(args[key]); if (ts === null) throw new Error('Invalid timestamp: ' + key); args[key] = ts;
  }
  for (const key of ['start-sol', 'sol-usd']) if (args[key] !== undefined) {
    const n = finite(args[key]); if (!(n > 0)) throw new Error('Expected positive number: ' + key); args[key] = n;
  }
  if (args.from !== undefined && args.to !== undefined && args.to <= args.from) throw new Error('--to must be after --from');
  return args;
}
export function writeReport(report, out, dataDir) {
  if (!out) throw new Error('--out is required for paired JSON/Markdown output');
  const base = path.resolve(out), source = fs.realpathSync(dataDir);
  let ancestor = path.dirname(base);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const prospective = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, base));
  const preflight = path.relative(source, prospective);
  if (!preflight || (!preflight.startsWith('..' + path.sep) && !path.isAbsolute(preflight))) throw new Error('Output must be outside the input directory');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const destination = path.join(fs.realpathSync(path.dirname(base)), path.basename(base));
  const relative = path.relative(source, destination);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Output must be outside the input directory');
  if (fs.existsSync(base + '.json') || fs.existsSync(base + '.md')) throw new Error('Refusing to overwrite an existing report');
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(base + '.md', renderReport(report), { flag: 'wx' });
  return { json: base + '.json', markdown: base + '.md' };
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (['help', '--help'].includes(args.command)) {
    console.log('Usage: node src/analytics/journalReport.js journal|replay --data-dir DIR --out BASE [--from ISO --to ISO]');
    console.log('Replay requires --from and --to; existing preset defaults to FAST, start-sol=1, sol-usd=200.');
    return;
  }
  if (!['journal', 'replay'].includes(args.command)) throw new Error('Command must be journal or replay');
  if (!args['data-dir'] || !args.out) throw new Error('--data-dir and --out are required');
  const options = { dataDir: path.resolve(args['data-dir']), from: args.from ?? null, to: args.to ?? null };
  const report = args.command === 'journal' ? await journalReport(options) : await replayReport({ ...options,
    preset: args.preset || 'FAST', startSol: args['start-sol'] ?? 1, solUsd: args['sol-usd'] ?? 200 });
  const files = writeReport(report, args.out, options.dataDir);
  console.log(renderReport(report));
  console.log('OUTPUT', JSON.stringify(files));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Phase 0 report failed:', error.message); process.exitCode = 1; });
}

export async function replayReport({ dataDir, from, to, preset = 'FAST', startSol = 1, solUsd = 200 } = {}) {
  if (!(from > 0) || !(to > from)) throw new Error('Replay requires explicit --from and --to');
  const { loadEvents, makeConfigs, replayFixedWindow } = await import('../replayLab.js');
  const config = makeConfigs([preset])[0];
  if (!config) throw new Error('Unknown existing reference preset: ' + preset);
  const data = await loadEvents({ dataDir }), events = data.events.filter(e => e.ts >= from && e.ts < to);
  const result = replayFixedWindow(data.events, config, { from, to, startSol, solUsd });
  const strategyId = `${preset}_LEGACY_REFERENCE`, trades = result.trades.map((t, i) => ({ ...t,
    id: `${t.mint}:${t.openedAt}:${i}`, currency: 'SOL', strategyId }));
  const sources = [];
  for (const name of JOURNALS) if (fs.existsSync(path.join(dataDir, name))) sources.push(await fingerprint(path.join(dataDir, name)));
  const simulator = await fingerprint(fileURLToPath(new URL('../executionSim.js', import.meta.url)));
  const sharedCore = await fingerprint(fileURLToPath(new URL('../core/paperTrading.js', import.meta.url)));
  return { schema: 'mpo.phase0.replay-report.v1', kind: 'replay', mode: 'PAPER', readOnly: true,
    window: { start: from, end: to, convention: '[start,end)' }, sources,
    inputHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'), inputEvents: events.length,
    quarantine: data.quarantine, config, startSol, solUsd,
    execution: { model: 'existing estimatePaperExecution + deterministicFillAllowed', simulator, sharedCore,
      seedRule: 'existing mint + floor(timestamp / 8000) deterministic rule; no current wall clock' },
    metrics: [{ strategyId, currency: 'SOL', ...summarizeTrades(trades, { start: from, end: to, startingCapital: startSol }) }],
    censored: result.censored, censoredMarks: result.censoredMarks, exitFailures: result.exitFailures,
    finalEquity: result.finalEquity, realizedPnlIncludingOpenPartialsAndFees: result.realizedPnl,
    fees: result.fees, modeledSlippageCost: result.slippage, exitReasons: result.exitReasons,
    markedDrawdown: drawdown(result.curve.map(point => point.equity), startSol),
    runtimeParity: false, verdict: 'REFERENCE_ONLY_NOT_RUNTIME_EDGE_PROOF', limitations: [
      'The existing replay policy uses its own entry filters, sizing, position cap and exits; it is not FAIR/LAB_AUTO runtime parity.',
      'The running app uses simulatePumpPaperExecution with rejection/partial-fill behavior; this legacy historical replay uses estimatePaperExecution.',
      'Captured candidate rows omit micro.p10, priceAccel, pool binding and historical champion/config transitions required for exact runtime reconstruction.',
      'SOL/USD is the explicit constant shown in solUsd, not a reconstructed historical conversion-price series.',
      'Start capital is a standalone replay assumption; original bankrolls, resets, open positions and journals are untouched.',
      'Stale or disappearing positions and end-of-window positions are censored, not booked as closed wins.',
      'Closed-trade metrics omit open partial realizations and open entry fees; those remain in the separate total realized and marked-equity fields.',
      'This reference cannot approve Phase 1 or support a live-edge claim; faithful runtime-policy replay remains an evidence gap.' ] };
}
