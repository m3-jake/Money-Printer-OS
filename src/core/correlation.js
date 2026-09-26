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

// ---------------------------------------------------------------- other event kinds
// Generic page shape for non-macro events: { id, kind, title, when, whenLabel, metrics:[{label,value,sub}],
// sections:[{title, note, items:[{text, sub, url}]}], exposure, provenance }.
const pct = v => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
function wireFor(wire, test) { return wire.filter(test).slice(0, 8).map(w => ({ text: w.title, sub: `${w.source} · importance ${w.importance}`, url: w.url || null, at: w.at })); }
function heldIn(ids, held, heldCost) { const hit = ids.filter(id => held.has(id)); return { contracts: hit.map(id => ({ id, costUsd: heldCost.get(id) ?? null })), costUsd: hit.reduce((s, id) => s + (heldCost.get(id) || 0), 0) }; }
const venuePrice = v => `K ${pct(v?.kalshi)} · P ${pct(v?.polymarket ?? v?.polymarketComplement)}`;

export function sportsPages(events = [], { wire = [], held = new Set(), heldCost = new Map(), limit = 8 } = {}) {
  const score = e => (e.live ? 2 : 0) + (e.venues.length > 1 ? 1 : 0);
  const ranked = [...events].filter(e => e.venues?.length > 1 || e.live || e.fastSettling).sort((a, b) => score(b) - score(a));
  return ranked.slice(0, limit).map(e => {
    const w = e.winner || [], names = e.participants, lower = names.map(n => n.toLowerCase());
    const gap = [0, 1].map(i => { const v = w[i]?.venues || {}, p = v.polymarket ?? v.polymarketComplement; return v.kalshi !== undefined && p !== undefined ? Math.abs(v.kalshi - p) : null; }).find(x => x !== null) ?? null;
    const liveText = e.live ? `${e.live.state}${e.live.score?.[0] != null ? ' ' + e.live.score.join('–') : ''}` : 'no feed';
    return { id: `sports:${e.id}`, kind: 'SPORTS', title: `${e.sport}: ${names[0]} vs ${names[1]}`, when: e.contracts.map(c => c.closeAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null, whenLabel: `game day ${e.day}`,
      metrics: [{ label: names[0], value: venuePrice(w[0]?.venues), sub: 'winner price' }, { label: names[1], value: venuePrice(w[1]?.venues), sub: 'winner price' },
        { label: 'Live', value: liveText, sub: e.live?.period || e.live?.feed || '' }, { label: 'Venue gap', value: gap === null ? '—' : `${(gap * 100).toFixed(1)} pts`, sub: e.fastSettling ? 'fast-settling' : `${e.contracts.length} contracts` }],
      sections: [{ title: 'Markets on this game', note: 'Clustered by sport, day and names (heuristic).', items: e.contracts.slice(0, 12).map(c => ({ text: `${c.venue}: ${c.title}`, sub: `${c.type}${c.line != null ? ' ' + c.line : ''} · YES ${pct(c.yesMid)}` })) },
        { title: 'Wire', items: wireFor(wire, x => (x.entities || []).some(en => en.type === 'team' && lower.some(n => n.includes(en.key.toLowerCase()) || en.key.toLowerCase().includes(n)))) }],
      exposure: heldIn(e.contracts.map(c => c.id), held, heldCost), provenance: 'Prices are listing mids; live state from official feeds only; clustering is heuristic.' };
  });
}

const exposureOf = an => [...(an?.sectors || []).map(x => ({ text: x })), ...(an?.markets || []).map(m => ({ text: `${m.venue}: ${m.title}` }))];
export function weatherPages(weather, { wire = [], limit = 6 } = {}) {
  if (!weather) return [];
  const storms = (weather.storms || []).filter(s => /HU|TS|PTC|STS/.test(s.classification || '')).map(s => ({
    id: `weather:storm:${s.id}`, kind: 'WEATHER', title: `${s.classification === 'HU' ? 'HURRICANE' : 'TROPICAL SYSTEM'} ${String(s.name).toUpperCase()}`, when: s.updated, whenLabel: 'NHC update',
    metrics: [{ label: 'Wind', value: s.intensityKt ? `${s.intensityKt} kt` : '—', sub: s.classification }, { label: 'Pressure', value: s.pressureMb ? `${s.pressureMb} mb` : '—', sub: '' }, { label: 'Position', value: `${s.lat ?? '?'}, ${s.lon ?? '?'}`, sub: s.movement || '' }, { label: 'Linked markets', value: String(s.analysis?.markets?.length || 0), sub: 'speculative' }],
    sections: [{ title: 'Possible exposure (speculative)', note: s.analysis?.note, items: exposureOf(s.analysis) }, { title: 'NHC', items: s.advisory ? [{ text: 'Public advisory', url: s.advisory }] : [] },
      { title: 'Wire', items: wireFor(wire, x => x.kind === 'WEATHER' && /tropical|hurricane|storm/i.test(x.title)) }],
    exposure: { contracts: [], costUsd: 0 }, provenance: 'NHC facts; market and sector links are speculative analysis.' }));
  const extreme = (weather.alerts || []).filter(a => a.severity === 'Extreme').slice(0, 3).map(a => ({
    id: `weather:alert:${a.id}`, kind: 'WEATHER', title: `${String(a.event).toUpperCase()} — ${String(a.area || '').split(';')[0]}`, when: a.sent, whenLabel: 'NWS sent',
    metrics: [{ label: 'Severity', value: a.severity, sub: `${a.urgency || ''} / ${a.certainty || ''}` }, { label: 'Expires', value: a.expires ? new Date(a.expires).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—', sub: '' }, { label: 'Sectors', value: String(a.analysis?.sectors?.length || 0), sub: 'speculative' }, { label: 'Markets', value: String(a.analysis?.markets?.length || 0), sub: 'speculative' }],
    sections: [{ title: 'Area', items: [{ text: a.area }] }, { title: 'Possible exposure (speculative)', note: a.analysis?.note, items: exposureOf(a.analysis) }],
    exposure: { contracts: [], costUsd: 0 }, provenance: 'NWS alert facts; links are speculative analysis.' }));
  return [...storms, ...extreme].slice(0, limit);
}

export function corporatePages(filings = [], { wire = [], assets = {}, held = new Set(), heldCost = new Map(), limit = 6 } = {}) {
  const keep = ['EARNINGS', 'M&A', 'CHANGE_OF_CONTROL', 'BANKRUPTCY', 'RESTATEMENT', 'DILUTION', 'EXECUTIVE_CHANGE', 'MATERIAL_AGREEMENT'];
  return filings.filter(f => (f.analysis?.catalysts || []).some(c => keep.includes(c))).sort((a, b) => (b.facts.acceptedAt || 0) - (a.facts.acceptedAt || 0)).slice(0, limit).map(f => {
    const x = f.facts, a = f.analysis, px = x.ticker ? assets[x.ticker] : null;
    return { id: `corporate:${x.accession}`, kind: 'CORPORATE', title: `${x.ticker || x.company} — ${a.catalysts.join(', ')}`, when: x.acceptedAt, whenLabel: `SEC accepted (${x.form})`,
      metrics: [{ label: 'Form', value: x.form, sub: x.company }, { label: 'Items', value: String(x.items.length), sub: x.items.map(i => i.code).join(', ') }, { label: 'Price', value: px?.price != null ? String(px.price) : 'unavailable', sub: px?.source || '' }, { label: 'Linked markets', value: String(a.relatedMarkets.length), sub: 'rule-based' }],
      sections: [{ title: 'Filing facts', items: [...x.items.map(i => ({ text: `${i.code} ${i.name}` })), { text: 'Filing document', url: x.url }] }, { title: 'Related markets (rule-based)', note: a.note, items: a.relatedMarkets.map(m => ({ text: `${m.venue}: ${m.title}` })) },
        { title: 'Wire', items: wireFor(wire, w => x.ticker && (w.entities || []).some(e => e.type === 'ticker' && e.key === x.ticker)) }],
      exposure: heldIn(a.relatedMarkets.map(m => m.id), held, heldCost), provenance: 'Filing facts as declared to the SEC; catalysts and links are rule-based analysis.' };
  });
}
