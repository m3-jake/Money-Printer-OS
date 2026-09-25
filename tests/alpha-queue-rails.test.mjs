// alpha-queue.ndjson has the same append-many/read-whole-file-to-drain shape that let
// data/actions.ndjson grow to 23 GB plus 76.7 GB of orphaned .drain files on 2026-09-18
// (see tests/action-queue-rails.test.mjs). It carried none of those rails until now:
// an oversized record is dropped instead of growing the file without bound, an oversized
// queue file is quarantined (not read into memory, not deleted), and orphaned .drain files
// from a worker that died mid-drain (ALPHA_WORKER_ENABLED=false, or a crash loop) are swept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-alpha-queue-rails-'));
process.env.MONEY_PRINTER_DATA_DIR = DIR;
const { enqueueAlphaEvent, flushAlphaEvents, drainAlphaEvents, cleanupAlphaDrains, quarantineAlphaQueue, RECORD_MAX_BYTES, QUEUE_MAX_BYTES, DRAIN_ORPHAN_MS } = await import('../src/alphaQueue.js');
const Q = path.join(DIR, 'alpha-queue.ndjson');

test('small events round-trip; an event above the byte rail is dropped before touching disk', () => {
  assert.equal(enqueueAlphaEvent({ type: 'outcome', outcome: { mint: 'A' } }), true);
  assert.equal(enqueueAlphaEvent({ type: 'outcome', outcome: { blob: 'x'.repeat(RECORD_MAX_BYTES) } }), false);
  flushAlphaEvents();
  const drained = drainAlphaEvents();
  assert.deepEqual(drained.map(a => a.type), ['outcome']);
  assert.ok(!fs.existsSync(Q));
});

test('an oversized queue file is quarantined instead of being read into memory', () => {
  fs.writeFileSync(Q, '');
  fs.truncateSync(Q, QUEUE_MAX_BYTES + 1); // sparse: no real bytes are written
  assert.deepEqual(drainAlphaEvents(), []);
  assert.ok(!fs.existsSync(Q), 'the oversized queue is moved aside');
  const quarantined = fs.readdirSync(DIR).filter(n => n.startsWith('alpha-queue.ndjson.quarantined-'));
  assert.equal(quarantined.length, 1);
  for (const n of quarantined) fs.rmSync(path.join(DIR, n), { force: true });
  assert.equal(quarantineAlphaQueue('nothing there'), null);
});

test('orphaned drain files older than the grace period are swept, fresh ones are kept', () => {
  const old = path.join(DIR, `alpha-queue.ndjson.99999.${Date.now() - DRAIN_ORPHAN_MS * 2}.drain`);
  const fresh = path.join(DIR, `alpha-queue.ndjson.99998.${Date.now()}.drain`);
  fs.writeFileSync(old, '{}\n'); fs.writeFileSync(fresh, '{}\n');
  const past = Date.now() - DRAIN_ORPHAN_MS * 2;
  fs.utimesSync(old, past / 1000, past / 1000);
  assert.equal(cleanupAlphaDrains(), 1);
  assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(fresh));
  fs.rmSync(fresh, { force: true });
});

test('candidate dedupe (one row per mint per 30s) is unaffected by the byte rail', () => {
  const row = { type: 'candidate', ts: Date.now(), observation: { mint: 'DEDUPE-MINT' } };
  assert.equal(enqueueAlphaEvent(row), true);
  assert.equal(enqueueAlphaEvent({ ...row, ts: row.ts + 1000 }), false);
  flushAlphaEvents();
  assert.deepEqual(drainAlphaEvents().map(a => a.observation.mint), ['DEDUPE-MINT']);
});

// The same data-loss path that was fixed in store.js drainActions, which this file's sibling
// commit missed here: a failed write-back of the remainder must not destroy the batch.
test('a failure writing the remainder back leaves the .drain file on disk instead of deleting it', () => {
  enqueueAlphaEvent({ type: 'outcome', outcome: { mint: 'A' } });
  enqueueAlphaEvent({ type: 'outcome', outcome: { mint: 'B' } });
  flushAlphaEvents();
  const original = fs.appendFileSync;
  fs.appendFileSync = (p, ...rest) => {
    if (String(p) === Q) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return original(p, ...rest);
  };
  try {
    assert.throws(() => drainAlphaEvents(1), /ENOSPC/);
  } finally {
    fs.appendFileSync = original;
  }
  const drains = fs.readdirSync(DIR).filter(n => n.startsWith('alpha-queue.ndjson.') && n.endsWith('.drain'));
  assert.equal(drains.length, 1, 'the drain file must survive a failed write-back');
  const recovered = fs.readFileSync(path.join(DIR, drains[0]), 'utf8').split('\n').filter(Boolean);
  assert.equal(recovered.length, 2, 'both the taken event and the remainder are still recoverable');
  for (const n of drains) fs.rmSync(path.join(DIR, n), { force: true });
});

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
