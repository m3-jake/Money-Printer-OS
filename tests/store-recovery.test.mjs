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
