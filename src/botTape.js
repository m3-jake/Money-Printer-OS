// Point-in-time tape of what the paper bots saw (2026-10-03, Research Workbench phase 2; see
// docs/EVOLUTION-LAB-AUDIT-2026-10-02.md). Each bot run's inputs (Kalshi weather buckets with bid/ask,
// the NWS and calibrated forecasts, BTC spot/vol and the tradable BTC contracts, Polymarket leader trades)
// and every Kalshi settlement are appended as one JSON line, so a later calibrator or variant can be
// replayed against exactly what was known at the time, never against hindsight.
//
//   <data>/bot-tape/<stream>/<YYYY-MM-DD>.jsonl      today (UTC), appended
//   <data>/bot-tape/<stream>/<YYYY-MM-DD>.jsonl.gz   finished days, gzipped at the first write of a new day
//
// Days older than keepDays are deleted. A failed write is counted and reported, never thrown: the tape must
// not stop a bot.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const TAPE_STREAMS = Object.freeze(['kalshi-weather', 'kalshi-btc', 'kalshi-settle', 'polycopy-trades', 'polycopy-leaders', 'polycopy-receipts', 'polycopy-candidates']);
const DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

export class BotTape {
  constructor({ dataDir, now = () => Date.now(), keepDays = 180 } = {}) {
    this.dir = path.join(dataDir, 'bot-tape'); this.now = now; this.keepDays = keepDays;
    this.day = {}; this.rows = {}; this.lastAt = {}; this.errors = 0; this.lastError = null;
  }
  append(stream, row) {
    if (!TAPE_STREAMS.includes(stream)) throw new Error('Unknown tape stream ' + stream);
    try {
      const at = this.now(), day = new Date(at).toISOString().slice(0, 10), dir = path.join(this.dir, stream);
      fs.mkdirSync(dir, { recursive: true });
      if (this.day[stream] !== day) { this.rollover(stream, day); this.day[stream] = day; this.rows[stream] = 0; }
      fs.appendFileSync(path.join(dir, day + '.jsonl'), JSON.stringify({ at, ...row }) + '\n');
      this.rows[stream]++; this.lastAt[stream] = at;
      return true;
    } catch (e) { this.errors++; this.lastError = String(e.message || e).slice(0, 200); return false; }
  }
  // Gzip every finished day and delete days past keepDays.
  rollover(stream, today) {
    const dir = path.join(this.dir, stream), cutoff = new Date(Date.parse(today) - this.keepDays * 86400e3).toISOString().slice(0, 10);
    for (const f of fs.readdirSync(dir)) {
      const m = DAY.exec(f); if (!m) continue;
      const p = path.join(dir, f);
      if (m[1] < cutoff) { fs.rmSync(p, { force: true }); continue; }
      if (!m[2] && m[1] < today) { fs.writeFileSync(p + '.gz', zlib.gzipSync(fs.readFileSync(p))); fs.rmSync(p); }
    }
  }
  // Read one stream's rows for a UTC day (plain or gzipped), oldest first.
  read(stream, day) {
    const p = path.join(this.dir, stream, day + '.jsonl');
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fs.existsSync(p + '.gz') ? zlib.gunzipSync(fs.readFileSync(p + '.gz')).toString('utf8') : '';
    return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  stats() {
    const streams = {};
    let bytes = 0;
    for (const s of TAPE_STREAMS) {
      const dir = path.join(this.dir, s); let files = [];
      try { files = fs.readdirSync(dir).filter(f => DAY.test(f)).sort(); } catch {}
      const size = files.reduce((n, f) => { try { return n + fs.statSync(path.join(dir, f)).size; } catch { return n; } }, 0); bytes += size;
      streams[s] = { days: files.length, from: files[0]?.slice(0, 10) || null, to: files.at(-1)?.slice(0, 10) || null, bytes: size, rowsThisRun: this.rows[s] || 0, lastAt: this.lastAt[s] || null };
    }
    return { dir: 'bot-tape', keepDays: this.keepDays, bytes, streams, errors: this.errors, lastError: this.lastError };
  }
}

// Compact rows. Bucket and contract tuples keep the order documented here so a reader needs no schema lookup.
// weather event: { city, date, event, closeAt, nws, cal: {mu, sigma, lead, forecast} | null,
//                  buckets: [[lo, hi, yesBid, yesAsk, noBid, noAsk, ticker]] }   (open-ended lo/hi are null)
// v2 (2026-10-03) adds per event:
//   prov: { nws: {value, publishedAt, receivedAt, units} | null,
//           cal: {provider, model, run, runObserved, receivedAt, firstReceivedAt, revision, previousValue, units, tz,
//                 lat, lon, station, horizonH, endpoint, variable} | null }
//   binding: {ok, station, expectedStation, ruleDate, unit, kind, source, sourceUrl, rulesTemplateHash, reason}
// Rows without v are v1 and carry no provenance; prospective evaluators read v2 rows only.
export const WEATHER_TAPE_VERSION = 2;
export function weatherTapeRow(frame) {
  return { v: WEATHER_TAPE_VERSION, events: frame.events.map(({ cityId, m, cm }) => ({ city: cityId, date: m.date, event: m.eventTicker, closeAt: m.closeAt, nws: m.nwsHigh ?? null,
    cal: cm ? { mu: cm.mu, sigma: cm.sigma, lead: cm.lead, forecast: cm.forecast, source: cm.source || null } : null,
    prov: { nws: m.nwsHigh == null ? null : { value: m.nwsHigh, ...(m.nwsProv || {}) }, cal: cm?.prov || null },
    binding: m.binding ? (({ ok, station, expectedStation, ruleDate, unit, kind, source, sourceUrl, rulesTemplateHash, reason }) => ({ ok, station: station ?? null, expectedStation, ruleDate: ruleDate ?? null, unit: unit ?? null, kind: kind ?? null, source: source ?? null, sourceUrl: sourceUrl ?? null, rulesTemplateHash: rulesTemplateHash ?? null, reason }))(m.binding) : null,
    buckets: (m.buckets || []).map(b => [Number.isFinite(b.lo) ? b.lo : null, Number.isFinite(b.hi) ? b.hi : null, b.yesBid ?? null, b.yesAsk ?? null, b.noBid ?? null, b.noAsk ?? null, b.sourceId || null]) })) };
}
// btc: { spot, volNow, volDay, contracts: [[ticker, event, closeAt, strikeType, floor, cap, yesBid, yesAsk, noBid, noAsk]] }
// Only contracts with a two-sided market between 2¢ and 98¢ are kept; the rest are never tradable and would
// make the tape ten times bigger.
export function btcTapeRow(frame) {
  const contracts = [];
  for (const { e, markets } of frame.events) for (const m of markets) {
    const d = m.data, mid = d.yesBid != null && d.yesAsk != null ? (d.yesBid + d.yesAsk) / 2 : null;
    if (mid == null || mid < 0.02 || mid > 0.98) continue;
    contracts.push([m.sourceId, e.event_ticker, d.closeAt, d.strikeType, d.floorStrike ?? null, d.capStrike ?? null, d.yesBid, d.yesAsk, d.noBid ?? null, d.noAsk ?? null]);
  }
  return { spot: frame.spot, volNow: frame.volNow, volDay: frame.volDay, contracts };
}
