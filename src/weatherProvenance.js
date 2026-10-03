// Weather forecast provenance and Kalshi settlement binding (2026-10-03, coordinated research run).
//
// Two jobs, both read-only and paper-only:
//  1. Bind each Kalshi daily-high event to the exact settlement criteria its own contract rules state: the
//     climate station (NWS CLI site id, e.g. CLINYC = Central Park), the local date, the unit and the named
//     source. A contract whose rules name a different station, date or unit than the city the forecast is for
//     is REJECTED: a forecast for one station is not evidence about another station's reading.
//  2. Share forecast downloads. Identical concurrent requests are coalesced onto one in-flight promise, results
//     are cached by (provider, model, run, location), and each provider has an hourly request budget. Every
//     receipt is stamped with first-receipt time and revision count; a model run time is recorded only when the
//     provider states it (never inferred).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { writeFileAtomicSync } from './atomicRename.js';

// Station each city's forecast coordinates describe (the CLI site named in the Kalshi KXHIGH* rules).
export const KALSHI_WEATHER_STATIONS = Object.freeze({
  NYC: { station: 'CLINYC', place: 'Central Park', tz: 'America/New_York' },
  CHI: { station: 'CLIMDW', place: 'Chicago Midway', tz: 'America/Chicago' },
  MIA: { station: 'CLIMIA', place: 'Miami Intl', tz: 'America/New_York' },
  LAX: { station: 'CLILAX', place: 'Los Angeles Intl', tz: 'America/Los_Angeles' },
  AUS: { station: 'CLIAUS', place: 'Austin Bergstrom', tz: 'America/Chicago' },
  DEN: { station: 'CLIDEN', place: 'Denver Intl', tz: 'America/Denver' },
  PHL: { station: 'CLIPHL', place: 'Philadelphia Intl', tz: 'America/New_York' },
  ATL: { station: 'CLIATL', place: 'Atlanta Hartsfield', tz: 'America/New_York' },
  SEA: { station: 'CLISEA', place: 'Seattle-Tacoma', tz: 'America/Los_Angeles' },
  DAL: { station: 'CLIDFW', place: 'Dallas/Fort Worth', tz: 'America/Chicago' },
});
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const sha = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// Parse one contract's primary rules: "If the maximum temperature recorded at New York City (CLINYC) for
// Sep 27, 2026, is greater than 72° fahrenheit according to The Weather Company, then ...".
export function parseWeatherRules(rules) {
  const t = String(rules || ''); if (!t) return null;
  const st = /\((CLI[A-Z0-9]{3,4})\)/.exec(t), dm = /\bfor ([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4})/.exec(t);
  const unit = /fahrenheit|°\s*F\b/i.test(t) ? 'F' : /celsius|°\s*C\b/i.test(t) ? 'C' : null;
  const source = /according to ([^,.]+?)(?:,|\.| then)/i.exec(t)?.[1]?.trim() || null;
  const kind = /maximum temperature/i.test(t) ? 'DAILY_MAX' : /minimum temperature/i.test(t) ? 'DAILY_MIN' : null;
  const date = dm && MONTHS[dm[1]] ? `${dm[3]}-${String(MONTHS[dm[1]]).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}` : null;
  // Template hash: the same rules wording with thresholds/dates removed, so a rules change is visible.
  const template = t.replace(/\d+(\.\d+)?/g, '#');
  return { station: st?.[1] || null, date, unit, source, kind, templateHash: sha(template) };
}

// markets: normalized Kalshi contracts ({data:{settlementRules, resolutionSource, seriesTicker}}) of one event.
// Returns ok:true (bound), ok:false (explicit mismatch: never use this event as evidence for the city) or
// ok:null (rules unavailable: unknown, recorded as such).
export function bindWeatherSettlement({ cityId, date, eventTicker = null, markets = [] } = {}) {
  const expect = KALSHI_WEATHER_STATIONS[cityId];
  const base = { schema: 'mpo.weather-settlement-binding.v1', cityId, eventTicker, date, expectedStation: expect?.station || null, tz: expect?.tz || null };
  if (!expect) return { ...base, ok: false, reason: 'city has no declared settlement station' };
  const parsed = markets.map(m => parseWeatherRules(m?.data?.settlementRules)).filter(Boolean);
  if (!parsed.length) return { ...base, ok: null, reason: 'contract rules unavailable' };
  const stations = [...new Set(parsed.map(p => p.station))], dates = [...new Set(parsed.map(p => p.date))], units = [...new Set(parsed.map(p => p.unit))], kinds = [...new Set(parsed.map(p => p.kind))];
  const sources = [...new Set(parsed.map(p => p.source))], templates = [...new Set(parsed.map(p => p.templateHash))];
  const sourceUrl = markets.map(m => m?.data?.resolutionSource).find(Boolean) || null;
  const out = { ...base, station: stations.length === 1 ? stations[0] : null, ruleDate: dates.length === 1 ? dates[0] : null, unit: units.length === 1 ? units[0] : null, kind: kinds.length === 1 ? kinds[0] : null, source: sources.length === 1 ? sources[0] : null, sourceUrl, rulesTemplateHash: templates.length === 1 ? templates[0] : null, contracts: parsed.length };
  const problems = [];
  if (stations.length !== 1 || stations[0] !== expect.station) problems.push(`rules name station ${stations.join('/') || 'none'}, forecast is for ${expect.station}`);
  if (dates.length !== 1 || (date && dates[0] !== date)) problems.push(`rules date ${dates.join('/') || 'none'} differs from event date ${date}`);
  if (units.length !== 1 || units[0] !== 'F') problems.push(`rules unit ${units.join('/') || 'none'} is not °F`);
  if (kinds.length !== 1 || kinds[0] !== 'DAILY_MAX') problems.push('rules are not a daily maximum');
  if(problems.length)return { ...out, ok: false, reason: problems.join('; ') };
  if(parsed.length!==markets.length)return {...out,ok:null,reason:'One or more contract rules are unavailable; event binding is incomplete'};
  if(sources.length!==1||!sources[0])return {...out,ok:null,reason:'Exact settlement source is unavailable or inconsistent'};
  return { ...out, ok: true, reason: null };
}

// One shared lane for forecast downloads. key = (provider, model, run, location); identical concurrent requests
// share one promise; results live for ttlMs; every provider has an hourly budget (exceeding it fails closed
// with code BUDGET instead of issuing the request). Revisions: a changed value for the same
// (provider, model, location, target date) increments its revision and keeps first-receipt time.
export class SharedForecastFetch {
  constructor({ now = () => Date.now(), budgets = { 'open-meteo': 600, nws: 600 }, file = null } = {}) {
    this.now = now; this.budgets = budgets; this.inflight = new Map(); this.cache = new Map(); this.window = new Map(); this.receipts = new Map();
    this.file = file;
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.schema !== 'mpo.forecast-receipts.v1' || !Array.isArray(saved.receipts) || !Array.isArray(saved.window)) throw new Error('invalid schema');
        this.receipts = new Map(saved.receipts); this.window = new Map(saved.window);
      } catch { this.recoveryError = 'Forecast receipt store unreadable; preserve it for recovery'; }
    }
    this.stats = { requests: 0, coalesced: 0, cacheHits: 0, budgetRefusals: 0, byProvider: {} };
  }
  persist() { if (this.file) writeFileAtomicSync(this.file, JSON.stringify({ schema: 'mpo.forecast-receipts.v1', receipts: [...this.receipts], window: [...this.window] })); }
  static key({ provider, model = 'default', run = 'latest', lat, lon, tz = '' }) { return [provider, model, run, Number(lat).toFixed(4), Number(lon).toFixed(4), tz].join('|'); }
  async get(spec, load, { ttlMs = 1800e3 } = {}) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    const key = SharedForecastFetch.key(spec), hit = this.cache.get(key), t = this.now();
    if (hit && t - hit.at < ttlMs) { this.stats.cacheHits++; return hit.value; }
    if (this.inflight.has(key)) { this.stats.coalesced++; return this.inflight.get(key); }
    const hour = Math.floor(t / 3600e3), w = this.window.get(spec.provider);
    const used = w?.hour === hour ? w.n : 0, budget = this.budgets[spec.provider] ?? Infinity;
    if (used >= budget) { this.stats.budgetRefusals++; throw Object.assign(new Error(`${spec.provider} forecast budget (${budget}/h) exhausted`), { code: 'BUDGET' }); }
    this.window.set(spec.provider, { hour, n: used + 1 });
    this.persist();
    this.stats.requests++; this.stats.byProvider[spec.provider] = (this.stats.byProvider[spec.provider] || 0) + 1;
    const p = Promise.resolve().then(load).then(value => { this.cache.set(key, { at: this.now(), value }); while (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value); return value; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p); return p;
  }
  // Stamp a received forecast value: first receipt, latest receipt and revision count per target.
  receipt({ provider, model = 'default', cityId, target, value, receivedAt = this.now(), run = null, publishedAt = null }) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    const k = [provider, model, cityId, target].join('|'), prev = this.receipts.get(k);
    const changed = !prev || prev.value !== value || prev.receivedAt !== receivedAt;
    const rec = !prev ? { firstReceivedAt: receivedAt, valueAvailableAt:receivedAt, revision: 0, value } : prev.value === value ? prev : { firstReceivedAt: prev.firstReceivedAt, valueAvailableAt:receivedAt, revision: prev.revision + 1, value, previous: prev.value };
    rec.valueAvailableAt??=rec.receivedAt??receivedAt;
    rec.receivedAt = receivedAt; this.receipts.set(k, rec);
    while (this.receipts.size > 2000) this.receipts.delete(this.receipts.keys().next().value);
    if (changed) this.persist();
    return { provider, model, cityId, target, value, run, runObserved: run != null, publishedAt, receivedAt, valueAvailableAt:rec.valueAvailableAt, firstReceivedAt: rec.firstReceivedAt, revision: rec.revision, previousValue: rec.previous ?? null };
  }
  snapshot() { return { ...this.stats, byProvider: { ...this.stats.byProvider }, inflight: this.inflight.size, cached: this.cache.size, recoveryError: this.recoveryError ?? null }; }
}

// Hours from a receipt to the end of the settlement day in the station's timezone (the forecast horizon).
export function horizonHours(receivedAt, date, tz) {
  if (!Number.isFinite(receivedAt) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !tz) return null;
  // End of local day = local midnight after `date`; find the UTC instant by probing the zone offset.
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400e3);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(next).map(p => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute), offset = asLocal - next.getTime();
  return Math.round((next.getTime() - offset - receivedAt) / 3600e3 * 100) / 100;
}
