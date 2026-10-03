// Bounded, read-only price history and contract grouping for the HUD (/api/market-history, /api/market-groups,
// /api/market-quotes). Built only from data already on disk; nothing here fetches, writes or synthesizes prices.
//   crypto:<SYM>   <dataDir>/robinhood-tape/<SYM>.ndjson {t,bid,ask,src}. Live quote rows keep availableAt=t. Coinbase
//                  candle warm-start rows expand one 1-minute candle into :00/:15/:30/:45 samples with bid=ask; only the
//                  :45 close is a real price at a time (same rule as core/replay.js), kept as src 'coinbase-candles' with
//                  availableAt = minute end and labelled as candle closes, never as quotes.
//   equity:<SYM>   <dataDir>/robinhood-equities/bars.json daily SESSION bars: t = verified session close, mid = close,
//                  lo/hi = session low/high. session:true; never a live quote.
//   contract:<venue>:<id>  mpos-core.sqlite entity_versions (+ current entity row), yes bid/ask in PROB, observed_at and
//                  available_at preserved; source = stored quoteSource (executable flag kept).
//   pump:<mint>    state.json tickHistory[mint] {ts,price} USD token listing ticks ("captured token ticks").
// Points: [t, bid, ask, mid, availableAt, src, lo, hi, n] (fields listed in every reply). src indexes `sources`.
// Downsampling keeps the LAST real observation per time bucket (its own timestamp) plus the bucket's mid range;
// nothing is interpolated. Gaps are spans with no observation longer than max(minGap, min(maxGap, 6x median spacing)).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { inCalendar, sessionFor } from './robinhoodEquitiesCalendar.js';

export const LIMITS = Object.freeze({ maxIds: 64, maxPoints: 2000, defaultPoints: 240, totalPoints: 40000, maxGaps: 200, maxContractRows: 20000, quotePage: 500 });
export const FIELDS = Object.freeze(['t', 'bid', 'ask', 'mid', 'availableAt', 'src', 'lo', 'hi', 'n']);
const MIN_GAP = { crypto: 5 * 60e3, contract: 60 * 60e3, pump: 10 * 60e3, equity: 4.5 * 864e5 };
// Spacing-based thresholds are capped so a sparse series cannot hide its own holes (a median of gaps is a gap).
const MAX_GAP = { crypto: 30 * 60e3, contract: 6 * 3600e3, pump: 30 * 60e3, equity: 4.5 * 864e5 };
export const STALE_MS = 30 * 60e3;
const SOURCE_INFO = {
  robinhood: { label: 'Robinhood crypto BBO quote', quote: true },
  'coinbase-public-paper': { label: 'Coinbase public L1 BBO (paper reference quote)', quote: true },
  'coinbase-candles': { label: 'Coinbase 1-minute candle close (not a quote; available at minute end)', quote: false },
  unlabeled: { label: 'Tape row written before source tagging', quote: false },
  'captured token ticks': { label: 'Captured Pump.fun token listing price ticks (not executable quotes)', quote: false },
  'market-metadata': { label: 'Venue listing quote from market metadata (not executable)', quote: false },
};
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const mid = (b, a) => (b != null && a != null ? (b + a) / 2 : null);
const round8 = x => (x == null ? null : Math.round(x * 1e8) / 1e8);
const round6 = x => (x == null ? null : Math.round(x * 1e6) / 1e6);
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- crypto tape: incremental, cached by size/mtime/head ----------
const tapes = new Map(), tapeLoads = new Map();
function tapeRow(line, out) {
  if (!line) return;
  let r; try { r = JSON.parse(line); } catch { return; }
  const t = num(r?.t), bid = num(r?.bid), ask = num(r?.ask);
  if (!(t > 0) || !(bid > 0) || !(ask >= bid)) return;
  const src = typeof r.src === 'string' && /^[a-z0-9-]{1,32}$/.test(r.src) ? r.src : 'unlabeled';
  if (src === 'coinbase-candles') { if (t % 60000 !== 45000) return; out.push([t, bid, ask, Math.floor(t / 60000) * 60000 + 60000, src]); }
  else out.push([t, bid, ask, t, src]);
}
function sortDedupe(rows) {
  rows.sort((a, b) => a[0] - b[0]);
  let w = 0; for (const r of rows) { if (w && rows[w - 1][0] === r[0]) rows[w - 1] = r; else rows[w++] = r; }
  rows.length = w; return rows;
}
async function loadTape(file) {
  if (tapeLoads.has(file)) return tapeLoads.get(file);
  const p = (async () => {
    let st; try { st = await fs.promises.stat(file); } catch { tapes.delete(file); return null; }
    let c = tapes.get(file);
    const fd = await fs.promises.open(file, 'r');
    try {
      const headBuf = Buffer.alloc(Math.min(64, st.size)); await fd.read(headBuf, 0, headBuf.length, 0); const head = headBuf.toString('latin1');
      // Compaction rewrites the file; a shrink or a changed first row means start over.
      if (!c || st.size < c.offset || (st.size === c.offset && st.mtimeMs !== c.mtimeMs) || !head.startsWith(c.head.slice(0, head.length)) || head.length < c.head.length) c = { rows: [], offset: 0, head, size: 0, mtimeMs: 0, rest: '' };
      if (st.size > c.offset) {
        const buf = Buffer.alloc(st.size - c.offset); await fd.read(buf, 0, buf.length, c.offset);
        const text = c.rest + buf.toString('utf8'), lines = text.split('\n'); c.rest = lines.pop() || '';
        const added = []; for (const l of lines) tapeRow(l, added);
        const lastT = c.rows.length ? c.rows[c.rows.length - 1][0] : -Infinity;
        for (const r of added) c.rows.push(r);
        if (added.some(r => r[0] <= lastT) || added.some((r, i) => i && r[0] <= added[i - 1][0])) sortDedupe(c.rows);
        c.offset = st.size;
      }
      c.size = st.size; c.mtimeMs = st.mtimeMs; tapes.set(file, c); return c;
    } finally { await fd.close(); }
  })().finally(() => tapeLoads.delete(file));
  tapeLoads.set(file, p); return p;
}

// ---------- equity bars + pump ticks: whole-file caches keyed by size/mtime ----------
const fileCache = new Map();
function cachedJson(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = fileCache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.value;
  let value = null; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return c?.value ?? null; }
  fileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value }); return value;
}
const nyHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
const closeCache = new Map();
export function sessionCloseMs(d) {
  if (closeCache.has(d)) return closeCache.get(d);
  if (inCalendar(d)) { const t = sessionFor(d)?.closeMs ?? null; closeCache.set(d, t); return t; }
  const edt = Date.parse(d + 'T20:00:00Z'); if (!Number.isFinite(edt)) return null;
  const t = Number(nyHour.format(edt)) === 16 ? edt : edt + 3600e3; closeCache.set(d, t); return t;
}
function readState(ctx) {
  if (ctx.live?.loadStateCached) { try { return ctx.live.loadStateCached(); } catch {} }
  return cachedJson(path.join(ctx.dataDir, 'state.json')) || {};
}

// ---------- sqlite: the desktop's own handle, or a cached read-only one ----------
const dbs = new Map();
export function contractDb(ctx) {
  try { const db = ctx.live?.marketPlatform?.()?.store?.db; if (db) return db; } catch {}
  const file = path.join(ctx.dataDir, 'mpos-core.sqlite');
  if (dbs.has(file)) return dbs.get(file);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true }); dbs.set(file, db); return db;
}
export function closeMarketHistoryHandles() { for (const db of dbs.values()) { try { db.close(); } catch {} } dbs.clear(); tapes.clear(); fileCache.clear(); contractCache.clear(); contractMemo.clear(); baselineCache.clear(); recent.clear(); }
const stmtCache = new WeakMap();
function stmt(db, sql) { let m = stmtCache.get(db); if (!m) stmtCache.set(db, m = new Map()); let s = m.get(sql); if (!s) m.set(sql, s = db.prepare(sql)); return s; }

// ---------- series assembly ----------
function lowerBound(rows, t) { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m + 1; else hi = m; } return lo; }
// rows: [t,bid,ask,mid,availableAt,srcName,lo,hi] sorted by t, already restricted to [from,to].
export function buildSeries(rows, { kind, from = null, to = null, points = LIMITS.defaultPoints, ohlc = false } = {}) {
  const srcNames = [], srcIdx = new Map(), counts = {};
  const si = name => { if (!srcIdx.has(name)) { srcIdx.set(name, srcNames.length); srcNames.push(name); } counts[name] = (counts[name] || 0) + 1; return srcIdx.get(name); };
  const raw = rows.length, idx = rows.map(r => si(r[5]));
  const diffs = [], step = Math.max(1, Math.floor(raw / 4000)); for (let i = step; i < raw; i += step) diffs.push(rows[i][0] - rows[i - step][0]) ; if (step > 1) for (let i = 0; i < diffs.length; i++) diffs[i] /= step; // sampled spacing for long tapes
  const typical = median(diffs), threshold = Math.max(MIN_GAP[kind] || 0, Math.min(MAX_GAP[kind] ?? Infinity, (typical || 0) * 6));
  const gaps = []; let gapsOmitted = 0;
  const gap = g => { if (gaps.length < LIMITS.maxGaps) gaps.push(g); else gapsOmitted++; };
  const reason = kind === 'equity' ? 'missing-sessions' : 'no-observation';
  if (raw && from != null && rows[0][0] - from > threshold) gap([from, rows[0][0], 'before-first-observation']);
  for (let i = 1; i < raw; i++) if (rows[i][0] - rows[i - 1][0] > threshold) gap([rows[i - 1][0], rows[i][0], reason]);
  if (raw && to != null && to - rows[raw - 1][0] > threshold) gap([rows[raw - 1][0], to, 'no-recent-observation']);
  let out = [], mode = 'none', bucketMs = null;
  const pt = (r, i, lo, hi, n) => [r[0], r[1], r[2], r[3], r[4], idx[i], lo, hi, n];
  if (raw <= points) out = rows.map((r, i) => pt(r, i, r[6] ?? r[3], r[7] ?? r[3], 1));
  else {
    mode = ohlc ? 'ohlc' : 'last-in-bucket';
    const t0 = rows[0][0], span = rows[raw - 1][0] - t0 + 1; bucketMs = Math.ceil(span / points);
    let b = -1, lo = null, hi = null, n = 0, last = -1;
    const flush = () => { if (last >= 0) out.push(pt(rows[last], last, lo, hi, n)); };
    for (let i = 0; i < raw; i++) {
      const r = rows[i], k = Math.floor((r[0] - t0) / bucketMs);
      if (k !== b) { flush(); b = k; lo = null; hi = null; n = 0; }
      const l = r[6] ?? r[3], h = r[7] ?? r[3];
      if (l != null) lo = lo == null ? l : Math.min(lo, l); if (h != null) hi = hi == null ? h : Math.max(hi, h);
      n++; last = i;
    }
    flush();
  }
  return {
    sources: srcNames.map(id => ({ id, ...(SOURCE_INFO[id] || { label: id, quote: kind === 'contract' && /executable/.test(id) }), raw: counts[id] })),
    points: out, gaps, ...(gapsOmitted ? { gapsOmitted } : {}),
    coverage: { first: raw ? rows[0][0] : null, last: raw ? rows[raw - 1][0] : null, raw, returned: out.length, downsample: mode, bucketMs, typicalSpacingMs: typical, gapThresholdMs: raw > 1 ? threshold : null },
  };
}

const ID_RE = /^(crypto|equity|contract|pump):(.{1,200})$/;
async function seriesFor(ctx, id, q) {
  const m = ID_RE.exec(id); if (!m) return { id, unavailable: 'INVALID_ID' };
  const [, kind, key] = m, base = { id, kind };
  if (kind === 'crypto') {
    if (!/^[A-Z0-9]{2,10}-USD$/.test(key)) return { ...base, unit: 'USD', unavailable: 'INVALID_SYMBOL' };
    const tape = await loadTape(path.join(ctx.dataDir, 'robinhood-tape', key + '.ndjson'));
    if (!tape?.rows.length) return { ...base, unit: 'USD', unavailable: 'NO_TAPE' };
    const memoKey = [q.from, q.to, q.points, tape.offset].join('|'); if (tape.memo?.key === memoKey) return tape.memo.value;
    const all = tape.rows, a = lowerBound(all, q.from ?? -Infinity), z = q.to == null ? all.length : lowerBound(all, q.to + 1);
    const rows = []; for (let i = a; i < z; i++) { const r = all[i]; rows.push([r[0], r[1], r[2], round8(mid(r[1], r[2])), r[3], r[4]]); }
    const value = { ...base, unit: 'USD', ...buildSeries(rows, { kind, ...q }) }; tape.memo = { key: memoKey, value }; return value;
  }
  if (kind === 'equity') {
    const store = cachedJson(path.join(ctx.dataDir, 'robinhood-equities', 'bars.json')), bars = store?.bars?.[key];
    if (!Array.isArray(bars) || !bars.length) return { ...base, unit: 'USD', session: true, unavailable: 'NO_SESSION_BARS' };
    const memoKey = [key, q.from, q.to, q.points].join('|'), memo = equityMemo.get(store); if (memo?.has(memoKey)) return memo.get(memoKey);
    const src = 'session bars (' + (store.provider || 'unknown') + ')', rows = [];
    for (const b of bars) {
      const t = sessionCloseMs(String(b?.d)), c = num(b?.c); if (t == null || c == null) continue;
      if ((q.from != null && t < q.from) || (q.to != null && t > q.to)) continue;
      const feed = b.f || (store.provider === 'alpaca' ? 'iex' : 'feed unknown');
      rows.push([t, null, null, c, num(b.availableAt) ?? null, src + ' · ' + feed + (inCalendar(String(b.d)) ? '' : ' · unverified calendar, conventional 16:00 close'), num(b.l), num(b.h)]);
    }
    rows.sort((x, y) => x[0] - y[0]);
    const value = { ...base, unit: 'USD', session: true, provider: store.provider || null, fetchedAt: store.fetchedAt || null, lastSession: store.lastSession || null,
      note: 'Daily session bars: t uses the verified session calendar including early closes; dates outside it use a labelled conventional 16:00 close. Per-bar availability stays unknown unless recorded. IEX/SIP sources remain separate; bars are not live quotes.', ...buildSeries(rows, { kind, ...q, ohlc: true }) };
    if (!memo) equityMemo.set(store, new Map()); const m = equityMemo.get(store); if (m.size > 500) m.clear(); m.set(memoKey, value); return value;
  }
  if (kind === 'pump') {
    const ticks = readState(ctx)?.tickHistory?.[key];
    if (!Array.isArray(ticks) || !ticks.length) return { ...base, unit: 'USD', unavailable: 'NO_CAPTURED_TICKS' };
    const rows = [];
    for (const x of ticks) { const t = num(x?.ts), p = num(x?.price); if (!(t > 0) || p == null) continue; if ((q.from != null && t < q.from) || (q.to != null && t > q.to)) continue; rows.push([t, null, null, p, t, 'captured token ticks']); }
    sortDedupe(rows);
    return { ...base, unit: 'USD', note: 'Bounded in-memory tick ring (latest ~240 per watched token); older ticks are not retained.', ...buildSeries(rows, { kind, ...q }) };
  }
  // contract
  const db = contractDb(ctx); if (!db) return { ...base, unit: 'PROB', unavailable: 'NO_CONTRACT_STORE' };
  if (!/^(kalshi|polymarket):/.test(key)) return { ...base, unit: 'PROB', unavailable: 'INVALID_ID' };
  const eid = 'contract:' + key, from = q.from ?? 0, to = q.to ?? 8.64e15;
  // Memo per id until a newer observation lands (a PK lookup), so polling without `to` re-reads nothing.
  const head = stmt(db, 'SELECT max(observed_at) o,count(*) n FROM entity_versions WHERE id=?').get(eid), currentHead = stmt(db, 'SELECT observed_at o,available_at a FROM entities WHERE id=?').get(eid), memoKey = [ctx.dataDir, eid, q.from, q.to, q.points, head?.o, head?.n,currentHead?.o,currentHead?.a].join('|');
  const memo = contractMemo.get(memoKey); if (memo) return memo;
  // one multi-path json_extract per row (parses each ~3 KB payload once)
  const vs = stmt(db, "SELECT observed_at o,available_at a,json_extract(payload,'$.data.yesBid','$.data.yesAsk','$.data.quoteSource','$.data.quoteExecutable') j FROM entity_versions WHERE id=? AND observed_at BETWEEN ? AND ? ORDER BY observed_at DESC LIMIT ?").all(eid, from, to, LIMITS.maxContractRows + 1)
    .map(v => { let j = []; try { j = JSON.parse(v.j); } catch {} return { o: v.o, a: v.a, b: j[0], k: j[1], s: j[2], x: j[3] === true || j[3] === 1 ? 1 : 0 }; });
  const cur = stmt(db, "SELECT observed_at o,available_at a,json_extract(payload,'$.yesBid') b,json_extract(payload,'$.yesAsk') k,json_extract(payload,'$.quoteSource') s,json_extract(payload,'$.quoteExecutable')=1 x,json_extract(payload,'$.title') title,json_extract(payload,'$.status') status,json_extract(payload,'$.eventId') eventId FROM entities WHERE id=?").get(eid);
  if (!cur && !vs.length) return { ...base, unit: 'PROB', unavailable: 'NO_STORED_OBSERVATIONS' };
  const truncated = vs.length > LIMITS.maxContractRows; if (truncated) vs.length = LIMITS.maxContractRows;
  if (cur && cur.o >= from && cur.o <= to && !vs.some(v => v.o === cur.o)) vs.push(cur);
  const rows = vs.map(v => { const b = num(v.b), k = num(v.k); return [v.o, b, k, round6(mid(b, k)), v.a, (v.s || 'unknown source') + (v.x === 1 ? ' (executable)' : '')]; }).sort((x, y) => x[0] - y[0]);
  const s = buildSeries(rows, { kind, ...q });
  const value = { ...base, unit: 'PROB', meta: cur ? { title: cur.title, status: cur.status, eventId: cur.eventId } : null, ...s, ...(truncated ? { olderOmitted: true } : {}),
    note: 'Yes-side bid/ask in probability units (0..1) as stored; mid is null unless both sides exist. Listing quotes are not fills.' };
  if (contractMemo.size >= 2000) contractMemo.delete(contractMemo.keys().next().value);
  contractMemo.set(memoKey, value); return value;
}
const contractMemo = new Map(), equityMemo = new WeakMap(); // equity memo dies with its parsed bars.json

function parseTime(v) { if (v == null || v === '') return null; const n = Number(v); if (Number.isFinite(n)) return n; const d = Date.parse(v); return Number.isFinite(d) ? d : NaN; }
export async function marketHistory(ctx, { ids = [], from = null, to = null, points = null } = {}) {
  ids = [...new Set(ids.map(x => String(x).trim()).filter(Boolean))];
  if (!ids.length) return { error: 'ids required', status: 400 };
  if (ids.length > LIMITS.maxIds) return { error: `at most ${LIMITS.maxIds} ids per request`, status: 400 };
  from = parseTime(from); to = parseTime(to);
  if (Number.isNaN(from) || Number.isNaN(to) || (from != null && to != null && from > to)) return { error: 'invalid from/to', status: 400 };
  let p = points == null || points === '' ? LIMITS.defaultPoints : Math.trunc(Number(points));
  if (!(p >= 2)) return { error: 'invalid points', status: 400 };
  p = Math.min(p, LIMITS.maxPoints);
  const perId = Math.max(2, Math.min(p, Math.floor(LIMITS.totalPoints / ids.length)));
  const q = { from, to, points: perId }, series = [];
  for (const id of ids) { try { series.push(await seriesFor(ctx, id, q)); } catch (e) { series.push({ id, unavailable: 'READ_FAILED: ' + String(e?.message || e).slice(0, 160) }); } }
  return { schema: 'mpo.market-history.v1', at: Date.now(), readOnly: true, fields: FIELDS, query: { from, to, points: perId, requestedPoints: p, budgetLimited: perId < p }, series,
    rules: 'Observed data only: no interpolation; downsampled buckets keep their last real observation and its own timestamp; session bars are not quotes; candle closes are not quotes.' };
}

// ---------- contract catalogue, grouping, paging ----------
const contractCache = new Map();
const KALSHI_CATEGORY = [
  ['weather', /^KX(HIGH|LOW|TEMP|RAIN|SNOW|HURR|TORNADO)/], ['crypto', /^KX(BTC|ETH|SOL|XRP|DOGE|CRYPTO)/],
  ['economics', /^KX(CPI|U3|PAYROLLS|GDP|FED|PCE|JOBLESS|INFL|RATE|RECESS|ISM)/], ['commodities', /^KX(AAAGAS|GAS|OIL|WTI|PLATINUM|PALLADIUM|GOLD|SILVER|COPPER)/],
  ['esports', /^KX(CS2|DOTA2|LOL|VALORANT|R6|OW)/],
  ['sports', /^KX(NFL|NCAA|NBA|WNBA|MLB|NHL|MLS|NWSL|EPL|UEFA|SERIE|LIGUE|LALIGA|BUNDES|ATP|WTA|ITF|TT|USL|URY|ARG|BRASIL|CONCACAF|INTLFRIENDLY|EERSTE|LIGA|DIMAYOR|PGA|UFC|F1|NASCAR|BOX|CFL|KBO|NPB)/],
  ['politics', /^KX(PRES|SENATE|HOUSE|GOV|ELECT|TRUMP|POTUS|MAYOR)/],
];
const TITLE_CATEGORY = [
  ['weather', /temperature|°[CF]|\brain(fall)?\b|\bsnow|hurricane|weather/i], ['crypto', /bitcoin|\bbtc\b|ethereum|\beth\b|solana|\bxrp\b|crypto|dogecoin/i],
  ['economics', /inflation|\bcpi\b|\bgdp\b|unemployment|\bfed\b|interest rate|payroll|recession|jobs report/i], ['commodities', /crude|\boil\b|\bwti\b|\bgold\b|\bsilver\b|natural gas/i],
  ['esports', /counter-strike|dota|league of legends|valorant|\bcs2\b|\(BO\d\)|map \d winner|o\/u [\d.]+ (rounds|maps)/i],
  ['sports', /\bvs\.?\b|o\/u|spread:|exact score|win on \d{4}-|championship|world series|super bowl|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|premier league|stanley cup|rushing|touchdown|goals/i],
  ['politics', /election|president|nominat|prime minister|senate|governor|parliament|congress|moratorium|minister|mayor|\bparty\b|trump/i],
  ['geopolitics', /iran|israel|ukraine|russia|china|\bwar\b|troops|ceasefire|nuclear|military|gaza|nato/i],
  ['culture', /tweets|musk|openai|\bai\b|album|movie|oscar|grammy|spotify|youtube|tiktok/i],
];
export const GROUP_RULE = 'venue -> category -> series -> event. Kalshi series = ticker prefix before the first "-", category from a fixed series-prefix table; Polymarket has no series, so series = event, category from a fixed title keyword table (first match wins). Payload categories are used when present. Unmatched contracts are counted under "other", never dropped.';
export function classifyContract({ provider, sourceId, title, eventTitle, category }) {
  const series = provider === 'kalshi' ? String(sourceId || '').split('-')[0] || 'unknown' : null;
  let cat = typeof category === 'string' && category.trim() ? category.trim().toLowerCase() : null;
  if (!cat) for (const [c, re] of provider === 'kalshi' ? KALSHI_CATEGORY : TITLE_CATEGORY) if (re.test(provider === 'kalshi' ? series : `${title || ''} ${eventTitle || ''}`)) { cat = c; break; }
  return { category: cat || 'other', series };
}
function contractVersion(db) { const r = stmt(db, "SELECT count(*) n,max(available_at) a FROM entities WHERE kind='Contract'").get(); return `${r.n}-${r.a ?? 0}`; }
// Current rows for every stored contract, rebuilt only when the contract table changes (or every 60 s for history counts).
export function contractCatalogue(ctx, { now = Date.now() } = {}) {
  const db = contractDb(ctx); if (!db) return null;
  const version = contractVersion(db), c = contractCache.get(db);
  if (c && c.version === version && now - c.builtAt < 60e3) return c;
  const historyCounts = c && now - c.historyAt < 60e3 ? c.historyCounts : new Map(stmt(db, "SELECT id,count(*) n FROM entity_versions WHERE id>='contract:' AND id<'contract;' GROUP BY id").all().map(r => [r.id, r.n]));
  const rows = stmt(db, "SELECT id,provider,source_id s,observed_at o,available_at a,json_extract(payload,'$.title') title,json_extract(payload,'$.eventTitle') eventTitle,json_extract(payload,'$.eventId') eventId,json_extract(payload,'$.category') category,json_extract(payload,'$.yesBid') yb,json_extract(payload,'$.yesAsk') ya,json_extract(payload,'$.noBid') nb,json_extract(payload,'$.noAsk') na,json_extract(payload,'$.status') status,json_extract(payload,'$.currency') currency,json_extract(payload,'$.quoteSource') qs,json_extract(payload,'$.quoteExecutable') qx,json_extract(payload,'$.closeAt') closeAt FROM entities WHERE kind='Contract' ORDER BY provider,source_id").all().map(r => {
    const bid = num(r.yb), ask = num(r.ya), { category, series } = classifyContract({ provider: r.provider, sourceId: r.s, title: r.title, eventTitle: r.eventTitle, category: r.category });
    return { id: r.id, symbol: r.s, title: r.title, venue: r.provider, bid, ask, mid: round6(mid(bid, ask)), noBid: num(r.nb), noAsk: num(r.na), at: r.o, availableAt: r.a, status: r.status, source: r.qs || 'market listing', executable: r.qx === 1, currency: r.currency || 'USD',
      category, series: series || r.eventId || 'no-event', eventId: r.eventId || null, eventTitle: r.eventTitle || null, closeAt: num(r.closeAt), versions: historyCounts.get(r.id) || 0 };
  });
  const out = { version, builtAt: now, historyAt: c && historyCounts === c.historyCounts ? c.historyAt : now, historyCounts, rows, etag: 'W/"mq-' + crypto.createHash('sha1').update(version + ':' + historyCounts.size).digest('hex').slice(0, 16) + '"' };
  contractCache.set(db, out); return out;
}
const quoted = r => r.bid != null || r.ask != null;
export function coverageOf(rows, now = Date.now()) {
  const c = { total: 0, quoted: 0, twoSided: 0, stale: 0, unknown: 0, executable: 0, withHistory: 0 };
  for (const r of rows) { c.total++; if (quoted(r)) c.quoted++; else c.unknown++; if (r.bid != null && r.ask != null) c.twoSided++; if (!(r.at >= now - STALE_MS)) c.stale++; if (r.executable) c.executable++; if (r.versions >= 2) c.withHistory++; }
  return c;
}
export function contractCoverage(ctx, { now = Date.now() } = {}) {
  const cat = contractCatalogue(ctx, { now }); if (!cat) return null;
  const byVenue = {}; for (const r of cat.rows) (byVenue[r.venue] ||= []).push(r);
  return { version: cat.version, staleMs: STALE_MS, rules: 'quoted = at least one yes side priced; unknown = no price; stale = observation older than staleMs; executable = stored quoteExecutable; withHistory = >= 2 stored observations', venues: Object.fromEntries(Object.entries(byVenue).map(([v, rows]) => [v, coverageOf(rows, now)])) };
}

const WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 864e5, '7d': 7 * 864e5 };
const baselineCache = new Map();
function baselineMids(db, at, cacheKey, now) {
  const c = baselineCache.get(cacheKey); if (c && now - c.builtAt < 60e3) return c.mids;
  const mids = new Map();
  for (const r of stmt(db, "SELECT e.id id,v.observed_at o,json_extract(v.payload,'$.data.yesBid') b,json_extract(v.payload,'$.data.yesAsk') k FROM entities e JOIN entity_versions v ON v.id=e.id AND v.observed_at=(SELECT max(observed_at) FROM entity_versions WHERE id=e.id AND observed_at<=?) WHERE e.kind='Contract'").all(at)) {
    const m = mid(num(r.b), num(r.k)); if (m != null) mids.set(r.id, { mid: m, at: r.o });
  }
  baselineCache.set(cacheKey, { builtAt: now, mids }); return mids;
}
export function marketGroups(ctx, { venue = '', window = '24h', by = 'category', category = '', now = Date.now() } = {}) {
  const cat = contractCatalogue(ctx, { now }); if (!cat) return { error: 'contract store unavailable', status: 503 };
  const span = WINDOWS[window]; if (!span) return { error: 'window must be one of ' + Object.keys(WINDOWS).join(','), status: 400 };
  if (!['category', 'series', 'event'].includes(by)) return { error: 'by must be category, series or event', status: 400 };
  const db = contractDb(ctx), base = baselineMids(db, now - span, ctx.dataDir+'|w' + window, now);
  const rows = cat.rows.filter(r => (!venue || r.venue === venue) && (!category || r.category === category));
  const groups = new Map();
  for (const r of rows) {
    const k = by === 'category' ? r.category : by === 'series' ? r.series : r.eventId || 'no-event', key = r.venue + '/' + k;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, venue: r.venue, group: k, label: by === 'event' ? r.eventTitle || r.title || k : k, category: by === 'category' ? k : r.category, rows: [] });
    g.rows.push(r);
  }
  const list = [...groups.values()].map(g => {
    const cov = coverageOf(g.rows, now), mids = g.rows.map(r => r.mid).filter(x => x != null), changes = [], statuses = {};
    for (const r of g.rows) { statuses[r.status || 'UNKNOWN'] = (statuses[r.status || 'UNKNOWN'] || 0) + 1; const b = base.get(r.id); if (b && r.mid != null && r.at > b.at) changes.push(r.mid - b.mid); }
    const series = new Set(g.rows.map(r => r.series)), events = new Set(g.rows.map(r => r.eventId || 'no-event'));
    return { key: g.key, venue: g.venue, group: g.group, label: g.label, category: g.category, count: cov.total, quoted: cov.quoted, twoSided: cov.twoSided, stale: cov.stale, unknown: cov.unknown, executable: cov.executable, withHistory: cov.withHistory,
      series: series.size, events: events.size, statuses, medianMid: round6(median(mids)),
      change: { window, median: round6(median(changes)), measured: changes.length, omitted: cov.total - changes.length, omittedReason: 'no two-sided observation at both window start and now' },
      freshest: g.rows.reduce((m, r) => Math.max(m, r.at || 0), 0) || null, oldest: g.rows.reduce((m, r) => Math.min(m, r.at || Infinity), Infinity) };
  }).map(g => ({ ...g, oldest: Number.isFinite(g.oldest) ? g.oldest : null })).sort((a, b) => a.venue.localeCompare(b.venue) || b.count - a.count || a.group.localeCompare(b.group));
  const grouped = list.reduce((n, g) => n + g.count, 0);
  return { schema: 'mpo.market-groups.v1', at: now, readOnly: true, version: cat.version, venue: venue || null, window, by, category: category || null, unit: 'PROB', rule: GROUP_RULE,
    accounting: { total: rows.length, grouped, other: list.filter(g => g.category === 'other').reduce((n, g) => n + g.count, 0), allAccounted: grouped === rows.length },
    coverage: coverageOf(rows, now), staleMs: STALE_MS, groups: list,
    notes: ['US Polymarket listings held only in the desktop process memory are not part of the stored contract catalogue.', 'Changes compare the newest stored mid with the last stored mid at or before the window start; contracts without both are counted as omitted.'] };
}
export function marketQuotes(ctx, { venue = '', group = '', q = '', offset = 0, limit = 100, now = Date.now() } = {}) {
  const cat = contractCatalogue(ctx, { now }); if (!cat) return { error: 'contract store unavailable', status: 503 };
  offset = Math.max(0, Math.trunc(Number(offset) || 0)); limit = Math.max(1, Math.min(LIMITS.quotePage, Math.trunc(Number(limit) || 100)));
  const needle = String(q || '').trim().toLowerCase().slice(0, 120);
  // group: "<category>", "series:<key>", "event:<eventId>" (optionally prefixed "<venue>/")
  let g = String(group || ''); const slash = g.indexOf('/'); if (slash > 0 && !g.startsWith('series:') && !g.startsWith('event:')) { venue = venue || g.slice(0, slash); g = g.slice(slash + 1); }
  const match = r => (!venue || r.venue === venue) && (!g || (g.startsWith('series:') ? r.series === g.slice(7) : g.startsWith('event:') ? (r.eventId || 'no-event') === g.slice(6) : r.category === g))
    && (!needle || (r.symbol || '').toLowerCase().includes(needle) || (r.title || '').toLowerCase().includes(needle) || (r.eventTitle || '').toLowerCase().includes(needle));
  const hits = cat.rows.filter(match);
  const etag = cat.etag.slice(0, -1) + '-' + crypto.createHash('sha1').update(JSON.stringify([venue, g, needle, offset, limit, Math.floor(now / 60e3)])).digest('hex').slice(0, 10) + '"';
  return { schema: 'mpo.market-quotes.v1', at: now, readOnly: true, version: cat.version, etag, unit: 'PROB', total: hits.length, offset, limit, filters: { venue: venue || null, group: g || null, q: needle || null },
    staleMs: STALE_MS, rows: hits.slice(offset, offset + limit).map(r => ({ ...r, stale: !(r.at >= now - STALE_MS) })),
    note: 'Stored listing quotes; executable=false rows are not fills. Use /api/market-history?ids=<id> for observations.' };
}

// ---------- HTTP handlers (HUD_ROUTES) ----------
const inflight = new Map(), recent = new Map();
async function shared(key, ttl, fn) {
  const r = recent.get(key); if (r && Date.now() - r.at < ttl) return r.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).then(value => { recent.set(key, { at: Date.now(), value }); if (recent.size > 200) recent.delete(recent.keys().next().value); return value; }).finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}
const ctxKey = ctx => (ctx.live ? 'live:' : 'files:') + ctx.dataDir;
function reply(ctx, res, body, extra = {}) { if (body?.error) return ctx.json(res, { ok: false, error: body.error }, body.status || 400), true; ctx.json(res, body, 200, extra); return true; }
export async function handleMarketHistoryRequest(req, res, url, ctx) {
  if (url.pathname !== '/api/market-history') return false;
  const sp = url.searchParams, args = { ids: (sp.get('ids') || '').split(','), from: sp.get('from'), to: sp.get('to'), points: sp.get('points') };
  return reply(ctx, res, await shared(ctxKey(ctx) + '|h|' + url.search, 1000, () => marketHistory(ctx, args)));
}
export async function handleMarketGroupsRequest(req, res, url, ctx) {
  if (url.pathname !== '/api/market-groups') return false;
  const sp = url.searchParams, args = { venue: sp.get('venue') || '', window: sp.get('window') || '24h', by: sp.get('by') || 'category', category: sp.get('category') || '' };
  return reply(ctx, res, await shared(ctxKey(ctx) + '|g|' + url.search, 5000, () => marketGroups(ctx, args)));
}
export async function handleMarketQuotesRequest(req, res, url, ctx) {
  if (url.pathname !== '/api/market-quotes') return false;
  const sp = url.searchParams, args = { venue: sp.get('venue') || '', group: sp.get('group') || '', q: sp.get('q') || '', offset: sp.get('offset'), limit: sp.get('limit') };
  const body = await shared(ctxKey(ctx) + '|q|' + url.search, 1000, () => marketQuotes(ctx, args));
  if (body?.etag && req.headers?.['if-none-match'] === body.etag) { res.writeHead(304, { etag: body.etag, 'cache-control': 'no-cache' }); res.end(); return true; }
  return reply(ctx, res, body, body?.etag ? { etag: body.etag, 'cache-control': 'no-cache' } : {});
}
// Preview only (ctx.live absent): the coordination snapshot needs in-process bots, so the source preview summarizes the
// running trader's full payload (GET) and adds file-derived contract coverage. The desktop server builds it in-process.
const previewSummary = new Map();
export async function handleCommandCenterSummaryPreview(req, res, url, ctx) {
  if (ctx.live || url.pathname !== '/api/command-center' || url.searchParams.get('view') !== 'summary') return false;
  const origin = ctx.traderOrigin || 'http://127.0.0.1:8792', { commandCenterSummary, createBuildCache } = await import('./commandCenter.js');
  if (!previewSummary.has(origin)) previewSummary.set(origin, createBuildCache());
  const body = await previewSummary.get(origin).get('summary', async () => {
    const r = await fetch(origin + '/api/command-center', { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!r.ok) throw Error('trader HTTP ' + r.status);
    let coverage = null; try { coverage = contractCoverage(ctx); } catch {}
    return { ...commandCenterSummary(await r.json(), { coverage }), previewSource: 'summarized from the running trader full payload' };
  });
  ctx.json(res, body); return true;
}
