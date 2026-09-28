// P2.2 -- "async batched journal appends (state.json semantics byte-for-byte)" -- measured before it was
// touched, and the premise turned out to be false for the real cycle volume:
//
//   One real paper cycle (`node src/index.js --once`, temp data dir, default profile) performs exactly TWO
//   appends: one `appendJournalBatch` for the whole cycle volume (30 scan-candidate rows + the scan-summary)
//   and one `appendJournal` per event (that cycle: `trade-open`). 28,529 bytes / 32 rows / ~1 ms of a
//   4,575 ms cycle -- 0.02% (riskMs 4,311 was 94% of it, discoveryMs 185, saveMs < 1).
//   Per-call cost is 0.29-0.37 ms (one open+write+close each), so per-row appends would be ~70x the batched
//   cost: the volume path is already batched and every other call site is a single event (24 of them in
//   src/index.js, none inside a per-row loop). The audit's journal finding is *volume* (~98% scan-candidate
//   rows, ~1 GB/day), which rotation (3 x 128 MB) and `MPO_JOURNAL_SCAN_CANDIDATES=false` already bound --
//   not append latency. Making the path async would trade that 1 ms for the journal-first durability P0.1
//   depends on (the row is on disk before the state save), so the change was declined, not made.
//
// What is locked here is the premise a future reader would need to re-open it, plus the acceptance criterion
// the item named: batching is format-preserving (a batch writes the bytes a run of single appends writes),
// journal activity cannot change state.json byte-for-byte, and the engine batches the one high-volume source
// instead of appending rows one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-journal-contract-'));
let sequence = 0;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// store.js resolves the data dir at import time, so each case gets its own module instance and its own dir.
async function fixture() {
  const dir = path.join(root, String(++sequence));
  fs.mkdirSync(dir, { recursive: true });
  process.env.MONEY_PRINTER_DATA_DIR = dir;
  const store = await import(new URL('../src/store.js?journal-contract=' + sequence, import.meta.url));
  return {
    ...store,
    dir,
    journal: () => fs.readFileSync(path.join(dir, 'market.ndjson'), 'utf8'),
    rows: () => fs.readFileSync(path.join(dir, 'market.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

// Every write the store makes while journaling, so a journal burst can be proven to touch nothing else.
// Node implements fs.appendFileSync on top of fs.writeFileSync, so a write that happens *inside* an
// appendFileSync call is not counted twice.
function watchWrites() {
  const original = { writeFileSync: fs.writeFileSync, appendFileSync: fs.appendFileSync, renameSync: fs.renameSync };
  const events = [];
  let appending = 0;
  fs.appendFileSync = (file, ...rest) => {
    events.push({ kind: 'append', file: String(file) });
    appending++;
    try { return original.appendFileSync(file, ...rest); } finally { appending--; }
  };
  fs.writeFileSync = (file, ...rest) => {
    if (!appending) events.push({ kind: 'write', file: String(file) });
    return original.writeFileSync(file, ...rest);
  };
  fs.renameSync = (from, to) => {
    if (!appending) events.push({ kind: 'rename', file: String(to) });
    return original.renameSync(from, to);
  };
  return {
    events,
    appends: () => events.filter(e => e.kind === 'append'),
    files: () => events.map(e => e.file),
    restore: () => Object.assign(fs, original),
  };
}

test('the cycle volume is one append for 30 rows; everything else is one append per event', async () => {
  const f = await fixture();
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    type: 'scan-candidate', ts: 1_700_000_000_000 + i, a: { mint: 'mint' + i, priceUsd: 1 + i },
  }));
  const writes = watchWrites();
  try {
    f.appendJournalBatch(candidates);
    assert.equal(writes.appends().length, 1, 'one syscall for the whole scan volume, not one per row');
    for (const row of [{ type: 'scan-summary' }, { type: 'trade-open' }, { type: 'trade-close' }]) f.appendJournal(row);
    assert.equal(writes.appends().length, 4, 'and one per event');
  } finally {
    writes.restore();
  }
  const rows = f.rows();
  assert.equal(rows.length, 33, 'all 33 rows landed');
  assert.deepEqual(rows.map(r => r.type), [...Array(30).fill('scan-candidate'), 'scan-summary', 'trade-open', 'trade-close']);
});

test('a batch writes exactly the bytes a run of single appends writes (batching stays format-preserving)', async () => {
  const f = await fixture();
  // Explicit ts: the stamp is the only field that legitimately differs between the two paths (each path calls
  // Date.now() per row), so it is pinned here to compare the bytes the two paths produce.
  const rows = Array.from({ length: 12 }, (_, i) => ({
    type: 'scan-candidate', ts: 1_700_000_000_000 + i, a: { mint: 'mint' + i, priceUsd: 0.001 * (i + 1), warnings: ['w' + i] },
  }));
  f.appendJournalBatch(rows);
  const batched = f.journal();
  fs.rmSync(path.join(f.dir, 'market.ndjson'), { force: true });
  for (const row of rows) f.appendJournal(row);
  assert.equal(f.journal(), batched, 'one append of N rows is byte-for-byte N appends of one row');
  assert.ok(batched.endsWith('\n') && !batched.includes('\n\n'), 'one NDJSON row per line, trailing newline, no blank line');
});

test('ts is stamped per row and a caller-supplied ts is never rewritten', async () => {
  const f = await fixture();
  const before = Date.now();
  f.appendJournalBatch([
    { type: 'scan-summary', tracked: 4 },
    { type: 'trade-open', ts: 1_234_567_890_000, sizeSol: 0.05 },
    { type: 'scan-summary', tracked: 5 },
  ]);
  const rows = f.rows();
  const after = Date.now();
  assert.equal(rows.length, 3);
  assert.ok(Number.isFinite(rows[0].ts) && rows[0].ts >= before && rows[0].ts <= after, 'a row without a ts gets its own stamp');
  assert.equal(rows[1].ts, 1_234_567_890_000, 'a row that carries its own ts keeps it, to the millisecond');
  assert.match(f.journal().split('\n')[1], /"ts":1234567890000/, 'and it is written as that value, not re-stamped');
  assert.ok(rows.every(row => Number.isFinite(row.ts)), 'every row carries one');
  assert.ok(rows[2].ts >= rows[0].ts, 'the batch does not reorder rows');
  // A single append carries the same stamp shape, so a batch and a run of singles are interchangeable.
  f.appendJournal({ type: 'trade-close', ts: 42 });
  assert.equal(f.rows().at(-1).ts, 42);
});

test('journal activity cannot change state.json: its bytes are the state\'s, never the journal\'s', async () => {
  const f = await fixture();
  const state = f.loadState();
  f.saveState(state);
  const statePath = path.join(f.dir, 'state.json');
  const before = fs.readFileSync(statePath);
  const writes = watchWrites();
  try {
    f.appendJournalBatch(Array.from({ length: 30 }, (_, i) => ({ type: 'scan-candidate', a: { mint: 'm' + i } })));
    for (const row of [{ type: 'trade-open' }, { type: 'scan-summary' }, { type: 'trade-close' }]) f.appendJournal(row);
    assert.deepEqual(writes.files().filter(file => file.includes('state.json')), [], 'journaling writes only the journal');
    assert.deepEqual([...new Set(writes.files().map(file => path.dirname(file)))], [f.dir], 'and only inside the data dir');
  } finally {
    writes.restore();
  }
  assert.deepEqual(fs.readFileSync(statePath), before, 'byte-for-byte unchanged by 33 journal rows');
  // And a save taken after the journal burst matches a save taken before it: the journal is not an input.
  // (saveMs is the previous save's measured duration by design, so it is the one field normalized away.)
  const stable = bytes => bytes.toString('utf8').replace(/"saveMs":\d+/g, '"saveMs":N');
  f.saveState(JSON.parse(JSON.stringify(state)));
  assert.equal(stable(fs.readFileSync(statePath)), stable(before), 'the same state saves the same bytes with or without journal rows in between');
});

// The measurement the verdict rests on, executable: the per-call overhead (open+write+close) is what makes
// per-row appends expensive, and that is why the engine's one high-volume source takes the batch path. The
// bound is relative, not a wall-clock threshold, so it holds on a slow disk too.
test('per-row appends cost an order of magnitude more than the batch the engine uses', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    type: 'scan-candidate', ts: 1_700_000_000_000 + i, a: { mint: 'mint' + i, priceUsd: 0.001 * (i + 1), score: i % 100 },
  }));
  const batched = await fixture();
  const singled = await fixture();
  const mark = performance.now();
  batched.appendJournalBatch(rows);
  const batchMs = performance.now() - mark;
  const mark2 = performance.now();
  for (const row of rows) singled.appendJournal(row);
  const singleMs = performance.now() - mark2;
  assert.equal(batched.rows().length, 1000);
  assert.equal(singled.rows().length, 1000);
  assert.equal(singled.journal(), batched.journal(), 'the same 1000 rows either way');
  assert.ok(batchMs * 5 < singleMs,
    `one batch of 1000 rows must stay far below 1000 single appends (batch ${batchMs.toFixed(2)} ms vs per-row ${singleMs.toFixed(2)} ms)`);
  // Telemetry, not a gate: the number a reader should compare against the cycle (a real cycle appends 2x).
  console.log(`journal append cost, 1000 rows (~390 KB): one batch ${batchMs.toFixed(2)} ms, per-row ${singleMs.toFixed(2)} ms (${(singleMs / Math.max(batchMs, 0.01)).toFixed(1)}x, ${(singleMs / 1000).toFixed(3)} ms per row)`);
});

// P2.2's premise, at the source: the 30 rows the cycle's scan phase produces are one array handed to one
// appendJournalBatch call, and every other append in the engine is one event. This fails if a per-row or
// per-candidate append is introduced -- which is the only way the measured 2 appends per cycle can grow.
test('the engine batches the cycle volume and appends one row per event, never per row', async () => {
  const engine = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(engine, /const journalRows = ranked\.slice\(0, 30\)\.map\(/, 'the scan volume is collected into one array');
  assert.match(engine, /appendJournalBatch\(journalRows\)/, 'and written by one call');
  assert.equal((engine.match(/appendJournalBatch\(/g) || []).length, 1, 'one batch per cycle');
  const singleSites = (engine.match(/appendJournal\(/g) || []).length;
  assert.ok(singleSites <= 24,
    `the engine's single appends are per event (${singleSites} event sites); a per-row append raises this count`);
  const inLoop = engine.match(/for\s*\((?:const|let)\s+\w+\s+of\s+\w+\)\s*[^\n]*appendJournal\(/);
  assert.equal(inLoop, null, 'no loop body appends a row per iteration');
});
