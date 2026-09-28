import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync(new URL('./quant-catalog.json', import.meta.url), 'utf8'));
const pick = (id, lane, fit, adaptation, prerequisites) => ({
  id, lane, fit, adaptation, prerequisites, status: 'RESEARCH_ONLY',
  paperEligible: false, liveActivationAllowed: false,
});

// These are implementation priorities, not expected-return or profitability rankings.
export const QUANT_SHORTLIST = [
  pick('specs:018-dual-momentum-sector-rotation', 'robinhood-etfs', 'existing-overlap',
    'Compare against tactical-a; broad-market trend gating differs from its T-bill hurdle. Avoid counting a related sleeve as independent alpha.',
    ['adjusted daily ETF bars', 'cash and SPY benchmarks', 'next-session execution', 'monthly rebalance']),
  pick('specs:037-single-moving-average', 'robinhood-etfs', 'existing-overlap',
    'Use as a transparent standalone baseline for the existing SPY trend sleeve.',
    ['adjusted session bars', 'cash yield assumptions', 'turnover and settlement costs']),
  pick('specs:050-index-volatility-targeting', 'robinhood-etfs', 'new-shadow-candidate',
    'Test an unlevered trailing-realized-volatility overlay capped at 100%; document the estimator change and volatility lag. This is risk scaling, not a return forecast.',
    ['adjusted trailing returns', 'predeclared volatility window', 'delay-1 weights', 'cash and SPY benchmarks']),
  pick('specs:040-donchian-channel', 'robinhood-crypto-spot', 'new-shadow-candidate',
    'Declare breakout mode explicitly; the source default is fade. Exclude the signal bar from high/low bands; a spot adaptation must be long-only.',
    ['authentic OHLC bars', 'bid/ask execution tape', 'fees and depth', 'gap and stale-bar rejection']),
  pick('vault:Digital-Currency-Futures-Multi-Variety-ATR-Strategy-Teaching', 'robinhood-crypto-spot', 'adaptation-required',
    'Study an EMA typical-price band plus EMA true range. A spot long-only version is a separate strategy; futures shorts, funding and liquidation do not transfer.',
    ['OHLC aggregation', 'new shadow signal implementation', 'next-observation fills', 'cost stress']),
  pick('specs:081-etf-mean-reversion-ibs', 'robinhood-etfs', 'adaptation-required',
    'The source is a dollar-neutral cross-sectional fade with shorts. Test a separately labeled long-only adaptation; skip zero-range bars.',
    ['consistently adjusted OHLC', 'next-session fills', 'T+1 buying power', 'overnight gap stress']),
  pick('specs:001-price-momentum', 'robinhood-stocks', 'data-blocked',
    '12-1 equity momentum requires a point-in-time cross-section. Existing ETF rotation is related but does not implement the source stock long/short portfolio.',
    ['point-in-time universe', 'delistings', 'corporate actions', 'long-only adaptation or borrow model']),
  pick('specs:048-market-making', 'polymarket-market-making', 'simulator-blocked',
    'Study inventory skew and toxic-flow markouts in a simulator. Equity assumptions require a new binary-payoff adaptation.',
    ['order-book replay', 'queue and partial-fill model', 'adverse-selection markouts', 'inventory caps', 'binary settlement model']),
  pick('vault:Adaptive-Intelligent-Grid-Trading-Strategy', 'robinhood-crypto-spot', 'simulator-blocked',
    'Its pyramiding can concentrate inventory during trends. Require bounded inventory, marked losses and queue-aware fills before any grid experiment.',
    ['inventory stress scenarios', 'spread and fee modeling', 'partial fills', 'capital and turnover caps']),
  pick('vault:Dynamic-Spread-Market-Making-Strategy', 'polymarket-market-making', 'simulator-blocked',
    'This snippet quotes around an SMA with inventory limits; it is not an Avellaneda-Stoikov implementation despite the repository README framing.',
    ['queue-aware simulator', 'toxic-flow model', 'cancel latency', 'venue-specific payoff adaptation']),
];

export const QUANT_RESEARCH_PROTOCOL = Object.freeze({
  schema: 'mpo.quant-research-protocol.v1',
  stages: ['market-and-regime-review', 'data-quality-and-opportunity-scan', 'predeclare-thesis-and-parameters', 'cost-aware-replay', 'chronological-holdout', 'walk-forward-and-sensitivity', 'benchmark-comparison', 'invalidation-and-deployment-review'],
  requiredEvidence: ['point-in-time-data-provenance', 'executable-prices-and-delay', 'fees-spread-slippage-and-impact', 'settlement-and-buying-power', 'untouched-holdout', 'all-trials-and-selection-bias', 'parameter-neighborhoods', 'regime-and-tail-stress', 'correlation-and-concentration', 'benchmark-after-costs'],
  reportFields: ['thesis', 'universe', 'entry-and-exit', 'sizing-and-rebalance', 'data-coverage', 'assumptions', 'total-return', 'CAGR', 'Sharpe', 'Sortino', 'max-drawdown', 'win-rate', 'profit-factor', 'turnover', 'benchmark-excess-return', 'holdout-and-stress-results', 'invalidation-conditions', 'limitations'],
  note: 'Report unavailable metrics as null with a reason. Image Sharpe/drawdown suggestions are research preferences, not universal admission thresholds. Existing trader evidence gates remain authoritative.',
  paperEligible: false, automaticLivePromotionAllowed: false, liveActivationAllowed: false,
});

export function quantResearchSummary() {
  return { schema: catalog.schema, ...catalog.summary, sources: catalog.sources, shortlisted: QUANT_SHORTLIST.length, status: 'UNVALIDATED', paperEligible: false, liveActivationAllowed: false };
}

export function queryQuantResearch({ query = '', source = '', family = '', language = '', offset = 0, limit = 50 } = {}) {
  const q = String(query).slice(0, 200).trim().toLowerCase();
  const rows = catalog.entries.filter(row => (!source || row.source === source) && (!family || row.families.includes(family)) && (!language || row.language === language) && (!q || `${row.title} ${row.id} ${row.assetClass || ''}`.toLowerCase().includes(q)));
  const start = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
  const size = Number.isFinite(Number(limit)) ? Math.min(100, Math.max(1, Math.trunc(Number(limit)))) : 50;
  // Fresh objects prevent callers from mutating the shared index or safety labels.
  return structuredClone({ schema: catalog.schema, total: rows.length, offset: start, limit: size, entries: rows.slice(start, start + size), summary: quantResearchSummary(), shortlist: QUANT_SHORTLIST, protocol: QUANT_RESEARCH_PROTOCOL });
}
