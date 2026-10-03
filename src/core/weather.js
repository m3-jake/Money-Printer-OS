// Weather desk. Sources:
//   NWS (api.weather.gov): active Severe/Extreme alerts and point forecasts. NWS asks clients for a
//     descriptive User-Agent; set NWS_USER_AGENT to add a contact (a generic app name works today).
//   NHC (nhc.noaa.gov/CurrentStorms.json): active tropical systems.
//   Kalshi daily-high markets: mutually exclusive temperature buckets per city and day. Kalshi settles
//     them on The Weather Company's reading (series settlement source), NOT on NWS, so the NWS forecast
//     is an input to compare against the market, never the settlement value.
// Links from alerts/storms to markets and sectors are SPECULATIVE ANALYSIS and labelled so.

export const WEATHER_CITIES = Object.freeze([
  { id: 'NYC', label: 'New York City', lat: 40.7789, lon: -73.9692, kalshi: 'KXHIGHNY' },
  { id: 'CHI', label: 'Chicago', lat: 41.7868, lon: -87.7522, kalshi: 'KXHIGHCHI' },
  { id: 'MIA', label: 'Miami', lat: 25.7959, lon: -80.287, kalshi: 'KXHIGHMIA' },
  { id: 'LAX', label: 'Los Angeles', lat: 33.9382, lon: -118.3866, kalshi: 'KXHIGHLAX' },
  { id: 'AUS', label: 'Austin', lat: 30.1945, lon: -97.6699, kalshi: 'KXHIGHAUS' },
  { id: 'DEN', label: 'Denver', lat: 39.8466, lon: -104.6562, kalshi: 'KXHIGHDEN' },
  { id: 'PHL', label: 'Philadelphia', lat: 39.8729, lon: -75.2437, kalshi: 'KXHIGHPHIL' },
  { id: 'ATL', label: 'Atlanta', lat: 33.6407, lon: -84.4277, kalshi: 'KXHIGHTATL' },
  { id: 'SEA', label: 'Seattle', lat: 47.4502, lon: -122.3088, kalshi: 'KXHIGHTSEA' },
  { id: 'DAL', label: 'Dallas', lat: 32.8998, lon: -97.0403, kalshi: 'KXHIGHTDAL' },
]);

// Kalshi bucket ladder -> distribution. between [floor, cap] inclusive of whole degrees; less: below cap;
// greater: above floor. Probabilities are YES mids; their sum is reported, not forced to 1, except for
// the median, which uses the normalized cumulative distribution.
export function bucketLadder(markets) {
  const rows = [];
  for (const m of markets) {
    const d = m.data, bid = d.yesBid, ask = d.yesAsk;
    if (bid === null || ask === null || ask < bid) continue;
    let lo = null, hi = null;
    if (d.strikeType === 'between' && Number.isFinite(d.floorStrike) && Number.isFinite(d.capStrike)) { lo = d.floorStrike; hi = d.capStrike; }
    else if (d.strikeType === 'less' && Number.isFinite(d.capStrike)) { lo = -Infinity; hi = d.capStrike - 1; }
    else if (d.strikeType === 'greater' && Number.isFinite(d.floorStrike)) { lo = d.floorStrike + 1; hi = Infinity; }
    else continue;
    rows.push({ lo, hi, p: (bid + ask) / 2, label: d.yesLabel || d.outcomeDefinition || d.title, sourceId: m.sourceId, closeAt: d.closeAt, yesBid: bid, yesAsk: ask, noBid: d.noBid ?? null, noAsk: d.noAsk ?? null, feeModel: d.feeModel || null });
  }
  rows.sort((a, b) => a.lo - b.lo);
  const total = rows.reduce((s, r) => s + r.p, 0);
  let median = null, acc = 0;
  if (total > 0) for (const r of rows) { acc += r.p / total; if (acc >= 0.5) { median = r.hi === Infinity ? `${r.lo}+` : r.lo === -Infinity ? `≤${r.hi}` : r.lo === r.hi ? `${r.lo}` : `${r.lo}–${r.hi}`; break; } }
  const mid = r => (r.lo === -Infinity ? r.hi - 0.5 : r.hi === Infinity ? r.lo + 0.5 : (r.lo + r.hi) / 2);
  const expected = total > 0 && rows.length ? Math.round(rows.reduce((s, r) => s + mid(r) * r.p / total, 0) * 10) / 10 : null;
  return { buckets: rows, sumOfMids: Math.round(total * 1000) / 1000, medianBucket: median, expectedHigh: expected, closeAt: rows.map(r => r.closeAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null,
    note: 'Bucket mids from Kalshi; the sum is shown as quoted. Median and expected value use the normalized distribution and tail midpoints ±0.5°F.' };
}

// NWS forecast periods -> daytime highs by local date (YYYY-MM-DD from the period start).
export function dailyHighs(periods) {
  const out = {};
  for (const p of periods || []) if (p.isDaytime && Number.isFinite(p.temperature) && p.temperatureUnit === 'F') out[String(p.startTime).slice(0, 10)] = { high: p.temperature, name: p.name, short: p.shortForecast };
  return out;
}

export function parseAlerts(geojson) {
  return (geojson?.features || []).map(f => { const p = f.properties || {}; const sent = Date.parse(p.sent || ''); return p.id && Number.isFinite(sent) ? { id: p.id, event: p.event ?? null, severity: p.severity ?? null, urgency: p.urgency ?? null, certainty: p.certainty ?? null, area: p.areaDesc ?? null, headline: p.headline || null, sent, onset: Date.parse(p.onset || '') || null, expires: Date.parse(p.expires || '') || null, sender: p.senderName || null, states: [...new Set(String(p.areaDesc || '').match(/\b[A-Z]{2}\b/g) || [])] } : null; }).filter(Boolean);
}
export function parseStorms(j) {
  return (j?.activeStorms || []).map(s => ({ id: s.id, name: s.name, classification: s.classification, intensityKt: Number(s.intensity) || null, pressureMb: Number(s.pressure) || null, lat: s.latitudeNumeric, lon: s.longitudeNumeric, movement: s.movementDir != null ? `${s.movementDir}° at ${s.movementSpeed} kt` : null, updated: Date.parse(s.lastUpdate || '') || null, advisory: s.publicAdvisory?.url || null }));
}

// SPECULATIVE ANALYSIS: which markets and sectors an alert or storm might touch.
const SECTOR_LINKS = [
  [/hurricane|tropical storm|storm surge/i, ['Insurers (KIE)', 'Energy (XLE)', 'Natural gas (UNG)', 'Airlines (JETS)', 'Home improvement (HD, LOW)']],
  [/excessive heat|extreme heat|heat advisory/i, ['Utilities (XLU)', 'Natural gas (UNG)']],
  [/winter storm|blizzard|ice storm|extreme cold|wind chill/i, ['Natural gas (UNG)', 'Heating oil', 'Airlines (JETS)']],
  [/flood|flash flood/i, ['Insurers (KIE)', 'Rail/transport (IYT)']],
  [/red flag|fire weather/i, ['Utilities (XLU)', 'Insurers (KIE)']],
];
export function weatherLinks(text, contracts = []) {
  const sectors = SECTOR_LINKS.filter(([re]) => re.test(text)).flatMap(([, s]) => s);
  const words = String(text).toLowerCase().match(/[a-z]{4,}/g) || [], names = new Set(words.filter(w => !['storm', 'warning', 'watch', 'advisory', 'tropical', 'weather', 'flood', 'flash', 'hurricane'].includes(w)));
  const markets = contracts.filter(c => { const t = String(c.data?.title || '').toLowerCase(); return /hurricane|storm|temperature|rain|snow|heat|weather/.test(t) && [...names].some(n => t.includes(n)); }).slice(0, 8).map(c => ({ id: c.id, venue: c.provider, title: c.data.title }));
  return { kind: 'SPECULATIVE_ANALYSIS', sectors: [...new Set(sectors)], markets, note: 'Possible exposure only; not a measured relationship.' };
}

export class WeatherSource {
  constructor({ fetchImpl = globalThis.fetch, env = process.env } = {}) { this.fetch = fetchImpl; this.env = env; this.cache = new Map(); this.inflight = new Map(); this.health = { status: 'IDLE', lastSuccess: null, lastError: null }; }
  ua() { return String(this.env.NWS_USER_AGENT || 'MoneyPrinterOS/0.5 (weather desk)'); }
  status() { return { id: 'nws', ...this.health }; }
  // Identical concurrent reads share one request.
  get(url, ttlMs) {
    const hit = this.cache.get(url); if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data);
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = this.fetchOnce(url).finally(() => this.inflight.delete(url)); this.inflight.set(url, p); return p;
  }
  async fetchOnce(url) {
    try {
      const r = await this.fetch(url, { headers: { 'User-Agent': this.ua(), accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout?.(15000) });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).host}`), { code: r.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR' });
      const data = await r.json(); this.cache.set(url, { at: Date.now(), data, receivedAt: Date.now() }); this.health = { status: 'CONNECTED', lastSuccess: Date.now(), lastError: null }; return data;
    } catch (e) { this.health = { ...this.health, status: e.code === 'RATE_LIMITED' ? 'DEGRADED' : 'DISCONNECTED', lastError: e.code || 'NETWORK_ERROR' }; throw e; }
  }
  async alerts() { return parseAlerts(await this.get('https://api.weather.gov/alerts/active?severity=Severe,Extreme', 120000)); }
  async storms() { return parseStorms(await this.get('https://www.nhc.noaa.gov/CurrentStorms.json', 600000)); }
  async highs(city) { const pt = await this.get(`https://api.weather.gov/points/${city.lat},${city.lon}`, 86400000); const f = await this.get(pt.properties.forecast, 1800000); return { highs: dailyHighs(f.properties?.periods), updated: Date.parse(f.properties?.updateTime || f.properties?.updated || '') || null, generatedAt: Date.parse(f.properties?.generatedAt || '') || null, receivedAt: this.cache.get(pt.properties.forecast)?.receivedAt ?? null }; }
}
