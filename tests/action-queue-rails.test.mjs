// The dashboard action queue can never grow without bound again: oversized actions are refused,
// an oversized queue file is quarantined (not read into memory, not deleted), and orphaned
// .drain files from a process that died mid-drain are swept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-queue-rails-'));
process.env.MONEY_PRINTER_DATA_DIR = DIR;
const { enqueueAction, drainActions, cleanupActionDrains, quarantineActionQueue, ACTION_MAX_BYTES, QUEUE_MAX_BYTES, DRAIN_ORPHAN_MS } = await import('../src/store.js');
const Q = path.join(DIR, 'actions.ndjson');

test('small actions round-trip; an action above the byte rail is refused before touching disk', () => {
  enqueueAction({ type: 'toggle-pause' });
  enqueueAction({ type: 'runtime', patch: { aggression: 72 } });
  assert.throws(() => enqueueAction({ type: 'evolution-sync', evolutionLoop: { blob: 'x'.repeat(ACTION_MAX_BYTES) } }), /accepts at most/);
  const drained = drainActions();
  assert.deepEqual(drained.map(a => a.type), ['toggle-pause', 'runtime']);
  assert.ok(!fs.existsSync(Q));
});

test('an oversized queue file is quarantined instead of being read into memory', () => {
  fs.writeFileSync(Q, '');
  fs.truncateSync(Q, QUEUE_MAX_BYTES + 1); // sparse: no real bytes are written
  assert.deepEqual(drainActions(), []);
  assert.ok(!fs.existsSync(Q), 'the oversized queue is moved aside');
  const quarantined = fs.readdirSync(DIR).filter(n => n.startsWith('actions.ndjson.quarantined-'));
  assert.equal(quarantined.length, 1);
  for (const n of quarantined) fs.rmSync(path.join(DIR, n), { force: true });
  assert.equal(quarantineActionQueue('nothing there'), null);
});

test('orphaned drain files older than the grace period are swept, fresh ones are kept', () => {
  const old = path.join(DIR, `actions.ndjson.99999.${Date.now() - DRAIN_ORPHAN_MS * 2}.drain`);
  const fresh = path.join(DIR, `actions.ndjson.99998.${Date.now()}.drain`);
  fs.writeFileSync(old, '{}\n'); fs.writeFileSync(fresh, '{}\n');
  const past = Date.now() - DRAIN_ORPHAN_MS * 2;
  fs.utimesSync(old, past / 1000, past / 1000);
  assert.equal(cleanupActionDrains(), 1);
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(fresh));
  fs.rmSync(fresh, { force: true });
});

test('a failure writing the remainder back leaves the .drain file on disk instead of deleting it', () => {
  enqueueAction({ type: 'toggle-pause' });
  enqueueAction({ type: 'toggle-pause' });
  const original = fs.appendFileSync;
  fs.appendFileSync = (p, ...rest) => {
    if (String(p) === Q) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return original(p, ...rest);
  };
  try {
    assert.throws(() => drainActions(1), /ENOSPC/);
  } finally {
    fs.appendFileSync = original;
  }
  // the batch (both the taken action and the remainder) must still be recoverable on disk
  const drainFiles = fs.readdirSync(DIR).filter(n => n.startsWith('actions.ndjson.') && n.endsWith('.drain'));
  assert.equal(drainFiles.length, 1, 'the drain file must survive a failed write-back, not be deleted');
  const recovered = fs.readFileSync(path.join(DIR, drainFiles[0]), 'utf8').split('\n').filter(Boolean);
  assert.equal(recovered.length, 2);
  for (const n of drainFiles) fs.rmSync(path.join(DIR, n), { force: true });
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
