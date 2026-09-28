// P1.1 — reconcile the legacy float books against the core BigInt ledger and REFUSE the coverage
// claim when they disagree.
//
// syncLegacyLedger() (platform.js) already compares the mirror account's CASH with the book's own
// cash and reports the difference, and legacyImport.js never books an adjustment. But cash alone is
// not a reconciliation: a book whose open cost basis, open position count or fee total has drifted
// still shows the same cash. And `coverage.legacyBooks:'MIRRORED_AND_RECONCILED_WHERE_POSSIBLE'` was
// a literal string in snapshot() — the claim was asserted, not derived. This module derives it.
//
// Nothing here writes and nothing here repairs. A book that does not reconcile is refused, never
// adjusted, and unknowns stay unknown (a null on either side is UNKNOWN, not a match).
//
// What is compared, per book, per currency — never converted, so a SOL book is only ever compared
// with the SOL mirror account:
//   cash            the mirror's own verdict: it compared against the plan's expectedCash with a
//                   row-scaled tolerance, and it is the same comparison, so it is authoritative
//   openCost        book open cost vs the mirror account's open cost basis
//   openPositions   count vs the mirror account's open positions (exact)
//   realized        book realized + open-position realized vs the ledger's realized
//   fees            book fees over the same scope vs the ledger's fee total
// The last four are derived from what legacyImport.js plans to post (see the fields added to
// legacyBooks.js), so a disagreement here is a real one, not a rounding or scope artifact.
export const STATES = Object.freeze({ RECONCILED: 'RECONCILED', DIFFERENCE: 'DIFFERENCE', FAILED: 'FAILED', UNAVAILABLE: 'UNAVAILABLE', NOT_MIRRORED: 'NOT_MIRRORED' });
// States that make "reconciled" false. NOT_MIRRORED is deliberately absent: a book with no mirror
// account (US combos have no readable venue balance) has no reconciliation to fail, and the claim
// says so by name.
export const UNRECONCILED_STATES = Object.freeze([STATES.DIFFERENCE, STATES.FAILED]);
export const CLAIM = Object.freeze({ ok: 'MIRRORED_AND_RECONCILED_WHERE_POSSIBLE', refused: 'MIRRORED_WITH_UNRECONCILED_DIFFERENCE' });
// source -> the venue the mirror books under, so the platform and the tests join on one table.
export const MIRROR_VENUES = Object.freeze({ solana: 'solana-paper', 'robinhood-practice': 'robinhood-practice' });
export const mirrorAccount = epoch => `legacy-${Number(epoch) || 1}`;

const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const r6 = v => Math.round(Number(v) * 1e6) / 1e6;
// One rounding step per compared row: legacyImport rounds to 6 dp, so a long book must not be called
// a difference for accumulating 6-decimal rounding, and a single-row book must not hide a real drift.
export const toleranceFor = (rows, base = 1e-6) => base * (Math.max(0, Number(rows) || 0) + 1);

const field = (name, bookValue, ledgerValue, tolerance, reason = null) => {
  if (bookValue === null || ledgerValue === null) return { field: name, state: 'UNKNOWN', book: bookValue, ledger: ledgerValue, reason: reason || 'One side of this comparison is unknown; unknowns are not treated as matches' };
  const diff = Math.abs(ledgerValue - bookValue);
  return { field: name, state: diff > tolerance ? 'DIFFERENCE' : 'MATCH', book: bookValue, ledger: ledgerValue, diff: r6(ledgerValue - bookValue), tolerance: r6(tolerance) };
};


// books: one legacyCoverage() book. mirrorRow: its legacy_sync row. account: its mirror account from
// ledger.portfolio() (or null). Returns the verdict for that one book.
export function reconcileBook({ book = null, venue = null, mirrorRow = null, account = null, tolerance = 1e-6 } = {}) {
  const source = book?.source || mirrorRow?.source || null;
  const base = { source, venue, currency: book?.currency ?? null, account: account ? account.account || null : null, epoch: mirrorRow?.epoch ?? null, fields: [], differences: [] };
  const done = (state, reason, extra = {}) => ({ ...base, ...extra, state, reason, promotionRefused: UNRECONCILED_STATES.includes(state) });
  if (!book) return done(STATES.UNAVAILABLE, 'No legacy book loaded for this source');
  if (book.status === 'UNAVAILABLE') return done(STATES.UNAVAILABLE, `Book not readable: ${book.reason || 'unknown reason'}`);
  const row = mirrorRow || null;
  if (row?.status === 'FAILED') return done(STATES.FAILED, `Mirroring stopped on a refused entry: ${row.detail?.failed || 'see the mirror detail'}`);
  if (row?.status === 'UNAVAILABLE') return done(STATES.UNAVAILABLE, `Mirror could not read the book: ${row.reason || row.detail?.reason || 'unknown reason'}`);
  if (!row || row.status === 'NOT_MIRRORED') return done(STATES.NOT_MIRRORED, venue
    ? 'No mirror has run for this book yet, so there is nothing to reconcile it against'
    : 'This book has no mirror account (the venue balance is not readable), so it cannot be reconciled');
  if (!account) return done(STATES.DIFFERENCE, 'The mirror says this book is mirrored, but its ledger account is not in the portfolio', { differences: [{ field: 'account', state: 'DIFFERENCE', book: null, ledger: null, reason: `No account ${mirrorAccount(row.epoch)} for ${venue || source}` }] });
  // The caller resolves the account by venue and epoch, but the comparison refuses to cross books
  // anyway: a SOL book is never reconciled against a USD account that happens to hold the same
  // number, which is the one mistake this whole module exists to prevent.
  if (book.currency && account.currency && account.currency !== book.currency) return done(STATES.DIFFERENCE, `Refusing to compare across books: this is a ${book.currency} book and the account is in ${account.currency}`, { differences: [{ field: 'account', state: 'DIFFERENCE', book: book.currency, ledger: account.currency, reason: `A ${book.currency} book cannot be reconciled against a ${account.currency} account` }] });
  if (venue && account.venue && account.venue !== venue) return done(STATES.DIFFERENCE, `Refusing to compare across books: this book mirrors into ${venue} and the account belongs to ${account.venue}`, { differences: [{ field: 'account', state: 'DIFFERENCE', book: venue, ledger: account.venue, reason: `Wrong mirror venue for ${source}` }] });

  const positions = Array.isArray(account.positions) ? account.positions : [];
  const rows = (num(book.openPositions) || 0) + positions.length;
  const tol = toleranceFor(rows, tolerance);
  const ledgerOpen = positions.reduce((s, p) => s + (num(p.costBasis) || 0), 0);
  const syncDiff = num(row.detail?.diff);
  const bookCash = num(book.cash), ledgerCash = num(account.cash);
  // Cash carries the mirror's verdict: a difference it already reported stays a difference here even
  // if these rounded floats happen to agree, and the diff it recorded is what gets shown.
  const cash = bookCash === null || ledgerCash === null
    ? { field: 'cash', state: 'UNKNOWN', book: bookCash, ledger: ledgerCash, diff: syncDiff, reason: 'One side of the cash comparison is unknown' }
    : { field: 'cash', state: row.status === 'DIFFERENCE' ? 'DIFFERENCE' : 'MATCH', book: bookCash, ledger: ledgerCash, diff: syncDiff === null ? r6(ledgerCash - bookCash) : syncDiff, judgedBy: 'mirror-verdict' };
  const count = num(book.openPositions);
  const openPositions = count === null
    ? { field: 'openPositions', state: 'UNKNOWN', book: null, ledger: positions.length, reason: 'The book does not report an open position count' }
    : { field: 'openPositions', state: count === positions.length ? 'MATCH' : 'DIFFERENCE', book: count, ledger: positions.length, diff: positions.length - count };
  const openCost = field('openCost', num(book.openCost), positions.length ? ledgerOpen : num(book.openCost) === null ? null : 0, tol);
  const openRealized = num(book.openRealized);
  const realized = field('realized', num(book.realized) === null || openRealized === null ? null : num(book.realized) + openRealized, num(account.realized), tol,
    openRealized === null ? 'The book does not report realized on its open positions, so the mirrored realized cannot be predicted' : null);
  if (realized.state !== 'UNKNOWN') realized.scope = `${book.realizedScope || 'book lifetime'}${openRealized ? ' plus open-position realized' : ''}`;
  const fees = field('fees', num(book.fees), num(account.fees), tol, 'The book does not report a fee total over the mirrored scope');
  const fields = [cash, openPositions, openCost, realized, fees];
  const differences = fields.filter(f => f.state === 'DIFFERENCE');
  const state = differences.length ? STATES.DIFFERENCE : STATES.RECONCILED;
  return done(state, differences.length
    ? `Ledger and book disagree on ${differences.map(d => d.field).join(', ')}. Nothing was booked to hide it.`
    : 'Ledger and book agree on cash, open cost, open positions, realized and fees.', { fields, differences, tolerance: r6(tol), compared: fields.filter(f => f.state !== 'UNKNOWN').length, unknown: fields.filter(f => f.state === 'UNKNOWN').map(f => f.field) });
}

// coverage: a legacyCoverage() result. mirrors: legacy_sync rows (epoch + status + detail).
// accounts: ledger.portfolio().accounts. Every book gets a verdict, including the ones with no mirror.
export function reconcileLegacyBooks({ coverage = null, mirrors = [], accounts = [], tolerance = 1e-6, at = Date.now() } = {}) {
  const rows = new Map((mirrors || []).map(r => [r.source, r]));
  const books = (coverage?.books || []).map(book => {
    const venue = MIRROR_VENUES[book.source] || null;
    const row = rows.get(book.source) || null;
    const account = venue && row ? (accounts || []).find(a => a.venue === venue && a.account === mirrorAccount(row.epoch)) || null : null;
    return reconcileBook({ book, venue, mirrorRow: row, account, tolerance });
  });
  const states = {};
  for (const b of books) states[b.state] = (states[b.state] || 0) + 1;
  return { at, books, states, claim: coverageClaim(books), note: 'Read-only comparison of each legacy book against its mirror account, per currency, never summed or converted.' };
}

// The claim the platform publishes. It is a refusal, not a repair: the wording only says reconciled
// when every book that has a mirror actually reconciles, and every proven disagreement is named.
export function coverageClaim(books = []) {
  const refused = (books || []).filter(b => UNRECONCILED_STATES.includes(b.state)).map(b => ({ source: b.source, state: b.state, reason: b.reason, fields: (b.differences || []).map(d => d.field) }));
  const unverified = (books || []).filter(b => [STATES.UNAVAILABLE, STATES.NOT_MIRRORED].includes(b.state)).map(b => ({ source: b.source, state: b.state, reason: b.reason }));
  return { legacyBooks: refused.length ? CLAIM.refused : CLAIM.ok, promotionAllowed: refused.length === 0, refused, unverified, checked: (books || []).filter(b => b.state === STATES.RECONCILED).length };
}

