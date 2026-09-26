// Self-improving loop plan, batch F items 1-2: raw tape retention and fsync-before-rename writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneRawTapes } from '../src/researchCollector.js';
import { writeFileAtomicSync, writeFileSynced } from '../src/atomicRename.js';

const DAY = 864e5, NOW = Date.UTC(2026, 8, 26, 12);
const d = off => new Date(NOW - off * DAY).toISOString().slice(0, 10);
function tapeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-raw-'));
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), 'x'.repeat(bytes));
  return dir;
}

test('retention drops day files past keepDays with their sidecars, never today or yesterday', () => {
  const dir = tapeDir({ [`solana-path-${d(50)}.ndjson`]: 10, [`solana-path-${d(50)}.ndjson.sha256`]: 64, [`solana-path-${d(40)}.ndjson`]: 10, [`solana-path-${d(1)}.ndjson`]: 10, [`solana-path-${d(0)}.ndjson`]: 10, 'notes.txt': 5, [`polymarket-us-legs-${d(60)}.ndjson`]: 10 });
  try {
    const r = pruneRawTapes({ dir, now: NOW, keepDays: 45, budgetBytes: 1e9, exemptPrefixes: ['polymarket-us-'] });
    assert.deepEqual(r.removed.map(x => [x.name, x.reason]), [[`solana-path-${d(50)}.ndjson`, 'age']]);
    const left = fs.readdirSync(dir).sort();
    assert.ok(!left.includes(`solana-path-${d(50)}.ndjson.sha256`), 'sidecar goes with its day file');
    assert.ok(left.includes(`polymarket-us-legs-${d(60)}.ndjson`), 'exempt prefix kept');
    assert.ok(left.includes('notes.txt'), 'undated files are never touched');
    assert.equal(r.files, 4); assert.equal(r.totalBytes, 40); assert.equal(r.overBudget, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('over budget, the oldest go first, but today and yesterday stay even if still over', () => {
  const dir = tapeDir({ [`polymarket-depth-${d(5)}.ndjson`]: 100, [`solana-path-${d(4)}.ndjson`]: 100, [`solana-path-${d(3)}.ndjson`]: 100, [`solana-path-${d(1)}.ndjson`]: 100, [`solana-path-${d(0)}.ndjson`]: 100 });
  try {
    let r = pruneRawTapes({ dir, now: NOW, keepDays: 45, budgetBytes: 250 });
    assert.deepEqual(r.removed.map(x => x.name), [`polymarket-depth-${d(5)}.ndjson`, `solana-path-${d(4)}.ndjson`, `solana-path-${d(3)}.ndjson`]);
    assert.equal(r.totalBytes, 200); assert.equal(r.overBudget, false);
    r = pruneRawTapes({ dir, now: NOW, keepDays: 45, budgetBytes: 50 });
    assert.equal(r.removed.length, 0); assert.equal(r.overBudget, true, 'reported, not forced');
    assert.deepEqual(pruneRawTapes({ dir: path.join(dir, 'missing'), now: NOW }).files, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('atomic write fsyncs before rename, and a failed write never replaces the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-atomic-')), file = path.join(dir, 'sub', 'state.json');
  const realFsync = fs.fsyncSync, realRename = fs.renameSync, order = [];
  try {
    fs.fsyncSync = fd => { order.push('fsync'); return realFsync(fd); };
    fs.renameSync = (a, b) => { order.push('rename'); return realRename(a, b); };
    writeFileAtomicSync(file, '{"v":1}');
    assert.deepEqual(order, ['fsync', 'rename']); assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}');
    // A NUL-filled tmp left by an old crash is ignored: each write uses its own tmp name.
    fs.writeFileSync(`${file}.${process.pid}.tmp`, Buffer.alloc(64));
    fs.fsyncSync = () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); };
    assert.throws(() => writeFileAtomicSync(file, '{"v":2}'), /disk gone/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}', 'target keeps the old bytes');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.tmp') && n !== `state.json.${process.pid}.tmp`), [], 'the failed tmp is removed');
    fs.fsyncSync = realFsync;
    writeFileSynced(path.join(dir, 'raw.bin'), Buffer.from([1, 2, 3]));
    assert.deepEqual([...fs.readFileSync(path.join(dir, 'raw.bin'))], [1, 2, 3]);
  } finally { fs.fsyncSync = realFsync; fs.renameSync = realRename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent preflight flags a running app whose on-disk status is stale or missing', async () => {
  const { compareViews } = await import('../scripts/agent-preflight.mjs');
  const now = 10 * 3600000;
  assert.equal(compareViews({ name: 'lab', live: false, diskUpdatedAt: now, now }).verdict, 'UNVERIFIED');
  assert.equal(compareViews({ name: 'lab', live: true, diskUpdatedAt: now - 60000, now }).verdict, 'OK');
  assert.equal(compareViews({ name: 'lab', live: true, diskUpdatedAt: now - 3 * 3600000, now }).verdict, 'STALE_VIEW');
  assert.equal(compareViews({ name: 'lab', live: true, diskUpdatedAt: undefined, now }).verdict, 'STALE_VIEW');
  assert.equal(compareViews({ name: 'lab', live: true, diskUpdatedAt: now, liveGeneration: 100826, diskGeneration: 53549, now }).verdict, 'STALE_VIEW');
});
