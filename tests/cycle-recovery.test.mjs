// P0.1: a cycle error must leave evidence even when the recovery save is refused, and that
// evidence must survive a SIGKILL in the middle of a write.
//
// Before this, index.js's catch block called saveState() unguarded. store.js refuses to publish a
// state that violates the realized basis or jumps in equity, so that refusal escaped main(), set
// exitCode = 1 and ended the loop - and stats.errors, incremented one line earlier, was never
// written. These tests use real temp data directories and real store.js instances; nothing is
// mocked except the failing save itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-cycle-recovery-'));
const crashHelper = fileURLToPath(new URL('./helpers/cycle-error-crash.mjs', import.meta.url));
let sequence = 0;

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// store.js resolves MONEY_PRINTER_DATA_DIR once at import time, so every fixture needs both a fresh
// directory and a fresh module instance (?case=n).
async function fixture(name = String(++sequence)) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  process.env.MONEY_PRINTER_DATA_DIR = dir;
  return {
    dir,
    store: await import(new URL(`../src/store.js?case=${name}`, import.meta.url)),
    recovery: await import(new URL(`../src/cycleRecovery.js?case=${name}`, import.meta.url)),
  };
}

const refusal = () => Object.assign(new Error('refusing to save: REALIZED_BASIS on position p1'), { code: 'REALIZED_BASIS', violations: [{ code: 'REALIZED_BASIS' }] });
const errorRows = store => store.readJournal(200).filter(row => row.type === 'error' || row.type === 'error-persist-failed');

async function until(predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the crash fixture');
    await new Promise(r => setTimeout(r, 20));
  }
}

test('a refused recovery save still leaves evidence in the journal and in memory', async () => {
  const { store, recovery } = await fixture();
  const result = recovery.recordCycleError({ error: new Error('boom from cycle'), load: store.loadState, save: () => { throw refusal(); }, journal: store.appendJournal });

  assert.equal(result.saveFailed, true);
  assert.equal(result.stage, 'save');
  assert.equal(result.persisted, false);
  assert.equal(result.errors, 1, 'the counter is still incremented, so the caller can report it');
  assert.equal(result.consecutive, 1);

  const rows = errorRows(store);
  assert.deepEqual(rows.map(r => r.type), ['error', 'error-persist-failed'], 'the journal row is written before the save is attempted');
  assert.equal(rows[0].error, 'boom from cycle');
  assert.equal(rows[1].stage, 'save');
  assert.equal(rows[1].code, 'REALIZED_BASIS');
  assert.match(rows[1].message, /refusing to save/);

  const view = recovery.cycleRecoveryView({ journal: store.readJournal });
  assert.equal(view.saveFailed, true, '/api/health reads this');
  assert.equal(view.ok, false);
  assert.equal(view.lastSaveFailure.code, 'REALIZED_BASIS');
  assert.ok(view.pendingErrorRows >= 2);
});

test('a successful recovery save persists the counter and clears the flag', async () => {
  const { store, recovery } = await fixture();
  const first = recovery.recordCycleError({ error: new Error('first'), load: store.loadState, save: store.saveState, journal: store.appendJournal });
  assert.equal(first.persisted, true);
  assert.equal(first.saveFailed, false);
  let persisted = store.loadState();
  assert.equal(persisted.stats.errors, first.errors);
  assert.equal(persisted.system.lastError, 'first');
  assert.equal(persisted.system.cycleErrors.consecutive, 1);

  const second = recovery.recordCycleError({ error: new Error('second'), load: store.loadState, save: store.saveState, journal: store.appendJournal });
  assert.equal(second.consecutive, 2);
  persisted = store.loadState();
  assert.equal(persisted.system.cycleErrors.consecutive, 2);
  assert.equal(persisted.system.cycleErrors.total, 2);
  assert.equal(recovery.cycleRecoveryView({ journal: store.readJournal }).saveFailed, false);
});

test('an unreadable state file is journaled instead of replacing the cycle failure', async () => {
  const { store, recovery } = await fixture();
  let saved = false;
  const result = recovery.recordCycleError({
    error: new Error('cycle died'),
    load: () => { throw Object.assign(new Error('state.json and backup both unreadable'), { code: 'STATE_RECOVERY_REQUIRED' }); },
    save: () => { saved = true; },
    journal: store.appendJournal,
  });

  assert.equal(saved, false, 'nothing is written over an unreadable state');
  assert.equal(result.stage, 'load');
  assert.equal(result.saveFailed, true);
  const rows = errorRows(store);
  assert.deepEqual(rows.map(r => r.type), ['error', 'error-persist-failed']);
  assert.equal(rows[1].stage, 'load');
  assert.equal(rows[1].code, 'STATE_RECOVERY_REQUIRED');
  assert.equal(rows[1].cycleError, 'cycle died');
});
test('a process killed mid-write still reports the error on the next boot', async () => {
  const { dir, store, recovery } = await fixture('crash');
  const child = spawn(process.execPath, [crashHelper], {
    env: { ...process.env, MONEY_PRINTER_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const saves = () => (out.match(/^save \d+$/gm) || []).length;

  // Wait until the error is recorded and the child is deep enough into its save loop that the kill
  // lands somewhere inside a write.
  await until(() => /recorded \{"saveFailed":true/.test(out) && saves() >= 3);
  child.kill('SIGKILL');
  await new Promise(resolve => child.on('exit', resolve));

  // Next boot: state.json is either the old or the new file, never a torn one.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), 'the kill cannot leave a half-written state.json');
  const reopened = store.loadState();
  assert.ok(Number.isFinite(Number(reopened.cashSol)));
  assert.ok(saves() >= 3, `the child was killed mid-save-loop (${out.trim().split('\n').slice(-3).join(' | ')})`);

  // The counter was never persisted (that is the point) - the journal is what carries the failure
  // across the restart.
  const rows = errorRows(store);
  assert.equal(rows.length, 2);
  assert.match(rows[0].error, /injected accounting refusal/);
  assert.equal(rows[1].stage, 'save');
  const view = recovery.cycleRecoveryView({ journal: store.readJournal });
  assert.ok(view.pendingErrorRows >= 2, 'the journal row outlives the process that could not persist the counter');

  // And the next boot can still write: a leftover temp file must not block recovery.
  assert.doesNotThrow(() => store.saveState(store.loadState()));
});

// P0.2: a streak of failures must stop /api/health saying ok, and one clean cycle must clear it.
test('a streak of cycle errors degrades health until a clean cycle clears it', async () => {
  const { store, recovery } = await fixture();
  const threshold = recovery.cycleRecoveryView({ journal: store.readJournal }).degradeAfter;
  assert.ok(threshold >= 1, 'the threshold comes from CYCLE_ERROR_DEGRADE_AFTER');
  const record = () => recovery.recordCycleError({ error: new Error('cycle failed'), load: store.loadState, save: store.saveState, journal: store.appendJournal });
  for (let i = 1; i < threshold; i++) {
    const result = record();
    assert.equal(result.consecutive, i);
    assert.equal(result.degraded, false, `${i} failure(s) is below the ${threshold}-failure threshold`);
    assert.notEqual(store.loadState().system.health, 'DEGRADED');
  }

  const failing = record();
  assert.equal(failing.consecutive, threshold);
  assert.equal(failing.degraded, true);
  let persisted = store.loadState();
  assert.equal(persisted.system.health, 'DEGRADED');
  const diagnostic = persisted.system.diagnostics.find(d => d.code === recovery.CYCLE_ERROR_CODE);
  assert.equal(diagnostic.level, 'ERROR', 'supervisorTick derives DEGRADED from ERROR diagnostics');
  assert.match(diagnostic.message, new RegExp(`${threshold} consecutive cycle errors`));
  assert.equal(persisted.system.health !== 'DEGRADED', false, 'this is the value /api/health turns into ok:false');

  const view = recovery.cycleRecoveryView({ state: persisted, journal: store.readJournal });
  assert.equal(view.degraded, true);
  assert.equal(view.health, 'DEGRADED');
  assert.equal(view.consecutive, threshold);
  assert.equal(view.lastError, 'cycle failed');
  assert.ok(view.lastErrorAt > 0);

  // One cycle that finishes without throwing is enough to recover.
  const clean = recovery.markCleanCycle({ state: persisted, save: store.saveState });
  assert.deepEqual({ changed: clean.changed, cleared: clean.cleared, health: clean.health }, { changed: true, cleared: true, health: 'HEALTHY' });
  persisted = store.loadState();
  assert.equal(persisted.system.cycleErrors.consecutive, 0);
  assert.equal(persisted.system.health, 'HEALTHY');
  assert.equal(persisted.system.diagnostics.some(d => d.code === recovery.CYCLE_ERROR_CODE), false);
  assert.equal(recovery.cycleRecoveryView({ state: persisted, journal: store.readJournal }).degraded, false);
});

test('a clean cycle with no streak writes nothing', async () => {
  const { store, recovery } = await fixture();
  let saves = 0;
  const clean = recovery.markCleanCycle({ state: store.loadState(), save: () => { saves++; } });
  assert.deepEqual(clean, { changed: false, cleared: false, consecutive: 0 });
  assert.equal(saves, 0, 'the per-cycle reset must not add a second state write');
});

test('clearing the streak does not clear an unrelated degraded flag', async () => {
  const { store, recovery } = await fixture();
  const state = store.loadState();
  state.system.diagnostics = [{ level: 'ERROR', code: 'RPC_DOWN', message: 'all RPC endpoints unhealthy' }];
  state.system.health = 'DEGRADED';
  state.system.cycleErrors = { consecutive: 2, total: 2 };
  const clean = recovery.markCleanCycle({ state, save: store.saveState });
  assert.equal(clean.changed, true);
  assert.equal(clean.health, 'DEGRADED', 'the streak clears, the RPC failure does not');
  assert.equal(store.loadState().system.health, 'DEGRADED');
  assert.equal(store.loadState().system.cycleErrors.consecutive, 0);
});

test('the degradation threshold is configurable per call', async () => {
  const { store, recovery } = await fixture();
  const record = () => recovery.recordCycleError({ error: new Error('nope'), degradeAfter: 2, load: store.loadState, save: store.saveState, journal: store.appendJournal });
  assert.equal(record().degraded, false);
  assert.equal(record().degraded, true);
  assert.equal(store.loadState().system.health, 'DEGRADED');
});

// P0.4: an abandoned cycle is not a crashed cycle - it must not inflate the error streak, but it must
// still be visible, and a *streak* of aborts means the engine is not scanning either.
test('an abandoned cycle is counted apart from errors, and a streak of them degrades', async () => {
  const { store, recovery } = await fixture();
  const threshold = recovery.cycleRecoveryView({ journal: store.readJournal }).degradeAfter;

  const first = recovery.recordCycleBudgetAbort({ error: Object.assign(new Error('discovery exceeded the 45000ms cycle budget'), { code: 'CYCLE_BUDGET_EXCEEDED', stage: 'discovery', budgetMs: 45000, elapsedMs: 45001 }), load: store.loadState, save: store.saveState, journal: store.appendJournal });
  assert.equal(first.persisted, true);
  assert.equal(first.aborts, 1);
  assert.equal(first.degraded, false, 'one slow cycle is a warning, not a degradation');
  let persisted = store.loadState();
  assert.equal(persisted.system.cycleErrors?.consecutive || 0, 0, 'the error streak is untouched');
  assert.equal(persisted.system.cycleBudget.lastStage, 'discovery');
  assert.equal(persisted.system.health, 'CAUTION');
  const rows = store.readJournal(200).filter(row => row.type === 'cycle-budget');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'discovery');
  assert.equal(recovery.cycleRecoveryView({ state: persisted, journal: store.readJournal }).pendingErrorRows, 0, 'an abort is not an error row');
  assert.equal(recovery.cycleRecoveryView({ state: persisted, journal: store.readJournal }).aborts, 1);

  for (let i = 2; i <= threshold; i++) {
    const streak = recovery.recordCycleBudgetAbort({ error: Object.assign(new Error('budget exceeded again'), { code: 'CYCLE_BUDGET_EXCEEDED', stage: 'enrichment', budgetMs: 45000 }), load: store.loadState, save: store.saveState, journal: store.appendJournal });
    assert.equal(streak.abortStreak, i);
    assert.equal(streak.degraded, i >= threshold);
  }
  persisted = store.loadState();
  assert.equal(persisted.system.health, 'DEGRADED', 'the engine is not scanning, so health says so');
  assert.equal(persisted.system.diagnostics.find(d => d.code === 'CYCLE_BUDGET_EXCEEDED').level, 'ERROR');
  assert.equal(recovery.cycleRecoveryView({ state: persisted, journal: store.readJournal }).degraded, true);

  const clean = recovery.markCleanCycle({ state: persisted, save: store.saveState });
  assert.equal(clean.changed, true);
  persisted = store.loadState();
  assert.equal(persisted.system.cycleBudget.abortStreak, 0, 'a cycle that completes clears the abort streak too');
  assert.equal(persisted.system.cycleBudget.aborts, threshold, 'the lifetime count stays');
  assert.equal(persisted.system.health, 'HEALTHY');
});


// P4.1 (audit finding #3) measured false on 2026-09-28: `system.diagnostics` is *rebuilt* every cycle
// by supervisorTick (supervisor.js:3 `s.system.diagnostics=[]`), not appended to, so it cannot grow with
// uptime - and it must not be capped, because capping it would hide the current cycle's conditions. On
// a real temp data dir with a real store.js, 12 cycles in which every diagnostic condition fires every
// cycle leave 4 rows, an identical code set, one row per code, and a state.json that does not change
// size (4,178 B -> 4,178 B). Under the audit's model the same 12 cycles would have left 48 rows, and an
// 8 s cycle would leave 43,200 rows/day in a file fsynced every cycle.
//
// This test pins the mechanism, not those numbers: it goes red the moment `s.system.diagnostics=[]`
// becomes `||= []` - a plausible "don't lose the diagnostics" edit - which is the only way the audit's
// imagined growth can actually appear.
test('diagnostics are per-cycle state, not a log: they cannot grow with uptime', async () => {
  const { dir, store } = await fixture();
  // supervisor.js resolves config.js (and with it the data dir) at import time, so import it against
  // this fixture's directory, the same way the helper does for store.js/cycleRecovery.js above.
  const { supervisorTick } = await import(new URL(`../src/supervisor.js?case=${path.basename(dir)}`, import.meta.url));

  const state = store.loadState();
  state.positions = [{ mint: 'mint1', priceStatus: 'UNVERIFIED' }]; // makes index.js:700 fire every cycle
  state.research ||= {};
  state.research.feedStats = { dexscreener: { seen: 5, lastSeen: 0 } }; // makes supervisor FEED_STALE fire every cycle

  const CYCLES = 12;
  let firstRows = 0, firstCodes = '', firstBytes = 0;
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    state.system.lastCycle = Date.now() - 120_000; // makes supervisor STALE_CYCLE fire every cycle
    supervisorTick(state, []);
    // The three index.js pushes, mirrored (index.js:700, 702, 706): each is condition-guarded and
    // pushes at most one row per cycle. The drift guard below keeps that half true, since this test
    // drives the real supervisor but has to reproduce index.js's own pushes by hand.
    if (state.positions.some(p => p.priceStatus && p.priceStatus !== 'FRESH')) {
      state.system.diagnostics.push({ level: 'WARN', code: 'HELD_PRICE_UNVERIFIED', message: `${state.positions.length} held positions await a verified price` });
    }
    state.system.diagnostics.push({ level: 'WARN', code: 'MARKET_RATE_LIMIT', message: 'Market provider rate-limited; retry backoff is active' });
    state.system.marketBudget = { rejectsDelta: 3 };
    state.system.diagnostics.push({ level: 'WARN', code: 'MARKET_BUDGET_REJECTED', message: '3 market request(s) refused by the 120/min budget' });
    store.saveState(state);

    const persisted = store.loadState();
    const codes = persisted.system.diagnostics.map(d => d.code);
    if (cycle === 1) {
      firstRows = codes.length;
      firstCodes = codes.join(',');
      firstBytes = fs.statSync(path.join(dir, 'state.json')).size;
    }
    assert.equal(codes.length, firstRows, `cycle ${cycle}: the row count must not grow with uptime (${firstRows} rows x ${CYCLES} cycles = ${firstRows * CYCLES} rows only if these were appends)`);
    assert.equal(new Set(codes).size, codes.length, `cycle ${cycle}: no diagnostic code may appear twice in one cycle`);
    assert.equal(codes.join(','), firstCodes, `cycle ${cycle}: the same live conditions must yield the same board, not more of it`);
    assert.equal(persisted.system.health, 'CAUTION', 'health is derived from the rebuilt board, not from history');
  }

  const bytes = fs.statSync(path.join(dir, 'state.json')).size;
  assert.ok(bytes <= firstBytes + 200, `state.json grew by ${bytes - firstBytes} B over ${CYCLES} redundant cycles (one diagnostics row is ~110 B, so 44 extra rows would be ~5 KB)`);
  assert.ok(firstRows * CYCLES > 40, 'sanity: the scenario really does fire a condition every cycle');
});

// The behavioural test above mirrors index.js's pushes, so it cannot notice if one of them becomes an
// unguarded append - which is exactly how the audit's imagined growth would appear. This is the cheap
// other half of the pin: every `diagnostics.push` in index.js must sit on a guarded line. It proves the
// push is not a bare statement, not that the condition is a meaningful one; the supervisor's rebuild
// and cycleRecovery's per-code guards are covered by the test above and by the streak tests.
test('every per-cycle diagnostics push in index.js stays condition-guarded', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const pushes = source.split('\n')
    .map((line, i) => ({ text: line.trim(), at: `index.js:${i + 1}` }))
    .filter(l => l.text.includes('system.diagnostics.push('));
  assert.ok(pushes.length >= 3, `the pushes this guard exists for are no longer found (${pushes.length}); re-check the test above`);
  const unguarded = pushes.filter(l => !/^if\s*\(/.test(l.text)).map(l => l.at);
  assert.deepEqual(unguarded, [], 'a per-cycle diagnostics push became unconditional');
});

