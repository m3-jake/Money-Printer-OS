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

export const CITY_TZ = Object.freeze({ NYC: 'America/New_York', CHI: 'America/Chicago', MIA: 'America/New_York', LAX: 'America/Los_Angeles', AUS: 'America/Chicago', DEN: 'America/Denver', PHL: 'America/New_York', ATL: 'America/New_York', SEA: 'America/Los_Angeles', DAL: 'America/Chicago' });
const SCHEMA = 'mpo.weather-calibration.v1', MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DEFAULT_SD = [1.6, 2.6];
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
export const dateOfTicker = t => { const m = String(t).match(/-(\d{2})([A-Z]{3})(\d{2})$/); return m ? `20${m[1]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[3]}` : null; };

// Daily max per local date from an Open-Meteo hourly block (times are already local when timezone= is set).
export function dailyMax(times, values) {
  const out = {};
  times.forEach((t, i) => { const v = values?.[i]; if (v == null || !Number.isFinite(v)) return; const d = t.slice(0, 10); out[d] = out[d] == null ? v : Math.max(out[d], v); });
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
  constructor({ dataDir, fetchImpl = globalThis.fetch, now = () => Date.now(), days = 150 } = {}) { this.file = path.join(dataDir, 'weather-calibration.json'); this.fetch = fetchImpl; this.now = now; this.days = days; this.forecasts = new Map(); this.state = this.load(); }
  load() { try { const s = JSON.parse(fs.readFileSync(this.file, 'utf8')); return s.schema === SCHEMA ? s : null; } catch { return null; } }
  async get(url) { const r = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'MoneyPrinterOS/0.5 (weather calibration)' }, signal: AbortSignal.timeout?.(20000) }); if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`); return r.json(); }
  async actuals(series) {
    const out = {}; let cursor = '';
    for (let page = 0; page < 3; page++) {
      const j = await this.get(`https://external-api.kalshi.com/trade-api/v2/events?series_ticker=${series}&status=settled&limit=200&with_nested_markets=true${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      for (const e of j.events || []) { const d = dateOfTicker(e.event_ticker), v = (e.markets || []).map(m => Number(m.expiration_value)).find(Number.isFinite); if (d && v != null) out[d] = v; }
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
  async forecast(cityId) {
    const hit = this.forecasts.get(cityId); if (hit && this.now() - hit.at < 1800e3) return hit.highs;
    const city = WEATHER_CITIES.find(c => c.id === cityId); if (!city) return null;
    const j = await this.get(`https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&hourly=temperature_2m&forecast_days=3&temperature_unit=fahrenheit&timezone=${encodeURIComponent(CITY_TZ[cityId])}`);
    const highs = dailyMax(j.hourly.time, j.hourly.temperature_2m); this.forecasts.set(cityId, { at: this.now(), highs }); return highs;
  }
  // Model for one city/market date, or null (the bot then uses the NWS forecast with its default settings).
  async model(cityId, date) {
    const c = this.state?.cities?.[cityId]; if (!c?.leads) return null;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: CITY_TZ[cityId] }).format(new Date(this.now())), lead = date === today ? 0 : 1, L = c.leads[lead];
    if (!L?.use) return null;
    const highs = await this.forecast(cityId), f = highs?.[date]; if (f == null) return null;
    return { mu: f + L.params.bias, sigma: L.params.sd, forecast: f, lead, bias: L.params.bias, n: L.params.n, source: 'open-meteo + calibration' };
  }
  snapshot() { return this.state; }
}
