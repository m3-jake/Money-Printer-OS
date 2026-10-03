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

test('Jupiter sampler: positions first, quote-only GETs, round trip from the exact buy output, stops on 429', async () => {
  const { sampleTargets, sampleJupiterQuotes, SOL_MINT } = await import('../src/jupiterQuoteSampler.js');
  const A = 'A'.repeat(43), B = 'B'.repeat(43), C = 'C'.repeat(43);
  const state = { positions: [{ mint: B, symbol: 'BB' }], watchlist: [{ mint: C, symbol: 'CC', score: 10 }, { mint: A, symbol: 'AA', score: 90 }, { mint: 'not-a-mint' }, { mint: SOL_MINT }] };
  assert.deepEqual(sampleTargets(state, { limit: 3 }).map(t => [t.symbol, t.reason]), [['BB', 'position'], ['AA', 'watchlist'], ['CC', 'watchlist']]);
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), method: init?.method || 'GET' });
    if (u.searchParams.get('outputMint') === C) return { status: 429, ok: false, json: async () => ({}) };
    const out = u.searchParams.get('inputMint') === SOL_MINT ? '5000' : String(Math.round(Number(1e8) * 0.97));
    return { status: 200, ok: true, json: async () => ({ outAmount: out, priceImpactPct: '0.01', routePlan: [{}, {}] }) };
  };
  const r = await sampleJupiterQuotes({ state, limit: 3, fetchImpl, notionalSol: 0.1, now: 5 });
  assert.equal(r.rows.length, 2); assert.equal(r.rateLimited, true); assert.equal(r.calls, 5);
  assert.ok(seen.every(x => x.method === 'GET' && x.path.endsWith('/quote') && !('taker' in x.q) && !('userPublicKey' in x.q)), 'quotes only, no wallet');
  const row = r.rows[0];
  assert.equal(row.buy.inLamports, 1e8); assert.equal(row.sell.inRaw, '5000', 'sells exactly what the buy returned'); assert.equal(row.roundTripPct, 3); assert.equal(row.buy.hops, 2);
  const capped = await sampleJupiterQuotes({ state, limit: 3, fetchImpl, callsLeft: 3 });
  assert.equal(capped.rows.length, 1, 'daily call budget respected');
});

test('retention dry run reports what a policy would remove and deletes nothing; streams can keep fewer days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-retention-dry-'));
  try {
    const dayOf = d => new Date(NOW - d * 864e5).toISOString().slice(0, 10);
    for (const [name, d] of [['solana-path', 10], ['solana-path', 3], ['polymarket-depth', 10], ['polymarket-us-legs', 40]]) fs.writeFileSync(path.join(dir, `${name}-${dayOf(d)}.ndjson`), 'x'.repeat(100));
    const before = fs.readdirSync(dir).sort();
    const r = pruneRawTapes({ dir, now: NOW, keepDays: 30, budgetBytes: 1e9, prefixKeepDays: { 'solana-path': 7 }, exemptPrefixes: ['polymarket-us-'], dryRun: true });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.removed.map(x => x.name), [`solana-path-${dayOf(10)}.ndjson`], 'only the 10-day-old Solana file passes its 7-day limit');
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'a dry run deletes nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Pump.fun is parked: the paper engine scans at most every 20 s and Solana ticks are taped every 30 s', async () => {
  const { cfg } = await import('../src/config.js');
  assert.equal(cfg.pumpfunParked, true); assert.equal(cfg.parkedScanIntervalSec, 20);
  const engine = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'), collector = fs.readFileSync(new URL('../src/researchCollector.js', import.meta.url), 'utf8');
  assert.match(engine, /const parkedSec = cfg\.mode === 'paper' && cfg\.pumpfunParked \? cfg\.parkedScanIntervalSec : 0;/);
  assert.match(collector, /MPO_SOLANA_CAPTURE_MS\|\|30000/); assert.match(collector, /await sleep\(Math\.max\(50,LOOP_MS-/);
});
