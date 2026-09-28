import { createSign, constants } from 'node:crypto';

export const KALSHI_DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';
const SERIES = Object.freeze({ weather: ['KXHIGH', 'KXLOW'], sports: ['KXNFL', 'KXNBA', 'KXMLB'] });
export function kalshiSeries(category) { return [...(SERIES[String(category || '').toLowerCase()] || [])]; }
export function signKalshiRequest({ privateKey, timestamp, method, path }) {
  const signer = createSign('RSA-SHA256'); signer.update(`${timestamp}${String(method).toUpperCase()}${path.split('?')[0]}`); signer.end();
  return signer.sign({ key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
}

export class KalshiClient {
  constructor({ apiKey = process.env.KALSHI_API_KEY, privateKey = process.env.KALSHI_PRIVATE_KEY, baseUrl = KALSHI_DEMO_BASE,
    mode = process.env.MODE || 'paper', fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.apiKey = apiKey; this.privateKey = privateKey; this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.mode = String(mode).toLowerCase(); this.fetch = fetchImpl; this.now = now;
    if (this.mode === 'paper' && new URL(this.baseUrl).hostname !== 'demo-api.kalshi.co') throw new Error('Kalshi paper mode requires demo-api.kalshi.co');
  }
  async request(method, endpoint, body = null, { auth = false } = {}) {
    const url = new URL(`${this.baseUrl}${endpoint}`), headers = { accept: 'application/json' };
    let payload;
    if (body != null) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    if (auth) {
      if (!this.apiKey || !this.privateKey) throw new Error('KALSHI_API_KEY and KALSHI_PRIVATE_KEY are required');
      const timestamp = String(this.now()), pathname = url.pathname.replace('/trade-api/v2', '');
      headers['KALSHI-ACCESS-KEY'] = this.apiKey; headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
      headers['KALSHI-ACCESS-SIGNATURE'] = signKalshiRequest({ privateKey: this.privateKey, timestamp, method, path: pathname });
    }
    const response = await this.fetch(url, { method, headers, ...(payload ? { body: payload } : {}) });
    if (!response?.ok) throw new Error(`Kalshi HTTP ${response?.status || 0}`);
    return response.json();
  }
  async listMarkets({ series, eventTicker, limit = 100 } = {}) { const q = new URLSearchParams({ limit: String(Math.min(200, Math.max(1, limit))) }); if (series) q.set('series_ticker', series); if (eventTicker) q.set('event_ticker', eventTicker); return (await this.request('GET', `/markets?${q}`)).markets || []; }
  async getMarket(ticker) { return (await this.request('GET', `/markets/${encodeURIComponent(ticker)}`)).market; }
  async placeOrder(order) { return this.request('POST', '/portfolio/orders', order, { auth: true }); }
  async getPortfolio() { return this.request('GET', '/portfolio/balance', null, { auth: true }); }
  async getSettlements(params = {}) { const q = new URLSearchParams(params); return (await this.request('GET', `/portfolio/settlements${q.size ? `?${q}` : ''}`, null, { auth: true })).settlements || []; }
}
