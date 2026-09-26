import { MACRO_INDICATORS } from './macro.js';

// Event pages: one real-world event, many markets. Built from what the other desks already loaded:
// the macro calendar (Kalshi ladders), loaded Kalshi/Polymarket contracts, FRED values, crypto tape
// and stock quotes, the core ledger, and Wire items. Links between an event and a market or asset are
// RULE-BASED (templates below) unless they come from the same Kalshi event; every page says which.

export const EVENT_TEMPLATES = Object.freeze({
  FEDFUNDS: { title: 'Fed decision', search: 'fed decision', macro: ['FEDFUNDS', 'DGS2', 'DGS10', 'T10Y2Y', 'CPI_YOY'], assets: ['SPY', 'QQQ', 'TLT', 'BTC', 'SOL'], poly: /\bfed\b|fomc|rate cut|rate hike|interest rates?\b|powell/i },
  CPI: { title: 'CPI release', search: 'cpi', macro: ['CPI', 'CORE_CPI', 'CPI_YOY', 'FEDFUNDS'], assets: ['SPY', 'TLT', 'BTC'], poly: /\bcpi\b|inflation/i },
  CORE_CPI: { title: 'Core CPI release', search: 'core cpi', macro: ['CORE_CPI', 'CPI', 'CPI_YOY'], assets: ['SPY', 'TLT'], poly: /core (cpi|inflation)/i },
  CPI_YOY: { title: 'Inflation (CPI YoY) release', search: 'inflation', macro: ['CPI_YOY', 'CPI', 'FEDFUNDS'], assets: ['SPY', 'TLT', 'BTC'], poly: /inflation|\bcpi\b/i },
  PAYROLLS: { title: 'Jobs report', search: 'jobs report', macro: ['PAYROLLS', 'UNRATE', 'FEDFUNDS'], assets: ['SPY', 'QQQ', 'TLT'], poly: /jobs report|payrolls?|nonfarm|unemployment/i },
  UNRATE: { title: 'Unemployment rate', search: 'unemployment rate', macro: ['UNRATE', 'PAYROLLS'], assets: ['SPY', 'TLT'], poly: /unemployment/i },
  GDP: { title: 'GDP release', search: 'gdp', macro: ['GDP', 'PCE', 'FEDFUNDS'], assets: ['SPY', 'QQQ'], poly: /\bgdp\b|recession/i },
  CLAIMS: { title: 'Jobless claims', search: 'jobless claims', macro: ['CLAIMS', 'UNRATE'], assets: ['SPY'], poly: /jobless claims/i },
  RETAIL: { title: 'Retail sales', search: 'retail sales', macro: ['RETAIL'], assets: ['SPY', 'XRT'], poly: /retail sales/i },
});

const mid = d => (d?.yesBid !== null && d?.yesBid !== undefined && d?.yesAsk !== null && d?.yesAsk !== undefined && d.yesAsk >= d.yesBid ? (d.yesBid + d.yesAsk) / 2 : null);

// inputs: { macro (macroSnapshot), contracts, wire (items), held (Set of contract ids), heldCost (Map id -> USD), assets ({SYM: {price, at, source}}) }
export function buildEventPages({ macro, contracts = [], wire = [], held = new Set(), heldCost = new Map(), assets = {}, now = Date.now() } = {}) {
  const pages = [];
  for (const cal of macro?.calendar || []) {
    const tpl = EVENT_TEMPLATES[cal.id]; if (!tpl || !(cal.closeAt > now - 86400000)) continue;
    const ind = macro.indicators.find(i => i.id === cal.id);
    const kalshi = contracts.filter(c => c.provider === 'kalshi' && String(c.sourceId).startsWith(cal.eventTicker + '-'));
    const month = new Date(cal.closeAt).toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
    // Same topic AND same window: the Polymarket market must end within 5 days of the Kalshi close.
    const poly = contracts.filter(c => c.provider === 'polymarket' && (tpl.poly.test(c.data.title) || tpl.poly.test(c.data.eventTitle || '')) && c.data.closeAt !== null && c.data.closeAt >= now && Math.abs(c.data.closeAt - cal.closeAt) <= 5 * 86400000).slice(0, 12);
    const topics = [cal.id, ...tpl.macro];
    const signals = wire.filter(w => (w.entities || []).some(e => e.type === 'macro' && topics.includes(e.key)));
    const related = [...kalshi, ...poly];
    const exposure = related.filter(c => held.has(c.id)).map(c => ({ id: c.id, title: c.data.title, costUsd: heldCost.get(c.id) ?? null }));
    pages.push({
      id: `event:${cal.eventTicker}`, kind: 'MACRO', indicator: cal.id, title: `${tpl.title.toUpperCase()} — ${month.toUpperCase()}`, eventTicker: cal.eventTicker, when: cal.closeAt, whenLabel: 'Kalshi trading closes (release follows)',
      macro: tpl.macro.map(id => { const x = macro.indicators.find(i => i.id === id); return { id, label: x?.label || id, value: x?.last?.value ?? null, date: x?.last?.date ?? null, unit: x?.unit || '' }; }),
      predictionMarkets: {
        kalshi: { eventTicker: cal.eventTicker, title: cal.title, impliedMedian: cal.impliedMedian, unit: ind?.unit || '', rungs: (ind?.ladder?.rungs || []).map(r => ({ strike: r.strike, p: r.p })), link: 'SAME_KALSHI_EVENT' },
        polymarket: poly.map(c => ({ id: c.id, title: c.data.title, event: c.data.eventTitle || null, closeAt: c.data.closeAt, yes: mid(c.data) ?? c.data.impliedProbability ?? null, link: 'TOPIC_AND_WINDOW_MATCH' })),
      },
      assets: tpl.assets.map(sym => assets[sym] ? { symbol: sym, ...assets[sym] } : { symbol: sym, price: null, source: null, note: 'unavailable' }),
      exposure: { contracts: exposure, costUsd: exposure.reduce((s, x) => s + (x.costUsd || 0), 0), note: 'Core ledger positions in this event\'s linked contracts. Legacy books are not linked yet.' },
      signals: signals.slice(0, 10).map(s => ({ title: s.title, at: s.at, importance: s.importance, source: s.source, url: s.url || null })), signalCount: signals.length,
      relatedContractIds: related.map(c => c.id),
      provenance: 'Kalshi contracts: same Kalshi event (fact). Polymarket contracts, assets and signals: rule-based templates and keyword matches (analysis).',
    });
  }
  return pages.sort((a, b) => a.when - b.when);
}

export const macroIdsWithPages = Object.keys(EVENT_TEMPLATES).filter(id => MACRO_INDICATORS.some(m => m.id === id && m.kalshi));
