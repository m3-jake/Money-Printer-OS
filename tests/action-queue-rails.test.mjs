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

test('retired evolution-sync cannot enter the queue and historical queued snapshots cannot become policies', () => {
  assert.throws(() => enqueueAction({ type: 'evolution-sync', evolutionLoop: { champion: { id: 'UNVALIDATED' } } }), /retired/);
  fs.writeFileSync(Q, JSON.stringify({ type: 'evolution-sync', evolutionLoop: { champion: { id: 'UNVALIDATED' } } }) + '\n');
  enqueueAction({ type: 'toggle-pause' });
  assert.deepEqual(drainActions().map(action => action.type), ['toggle-pause']);
});

test('small actions round-trip; an action above the byte rail is refused before touching disk', () => {
  enqueueAction({ type: 'toggle-pause' });
  enqueueAction({ type: 'runtime', patch: { aggression: 72 } });
  assert.throws(() => enqueueAction({ type: 'evolution-sync', evolutionLoop: { blob: 'x'.repeat(ACTION_MAX_BYTES) } }), /accepts at most/);
  const drained = drainActions();
  assert.deepEqual(drained.map(a => a.type), ['toggle-pause', 'runtime']);
  assert.ok(!fs.existsSync(Q));
});

test('legacy rejection journal failure never loses a legitimate queued action', () => {
  fs.writeFileSync(Q, JSON.stringify({ type: 'evolution-sync' }) + '\n');
  enqueueAction({ type: 'toggle-pause' });
  const append = fs.appendFileSync;
  fs.appendFileSync = (file, ...args) => {
    if (String(file).endsWith('market.ndjson')) throw new Error('journal disk unavailable');
    return append(file, ...args);
  };
  try { assert.deepEqual(drainActions().map(a => a.type), ['toggle-pause']); }
  finally { fs.appendFileSync = append; }
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

// scan-candidate rows are ~98% of market.ndjson by volume (~1 GB/day measured). The research
// machine needs them - they are the Evolution Lab's dataset - but a laptop that only trades can
// drop them. Everything else must still be journaled either way.
test('MPO_JOURNAL_SCAN_CANDIDATES=false drops only scan-candidate rows', async () => {
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-journal-'));
  const run = async (flag) => {
    const mod = await import(`../src/store.js?journal=${flag}`);
    return mod;
  };
  // default: everything is kept
  process.env.MONEY_PRINTER_DATA_DIR = sub;
  delete process.env.MPO_JOURNAL_SCAN_CANDIDATES;
  const on = await run('on');
  on.appendJournalBatch([{ type: 'scan-candidate', a: 1 }, { type: 'trade-open', a: 2 }]);
  on.appendJournal({ type: 'scan-candidate', a: 3 });
  let rows = fs.readFileSync(path.join(sub, 'market.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.type), ['scan-candidate', 'trade-open', 'scan-candidate']);

  // opted out: scan-candidate is dropped, the rest survives
  fs.rmSync(path.join(sub, 'market.ndjson'), { force: true });
  process.env.MPO_JOURNAL_SCAN_CANDIDATES = 'false';
  const off = await run('off');
  assert.equal(off.JOURNAL_SCAN_CANDIDATES, false);
  off.appendJournalBatch([{ type: 'scan-candidate', a: 1 }, { type: 'trade-open', a: 2 }]);
  off.appendJournal({ type: 'scan-candidate', a: 3 });
  off.appendJournal({ type: 'trade-close', a: 4 });
  rows = fs.readFileSync(path.join(sub, 'market.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.type), ['trade-open', 'trade-close'], 'only scan-candidate is dropped');
  delete process.env.MPO_JOURNAL_SCAN_CANDIDATES;
  fs.rmSync(sub, { recursive: true, force: true });
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
