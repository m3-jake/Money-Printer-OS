import fs from 'node:fs';
import path from 'node:path';
import { isAggressivePaper } from './runtime.js';
import { proposePairedArbitrage, settlePairedArbitrage, recordArbitrageOpportunity } from './arbitrage.js';

function readBook(file) {
  if (!fs.existsSync(file)) return { mode: 'PAPER', cashUsd: 1000, open: [], history: [] };
  const book = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (book.mode !== 'PAPER' || !Number.isFinite(book.cashUsd) || book.cashUsd < 0 || !Array.isArray(book.open) || !Array.isArray(book.history)) throw new Error('Invalid paper arbitrage account');
  return book;
}
function saveBook(file, book) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2)); fs.renameSync(tmp, file);
}

// Reads public market/book endpoints only. A SELL is represented by a funded BUY of
// the complementary outcome: this paper lane never invents a naked short position.
export function createArbitragePoller({ platform, dataDir = process.env.MONEY_PRINTER_DATA_DIR || 'data', intervalMs = 60000, maxPairs = 4, quantity = 1, bufferBps = 100, now = Date.now } = {}) {
  const file = path.resolve(dataDir, 'arbitrage-paper.json'), journal = path.resolve(dataDir, 'arbitrage.ndjson');
  let lastAt = null, busy = false;
  async function tick({ state, mode = 'paper', runtime = state?.runtime } = {}) {
    if (!isAggressivePaper(runtime, mode)) return { enabled: false, reason: 'aggressive-paper-required', ordersSubmitted: 0 };
    const at = now();
    if (busy || lastAt !== null && at - lastAt < intervalMs) return { enabled: true, cached: true, ordersSubmitted: 0 };
    busy = true; lastAt = at;
    const result = { enabled: true, at, opportunities: 0, filled: 0, settled: 0, errors: [], ordersSubmitted: 0 };
    try {
      const book = readBook(file);
      for (const pair of [...book.open]) {
        try {
          const contracts = await Promise.all(pair.legs.map(leg => platform.contract(leg.venue, leg.marketId)));
          const outcomes = contracts.map(c => String(c.data.settlementOutcome || '').toUpperCase());
          if (outcomes.some(x => !['YES', 'NO'].includes(x))) continue;
          const payoutUsd = pair.legs.reduce((sum, leg, i) => sum + (leg.outcome === outcomes[i] ? pair.quantity : 0), 0);
          const closed = { ...pair, settledAt: at, payoutUsd, pnlUsd: payoutUsd - pair.costUsd, status: 'SETTLED', settlementMismatch: outcomes[0] !== outcomes[1] };
          book.cashUsd += payoutUsd; book.open = book.open.filter(x => x.id !== pair.id); book.history.unshift(closed); book.history = book.history.slice(0, 1000);
          saveBook(file, book); recordArbitrageOpportunity({ type: 'arbitrage-paper-settlement', ...closed }, journal); result.settled++;
        } catch (e) { result.errors.push(String(e.message)); }
      }
      const lists = await Promise.allSettled(['kalshi', 'polymarket'].map(venue => platform.markets(venue, { limit: 100 })));
      for (const x of lists) if (x.status === 'rejected') result.errors.push(String(x.reason?.message || x.reason));
      const pairs = platform.arbitrageCandidates({ limit: Math.min(10, Math.max(1, maxPairs)) }).pairs || [];
      for (const candidate of pairs.slice(0, maxPairs)) {
        try {
          const comparison = await platform.compare({ a: candidate.a, b: candidate.b, quantity });
          for (const direction of comparison.directions || []) {
            const edgeBps = Number(direction.effectiveSpread) * 10000;
            const eligible = direction.effectiveSpread !== null && edgeBps > bufferBps && direction.blocked.length === 0;
            const opportunity = { ok: eligible, reason: eligible ? null : direction.blocked.join(',') || 'edge-below-costs', grossEdgeBps: Number(direction.grossSpread) * 10000, netEdgeBps: edgeBps,
              requiredBps: bufferBps, match: { event: comparison.a.data.title, classification: comparison.classification }, quantity, capitalRequired: direction.capitalRequired,
              legs: [{ action: 'BUY', venue: candidate.a.venue, marketId: candidate.a.sourceId, outcome: direction.sideA, price: direction.venueA.averagePrice },
                { action: 'SELL', executionAction: 'BUY_COMPLEMENT', venue: candidate.b.venue, marketId: candidate.b.sourceId, outcome: direction.sideA, complementOutcome: direction.sideB, price: 1 - direction.venueB.averagePrice }] };
            result.opportunities++;
            const key = JSON.stringify([candidate.a, candidate.b, direction.sideA, direction.sideB]);
            const cost = Number(direction.capitalRequired);
            const canFill = eligible && !book.open.some(x => x.key === key) && book.open.length < 25 && cost > 0 && cost <= 500 && cost <= book.cashUsd;
            if (!canFill) { recordArbitrageOpportunity({ ...opportunity, executed: false, executionReason: eligible ? 'paper-budget-or-existing-pair' : opportunity.reason }, journal); continue; }
            const { proposal } = proposePairedArbitrage(state, opportunity, { mode, file: journal });
            const settled = settlePairedArbitrage(proposal, [{ ok: true, price: direction.venueA.averagePrice, fee: direction.feeA }, { ok: true, price: direction.venueB.averagePrice, fee: direction.feeB }], at);
            if (!settled.ok) continue;
            const position = { id: proposal.id, key, mode: 'PAPER', status: 'OPEN', openedAt: at, quantity, costUsd: cost,
              atomicSimulation: true, realVenueAtomicity: false,
              legs: [{ venue: candidate.a.venue, marketId: candidate.a.sourceId, outcome: direction.sideA, price: direction.venueA.averagePrice, fee: direction.feeA },
                { venue: candidate.b.venue, marketId: candidate.b.sourceId, outcome: direction.sideB, price: direction.venueB.averagePrice, fee: direction.feeB }] };
            book.cashUsd -= cost; book.open.push(position); saveBook(file, book);
            recordArbitrageOpportunity({ type: 'arbitrage-paper-fill', ...position }, journal); result.filled++;
          }
        } catch (e) { result.errors.push(String(e.message)); }
      }
      return result;
    } finally { busy = false; }
  }
  return { tick, file, journal };
}

const pollers = new WeakMap();
export function runArbitragePaperTick(platform, state, mode) {
  if (!pollers.has(platform)) pollers.set(platform, createArbitragePoller({ platform }));
  return pollers.get(platform).tick({ state, mode });
}
