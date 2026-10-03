import { createHash, randomUUID } from 'node:crypto';
import { validateBroker } from './provider.js';
import { stableId } from './model.js';
import { SYMBOL_RE } from '../robinhoodEquitiesData.js';
import { FEES, sellFees } from '../robinhoodEquitiesBook.js';
import { marketState } from '../robinhoodEquitiesCalendar.js';
import { routePaperProposal } from '../paperRouting.js';

// Equities through the BrokerProvider contract (provider.js BROKER_METHODS). The only broker here is
// PAPER: fills are simulated against a fresh quote and booked in the unified ledger through the Risk
// Governor, exactly like prediction-market paper fills. No real brokerage is connected: Robinhood has
// no official equities order API for this app, and real-money execution is forbidden by policy.
// Quotes come from Alpaca's market-data API (IEX feed) when a key is configured; otherwise every
// quote is unavailable and orders are refused. Prices are never invented or carried over.

export const STOCK_VENUE = 'stocks-paper';
export const EQUITY_FEE_MODEL = Object.freeze({ kind: 'EQUITY_PASS_THROUGH', commissionUsd: FEES.commissionUsd, describe: `Commission $0; sells pay SEC Section 31 and FINRA TAF as passed through by Robinhood (${FEES.source}, checked ${FEES.checkedAt})` });
const alpacaKeys = env => { const id = env.ALPACA_KEY_ID || env.APCA_API_KEY_ID || '', secret = env.ALPACA_SECRET_KEY || env.APCA_API_SECRET_KEY || ''; return id && secret ? { id, secret } : null; };
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const cleanSymbols = list => [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map(s => String(s).trim().toUpperCase()).filter(s => SYMBOL_RE.test(s)))].slice(0, 50);

export class AlpacaQuotes {
  constructor({ fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) { this.fetch = fetchImpl; this.env = env; this.now = now; this.observed = new Map(); this.health = { status: 'IDLE', lastSuccess: null, lastError: null }; }
  observedQuotes(){return [...this.observed.values()].map(q=>({...q}));}
  configured() { return !!alpacaKeys(this.env); }
  status() { return { id: 'alpaca-iex', ...this.health, status: this.configured() ? this.health.status : 'NOT CONFIGURED', feed: 'IEX (a single exchange, not the consolidated tape)' }; }
  async quotes(symbols) {
    const k = alpacaKeys(this.env), list = cleanSymbols(symbols);
    if (!k) throw Object.assign(new Error('Stock quotes unavailable: set ALPACA_KEY_ID and ALPACA_SECRET_KEY (free Alpaca market-data key)'), { code: 'NO_KEY' });
    if (!list.length) return {};
    const u = new URL('https://data.alpaca.markets/v2/stocks/snapshots'); u.searchParams.set('symbols', list.join(',')); u.searchParams.set('feed', 'iex');
    try {
      const r = await this.fetch(u.toString(), { headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret, accept: 'application/json' }, signal: AbortSignal.timeout?.(10000) });
      if (!r.ok) throw Object.assign(new Error(`Alpaca HTTP ${r.status}`), { code: r.status === 401 || r.status === 403 ? 'AUTH_ERROR' : r.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR' });
      const j = await r.json(), out = {}, received = this.now();
      for (const s of list) {
        const q = j?.[s]?.latestQuote, t = j?.[s]?.latestTrade, bar = j?.[s]?.dailyBar, prev = j?.[s]?.prevDailyBar;
        const at = Date.parse(q?.t || t?.t || '');
        out[s] = { symbol: s, bid: num(q?.bp) || null, ask: num(q?.ap) || null, bidSize: num(q?.bs), askSize: num(q?.as), last: num(t?.p), prevClose: num(prev?.c), dayClose: num(bar?.c),
          quoteAt: Number.isFinite(at) ? at : null, receivedAt: received, source: 'alpaca-iex' };
      }
      this.health = { status: 'CONNECTED', lastSuccess: received, lastError: null };
      for(const [s,q] of Object.entries(out))this.observed.set(s,{...q});
      return out;
    } catch (e) { this.health = { ...this.health, status: e.code === 'AUTH_ERROR' ? 'AUTH ERROR' : e.code === 'RATE_LIMITED' ? 'DEGRADED' : 'DISCONNECTED', lastError: e.code || 'NETWORK_ERROR' }; throw e; }
  }
}

export class PaperBroker {
  constructor({ platform, quotes = new AlpacaQuotes(), clock = () => Date.now(), session = marketState }) { this.platform = platform; this.quoteSource = quotes; this.clock = clock; this.session = session; this.id = STOCK_VENUE; validateBroker(this); }
  instrumentId(symbol) { return stableId('Instrument', STOCK_VENUE, symbol); }
  instruments(symbols) { return cleanSymbols(symbols).map(s => ({ symbol: s, instrumentId: this.instrumentId(s), kind: 'EQUITY_OR_ETF', venue: STOCK_VENUE })); }
  async quotes(symbols) {
    const quotes=await this.quoteSource.quotes(symbols);
    for(const [symbol,q] of Object.entries(quotes)){
      const instrumentId=this.instrumentId(symbol),quantity=num(q.bidSize),at=Math.min(q.quoteAt??0,q.receivedAt??0);
      if(!(q.bid>0)||!(q.ask>=q.bid)||!(quantity>0)||!at){this.platform.risk.clearMark(STOCK_VENUE,'manual',instrumentId);continue;}
      const f=sellFees(q.bid*quantity,quantity);
      this.platform.risk.recordMark({venue:STOCK_VENUE,account:'manual',instrumentId,bid:q.bid,quantity,liquidationFee:f.sec+f.taf,at,source:'alpaca-iex-liquidation'});
    }
    return quotes;
  }
  #rows() { return this.platform.ledger.portfolio('PAPER').accounts.filter(a => a.venue === STOCK_VENUE && a.currency === 'USD'); }
  positions(marks = {}) {
    return this.#rows().flatMap(a => a.positions.map(p => {
      const symbol = decodeURIComponent(String(p.instrumentId).split(':').pop()), bid = num(marks[symbol]?.bid), qty = Number(p.quantity), basis = Number(p.costBasis);
      return { symbol, instrumentId: p.instrumentId, quantity: qty, costBasis: basis, avgCost: qty ? basis / qty : null, mark: bid, marketValue: bid === null ? null : qty * bid, unrealized: bid === null ? null : qty * bid - basis };
    }));
  }
  account(marks = {}) {
    const rows = this.#rows(), cash = rows.reduce((s, a) => s + Number(a.cash), 0), pos = this.positions(marks);
    const pending = this.#proposals().filter(p => ['PROPOSED', 'AWAITING_APPROVAL'].includes(p.status) && p.payload.side === 'BUY').reduce((s, p) => s + Number(p.payload.gross) + Number(p.payload.fee), 0);
    const mv = pos.every(p => p.marketValue !== null) ? pos.reduce((s, p) => s + p.marketValue, 0) : null;
    return { venue: STOCK_VENUE, mode: 'PAPER', cash, buyingPower: Math.max(0, cash - pending), pendingBuys: pending, marketValue: mv, equity: mv === null ? null : cash + mv,
      realized: rows.reduce((s, a) => s + Number(a.realized), 0), fees: rows.reduce((s, a) => s + Number(a.fees), 0), deposits: rows.reduce((s, a) => s + Number(a.netDeposits), 0), funded: rows.length > 0 };
  }
  #proposals() { return this.platform.store.db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 500').all().map(r => ({ ...r, payload: JSON.parse(r.payload), decision: JSON.parse(r.decision) })).filter(r => r.payload.venue === STOCK_VENUE); }
  history() { return this.#proposals(); }
  orderStatus(id) { const o = this.#proposals().find(p => p.id === id); if (!o) throw new Error('Unknown order'); return o; }
  // Market or marketable-limit orders only; nothing rests. Regular session only.
  async preview({ id, symbol, side, quantity, notionalUsd, type = 'market', limitPrice = null, mode = 'PAPER' }) {
    const sym = cleanSymbols([symbol])[0]; if (!sym) throw new Error('Invalid symbol');
    if (!['BUY', 'SELL'].includes(side)) throw new Error('Side must be BUY or SELL');
    if (!['PAPER', 'MANUAL_APPROVAL'].includes(mode)) throw new Error('Only PAPER and MANUAL_APPROVAL are available; no real brokerage is connected');
    const now = this.clock(), st = this.session(now);
    if (st.state !== 'OPEN') throw Object.assign(new Error(`Market is ${st.state.replace('_', ' ').toLowerCase()} (NYSE regular session only)`), { code: 'MARKET_CLOSED' });
    const q = (await this.quotes([sym]))[sym];
    if (!q || !(q.bid > 0) || !(q.ask > 0) || q.ask < q.bid) throw new Error(`No two-sided quote for ${sym}`);
    const px = side === 'BUY' ? q.ask : q.bid;
    if (type === 'limit') { const lim = num(limitPrice); if (!(lim > 0)) throw new Error('Limit price required'); if (side === 'BUY' ? lim < px : lim > px) throw new Error('Limit is not marketable at the current quote; resting orders are not supported'); }
    let qty = num(quantity); const notional = num(notionalUsd);
    if (qty === null && notional !== null) qty = notional / px;
    if (!(qty > 0)) throw new Error('Quantity or dollar amount required');
    qty = Math.floor(qty * 1e6) / 1e6; if (!(qty > 0)) throw new Error('Quantity rounds to zero');
    const gross = Math.ceil(qty * px * 1e6) / 1e6; if (gross < 1) throw new Error('Minimum order is $1');
    const f = side === 'SELL' ? sellFees(gross, qty) : { sec: 0, taf: 0 }, feeUsd = Math.round((f.sec + f.taf) * 1e6) / 1e6;
    const size = side === 'BUY' ? q.askSize : q.bidSize;
    const payload = { id, mode, venue: STOCK_VENUE, account: 'manual', currency: 'USD', instrumentId: this.instrumentId(sym), symbol: sym, eventId: this.instrumentId(sym), strategyId: 'manual', side,
      quantity: Number(qty.toFixed(6)), price: px, feeUsd, gross: gross.toFixed(6), fee: feeUsd.toFixed(6), slippageBps: 0, liquidityUsd: size === null ? 0 : size * px,
      quoteAt: Math.min(q.quoteAt ?? 0, q.receivedAt), bookFingerprint: createHash('sha256').update(JSON.stringify(q)).digest('hex'), feeModel: { ...EQUITY_FEE_MODEL, sec: f.sec, taf: f.taf },
      quote: { bid: q.bid, ask: q.ask, source: q.source, quoteAt: q.quoteAt }, orderType: type, simulated: true };
    payload.id ||= randomUUID();
    const routed=routePaperProposal({state:this.platform.paperRouteState||=( {mode:'PAPER',proposals:[]} ),pick:{symbol:sym,instrumentKey:`equity:${sym}`},assetClass:'equity',platform:'robinhood',stakeUsd:Number(payload.gross)+Number(payload.fee),proposalId:payload.id,logger:row=>this.platform.store.record('CENTRAL_ROUTE_DECISION',row)});
    if(!routed.proposal)throw new Error('Central paper route refused the equity proposal');
    payload.centralRoute=routed.decision;
    return this.platform.risk.propose(payload);
  }
  submit(id) { return this.platform.executePaper(id, 'EXECUTE PAPER ORDER'); }
  cancel(id) {
    return this.platform.store.transaction(() => {
      const o = this.orderStatus(id); if (!['PROPOSED', 'AWAITING_APPROVAL'].includes(o.status)) throw new Error(`Order is ${o.status}; only unfilled previews can be cancelled`);
      this.platform.store.db.prepare("UPDATE proposals SET status='CANCELLED',updated_at=? WHERE id=?").run(this.clock(), id); this.platform.store.record('ORDER_CANCELLED', { id, venue: STOCK_VENUE });
      return { id, status: 'CANCELLED' };
    });
  }
}
