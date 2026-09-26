// Lab tape and family champions (batch 13): bounded, sealed, pull-based tape for the Lab and champions back.
// These are the rails that keep the 2026-09-18 actions-queue failure from recurring: byte caps, a quota,
// rate limits, atomic writes, idempotent acks, and a trader that keeps working with the Lab off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-lab-tape-'));
process.env.MONEY_PRINTER_DATA_DIR = path.join(DIR, 'data');
delete process.env.MONEY_PRINTER_BRIDGE_DIR; delete process.env.MONEY_PRINTER_BRIDGE_KEY;
const L = await import('../src/labTape.js');
const { readFamilyChampion, signRecord, LAB_LINK_SCHEMA } = await import('../src/labLink.js');
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const DAY = 864e5, D0 = Date.parse('2026-09-20T00:00:00Z');
const rowsFor = (days, perDay = 96, src = 'robinhood') => Array.from({ length: days * perDay }, (_, i) => ({ t: D0 + Math.floor(i / perDay) * DAY + (i % perDay) * Math.floor(DAY / perDay), bid: 100 + i * 0.01, ask: 100.1 + i * 0.01, src }));
function fresh(name) { const dir = path.join(DIR, name); fs.mkdirSync(dir, { recursive: true }); L.resetLabTapeMemory(); return dir; }
const manifest = dir => JSON.parse(fs.readFileSync(path.join(L.tapeRoot(dir), 'manifest.json'), 'utf8'));
const tapeFiles = dir => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.join(d, e.name)); }; walk(L.tapeRoot(dir)); return out; };

test('seals only complete UTC days, once, with sha256 and source counts; files are immutable and no tmp is left', () => {
  const dir = fresh('seal'), rows = rowsFor(3), now = D0 + 2 * DAY + 3600e3; // day 3 is today: not sealed
  const r = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rows, dir, now, nodeId: 'n1' });
  assert.equal(r.error, undefined); assert.equal(r.sealed, 2);
  const m = manifest(dir);
  assert.equal(m.schema, 'mpo.lab-tape-manifest.v1');
  assert.deepEqual(m.segments.map(s => s.day), ['2026-09-20', '2026-09-21']);
  for (const s of m.segments) {
    const buf = fs.readFileSync(path.join(L.tapeRoot(dir), s.file));
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), s.sha256);
    assert.equal(s.rows, 96); assert.deepEqual(s.sources, { robinhood: 96 });
  }
  assert.ok(!tapeFiles(dir).some(f => f.endsWith('.tmp')));
  const again = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rows, dir, now: now + 1, nodeId: 'n1' });
  assert.equal(again.reason, 'throttled', 'publishing is rate-limited');
  const forced = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rows, dir, now: now + 1, nodeId: 'n1', force: true });
  assert.equal(forced.sealed, 0, 'a sealed day is never rewritten');
});

test('segments are byte-capped, sealing per call is bounded, and invalid symbols or venues are refused', () => {
  const dir = fresh('caps'), rows = rowsFor(1, 500);
  const r = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD', '../etc'], loadRows: () => rows, dir, now: D0 + 2 * DAY, maxBytes: 4096, nodeId: 'n1' });
  const m = manifest(dir);
  assert.ok(m.segments.length > 1, 'a day larger than the cap is split into parts');
  assert.ok(m.segments.every(s => s.bytes <= 4096));
  assert.equal(m.segments.reduce((n, s) => n + s.rows, 0), 500);
  assert.ok(!fs.existsSync(path.join(L.tapeRoot(dir), 'robinhood', '..', 'etc')));
  const many = fresh('bounded');
  const r2 = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rowsFor(20), dir: many, now: D0 + 21 * DAY, nodeId: 'n1' });
  assert.equal(r2.sealed, L.MAX_SEAL_PER_CALL);
  const bad = L.publishTape({ venue: '../x', symbols: [], loadRows: () => [], dir: fresh('venue'), now: D0, force: true });
  assert.equal(bad.error, 'validation');
  assert.equal(r.error, undefined);
});

test('quota evicts oldest first; acked segments go after a week; aged segments go at KEEP_DAYS', () => {
  const dir = fresh('quota'), rows = rowsFor(6);
  L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rows, dir, now: D0 + 6 * DAY, nodeId: 'n1' });
  const keep4 = manifest(dir).segments.slice(-4).reduce((n, s) => n + s.bytes, 0);
  L.resetLabTapeMemory();
  L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rows, dir, now: D0 + 6 * DAY + 1, nodeId: 'n1', quotaBytes: keep4 + 10 });
  let m = manifest(dir);
  assert.deepEqual(m.segments.map(s => s.day), ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
  assert.ok(m.pruned.some(p => p.why === 'quota'));
  assert.equal(tapeFiles(dir).filter(f => f.endsWith('.ndjson')).length, 4, 'evicted files are deleted, not just forgotten');
  // Ack one segment from a lab on this machine; it stays for a week, then goes.
  const acked = m.segments[0];
  fs.writeFileSync(path.join(dir, 'lab-link', 'tape-ack.json'), JSON.stringify({ schema: 'mpo.lab-ack.v1', lab: 'lab-1', at: 1, ingested: [acked.sha256, 'not-a-hash'] }));
  L.resetLabTapeMemory();
  L.publishTape({ venue: 'robinhood', symbols: [], loadRows: () => [], dir, now: D0 + 7 * DAY, nodeId: 'n1' });
  m = manifest(dir); assert.equal(m.segments.find(s => s.sha256 === acked.sha256).acked, true);
  L.resetLabTapeMemory();
  L.publishTape({ venue: 'robinhood', symbols: [], loadRows: () => [], dir, now: D0 + 14 * DAY, nodeId: 'n1' });
  m = manifest(dir); assert.ok(!m.segments.some(s => s.sha256 === acked.sha256)); assert.ok(m.pruned.some(p => p.why === 'acked'));
  L.resetLabTapeMemory();
  L.publishTape({ venue: 'robinhood', symbols: [], loadRows: () => [], dir, now: D0 + 60 * DAY, nodeId: 'n1' });
  assert.equal(manifest(dir).segments.length, 0, 'nothing outlives KEEP_DAYS');
});

test('lab off / remote: the bridge gets one verified segment per call under a daily cap and a signed manifest', () => {
  const dir = fresh('bridge'), bridge = path.join(DIR, 'bridge'), rows = rowsFor(3);
  const r = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rows, dir, bridge, key: 'k', now: D0 + 3 * DAY, nodeId: 'n1' });
  assert.equal(r.sealed, 3); assert.equal(r.bridged, 1);
  const signed = JSON.parse(fs.readFileSync(path.join(bridge, 'lab-feed', 'n1.tape-manifest.json'), 'utf8'));
  const body = JSON.parse(signed.payload);
  assert.equal(body.segments.length, 1, 'the remote manifest lists only what was copied');
  assert.ok(fs.existsSync(path.join(bridge, 'lab-feed', 'n1', 'tape', body.segments[0].file)));
  // A torn or tampered local segment is never copied.
  const m = manifest(dir), next = m.segments.find(s => !s.bridged);
  fs.appendFileSync(path.join(L.tapeRoot(dir), next.file), '{"t":1,');
  L.resetLabTapeMemory();
  const r2 = L.publishTape({ venue: 'robinhood', symbols: [], loadRows: () => [], dir, bridge, key: 'k', now: D0 + 3 * DAY + 1, nodeId: 'n1' });
  assert.equal(r2.bridged, 0);
  assert.ok(!fs.existsSync(path.join(bridge, 'lab-feed', 'n1', 'tape', next.file)));
  // Without a lab or a bridge the trader simply keeps sealing locally.
  L.resetLabTapeMemory();
  const alone = L.publishTape({ venue: 'robinhood', symbols: ['BTC-USD'], loadRows: () => rowsFor(5), dir: fresh('alone'), now: D0 + 5 * DAY, nodeId: 'n1' });
  assert.equal(alone.error, undefined); assert.equal(alone.sealed, 5);
});

test('family champions: local or signed bridge copy, schema/family checked, 64 KB cap, live authority refused', () => {
  const dir = path.join(DIR, 'champ'), bridge = path.join(DIR, 'champ-bridge');
  const doc = (extra = {}) => ({ schema: LAB_LINK_SCHEMA.champion, family: 'robinhood-breakout', labNodeId: 'lab-1', publishedAt: 10, paramsHash: 'abc', params: { emaFast: 10 }, evidence: { quoteSource: 'robinhood', testCloses: 120 }, ...extra });
  const put = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
  assert.equal(readFamilyChampion('robinhood-breakout', { dir, bridge: '', key: '' }), null);
  put(path.join(dir, 'lab-link', 'champion-robinhood-breakout.json'), doc());
  assert.equal(readFamilyChampion('robinhood-breakout', { dir, bridge: '', key: '' }).source, 'local');
  assert.equal(readFamilyChampion('../x', { dir }), null);
  put(path.join(bridge, 'lab-link', 'champion-robinhood-breakout.json'), signRecord(doc({ publishedAt: 20, paramsHash: 'def' }), 'k'));
  assert.equal(readFamilyChampion('robinhood-breakout', { dir, bridge, key: 'k' }).paramsHash, 'def', 'the freshest valid source wins');
  assert.equal(readFamilyChampion('robinhood-breakout', { dir, bridge, key: 'wrong' }).source, 'local', 'a bad signature is ignored');
  put(path.join(dir, 'lab-link', 'champion-robinhood-breakout.json'), doc({ liveActivationAllowed: true }));
  assert.equal(readFamilyChampion('robinhood-breakout', { dir, bridge: '', key: '' }), null);
  put(path.join(dir, 'lab-link', 'champion-robinhood-breakout.json'), doc({ params: { pad: 'x'.repeat(70 * 1024) } }));
  assert.equal(readFamilyChampion('robinhood-breakout', { dir, bridge: '', key: '' }), null);
});
