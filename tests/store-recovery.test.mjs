import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-recovery-'));
let sequence = 0;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
async function fixture(primary, backup) {
  const dir = path.join(root, String(++sequence));
  fs.mkdirSync(dir);
  process.env.MONEY_PRINTER_DATA_DIR = dir;
  const write = (name, value) => fs.writeFileSync(path.join(dir, name),
    typeof value === 'string' ? value : JSON.stringify(value));
  if (primary !== undefined) write('state.json', primary);
  if (backup !== undefined) write('state.backup.json', backup);
  const module = process.env.STORE_TEST_MODULE || '../src/store.js';
  const store = await import(new URL(module + '?case=' + sequence, import.meta.url));
  return { ...store, dir, read: name => fs.readFileSync(path.join(dir, name), 'utf8') };
}
const account = cashSol => ({ cashSol, paperStartSol: 10, positions: [], history: [] });
test('first launch initializes, while zero cash survives reload', async () => {
  const f = await fixture();
  assert.ok(f.loadState().cashSol > 0);
  f.saveState(account(0));
  assert.equal(f.loadState().cashSol, 0);
});
test('truncated primary recovers exact balance and pauses entries', async () => {
  const f = await fixture('{"cashSol":', account(3.25));
  const s = f.loadState();
  assert.equal(s.cashSol, 3.25);
  assert.equal(s.system.paused, true);
  assert.equal(s.system.killSwitch, true);
  assert.equal(s.system.recovery.status, 'BACKUP_RECOVERED');
});
test('unrecoverable files are preserved instead of minting a new bankroll', async () => {
  for (const [primary, backup] of [['{', '{'], ['{', undefined], [undefined, '{'],
    [{}, undefined], [null, undefined], [[], undefined], [account(null), undefined]]) {
    const f = await fixture(primary, backup);
    assert.throws(() => f.loadState(), { code: 'STATE_RECOVERY_REQUIRED' });
    if (primary !== undefined) assert.ok(fs.existsSync(path.join(f.dir, 'state.json')));
  }
});
test('missing primary recovers backup with a visible pause', async () => {
  const f = await fixture(undefined, account(2));
  assert.equal(f.loadState().cashSol, 2);
  assert.equal(f.loadState().system.paused, true);
});
test('saving recovered state cannot destroy the good backup', async () => {
  const f = await fixture('{', account(4));
  const before = f.read('state.backup.json');
  f.saveState(f.loadState());
  assert.equal(f.read('state.backup.json'), before);
  assert.equal(f.loadState().cashSol, 4);
  assert.equal(f.loadState().system.killSwitch, true);
});
test('invalid balances and shapes never replace valid primary or backup', async () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, null, '10']) {
    const f = await fixture(account(5), account(4));
    const before = f.read('state.json'), backup = f.read('state.backup.json');
    assert.throws(() => f.saveState(account(bad)), /Invalid account state/);
    assert.equal(f.read('state.json'), before);
    assert.equal(f.read('state.backup.json'), backup);
  }
  for (const patch of [{ positions: null }, { history: {} }, { paperStartSol: Infinity }]) {
    const f = await fixture(account(5));
    assert.throws(() => f.saveState({ ...account(5), ...patch }), /Invalid account state/);
  }
});
test('valid saves retain the preceding account as recoverable backup', async () => {
  const f = await fixture(account(5), account(4));
  f.saveState(account(6));
  assert.equal(JSON.parse(f.read('state.backup.json')).cashSol, 5);
  assert.equal(f.loadState().cashSol, 6);
  assert.ok(!fs.readdirSync(f.dir).some(n => n.endsWith('.tmp')));
});
test('failed primary publication leaves the old account readable', async () => {
  const f = await fixture(account(5), account(4));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'state.json')) throw new Error('simulated rename failure');
    return rename(from, to);
  };
  try { assert.throws(() => f.saveState(account(6)), /simulated rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(f.loadState().cashSol, 5);
});
test('failed backup publication keeps prior recovery bytes', async () => {
  const f = await fixture(account(5), account(4));
  const before = f.read('state.backup.json'), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'state.backup.json')) throw new Error('simulated backup failure');
    return rename(from, to);
  };
  try { f.saveState(account(6)); } finally { fs.renameSync = rename; }
  assert.equal(f.read('state.backup.json'), before);
  assert.equal(f.loadState().cashSol, 6);
  assert.ok(!fs.readdirSync(f.dir).some(n => n.endsWith('.tmp')));
});

// ---------------------------------------------------------------------------------------------
// ACCOUNTING-AUDIT F1/F2/F3/F4/F6 — every one of these asserts THROUGH the load/save path.
// The pre-existing accounting tests bypassed it ("merge happens via reset/load patterns — call
// paperIdentity + guard directly"), which is exactly where the defects lived.
// ---------------------------------------------------------------------------------------------
const accounting = await import('../src/accounting.js');

const legacyHistory = (rows, first = Date.now() - rows * 1000) =>
  Array.from({ length: rows }, (_, i) => ({ closedAt: first + i * 1000, pnlSol: (i % 7) - 3 }));
const sumPnl = rows => rows.reduce((q, r) => q + r.pnlSol, 0);

// F1 — a legacy bankroll that predates the ledger must reconstruct on load. fresh() used to seed
// pnlLedger: [] / realizedLifetimePnlSol: 0 UNDER the persisted state, so ensurePnlLedger's
// guards never fired: lifetime PnL silently became 0 while cashSol carried the whole history.
test('F1 legacy state without a ledger reconstructs lifetime pnl through loadState', async () => {
  const history = legacyHistory(40);
  const life = sumPnl(history);
  const f = await fixture({ paperStartSol: 10, cashSol: 10 + life, positions: [], history });
  const r = f.loadState();
  assert.ok(Math.abs(r.realizedLifetimePnlSol - life) < 1e-9,
    `lifetime ${r.realizedLifetimePnlSol} != sum(history) ${life}`);
  assert.equal(r.pnlLedger.length, history.length);
  const id = accounting.paperIdentity(r);
  assert.equal(id.okExact, true);
  assert.ok(Math.abs(id.holeExact) <= 1e-9);
});

// F3 — history is a 1500-row ring, so it is never a source of truth for lifetime PnL.
test('F3 uncapped strategy totals beat the 1500-row history ring, and the cut is stamped', async () => {
  // 3100 lifetime closes; the on-disk history ring only reaches back 1600 of them, and pruneState
  // will cut that to 1500 on the next save. The strategy totals are never capped.
  const history = Array.from({ length: 1600 }, (_, i) => ({ closedAt: 1_700_000_000_000 + i * 1000, pnlSol: 0.001 }));
  const ringSum = sumPnl(history.slice(-1500));   // 1.5
  const inFile = sumPnl(history);                 // 1.6
  const trueLife = 3.1;                           // what the strategies actually booked
  const f = await fixture({
    paperStartSol: 10, cashSol: 10 + trueLife, positions: [], history,
    strategies: { UNIFIED_EDGE: { trades: 3100, pnlSol: trueLife } },
  });
  const r = f.loadState();
  assert.ok(Math.abs(r.realizedLifetimePnlSol - trueLife) < 1e-9,
    `lifetime ${r.realizedLifetimePnlSol} should be the strategy total ${trueLife}`);
  assert.ok(Math.abs(r.realizedLifetimePnlSol - ringSum) > 1e-9);
  assert.ok(Math.abs(r.realizedLifetimePnlSol - inFile) > 1e-9);
  assert.equal(r.pnlLedgerTruncatedBefore, history[0].closedAt);
  assert.equal(accounting.paperIdentity(r).okExact, true);
});

// F4 — nothing ever cleared system.accountingAlert; merge carried it forward and pinned health.
test('F4 a stale accounting alert is cleared once the books are clean', async () => {
  const f = await fixture({
    paperStartSol: 10, cashSol: 10, positions: [], history: [], pnlLedger: [], realizedLifetimePnlSol: 0,
    system: { health: 'HEALTHY', accountingAlert: { code: 'PAPER_IDENTITY', at: 1, alerts: [] } },
  });
  const r = f.loadState();
  assert.equal(r.system.accountingAlert, undefined);
  assert.equal(r.system.health, 'HEALTHY');
});

// F2 — the alert threshold used to be max(0.5, start*0.25) against the INEXACT hole, so the real
// 0.544 SOL hole on a 1 SOL bankroll cleared the bar by 0.044 and raised nothing.
test('F2 a small hole on a 1 SOL bankroll now raises PAPER_IDENTITY', async () => {
  const f = await fixture({
    paperStartSol: 1, cashSol: 1.11, positions: [], history: [], pnlLedger: [], realizedLifetimePnlSol: 0,
    system: { health: 'HEALTHY' },
  });
  const r = f.loadState();
  assert.equal(r.system.accountingAlert?.code, 'PAPER_IDENTITY');
  assert.ok(Math.abs(r._accounting.holeExact - 0.11) < 1e-9);
});

// F6 — the +7.359989876 SOL money-creation event: realizedSol (and therefore cash) rewritten on a
// position whose remainingSol did not move by a single lamport.
const pegState = () => ({
  paperStartSol: 10,
  cashSol: 9.3985,
  positions: [{
    id: 'peg-1', mint: 'PEGmint', symbol: 'PEG', sizeSol: 0.6, remainingSol: 0.6,
    entryPrice: 1e-5, lastPrice: 1.1e-5, realizedSol: -0.0015, feesSol: 0.0015,
  }],
  history: [], pnlLedger: [], realizedLifetimePnlSol: 0, system: { health: 'HEALTHY' },
});

test('F6 saveState refuses realized cash with no basis sold, and publishes nothing', async () => {
  const f = await fixture(pegState());
  const loaded = f.loadState();
  assert.equal(accounting.paperIdentity(loaded).okExact, true);
  const before = f.read('state.json');

  const corrupt = JSON.parse(JSON.stringify(loaded));
  corrupt.positions[0].realizedSol += 7.359989876;     // the PEG rewrite
  corrupt.cashSol += 7.359989876;                      // the cash it created
  corrupt.positions[0].priceIntegrityRepairAt = 1789070014803;
  // the books still "balance" — openRz absorbs it — which is why the identity alone never caught it
  assert.equal(accounting.paperIdentity(corrupt).okExact, true);
  assert.throws(() => f.saveState(corrupt), e => e?.code === 'REALIZED_WITHOUT_BASIS');
  assert.equal(f.read('state.json'), before, 'the corrupt state must never reach disk');

  // a real TP1 partial — 35% of basis out, proceeds in at the position's own mark — still saves
  const legit = JSON.parse(JSON.stringify(loaded));
  const p = legit.positions[0];
  const soldBasis = 0.21, proceeds = soldBasis * 1.1;
  p.remainingSol -= soldBasis;
  p.realizedSol += proceeds - soldBasis;
  p.tp1Done = true;
  legit.cashSol += proceeds;
  f.saveState(legit);
  assert.ok(Math.abs(f.loadState().positions[0].remainingSol - 0.39) < 1e-9);
});

test('F6 realized cash above what the position could possibly be worth is refused', async () => {
  const f = await fixture(pegState());
  const loaded = f.loadState();
  const corrupt = JSON.parse(JSON.stringify(loaded));
  const p = corrupt.positions[0];
  const soldBasis = 0.21;
  p.remainingSol -= soldBasis;
  p.realizedSol += soldBasis * 101.8;   // re-priced against the 101.8x bogus mark
  corrupt.cashSol += soldBasis * 101.8;
  assert.throws(() => f.saveState(corrupt), e => e?.code === 'REALIZED_EXCEEDS_MARK');
});

test('F6 a position appearing with positive realized cash is refused', async () => {
  const f = await fixture(pegState());
  const loaded = f.loadState();
  const corrupt = JSON.parse(JSON.stringify(loaded));
  corrupt.positions.push({ id: 'ghost-1', mint: 'GHOST', sizeSol: 0.5, remainingSol: 0.5, entryPrice: 1e-5, lastPrice: 1e-5, realizedSol: 7.36 });
  corrupt.cashSol += 7.36 - 0.5;
  assert.throws(() => f.saveState(corrupt), e => e?.code === 'REALIZED_WITHOUT_BASIS');
});

test('F6 ordinary opens and closes are unaffected', async () => {
  const f = await fixture(pegState());
  const s = f.loadState();
  s.positions.push({ id: 'new-1', mint: 'NEW', sizeSol: 0.4, remainingSol: 0.4, entryPrice: 2e-5, lastPrice: 2e-5, realizedSol: -0.001, feesSol: 0.001 });
  s.cashSol -= 0.401;
  f.saveState(s);
  const r = f.loadState();
  assert.equal(r.positions.length, 2);
  r.positions = r.positions.filter(p => p.id !== 'new-1');   // closed out entirely
  r.cashSol += 0.4;
  f.saveState(r);
  assert.equal(f.loadState().positions.length, 1);
});
