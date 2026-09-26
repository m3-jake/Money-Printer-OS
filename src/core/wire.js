import { MACRO_INDICATORS } from './macro.js';

// Wire: MPOS's event terminal. Items come from what MPOS already ingests (SEC filings, NWS alerts,
// live sports changes, the macro calendar, risk and fill events) plus official RSS feeds. Each item
// gets extracted entities, related markets and an importance score. Extraction and scoring are
// RULE-BASED ANALYSIS (labelled); the item text and link are the source.

export const WIRE_FEEDS = Object.freeze([
  { id: 'fed', label: 'Federal Reserve press releases', url: 'https://www.federalreserve.gov/feeds/press_all.xml', kind: 'MACRO' },
  { id: 'bea', label: 'Bureau of Economic Analysis releases', url: 'https://apps.bea.gov/rss/rss.xml', kind: 'MACRO' },
  { id: 'cftc', label: 'CFTC press releases', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', kind: 'MARKETS' },
]);
export const WIRE_FILTERS = Object.freeze(['ALL', 'MARKETS', 'CRYPTO', 'MACRO', 'CORPORATE', 'SPORTS', 'WEATHER', 'MY POSITIONS']);

const strip = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
export function parseRss(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const e = m[1], tag = n => { const x = e.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`)); return x ? strip(x[1]) : ''; };
    const title = tag('title'), link = tag('link'), guid = tag('guid') || link || title, at = Date.parse(tag('pubDate'));
    if (!title || !Number.isFinite(at)) continue;
    out.push({ guid, title, link: link || null, publishedAt: at, category: tag('category') || null, summary: tag('description').slice(0, 400) || null });
  }
  return out;
}

const CRYPTO = [[/\bbitcoin\b|\bBTC\b/i, 'BTC'], [/\bether(eum)?\b|\bETH\b/i, 'ETH'], [/\bsolana\b|\bSOL\b/, 'SOL'], [/\bcrypto|\bstablecoin|\bdigital asset|\bblockchain/i, 'CRYPTO']];
const MACRO_WORDS = [[/\bCPI\b|consumer price|inflation/i, ['CPI', 'CPI_YOY', 'CORE_CPI']], [/\bPCE\b|personal consumption|personal income/i, ['PCE']], [/payroll|employment situation|jobs report/i, ['PAYROLLS', 'UNRATE']],
  [/unemployment/i, ['UNRATE']], [/\bGDP\b|gross domestic product/i, ['GDP']], [/FOMC|federal funds|monetary policy|policy rate|interest rate/i, ['FEDFUNDS']], [/retail sales/i, ['RETAIL']], [/jobless claims/i, ['CLAIMS']], [/treasury yield|10-year/i, ['DGS10']]];

// entities: [{type, key, label}]. ctx: { tickers:Set, teams:[names], positions:{ instrumentIds:Set, symbols:Set } }
export function extractEntities(text, ctx = {}) {
  const t = String(text || ''), ents = [];
  for (const [re, sym] of CRYPTO) if (re.test(t)) ents.push({ type: 'crypto', key: sym, label: sym });
  for (const [re, ids] of MACRO_WORDS) if (re.test(t)) for (const id of ids) ents.push({ type: 'macro', key: id, label: MACRO_INDICATORS.find(m => m.id === id)?.label || id });
  for (const m of t.matchAll(/\$([A-Z]{1,5})\b|\(([A-Z]{1,5})\)/g)) { const k = m[1] || m[2]; if (!ctx.tickers || ctx.tickers.has(k)) ents.push({ type: 'ticker', key: k, label: k }); }
  const low = t.toLowerCase();
  for (const team of ctx.teams || []) if (team.length >= 5 && low.includes(team.toLowerCase())) ents.push({ type: 'team', key: team, label: team });
  const seen = new Set(); return ents.filter(e => { const k = e.type + ':' + e.key; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Related contracts among loaded ones: macro -> the indicator's Kalshi series; crypto -> titles naming
// the asset; team -> titles naming the team; ticker -> titles naming the ticker.
export function relatedMarkets(entities, contracts) {
  const out = new Map();
  for (const e of entities) for (const c of contracts) {
    const title = String(c.data?.title || ''), series = String(c.data?.seriesTicker || '');
    const hit = e.type === 'macro' ? (() => { const k = MACRO_INDICATORS.find(m => m.id === e.key)?.kalshi; return !!k && series === k; })()
      : e.type === 'crypto' ? (e.key === 'CRYPTO' ? false : new RegExp(`\\b(${e.key}|${{ BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' }[e.key]})\\b`, 'i').test(title))
      : e.type === 'team' ? title.toLowerCase().includes(e.key.toLowerCase())
      : e.type === 'ticker' ? new RegExp(`\\b${e.key}\\b`).test(title) : false;
    if (hit && !out.has(c.id)) out.set(c.id, { id: c.id, venue: c.provider, title });
    if (out.size >= 8) break;
  }
  return [...out.values()];
}

// Importance 0..100 (RULE-BASED): source weight + boosts for held exposure and related markets.
export function importance(item) {
  let s = { RISK: 90, FILL: 60, CORPORATE: 40, MACRO: 45, MARKETS: 35, CRYPTO: 45, SPORTS: 20, WEATHER: 40 }[item.kind] ?? 30;
  const text = `${item.title} ${item.category || ''}`;
  if (item.kind === 'MACRO' && /monetary policy|FOMC|federal funds/i.test(text)) s = 90;
  if (item.kind === 'MACRO' && /GDP|personal income|PCE|employment situation|CPI/i.test(text)) s = Math.max(s, 75);
  if (item.kind === 'MACRO' && item.scheduled) s = Math.max(s, 60);
  if (item.kind === 'CORPORATE' && (item.catalysts || []).some(c => ['EARNINGS', 'M&A', 'BANKRUPTCY', 'CHANGE_OF_CONTROL', 'RESTATEMENT'].includes(c))) s = 70;
  if (item.kind === 'WEATHER') s = item.severity === 'Extreme' ? 70 : /hurricane|tropical/i.test(text) ? 60 : 45;
  if (item.kind === 'SPORTS' && item.fastSettling) s += 10;
  if (/crypto|digital asset|stablecoin/i.test(text)) s = Math.max(s, 55);
  if (item.myPositions) s += 25;
  if ((item.relatedMarkets || []).length) s += 10;
  return Math.max(0, Math.min(100, s));
}

export function categoriesOf(item) {
  const c = new Set([item.kind === 'FILL' || item.kind === 'RISK' ? 'MARKETS' : item.kind]);
  if ((item.entities || []).some(e => e.type === 'crypto')) c.add('CRYPTO');
  if ((item.entities || []).some(e => e.type === 'macro')) c.add('MACRO');
  if ((item.relatedMarkets || []).length) c.add('MARKETS');
  if (item.myPositions) c.add('MY POSITIONS');
  return [...c];
}
