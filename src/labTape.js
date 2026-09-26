// Lab tape (reports/SOLANA-ROBINHOOD-LAB-REVIEW-2026-09-26.md §5): how the trader hands its quote tape to the
// Evolution Lab without a queue. Complete UTC days are sealed into immutable segment files and listed in a manifest;
// the Lab pulls them and acks by sha256. Every file is byte-capped, the directory has a quota, sealing and bridge
// copies are rate-limited, and every write is tmp + fsync + rename. Nothing here can grow without bound, which is
// what the 2026-09-18 actions-queue failure (23 GB) did.
//
//   <data>/lab-link/tape/<venue>/<SYMBOL>/<YYYY-MM-DD>.p<N>.ndjson    sealed segment, rows {t,bid,ask,src?}
//   <data>/lab-link/tape/manifest.json                                mpo.lab-tape-manifest.v1 (<= 256 KB)
//   <data>/lab-link/tape-ack.json                                     mpo.lab-ack.v1 from a lab on this machine
//   <bridge>/lab-feed/<node>/tape/...                                 copies of sealed segments (1 per call, 64 MB/day)
//   <bridge>/lab-feed/<node>.tape-manifest.json                       signed manifest for a remote lab
//   <bridge>/lab-link/ack/<node>.json                                 signed mpo.lab-ack.v1 from a remote lab
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renameSyncWithRetry } from './atomicRename.js';
import { readJson, signRecord, verifyRecord, traderNodeId } from './labLink.js';

export const TAPE_SCHEMA = { manifest: 'mpo.lab-tape-manifest.v1', ack: 'mpo.lab-ack.v1' };
export const TAPE_PUBLISH_MS = 10 * 60_000;
export const SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const QUOTA_BYTES = 1024 * 1024 * 1024;
export const KEEP_DAYS = 45;
export const ACKED_KEEP_MS = 7 * 864e5;
export const MAX_SEAL_PER_CALL = 8;
export const BRIDGE_DAILY_BYTES = 64 * 1024 * 1024;
const DAY_MS = 864e5;
const VENUE_RE = /^[a-z0-9-]{1,24}$/, SYMBOL_RE = /^[A-Z0-9]{2,10}-USD$/;

const dataDir = () => path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
const bridgeDir = () => String(process.env.MONEY_PRINTER_BRIDGE_DIR || '').trim();
const bridgeKey = () => String(process.env.MONEY_PRINTER_BRIDGE_KEY || '').trim();
export const tapeRoot = (dir = dataDir()) => path.join(dir, 'lab-link', 'tape');
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const dayStart = day => Date.parse(day + 'T00:00:00.000Z');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try { fs.writeFileSync(tmp, data, { flush: true }); renameSyncWithRetry(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
function emptyManifest(nodeId) { return { schema: TAPE_SCHEMA.manifest, node: nodeId, at: 0, quotaBytes: QUOTA_BYTES, usedBytes: 0, segments: [], pruned: [], bridge: { day: '', bytes: 0 } }; }
function loadManifest(dir, nodeId) {
  const m = readJson(path.join(tapeRoot(dir), 'manifest.json'));
  if (!m || m.schema !== TAPE_SCHEMA.manifest || !Array.isArray(m.segments)) return emptyManifest(nodeId);
  return { ...emptyManifest(nodeId), ...m, segments: m.segments.filter(s => s && typeof s.file === 'string' && typeof s.sha256 === 'string'), pruned: Array.isArray(m.pruned) ? m.pruned.slice(0, 50) : [], bridge: m.bridge && typeof m.bridge === 'object' ? m.bridge : { day: '', bytes: 0 } };
}
// Acks from a lab on this machine (plain) and a remote lab (signed). Unknown or malformed acks are ignored.
export function readAcks({ dir = dataDir(), bridge = bridgeDir(), key = bridgeKey(), nodeId = traderNodeId() } = {}) {
  const out = new Set(), take = doc => { if (doc?.schema === TAPE_SCHEMA.ack && Array.isArray(doc.ingested)) for (const h of doc.ingested) if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) out.add(h); };
  take(readJson(path.join(dir, 'lab-link', 'tape-ack.json')));
  if (bridge && key) take(verifyRecord(readJson(path.join(bridge, 'lab-link', 'ack', `${nodeId}.json`)), key));
  return out;
}

// Split one day's rows into segments no larger than maxBytes each.
export function segmentLines(rows, maxBytes = SEGMENT_MAX_BYTES) {
  const parts = []; let cur = [], bytes = 0;
  for (const r of rows) {
    const row = { t: r.t, bid: r.bid, ask: r.ask }; if (r.src) row.src = r.src;
    const line = JSON.stringify(row) + '\n', n = Buffer.byteLength(line);
    if (cur.length && bytes + n > maxBytes) { parts.push(cur.join('')); cur = []; bytes = 0; }
    cur.push(line); bytes += n;
  }
  if (cur.length) parts.push(cur.join(''));
  return parts;
}

let lastPublishAt = 0;
export function resetLabTapeMemory() { lastPublishAt = 0; }

// Seal complete days, prune, copy one segment to the bridge, rewrite the manifest. Never throws.
// loadRows(symbol, sinceMs) returns [{t,bid,ask,src?}] oldest first (robinhoodTape.loadTape fits).
export function publishTape({ venue, symbols = [], loadRows, dir = dataDir(), bridge = bridgeDir(), key = bridgeKey(), nodeId = traderNodeId(), now = Date.now(), force = false, maxBytes = SEGMENT_MAX_BYTES, quotaBytes = QUOTA_BYTES } = {}) {
  const out = { ran: false, sealed: 0, pruned: 0, bridged: 0, usedBytes: 0 };
  if (!force && now - lastPublishAt < TAPE_PUBLISH_MS) return { ...out, reason: 'throttled' };
  lastPublishAt = now; out.ran = true;
  try {
    if (!VENUE_RE.test(String(venue || ''))) throw Object.assign(new Error('invalid venue'), { code: 'validation' });
    const root = tapeRoot(dir), m = loadManifest(dir, nodeId), today = dayKey(now), oldest = dayKey(now - KEEP_DAYS * DAY_MS);
    const sealedDays = new Set(m.segments.filter(s => s.venue === venue).map(s => `${s.symbol}|${s.day}`));
    // 1. Seal complete UTC days that aren't sealed yet, oldest first, a bounded number per call.
    for (const symbol of symbols) {
      if (out.sealed >= MAX_SEAL_PER_CALL) break;
      if (!SYMBOL_RE.test(symbol)) continue;
      const rows = loadRows(symbol, dayStart(oldest)) || [], byDay = new Map();
      for (const r of rows) { const d = dayKey(r.t); if (d >= today || d < oldest || sealedDays.has(`${symbol}|${d}`)) continue; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
      for (const day of [...byDay.keys()].sort()) {
        if (out.sealed >= MAX_SEAL_PER_CALL) break;
        const dayRows = byDay.get(day), sources = {};
        for (const r of dayRows) sources[r.src || 'unknown'] = (sources[r.src || 'unknown'] || 0) + 1;
        segmentLines(dayRows, maxBytes).forEach((text, part) => {
          const rel = path.posix.join(venue, symbol, `${day}.p${part}.ndjson`), buf = Buffer.from(text);
          writeAtomic(path.join(root, rel), buf);
          m.segments.push({ venue, symbol, day, part, file: rel, rows: text.split('\n').length - 1, bytes: buf.length, sha256: sha256(buf), sources, sealedAt: now, acked: false, bridged: false });
        });
        sealedDays.add(`${symbol}|${day}`); out.sealed++;
      }
    }
    // 2. Acks, then prune: acked and a week old, older than KEEP_DAYS, then oldest-first over quota.
    const acks = readAcks({ dir, bridge, key, nodeId });
    for (const s of m.segments) if (acks.has(s.sha256)) s.acked = true;
    const drop = (s, why) => { try { fs.rmSync(path.join(root, s.file), { force: true }); } catch {} m.pruned = [{ file: s.file, sha256: s.sha256, why, at: now }, ...m.pruned].slice(0, 50); out.pruned++; };
    m.segments = m.segments.filter(s => { const why = s.day < oldest ? 'age' : s.acked && now - Number(s.sealedAt || 0) > ACKED_KEEP_MS ? 'acked' : null; if (why) drop(s, why); return !why; });
    m.segments.sort((a, b) => a.day.localeCompare(b.day) || a.symbol.localeCompare(b.symbol) || a.part - b.part);
    let used = m.segments.reduce((n, s) => n + Number(s.bytes || 0), 0);
    while (used > quotaBytes && m.segments.length) { const s = m.segments.shift(); used -= Number(s.bytes || 0); drop(s, 'quota'); }
    // 3. Bridge: at most one segment per call and BRIDGE_DAILY_BYTES per UTC day, then the signed manifest.
    if (bridge && key) {
      if (m.bridge.day !== today) m.bridge = { day: today, bytes: 0 };
      const next = m.segments.find(s => !s.bridged);
      if (next && m.bridge.bytes + next.bytes <= BRIDGE_DAILY_BYTES) {
        const buf = fs.readFileSync(path.join(root, next.file));
        if (sha256(buf) === next.sha256) { writeAtomic(path.join(bridge, 'lab-feed', nodeId, 'tape', next.file), buf); next.bridged = true; m.bridge.bytes += buf.length; out.bridged = 1; }
      }
    }
    // 4. Manifest, capped: drop the oldest entries (and their files) until it fits.
    m.at = now; m.node = nodeId; m.quotaBytes = quotaBytes; m.usedBytes = used;
    let json = JSON.stringify(m);
    while (Buffer.byteLength(json) > MANIFEST_MAX_BYTES && m.segments.length) { const s = m.segments.shift(); m.usedBytes -= Number(s.bytes || 0); drop(s, 'manifest'); json = JSON.stringify(m); }
    writeAtomic(path.join(root, 'manifest.json'), json);
    if (bridge && key) writeAtomic(path.join(bridge, 'lab-feed', `${nodeId}.tape-manifest.json`), JSON.stringify(signRecord({ ...m, segments: m.segments.filter(s => s.bridged) }, key)));
    out.usedBytes = m.usedBytes; out.segments = m.segments.length;
  } catch (e) { out.error = String(e?.code || e?.message || e).slice(0, 200); }
  return out;
}
