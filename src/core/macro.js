import { finite } from './model.js';

// Macro desk. Two kinds of data, never mixed up:
//   1. FRED observations. With FRED_API_KEY they come from ALFRED vintages: each value carries the date
//      it was first published (realtime_start), so a backtest can ask "what was known on day D".
//      FRED gives publication DATES, not times, so a value is treated as available only at the END of its
//      publication day (US/Eastern). That is late by up to a day, never early.
//      Without a key the public fredgraph CSV gives only the latest revised values: shown for context,
//      refused for as-of queries (it would leak revisions into the past).
//   2. Kalshi macro ladders: each strike market ("CPI rises more than 0.3%?") closes minutes before the
//      official release. Together they give the release schedule (Kalshi close time, labelled as such)
//      and a market-implied distribution.

export const MACRO_INDICATORS = Object.freeze([
  { id: 'CPI', label: 'CPI, month over month', fred: 'CPIAUCSL', transform: 'mom_pct', unit: '%', kalshi: 'KXCPI' },
  { id: 'CORE_CPI', label: 'Core CPI, month over month', fred: 'CPILFESL', transform: 'mom_pct', unit: '%', kalshi: 'KXCPICORE' },
  { id: 'CPI_YOY', label: 'CPI, year over year', fred: 'CPIAUCSL', transform: 'yoy_pct', unit: '%', kalshi: 'KXCPIYOY' },
  { id: 'PCE', label: 'PCE price index, month over month', fred: 'PCEPI', transform: 'mom_pct', unit: '%', kalshi: null },
  { id: 'UNRATE', label: 'Unemployment rate', fred: 'UNRATE', transform: 'level', unit: '%', kalshi: 'KXU3' },
  { id: 'PAYROLLS', label: 'Nonfarm payrolls, monthly change', fred: 'PAYEMS', transform: 'diff', unit: 'k', kalshi: 'KXPAYROLLS', kalshiScale: 0.001 }, // Kalshi strikes are jobs; FRED PAYEMS is thousands
  { id: 'CLAIMS', label: 'Initial jobless claims', fred: 'ICSA', transform: 'level', unit: '', kalshi: 'KXJOBLESS' },
  { id: 'GDP', label: 'Real GDP growth (annualized)', fred: 'A191RL1Q225SBEA', transform: 'level', unit: '%', kalshi: 'KXGDP' },
  { id: 'FEDFUNDS', label: 'Fed funds target, upper bound', fred: 'DFEDTARU', transform: 'level', unit: '%', kalshi: 'KXFED' },
  { id: 'DGS10', label: '10-year Treasury yield', fred: 'DGS10', transform: 'level', unit: '%', kalshi: null },
  { id: 'DGS2', label: '2-year Treasury yield', fred: 'DGS2', transform: 'level', unit: '%', kalshi: null },
  { id: 'T10Y2Y', label: 'Yield curve, 10y minus 2y', fred: 'T10Y2Y', transform: 'level', unit: 'pts', kalshi: null },
  { id: 'RETAIL', label: 'Retail sales, month over month', fred: 'RSAFS', transform: 'mom_pct', unit: '%', kalshi: 'KXRETAIL' },
  { id: 'INDPRO', label: 'Industrial production index', fred: 'INDPRO', transform: 'level', unit: '', kalshi: null },
  { id: 'HOUST', label: 'Housing starts (thousands)', fred: 'HOUST', transform: 'level', unit: 'k', kalshi: null },
  { id: 'UMCSENT', label: 'Consumer sentiment (Michigan)', fred: 'UMCSENT', transform: 'level', unit: '', kalshi: null },
  { id: 'M2', label: 'M2 money supply ($bn)', fred: 'M2SL', transform: 'level', unit: 'bn', kalshi: null },
]);
export const indicator = id => MACRO_INDICATORS.find(x => x.id === id) || null;

// End of a calendar day in US/Eastern, as epoch ms (DST-aware via Intl).
export function endOfDayEt(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return null;
  // Eastern offset that day (4 h in daylight time, 5 h otherwise), read at noon UTC.
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(Date.UTC(y, m - 1, d, 12))));
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999) + (12 - etHour) * 3600000;
}

export function transform(rows, kind) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], v = r.value;
    if (kind === 'level') out.push({ ...r });
    else if (kind === 'diff' && i > 0) out.push({ ...r, value: Math.round((v - rows[i - 1].value) * 1000) / 1000 });
    else if (kind === 'mom_pct' && i > 0) out.push({ ...r, value: Math.round((v / rows[i - 1].value - 1) * 100000) / 1000 });
    else if (kind === 'yoy_pct' && i >= 12) out.push({ ...r, value: Math.round((v / rows[i - 12].value - 1) * 100000) / 1000 });
  }
  return out;
}

export function parseFredCsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(','); const n = finite(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && n !== null) rows.push({ date, value: n });
  }
  return rows;
}

// ALFRED rows ({date, value, realtime_start}) -> for each observation date, every vintage in publication order.
export function vintagesFrom(observations) {
  const out = [];
  for (const o of observations || []) { const n = finite(o.value); if (n === null) continue; const availableAt = endOfDayEt(o.realtime_start); if (availableAt === null) continue; out.push({ date: o.date, value: n, published: o.realtime_start, availableAt }); }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.availableAt - b.availableAt);
}
// Series as it was knowable at asOf: for each observation date, its latest vintage published by then.
export function asOf(vintages, asOfMs) {
  const byDate = new Map();
  for (const v of vintages) if (v.availableAt <= asOfMs) byDate.set(v.date, v);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export class FredSource {
  constructor({ fetchImpl = globalThis.fetch, env = process.env } = {}) { this.fetch = fetchImpl; this.env = env; this.cache = new Map(); this.health = { status: 'IDLE', lastSuccess: null, lastError: null }; }
  keyed() { return !!this.env.FRED_API_KEY; }
  status() { return { id: 'fred', ...this.health, mode: this.keyed() ? 'ALFRED_VINTAGES' : 'LATEST_REVISED_CSV' }; }
  async #get(url, parse) {
    const hit = this.cache.get(url); if (hit && Date.now() - hit.at < 3600000) return hit.data;
    try {
      const r = await this.fetch(url, { signal: AbortSignal.timeout?.(15000) });
      if (!r.ok) throw Object.assign(new Error(`FRED HTTP ${r.status}`), { code: r.status === 400 || r.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR' });
      const data = await parse(r); this.cache.set(url, { at: Date.now(), data }); this.health = { status: 'CONNECTED', lastSuccess: Date.now(), lastError: null }; return data;
    } catch (e) { this.health = { ...this.health, status: e.code === 'AUTH_ERROR' ? 'AUTH ERROR' : 'DISCONNECTED', lastError: e.code || 'NETWORK_ERROR' }; throw e; }
  }
  // Latest revised values (context only).
  latest(series) { return this.#get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(series)}`, async r => parseFredCsv(await r.text())); }
  // All vintages (needs a free FRED key).
  async vintages(series) {
    if (!this.keyed()) throw Object.assign(new Error('As-of (vintage) macro history needs FRED_API_KEY (free at fred.stlouisfed.org)'), { code: 'NO_KEY' });
    const u = new URL('https://api.stlouisfed.org/fred/series/observations');
    for (const [k, v] of Object.entries({ series_id: series, api_key: this.env.FRED_API_KEY, file_type: 'json', realtime_start: '1776-07-04', realtime_end: '9999-12-31', observation_start: '2000-01-01' })) u.searchParams.set(k, v);
    return this.#get(u.toString(), async r => vintagesFrom((await r.json()).observations));
  }
}

// Kalshi ladder -> implied distribution. markets: normalized contracts of one event with strike
// ('greater' type: YES pays if outcome > strike). Uses mid of YES bid/ask; skips one-sided books.
// scale converts Kalshi strike units to the indicator's units (e.g. jobs -> thousands).
export function impliedLadder(markets, scale = 1) {
  const rungs = markets.map(m => ({ strike: Number.isFinite(m.data.strike) ? Math.round(m.data.strike * scale * 1e6) / 1e6 : null, type: m.data.strikeType, bid: m.data.yesBid, ask: m.data.yesAsk, title: m.data.title, sourceId: m.sourceId, closeAt: m.data.closeAt }))
    .filter(r => r.type === 'greater' && Number.isFinite(r.strike) && r.bid !== null && r.ask !== null && r.ask >= r.bid).map(r => ({ ...r, p: (r.bid + r.ask) / 2 })).sort((a, b) => a.strike - b.strike);
  let median = null;
  for (let i = 1; i < rungs.length; i++) { const a = rungs[i - 1], b = rungs[i]; if (a.p >= 0.5 && b.p < 0.5) { median = a.strike + (a.p - 0.5) / (a.p - b.p) * (b.strike - a.strike); break; } }
  return { rungs, impliedMedian: median === null ? null : Math.round(median * 1000) / 1000, closeAt: rungs.map(r => r.closeAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null,
    note: 'Probabilities are mid prices of "above strike" markets, not a model; they need not be monotone and include no fees.' };
}
