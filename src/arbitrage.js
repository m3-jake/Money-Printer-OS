import fs from 'node:fs';
import path from 'node:path';
import { proposeTrade } from './proposals.js';

const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = x => Number.isFinite(Number(x)) ? Number(x) : null;

export function matchMarkets(a, b) {
  if (!a || !b) return { ok: false, reason: 'missing-market' };
  const eventA = norm(a.event || a.eventTitle || a.eventId), eventB = norm(b.event || b.eventTitle || b.eventId);
  const outcomeA = norm(a.outcome), outcomeB = norm(b.outcome);
  if (!eventA || eventA !== eventB) return { ok: false, reason: 'event-mismatch' };
  if (!outcomeA || outcomeA !== outcomeB) return { ok: false, reason: 'outcome-mismatch' };
  if (a.venue === b.venue) return { ok: false, reason: 'same-venue' };
  return { ok: true, event: eventA, outcome: outcomeA };
}

export function detectDislocation(a, b, { feesBps = 0, slippageBps = 0, bufferBps = 0 } = {}) {
  const match = matchMarkets(a, b), pa = num(a?.ask ?? a?.price), pb = num(b?.ask ?? b?.price);
  if (!match.ok || !(pa > 0) || !(pb > 0)) return { ok: false, match, reason: match.reason || 'invalid-price' };
  const grossEdgeBps = Math.abs(pa - pb) / Math.min(pa, pb) * 10_000;
  const requiredBps = Math.max(0, Number(feesBps) || 0) + Math.max(0, Number(slippageBps) || 0) + Math.max(0, Number(bufferBps) || 0);
  const cheap = pa <= pb ? a : b, rich = pa <= pb ? b : a;
  return { ok: grossEdgeBps > requiredBps, match, reason: grossEdgeBps > requiredBps ? null : 'edge-below-costs', grossEdgeBps, requiredBps,
    legs: [{ action: 'BUY', venue: cheap.venue, marketId: cheap.id, outcome: cheap.outcome, price: Math.min(pa, pb) },
      { action: 'SELL', venue: rich.venue, marketId: rich.id, outcome: rich.outcome, price: Math.max(pa, pb) }] };
}

export function recordArbitrageOpportunity(opportunity, file = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'arbitrage.ndjson')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { type: 'arbitrage-opportunity', mode: 'PAPER', at: Date.now(), ...opportunity };
  fs.appendFileSync(file, JSON.stringify(row) + '\n'); return row;
}

export function proposePairedArbitrage(state, opportunity, { mode = 'paper', file } = {}) {
  const row = recordArbitrageOpportunity(opportunity, file);
  if (mode !== 'paper' || !opportunity?.ok || opportunity.legs?.length !== 2) return { recorded: row, proposal: null };
  const proposal = { id: `arb-${Date.now()}`, kind: 'ARBITRAGE_PAIR', status: 'PENDING', createdAt: Date.now(),
    signalSource: 'cross-venue-arbitrage', legs: opportunity.legs.map(leg => ({ ...leg })), statusReason: 'paper-paired-proposal' };
  // Preserve the proposal contract by creating one parent entry through proposeTrade; legs remain atomically grouped.
  const parent = proposeTrade(state, { mint: `arbitrage:${proposal.id}`, symbol: 'ARB', name: opportunity.match.event, dominantSignal: 'cross-venue-arbitrage', signalSource: 'cross-venue-arbitrage' }, 0);
  Object.assign(parent, proposal);
  return { recorded: row, proposal: parent };
}
