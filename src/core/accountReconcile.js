// Read-only reconciliation of real venue accounts against the LIVE side of the unified ledger.
// This is the prerequisite live trading would need; it never unlocks anything (the execution
// boundary stays closed regardless of the result). Venue reads are GET-only, through the existing
// venue modules supplied by the host.
//
// snapshot: { ok, venue, cashUsd|null, positions: [{ asset, qty }] | null, error?, code? }
// ledger:   the LIVE portfolio account for the venue (cash string, positions with quantity) or null.
// Result states: NO_CREDENTIALS, AUTH_ERROR, READ_FAILED, NOT_IN_LEDGER (venue holds value the ledger
// has never recorded), DIFFERENCE, RECONCILED. Unknown venue fields stay unknown and are not compared.

const n = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function reconcileVenue(snapshot, ledgerAccount, { cashTolerance = 0.01, qtyTolerance = 1e-8 } = {}) {
  const venue = snapshot?.venue || 'unknown';
  if (!snapshot || snapshot.ok !== true) {
    const code = snapshot?.code || 'READ_FAILED';
    return { venue, state: code === 'NO_CREDENTIALS' ? 'NO_CREDENTIALS' : code === 'AUTH_ERROR' ? 'AUTH_ERROR' : 'READ_FAILED', detail: snapshot?.error || null, differences: [] };
  }
  const venueCash = n(snapshot.cashUsd), ledgerCash = ledgerAccount ? n(ledgerAccount.cash) : null, differences = [];
  if (!ledgerAccount) {
    const holdsValue = (venueCash ?? 0) > cashTolerance || (snapshot.positions || []).some(p => Math.abs(n(p.qty) || 0) > qtyTolerance);
    return { venue, state: holdsValue ? 'NOT_IN_LEDGER' : 'RECONCILED', venueCash, ledgerCash: null, differences, detail: holdsValue ? 'The venue holds value the ledger has never recorded. Record the opening balance (explicit confirmation) or leave it unreconciled.' : 'Empty venue account and empty ledger.' };
  }
  if (venueCash !== null && Math.abs(venueCash - ledgerCash) > cashTolerance) differences.push({ field: 'cashUsd', venue: venueCash, ledger: ledgerCash });
  if (Array.isArray(snapshot.positions)) {
    const led = new Map((ledgerAccount.positions || []).map(p => [String(p.asset || p.instrumentId), n(p.quantity)]));
    const assets = new Set([...snapshot.positions.map(p => String(p.asset)), ...led.keys()]);
    for (const a of assets) { const v = n(snapshot.positions.find(p => String(p.asset) === a)?.qty) ?? 0, l = led.get(a) ?? 0; if (Math.abs(v - l) > qtyTolerance) differences.push({ field: `position:${a}`, venue: v, ledger: l }); }
  }
  return { venue, state: differences.length ? 'DIFFERENCE' : 'RECONCILED', venueCash, ledgerCash, differences, positionsCompared: Array.isArray(snapshot.positions), detail: Array.isArray(snapshot.positions) ? null : 'Venue positions are not readable; cash only.' };
}
