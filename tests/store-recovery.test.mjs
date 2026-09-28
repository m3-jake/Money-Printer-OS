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
test('transient Windows EPERM during primary publication is retried', async () => {
  const f = await fixture(account(5), account(4));
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'state.json') && attempts++ < 2) {
      const err = new Error('simulated Windows file lock');
      err.code = 'EPERM';
      throw err;
    }
    return rename(from, to);
  };
  try { f.saveState(account(6)); }
  finally { fs.renameSync = rename; }
  assert.equal(attempts, 3);
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
test('save caps the research blob: learner outcomes, universe and postmortems', async () => {
  const f = await fixture();
  const s = f.loadState();
  s.research.learner = { ...(s.research.learner || {}), pending: [], outcomes: Array.from({ length: 4000 }, (_, i) => ({ ts: 4000 - i, horizonMin: 5 })) };
  s.research.universe = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => ['m' + i, { mint: 'm' + i, lastSeen: i }]));
  s.research.postmortems = Array.from({ length: 900 }, (_, i) => ({ i }));
  f.saveState(s);
  const saved = { research: JSON.parse(f.read('research-state.json')) };
  assert.equal(saved.research.learner.outcomes.length, f.OUTCOME_KEEP);
  assert.equal(saved.research.learner.outcomes[0].ts, 4000, 'the newest outcomes are kept');
  assert.equal(Object.keys(saved.research.universe).length, f.UNIVERSE_KEEP);
  assert.ok(saved.research.universe.m2999 && !saved.research.universe.m0, 'the most recently seen mints are kept');
  assert.equal(saved.research.postmortems.length, 200);
});
test('heavy research lives in research-state.json; state.json keeps the account and small research fields', async () => {
  const f = await fixture();
  const s = f.loadState();
  s.research.autonomyLevel = 3;
  s.research.learner = { ...(s.research.learner || {}), outcomes: [{ ts: 1, horizonMin: 5 }] };
  f.saveState(s);
  const state = JSON.parse(f.read('state.json')), ext = JSON.parse(f.read('research-state.json'));
  assert.ok(!('learner' in state.research) && Array.isArray(state.research.externalized) && state.research.externalized.includes('learner'));
  assert.equal(state.research.autonomyLevel, 3, 'small fields stay readable by doctor/mesh');
  assert.equal(ext.learner.outcomes[0].ts, 1);
  assert.ok(Number.isFinite(state.cashSol), 'the account is untouched');
  const again = f.loadState();
  assert.equal(again.research.learner.outcomes[0].ts, 1, 'load reattaches the moved sections');
  assert.ok(!('externalized' in again.research));
});
test('an old state.json with inline research migrates on the next save', async () => {
  const f = await fixture();
  const old = f.loadState();
  old.research.learner.outcomes = [{ ts: 9, horizonMin: 5 }];
  fs.writeFileSync(path.join(f.dir, 'state.json'), JSON.stringify(old)); // pre-split format: research inline
  assert.ok(!fs.existsSync(path.join(f.dir, 'research-state.json')));
  const s = f.loadState();
  assert.equal(s.research.learner.outcomes[0].ts, 9);
  f.saveState(s);
  assert.ok(!('learner' in JSON.parse(f.read('state.json')).research));
  assert.equal(JSON.parse(f.read('research-state.json')).learner.outcomes[0].ts, 9);
});
test('a missing or torn research file never blocks the account', async () => {
  const f = await fixture({ cashSol: 4, paperStartSol: 10, positions: [], history: [], research: { autonomyLevel: 1, externalized: ['learner', 'universe'] } });
  const s = f.loadState();
  assert.equal(s.cashSol, 4); assert.ok(!s.system?.recovery, 'no backup recovery for a research-only problem');
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), '{"learner":');
  assert.equal(f.loadState().cashSol, 4);
});
test('research-state.json is rewritten at most every RESEARCH_SAVE_MS; state.json saves are not held back', async () => {
  const f = await fixture();
  const s = f.loadState();
  s.research.learner = { ...(s.research.learner || {}), outcomes: [{ ts: 1, horizonMin: 5 }] };
  f.saveState(s);
  s.research.learner.outcomes = [{ ts: 2, horizonMin: 5 }]; s.cashSol = s.cashSol; f.saveState(s);
  assert.equal(JSON.parse(f.read('research-state.json')).learner.outcomes[0].ts, 1, 'throttled: at most a minute of research can be lost');
  assert.equal(f.RESEARCH_SAVE_MS, 60000);
});

// ----------------------------------------------------------------------------------------------
// P2.1: research-state.json gets the account's backup/validate treatment, without the account's pause.
// Evidence for the item (measured, before this code existed): with the heavy sections in research-state.json
// and a torn file on disk, loadState() returned learner.outcomes [] / universe {} with NO marker anywhere, and
// the next save published those rebuilt-empty sections over the only copy of the dataset. No backup existed.
const externalized = ['learner', 'universe'];
const researchOnlyState = cashSol => ({ cashSol, paperStartSol: 10, positions: [], history: [], research: { autonomyLevel: 1, externalized } });
const sections = { learner: { outcomes: [{ ts: 9, horizonMin: 5 }] }, universe: { m1: { mint: 'm1', lastSeen: 3 } } };

test('P2.1 the validated section map and the backup bound cannot drift from the account side', async () => {
  const f = await fixture();
  assert.deepEqual(Object.keys(f.RESEARCH_SECTIONS).sort(), [...f.RESEARCH_HEAVY].sort(), 'every externalized section is validated');
  assert.equal(f.RESEARCH_BACKUP_MS, f.STATE_BACKUP_MS, 'research keeps the same recovery window as the account');
});

test('P2.1 a torn research file is reported, and rebuilt-empty sections never replace it', async () => {
  const f = await fixture(researchOnlyState(4));
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), '{"learner":');
  const damaged = f.read('research-state.json');
  const s = f.loadState();
  assert.equal(s.cashSol, 4, 'the account still loads');
  assert.equal(s.system.researchRecovery.status, 'RESEARCH_UNREADABLE');
  assert.equal(s.system.researchRecovery.reviewRequired, true);
  assert.ok(String(s.system.researchRecovery.reason).length > 0, 'why it could not be read is recorded');
  assert.ok(!s.system.paused && !s.system.killSwitch && !s.system.recovery, 'research damage is not dressed up as an account recovery');
  f.saveState(s);
  assert.equal(f.read('research-state.json'), damaged, 'the unreadable file is the last copy there is and is left in place');
  const state = JSON.parse(f.read('state.json'));
  assert.ok(!('externalized' in state.research), 'with publication refused, the sections travel inline in state.json');
  assert.equal(state.system.researchRecovery.status, 'RESEARCH_UNREADABLE', 'the marker is durable: the next reader still sees it');
  assert.ok(!fs.readdirSync(f.dir).some(n => n.endsWith('.tmp')));
});

test('P2.1 a damaged file that still parses is damaged too (JSON.parse alone would have emptied the dataset)', async () => {
  const f = await fixture(researchOnlyState(4));
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), 'null');
  const s = f.loadState();
  assert.match(s.system.researchRecovery.reason, /expected a section object/);
  const damaged = f.read('research-state.json');
  f.saveState(s);
  assert.equal(f.read('research-state.json'), damaged, 'a file we cannot read is never "repaired" by overwriting it');
});

test('P2.1 a torn research file with a valid backup recovers the sections and repairs itself', async () => {
  const f = await fixture(researchOnlyState(4));
  fs.writeFileSync(path.join(f.dir, 'research-state.backup.json'), JSON.stringify(sections));
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), '{"learner":');
  const s = f.loadState();
  assert.equal(s.research.learner.outcomes[0].ts, 9, 'the sections come back from the backup');
  assert.equal(Object.keys(s.research.universe).length, 1);
  assert.equal(s.system.researchRecovery.status, 'RESEARCH_BACKUP_RECOVERED');
  assert.ok(!s.system.paused, 'no pause: a research rollback is not a reason to stop trading');
  f.saveState(s);
  assert.equal(JSON.parse(f.read('research-state.json')).learner.outcomes[0].ts, 9, 'the damaged primary is rewritten from the recovery copy');
  assert.equal(JSON.parse(f.read('research-state.backup.json')).learner.outcomes[0].ts, 9, 'and the backup still holds the good copy');
});

test('P2.1 sections that would not read back are refused instead of published', async () => {
  const f = await fixture();
  const s = f.loadState();
  s.research.learner = [];
  s.research.universe = { m1: { mint: 'm1' } };
  f.saveState(s);
  assert.ok(!fs.existsSync(path.join(f.dir, 'research-state.json')), 'nothing was published');
  const state = JSON.parse(f.read('state.json'));
  assert.match(state.system.researchRecovery.reason, /learner must be an object/);
  assert.ok(Number.isFinite(state.cashSol), 'the account save itself is unaffected');
});

test('P2.1 the preceding research file becomes a recoverable backup, and an unreadable one never does', async () => {
  const f = await fixture();
  const s = f.loadState();
  s.research.learner = { ...(s.research.learner || {}), outcomes: [{ ts: 1, horizonMin: 5 }] };
  f.saveState(s);
  assert.ok(!fs.existsSync(path.join(f.dir, 'research-state.backup.json')), 'nothing to copy on the first publication');
  const realNow = Date.now;
  try {
    let skew = f.RESEARCH_SAVE_MS + 1_000;
    Date.now = () => realNow() + skew;
    s.research.learner.outcomes = [{ ts: 2, horizonMin: 5 }];
    f.saveState(s);
    assert.equal(JSON.parse(f.read('research-state.backup.json')).learner.outcomes[0].ts, 1, 'the preceding publication is the backup');
    assert.equal(JSON.parse(f.read('research-state.json')).learner.outcomes[0].ts, 2);
    skew += f.RESEARCH_SAVE_MS + f.RESEARCH_BACKUP_MS + 1_000;
    fs.writeFileSync(path.join(f.dir, 'research-state.json'), 'null'); // parses, so an unvalidated copy would be accepted
    f.saveState(f.loadState());
    assert.equal(JSON.parse(f.read('research-state.backup.json')).learner.outcomes[0].ts, 1, 'the unreadable primary never replaced the backup');
  } finally { Date.now = realNow; }
});

test('P2.1 repairing the file resumes publication without hiding what happened', async () => {
  const f = await fixture(researchOnlyState(4));
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), '{"learner":');
  f.saveState(f.loadState());
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), JSON.stringify(sections));
  const s = f.loadState();
  assert.equal(s.research.learner.outcomes[0].ts, 9, 'the repaired file is read again');
  s.research.learner.outcomes = [{ ts: 10, horizonMin: 5 }];
  f.saveState(s);
  const state = JSON.parse(f.read('state.json'));
  assert.ok(Array.isArray(state.research.externalized), 'publication resumed');
  assert.equal(JSON.parse(f.read('research-state.json')).learner.outcomes[0].ts, 10);
  assert.equal(state.system.researchRecovery.status, 'RESEARCH_UNREADABLE', 'the marker stays until a human clears it');
});

test('P2.1 an empty-but-valid section never turns into an account recovery', async () => {
  // Every section present and correctly typed, none of them populated: the shape a partially-written or
  // pre-schema file has. Before this item, `learner: {}` threw inside ensureLearner -> loadState() read the
  // research problem as an unreadable ACCOUNT and paused trading on the backup path.
  const f = await fixture(researchOnlyState(4));
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), JSON.stringify({
    learner: {}, universe: {}, postmortems: [], walletProfiles: {}, deployerProfiles: {},
    alpha: {}, improvementLoop: {}, daily: [], experiments: [], lessons: [], challengers: [],
  }));
  const s = f.loadState();
  assert.equal(s.cashSol, 4);
  assert.ok(!s.system.paused && !s.system.killSwitch && !s.system.recovery, 'no account recovery and no pause');
  assert.ok(!s.system.researchRecovery, 'the file is readable, so there is nothing to report');
  assert.ok(Number(s.research.learner.weights.edge) > 0, 'the learner section is repaired in memory');
});

// ----------------------------------------------------------------------------------------------
// P3.2, skipped on measurement: the queue asked for a `stateVersion` field plus a migration stub.
// Measured, the field has nothing to do here -- no reader anywhere in the tree, and measured inert in
// both directions (a file carrying `stateVersion: 99` loads as 99 and saves back as 99), because every
// migration in store.js is keyed on field presence (`!Array.isArray(s.pnlLedger)`,
// `research.externalized`, `pnlLedgerTruncatedBefore`), which is finer-grained than one integer.
// The capability the counter would uniquely add -- refusing an unknown version -- is the wrong answer
// on this document: loadState() is the engine's load path (index.js:489), and its rule is load the
// account and record the anomaly, never refuse it.
// What a counter would have been *for* is downgrade safety: a build must not lose what a newer build
// wrote. That already holds, and it holds by two rules measured in the downgrade probe -- the
// `...s` spread in merge() keeps unknown top-level keys, and attachResearch() takes the section list
// from the file it reads rather than from a hardcoded one, so a section this build cannot name still
// reattaches. Both are pinned here so a later refactor cannot quietly drop either.
const newerBuildState = cashSol => ({
  cashSol, paperStartSol: 10, positions: [], history: [],
  stateVersion: 7,                                  // a field this build has no reader for
  futureTopLevel: { keep: 'me' },                   // and a top-level key it cannot name
  research: { autonomyLevel: 1, externalized: ['learner', 'futureSection'], lessons: [{ id: 'kept' }] },
});

test('P3.2 state written by a newer build survives this one, counter or no counter', async () => {
  const f = await fixture(newerBuildState(7));
  fs.writeFileSync(path.join(f.dir, 'research-state.json'), JSON.stringify({
    learner: { outcomes: [{ ts: 9, horizonMin: 5 }] }, futureSection: { keep: 'me-too' },
  }));
  const s = f.loadState();
  assert.equal(s.cashSol, 7);
  assert.equal(s.research.learner.outcomes[0].ts, 9, 'a section this build knows reattaches');
  assert.deepEqual(s.research.futureSection, { keep: 'me-too' }, 'and one it does not know comes back too');
  assert.deepEqual(s.futureTopLevel, { keep: 'me' }, 'an unknown top-level key is not a reason to refuse the account');
  f.saveState(s);
  const state = JSON.parse(f.read('state.json'));
  assert.equal(state.stateVersion, 7, 'and not a reason to rewrite it either');
  assert.deepEqual(state.futureTopLevel, { keep: 'me' });
  assert.deepEqual(state.research.futureSection, { keep: 'me-too' }, 'the unknown section is still on disk after this build republishes');
  assert.deepEqual(f.loadState().research.futureSection, { keep: 'me-too' }, 'and after reload');
  // This build re-derives the externalized list from the sections it knows (store.js:501), so the unknown
  // one leaves the list -- and that is safe only because its data was written inline on the same save.
  // A reader must therefore take the list from the file, never assume its own list is the whole list.
  assert.ok(state.research.externalized.includes('learner'), 'the sections this build knows are still externalized');
  assert.ok(!state.research.externalized.includes('futureSection'), 'and the one it cannot name is not claimed as external');
  assert.deepEqual(JSON.parse(f.read('research-state.json')).lessons, [{ id: 'kept' }], 'a heavy section this build owns moved out as usual');
});

