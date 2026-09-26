import { stableId } from './model.js';

// Mirrors legacy books into the unified ledger and reconciles them. Each sync is idempotent: every
// entry has a fixed source key, and partial exits and fees are posted as DELTAS against what the
// ledger already holds for that trade. After a sync, the ledger's cash for the mirror account is
// compared with the book's own cash; any difference is REPORTED, never booked as an adjustment.
//
// Solana paper book (state.json) cash identity, verified on real data:
//   cashSol = paperStartSol + Σ closed pnlSol − Σ open remainingSol + Σ open realizedSol
// A position is mirrored in units of entry SOL: BUY size; SELL sold units for gross proceeds
// (sold + realized + fees); FEE entries for fees. Closed trades use size / pnlSol / feesSol.
// Robinhood practice: BUY costUsd at open, SELL exit proceeds at close.
// Polymarket US combos are real orders with no readable account balance: not mirrored.

const r6 = v => Math.round(Number(v) * 1e6) / 1e6, r8 = v => Math.round(Number(v) * 1e8) / 1e8;
const dec = (v, dp) => { const n = dp === 8 ? r8(v) : r6(v); return (n < 0 ? 0 : n).toFixed(dp); };

// mirrored: Map(instrumentId -> { bought, sold, soldGross, fees }) from the ledger.
export function solanaPlan(s, { epoch = 1, mirrored = new Map(), venue = 'solana-paper', account = `legacy-${epoch}` } = {}) {
  const out = [], notes = [], trades = [...(s.history || []).map(t => ({ ...t, closed: true })), ...(s.positions || []).map(t => ({ ...t, closed: false }))];
  const firstAt = Math.min(...trades.map(t => Number(t.openedAt)).filter(Number.isFinite), Date.now());
  const base = { mode: 'PAPER', venue, account, currency: 'SOL' };
  out.push({ ...base, sourceKey: `legacy:solana:${epoch}:deposit`, at: Math.max(1, firstAt - 1), kind: 'DEPOSIT', gross: dec(s.paperStartSol, 6), reference: 'Solana paper book starting balance (paperStartSol)' });
  for (const t of trades) {
    const size = Number(t.sizeSol), inst = stableId('Instrument', venue, String(t.id)), m = mirrored.get(inst) || { bought: 0, sold: 0, soldGross: 0, fees: 0 };
    if (!(size > 0) || !t.id) { notes.push(`Skipped trade without id/size (${t.symbol || '?'})`); continue; }
    const meta = { instrumentId: inst, strategyId: t.strategy || 'solana', eventId: stableId('Asset', 'solana', String(t.mint || t.id)) };
    const boughtUnits = r8(size);
    if (m.bought === 0) out.push({ ...base, ...meta, sourceKey: `legacy:solana:${epoch}:buy:${t.id}`, at: Number(t.openedAt) || firstAt, kind: 'BUY', quantity: dec(boughtUnits, 8), gross: dec(size, 6), reference: `Solana paper entry ${t.symbol || ''} ${t.mint || ''}`.trim() });
    const fees = Number(t.feesSol) || 0, realized = t.closed ? Number(t.pnlSol) : Number(t.realizedSol) || 0;
    const soldUnits = t.closed ? boughtUnits : r8(Math.max(0, Math.min(size, size - Number(t.remainingSol || 0))));
    const soldGross = r6(t.closed ? size + realized + fees : (size - Number(t.remainingSol || 0)) + realized + fees);
    const dUnits = r8(Math.min(boughtUnits, soldUnits) - m.sold), dGross = r6(soldGross - m.soldGross), dFees = r6(fees - m.fees);
    const at = Number(t.closed ? t.closedAt : t.priceObservedAt || t.openedAt) || Date.now();
    if (dUnits > 0) { if (dGross < 0) notes.push(`Trade ${t.id}: proceeds went down after a sell; not mirrored`); else out.push({ ...base, ...meta, sourceKey: `legacy:solana:${epoch}:sell:${t.id}:${dec(soldUnits, 8)}`, at, kind: 'SELL', quantity: dec(dUnits, 8), gross: dec(dGross, 6), reference: `Solana paper ${t.closed ? 'exit' : 'partial exit'} ${t.symbol || ''}${t.reason ? ' (' + t.reason + ')' : ''}` }); }
    if (dFees > 0) out.push({ ...base, ...meta, sourceKey: `legacy:solana:${epoch}:fee:${t.id}:${dec(fees, 6)}`, at, kind: 'FEE', gross: dec(dFees, 6), reference: `Solana paper fees ${t.symbol || ''}` });
  }
  return { entries: out, notes, expectedCash: Number(s.cashSol), account, venue, currency: 'SOL' };
}

export function practicePlan(book, { epoch = 1, mirrored = new Map(), venue = 'robinhood-practice', account = `legacy-${epoch}` } = {}) {
  const out = [], notes = [], base = { mode: 'PAPER', venue, account, currency: 'USD' };
  const trades = [...(book.history || []), ...(book.positions || [])];
  const firstAt = Math.min(...trades.map(t => Number(t.openedAt)).filter(Number.isFinite), Number(book.createdAt) || Date.now());
  out.push({ ...base, sourceKey: `legacy:rh-practice:${epoch}:deposit`, at: Math.max(1, firstAt - 1), kind: 'DEPOSIT', gross: dec(book.startUsd, 6), reference: 'Robinhood practice book budget (startUsd)' });
  for (const t of trades) {
    if (!t.id || !(Number(t.costUsd) > 0) || !(Number(t.qty) > 0)) { notes.push(`Skipped practice trade without id/cost/qty`); continue; }
    const inst = stableId('Instrument', venue, String(t.id)), meta = { instrumentId: inst, strategyId: t.placedBy || 'practice', eventId: stableId('Asset', 'crypto', String(t.symbol || 'unknown')) };
    if (!(mirrored.get(inst)?.bought > 0)) out.push({ ...base, ...meta, sourceKey: `legacy:rh-practice:${epoch}:buy:${t.id}`, at: Number(t.openedAt) || firstAt, kind: 'BUY', quantity: dec(t.qty, 8), gross: dec(t.costUsd, 6), reference: `Robinhood practice entry ${t.symbol}` });
    if (t.status === 'CLOSED' && !(mirrored.get(inst)?.sold > 0)) {
      const proceeds = Number(t.exit?.proceedsUsd ?? (Number(t.costUsd) + Number(t.pnlUsd)));
      if (!(proceeds >= 0)) { notes.push(`Practice trade ${t.id}: no exit proceeds`); continue; }
      out.push({ ...base, ...meta, sourceKey: `legacy:rh-practice:${epoch}:sell:${t.id}`, at: Number(t.closedAt) || Date.now(), kind: 'SELL', quantity: dec(t.qty, 8), gross: dec(proceeds, 6), reference: `Robinhood practice exit ${t.symbol} (${t.exit?.reason || 'closed'})` });
    }
  }
  return { entries: out, notes, expectedCash: Number(book.cashUsd), account, venue, currency: 'USD' };
}
