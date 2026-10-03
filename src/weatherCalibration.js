// Weather calibrator (2026-10-02): Research Workbench phase 1 — see docs/EVOLUTION-LAB-AUDIT-2026-10-02.md.
// Few parameters, real history, held-out check. For each city it learns how far the Open-Meteo forecast lands
// from Kalshi's own settlement value:
//   truth     Kalshi settled KXHIGH* events: the winning market's expiration_value is the official high.
//   forecast  Open-Meteo previous-runs API: hourly temperature_2m for the same day (lead 0) and as forecast one
//             day earlier (lead 1, temperature_2m_previous_day1); daily high = max over the local day.
// Fit per city and lead: bias = mean(actual − forecast), sd = residual standard deviation (floor 1.0 °F).
// The last `testDays` are held out: the calibrated model must beat the default (bias 0, σ 1.6/2.6 °F) on
// log score of the actual degree there, or the city stays on the default. Then it refits on all days.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { WEATHER_CITIES } from './core/weather.js';
import { bucketProbability } from './kalshiBots.js';
import { SharedForecastFetch, KALSHI_WEATHER_STATIONS, horizonHours } from './weatherProvenance.js';

export const CITY_TZ = Object.freeze({ NYC: 'America/New_York', CHI: 'America/Chicago', MIA: 'America/New_York', LAX: 'America/Los_Angeles', AUS: 'America/Chicago', DEN: 'America/Denver', PHL: 'America/New_York', ATL: 'America/New_York', SEA: 'America/Los_Angeles', DAL: 'America/Chicago' });
const SCHEMA = 'mpo.weather-calibration.v1', MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DEFAULT_SD = [1.6, 2.6];
const LAB_MODELS = new Set(['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless', 'gem_seamless']);
const EVIDENCE_MAX_AGE_MS = 48 * 3600e3;
const freshEvidence = (at, now) => Number.isSafeInteger(at) && at > 0 && at <= now && now - at <= EVIDENCE_MAX_AGE_MS;
const safeParams = p => p && Number.isFinite(p.bias) && Math.abs(p.bias) <= 20 && Number.isFinite(p.sd) && p.sd >= 1 && p.sd <= 20;
const finiteScore = x => Number.isFinite(x) && x <= 0 && x >= Math.log(1e-6) - .001;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
export const dateOfTicker = t => { const m = String(t).match(/-(\d{2})([A-Z]{3})(\d{2})$/); return m ? `20${m[1]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[3]}` : null; };

// Daily max per local date from an Open-Meteo hourly block (times are already local when timezone= is set).
export function dailyMax(times, values) {
  const out = {};
  (times || []).forEach((t, i) => { const v = values?.[i]; if (typeof t !== 'string' || v == null || !Number.isFinite(v)) return; const d = t.slice(0, 10); out[d] = out[d] == null ? v : Math.max(out[d], v); });
  return out;
}
export function fit(residuals) {
  const n = residuals.length; if (n < 10) return null;
  const bias = residuals.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(residuals.reduce((s, x) => s + (x - bias) ** 2, 0) / (n - 1));
  return { n, bias: round(bias, 2), sd: round(Math.max(1, sd), 2), mae: round(residuals.reduce((s, x) => s + Math.abs(x), 0) / n, 2) };
}
// Mean log probability the model gave to the degree that actually happened (higher is better).
export function logScore(rows, lead, params) {
  const xs = rows.filter(r => r.f[lead] != null); if (!xs.length) return null;
  return round(xs.reduce((s, r) => s + Math.log(Math.max(1e-6, bucketProbability(r.actual, r.actual, r.f[lead] + params.bias, params.sd))), 0) / xs.length, 4);
}
// rows: [{date, actual, f:[lead0, lead1]}] sorted by date.
export function calibrateCity(rows, { testDays = 30 } = {}) {
  const out = {};
  for (const lead of [0, 1]) {
    const usable = rows.filter(r => r.f[lead] != null), test = usable.slice(-testDays), train = usable.slice(0, -testDays);
    const trained = fit(train.map(r => r.actual - r.f[lead])), def = { bias: 0, sd: DEFAULT_SD[lead] };
    const heldOut = trained ? { calibrated: logScore(test, lead, trained), default: logScore(test, lead, def), n: test.length } : null;
    const passes = !!(heldOut && heldOut.calibrated != null && heldOut.calibrated > heldOut.default);
    const final = passes ? fit(usable.map(r => r.actual - r.f[lead])) : null;
    out[lead] = { use: passes, params: final || def, trained, heldOut, reason: !trained ? 'not enough history' : passes ? 'beats the default on held-out days' : 'did not beat the default on held-out days' };
  }
  return out;
}

export class WeatherCalibrator {
  constructor({ dataDir, fetchImpl = globalThis.fetch, now = () => Date.now(), days = 150, shared = null } = {}) { this.file = path.join(dataDir, 'weather-calibration.json'); this.fetch = fetchImpl; this.now = now; this.days = days; this.forecasts = new Map(); this.shared = shared || new SharedForecastFetch({ now, file: path.join(dataDir, 'weather-forecast-receipts.json') }); this.state = this.load(); }
  load() { try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); return s.schema === SCHEMA ? s : null; } catch { return null; } }
  async get(url) { const r = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5 (weather calibration)' }, signal: AbortSignal.timeout?.(20000) }); if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`); return r.json(); }
  async actuals(series) {
    const out = {}; let cursor = '';
    for (let page = 0; page < 3; page++) {
      const j = await this.get(`https://external-api.kalshi.com/trade-api/v2/events?series_ticker=${series}&status=settled&limit=200&with_nested_markets=true${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      for (const e of j.events || []) { const d = dateOfTicker(e.event_ticker), v = (e.markets || []).map(m => m.expiration_value).filter(v => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean').map(Number).find(Number.isFinite); if (d && v != null) out[d] = v; }
      const oldest = Object.keys(out).sort()[0]; cursor = j.cursor;
      if (!cursor || (oldest && Date.parse(oldest) < this.now() - this.days * 86400e3)) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return out;
  }
  async history(city, start, end) {
    const j = await this.get(`https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&start_date=${start}&end_date=${end}&hourly=temperature_2m,temperature_2m_previous_day1&temperature_unit=fahrenheit&timezone=${encodeURIComponent(CITY_TZ[city.id])}`);
    return { d0: dailyMax(j.hourly.time, j.hourly.temperature_2m), d1: dailyMax(j.hourly.time, j.hourly.temperature_2m_previous_day1) };
  }
  async run() {
    const end = new Date(this.now() - 86400e3).toISOString().slice(0, 10), start = new Date(this.now() - this.days * 86400e3).toISOString().slice(0, 10), cities = {};
    for (const city of WEATHER_CITIES) {
      try {
        const [truth, h] = await Promise.all([this.actuals(city.kalshi), this.history(city, start, end)]);
        const rows = Object.keys(truth).filter(d => d >= start && d <= end).sort().map(d => ({ date: d, actual: truth[d], f: [h.d0[d] ?? null, h.d1[d] ?? null] })).filter(r => r.f[0] != null || r.f[1] != null);
        cities[city.id] = { label: city.label, days: rows.length, from: rows[0]?.date || null, to: rows.at(-1)?.date || null, leads: calibrateCity(rows) };
      } catch (e) { cities[city.id] = { label: city.label, error: String(e.message).slice(0, 200) }; }
    }
    this.state = { schema: SCHEMA, at: this.now(), source: 'Kalshi settled expiration_value vs Open-Meteo previous-runs (lead 0 / lead 1)', cities };
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeFileAtomicSync(this.file, JSON.stringify(this.state, null, 1));
    return this.state;
  }
  // Live Open-Meteo daily highs (same hourly → daily-max method as the calibration), cached 30 minutes.
  // Downloads go through the shared forecast lane: concurrent identical requests share one in-flight promise,
  // results are cached by (provider, model, run, location) for 30 minutes and the provider budget applies.
  async forecast(cityId) {
    const city = WEATHER_CITIES.find(c => c.id === cityId); if (!city) return null;
    const got = await this.shared.get({ provider: 'open-meteo', model: 'best_match', lat: city.lat, lon: city.lon, tz: CITY_TZ[cityId] }, async () => {
      const j = await this.get(`https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&forecast_days=3&temperature_unit=fahrenheit&timezone=${encodeURIComponent(CITY_TZ[cityId])}`);
      return { highs: dailyMax(j.hourly.time, j.hourly.temperature_2m), receivedAt: this.now() };
    });
    this.forecasts.set(cityId, { at: got.receivedAt, highs: got.highs }); return got.highs;
  }
  // The Evolution Lab's per-city, per-lead best forecast model (lab-link/workbench.json, its weather-models job):
  // one of gfs_seamless / ecmwf_ifs025 / icon_seamless / gem_seamless, or 'mean' of them, with bias and sd.
  labBest(cityId, lead) {
    if (!this.labCache || this.now() - this.labCache.at > 300e3) {
      let w = null; try { w = JSON.parse(fs.readFileSync(path.join(path.dirname(this.file), 'lab-link', 'workbench.json'), 'utf8')); } catch {}
      const now = this.now(), models = w?.weather?.models;
      const valid = w?.schema === 'mpo.lab-workbench.v1' && freshEvidence(w.updatedAt, now) && freshEvidence(w.weather?.at, now) && Array.isArray(models) && models.length >= 1 && models.length <= 4 && new Set(models).size === models.length && models.every(m => LAB_MODELS.has(m));
      this.labCache = { at: now, evidenceAt: valid ? w.weather.at : null, updatedAt: valid ? w.updatedAt : null, best: valid ? w.weather.best || null : null, models: valid ? models : [] };
    }
    const b = this.labCache.best?.[cityId]?.[lead];
    return freshEvidence(this.labCache.evidenceAt, this.now()) && freshEvidence(this.labCache.updatedAt, this.now()) && b?.use === true && (LAB_MODELS.has(b.model) && this.labCache.models.includes(b.model) || b.model === 'mean' && this.labCache.models.length >= 2) && safeParams(b) && finiteScore(b.heldOut) && finiteScore(b.default) && b.heldOut > b.default ? b : null;
  }
  // Live daily highs from one Open-Meteo model, or the mean of the Lab's models, cached 30 minutes.
  async forecastModel(cityId, model) {
    if (!(LAB_MODELS.has(model) || model === 'mean')) return null;
    const key = cityId + ':' + model;
    const city = WEATHER_CITIES.find(c => c.id === cityId); if (!city) return null;
    const models = model === 'mean' ? this.labCache?.models || [] : [model];
    if (model === 'mean' && models.length < 2 || models.some(m => !LAB_MODELS.has(m))) return null;
    const got = await this.shared.get({ provider: 'open-meteo', model: models.join('+'), lat: city.lat, lon: city.lon, tz: CITY_TZ[cityId] }, async () => {
    const j = await this.get(`https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&models=${models.join(',')}&forecast_days=3&temperature_unit=fahrenheit&timezone=${encodeURIComponent(CITY_TZ[cityId])}`);
    const per = models.map(m => dailyMax(j.hourly?.time, j.hourly?.[`temperature_2m_${m}`] ?? (models.length === 1 ? j.hourly?.temperature_2m : null)));
    const highs = {}; for (const d of new Set(per.flatMap(h => Object.keys(h)))) { const xs = per.map(h => h[d]).filter(Number.isFinite); if (xs.length === models.length) highs[d] = xs.reduce((s, v) => s + v, 0) / xs.length; }
    return { highs, receivedAt: this.now() };
    });
    this.forecasts.set(key, { at: got.receivedAt, highs: got.highs }); return got.highs;
  }
  // Model for one city/market date, or null (the bot then uses the NWS forecast with its default settings).
  // The Lab's model is used when it beats the default on held-out days and scores better than this calibration.
  async model(cityId, date) {
    if (!CITY_TZ[cityId] || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return null;
    const c = this.state?.cities?.[cityId];
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: CITY_TZ[cityId] }).format(new Date(this.now())), daysAhead = (Date.parse(date) - Date.parse(today)) / 86400e3;
    if (![0, 1].includes(daysAhead)) return null;
    const lead = daysAhead, L = c?.leads?.[lead];
    const lab = this.labBest(cityId, lead);
    if (lab && (!L?.use || lab.heldOut > (L.heldOut?.calibrated ?? -Infinity))) {
      const highs = await this.forecastModel(cityId, lab.model).catch(() => null), f = highs?.[date];
      if (f != null) return { mu: f + lab.bias, sigma: lab.sd, forecast: round(f, 1), lead, bias: lab.bias, source: `lab ${lab.model} + calibration`, prov: this.provenance(cityId, lab.model, date, f) };
    }
    if (!L?.use || !safeParams(L.params)) return null;
    const highs = await this.forecast(cityId), f = highs?.[date]; if (f == null) return null;
    return { mu: f + L.params.bias, sigma: L.params.sd, forecast: f, lead, bias: L.params.bias, n: L.params.n, source: 'open-meteo + calibration', prov: this.provenance(cityId, 'best_match', date, f) };
  }
  // Receipt provenance for one forecast value. Open-Meteo's forecast endpoint does not state the model run, so
  // run stays null (runObserved false) rather than being inferred from the receipt time.
  provenance(cityId, model, date, value) {
    const city = WEATHER_CITIES.find(c => c.id === cityId), tz = CITY_TZ[cityId], at = this.forecasts.get(model === 'best_match' ? cityId : cityId + ':' + model)?.at ?? this.now();
    const r = this.shared.receipt({ provider: 'open-meteo', model, cityId, target: date, value: round(value, 2), receivedAt: at });
    return { ...r, endpoint: 'api.open-meteo.com/v1/forecast', variable: 'temperature_2m daily max (local day)', units: 'F', tz, lat: city?.lat ?? null, lon: city?.lon ?? null, station: KALSHI_WEATHER_STATIONS[cityId]?.station || null, horizonH: horizonHours(at, date, tz) };
  }
  snapshot() { return this.state; }
}
