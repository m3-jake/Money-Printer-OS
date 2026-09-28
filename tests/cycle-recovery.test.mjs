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

