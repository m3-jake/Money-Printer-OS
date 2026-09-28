// Read-only coverage of books that still live in their original programs (Solana paper engine,
// Robinhood practice, Polymarket US combos). Nothing here writes to the core ledger: those books
// have no reconciled import yet, so they are reported next to it, never summed into it.
// Currencies are never converted (no FX or SOL price is invented). Missing values stay null.
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const sum = (rows, f) => { let t = 0; for (const r of rows) { const v = num(f(r)); if (v === null) return null; t += v; } return t; };
const unavailable = (source, label, currency, mode, reason) => ({ source, label, currency, mode, status: 'UNAVAILABLE', reason, cash: null, openCost: null, openPositions: null, realized: null, start: null, asOf: null });

export function solanaLegacy(s) {
  if (!s || typeof s !== 'object') return unavailable('solana', 'Solana paper engine', 'SOL', 'PAPER', 'Engine state not loaded');
  const positions = Array.isArray(s.positions) ? s.positions : [], history = Array.isArray(s.history) ? s.history : [];
  return { source: 'solana', label: 'Solana paper engine', currency: 'SOL', mode: 'PAPER', status: 'LEGACY_READ_ONLY', reason: null,
    cash: num(s.cashSol), start: num(s.paperStartSol), openPositions: positions.length,
    openCost: sum(positions, p => p.remainingSol ?? p.sizeSol),
    // History is capped at the last 1500 closes, so this is realized P/L over the retained window only.
    realized: sum(history, h => h.pnlSol), realizedScope: `last ${history.length} closes`, asOf: num(s.updatedAt) ?? null,
    // What the ledger mirror of THIS book must show, for the reconciliation in bookReconcile.js.
    // solanaPlan grosses a sell's proceeds up by its fees and books the fees as a separate FEE entry,
    // so the ledger's realized is (history pnl) + (partial-exit pnl still open) and its fee total is
    // every trade's fees, closed or open. Null anywhere stays null: unknown is never guessed.
    openRealized: sum(positions, p => p.realizedSol), fees: sum([...history, ...positions], t => t.feesSol) };
}

export function robinhoodPracticeLegacy(snap) {
  if (!snap || typeof snap !== 'object') return unavailable('robinhood-practice', 'Robinhood practice', 'USD', 'PAPER', 'Practice book not loaded');
  const positions = Array.isArray(snap.positions) ? snap.positions : [];
  return { source: 'robinhood-practice', label: 'Robinhood practice', currency: 'USD', mode: 'PAPER', status: snap.recoveryRequired ? 'RECOVERY_REQUIRED' : 'LEGACY_READ_ONLY',
    reason: snap.recoveryReason || null, cash: num(snap.cashUsd), start: num(snap.budgetUsd), openPositions: positions.length,
    openCost: sum(positions, p => p.costUsd), realized: num(snap.realizedPnlUsd), realizedScope: 'book lifetime', asOf: num(snap.at),
    // practicePlan mirrors BUY at cost and SELL at proceeds (cost + pnl) with no FEE entries, so an open
    // position contributes nothing to realized and the mirror account's fee total is 0 by construction.
    openRealized: 0, fees: 0 };
}

// US combo entries are real venue orders placed manually. They are not reconciled against the venue,
// so they are labelled LIVE_UNRECONCILED and unverified fills are counted separately.
export function usCombosLegacy(journal) {
  if (!journal || typeof journal !== 'object') return unavailable('polymarket-us-combos', 'Polymarket US combos', 'USD', 'LIVE_UNRECONCILED', 'Combo journal not loaded');
  const open = Array.isArray(journal.open) ? journal.open : [];
  return { source: 'polymarket-us-combos', label: 'Polymarket US combos', currency: 'USD', mode: 'LIVE_UNRECONCILED',
    status: journal.recoveryRequired ? 'RECOVERY_REQUIRED' : 'LEGACY_READ_ONLY', reason: journal.recoveryError || null,
    cash: null, start: null, openPositions: open.length, unverifiedFills: open.filter(x => x.fillVerified !== true).length,
    openCost: sum(open, x => x.costUsd ?? x.stakeUsd), realized: num(journal.stats?.pnlUsd), realizedScope: 'journal lifetime', asOf: null };
}

// Per-currency totals of what is known. A null anywhere in a currency makes that total null.
export function legacyTotals(books) {
  const out = {};
  for (const b of books) {
    if (b.status === 'UNAVAILABLE') continue;
    const t = out[b.currency] ||= { currency: b.currency, openCost: 0, realized: 0, books: 0 };
    t.books++;
    t.openCost = t.openCost === null || b.openCost === null ? null : t.openCost + b.openCost;
    t.realized = t.realized === null || b.realized === null ? null : t.realized + b.realized;
  }
  return Object.values(out);
}

export function legacyCoverage(readers = {}) {
  const books = [['solana', solanaLegacy], ['robinhoodPractice', robinhoodPracticeLegacy], ['usCombos', usCombosLegacy]].map(([key, view]) => {
    try { return view(readers[key]?.()); }
    catch (e) { return { ...view(null), reason: `Read failed: ${String(e?.message || e).slice(0, 160)}` }; }
  });
  return { books, totals: legacyTotals(books), note: 'Read-only. These books are not in the core ledger and are never converted between currencies.' };
}
