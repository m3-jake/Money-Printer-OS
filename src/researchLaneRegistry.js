// Versioned, paper-only registry for venue research lanes.
// Registry membership is descriptive; it never grants execution authority.
export const LANE_SCHEMA = 'mpo.research-lane.v1';
export const READINESS = Object.freeze(['READY', 'NO_DATA', 'STALE', 'NOT_CONFIGURED', 'UNAVAILABLE', 'REJECTED']);

const lane = (id, venue, assetClass, requirements, unavailable = []) => Object.freeze({
  schema: LANE_SCHEMA, id, version: 1, venue, assetClass,
  requirements: Object.freeze([...requirements]),
  strategyParameters: Object.freeze({ bounded: true }),
  paperBook: Object.freeze({ fills: 'depth-aware', fees: 'required', latency: 'modeled', settlement: 'explicit' }),
  riskLimits: Object.freeze({ paperOnly: true, maxExposure: 'configured-per-lane' }),
  outputs: Object.freeze(['candidate', 'incumbent', 'cash', 'coverage', 'rejectionReasons']),
  promotion: Object.freeze({ shadow: true, paper: true, live: false, automaticLivePromotionAllowed: false }),
  readiness: 'NOT_CONFIGURED', unavailable: Object.freeze([...unavailable]),
});

export const POLYMARKET_LANES = Object.freeze([
  lane('polymarket-single-binary', 'polymarket', 'binary', ['metadata', 'outcomes', 'quotes', 'depth', 'fees', 'resolution']),
  lane('polymarket-multi-outcome', 'polymarket', 'multi-outcome', ['event-group', 'outcomes', 'token-ids', 'depth', 'resolution']),
  lane('polymarket-sports', 'polymarket', 'sports', ['event-group', 'sports-signal', 'depth', 'settlement']),
  lane('polymarket-politics-elections', 'polymarket', 'politics', ['event-group', 'resolution-rules', 'depth', 'coverage']),
  lane('polymarket-macro-financial', 'polymarket', 'macro-financial', ['event-group', 'external-signal', 'resolution', 'fees']),
  lane('polymarket-crypto-range', 'polymarket', 'crypto', ['event-group', 'price-source', 'depth', 'resolution']),
  lane('polymarket-weather-events', 'polymarket', 'weather-events', ['event-group', 'weather-source', 'resolution', 'coverage']),
  lane('polymarket-market-making', 'polymarket', 'liquidity', ['depth', 'queue-model', 'fees', 'latency']),
  lane('polymarket-relationships', 'polymarket', 'cross-market', ['event-group', 'correlation-policy', 'depth']),
  lane('polymarket-cross-venue', 'polymarket', 'cross-venue', ['venue-qualified-prices', 'timestamps', 'costs']),
  lane('polymarket-combos', 'polymarket-us', 'combos', ['official-beta-access', 'signed-quotes', 'settlement'], ['platform-beta-access']),
  lane('polymarket-settlement', 'polymarket', 'resolution', ['resolution-rules', 'outcome', 'invalidation-cancellation']),
]);

export const ROBINHOOD_LANES = Object.freeze([
  lane('robinhood-crypto-spot', 'robinhood', 'crypto', ['qualified-quotes', 'spread', 'fees', 'paper-ledger']),
  lane('robinhood-stocks', 'robinhood', 'stocks', ['qualified-bars', 'sessions', 'corporate-actions', 't-plus-one']),
  lane('robinhood-etfs', 'robinhood', 'etfs', ['qualified-bars', 'sessions', 'corporate-actions', 'benchmarks']),
  lane('robinhood-fractional-shares', 'robinhood', 'fractional-shares', ['qualified-fractional-rules', 'precision', 'settlement']),
  lane('robinhood-options-readonly', 'robinhood', 'options', ['contract-discovery', 'chains', 'historical-data', 'greeks-or-valuation', 'assignment-exercise', 'buying-power', 'settlement', 'paper-ledger', 'replay'], ['missing-prerequisites']),
  lane('robinhood-event-driven-equity', 'robinhood', 'event-driven-equity', ['earnings', 'corporate-actions', 'calendar', 'no-lookahead']),
  lane('robinhood-corporate-actions', 'robinhood', 'corporate-actions', ['official-actions', 'effective-dates', 'adjustment-rules']),
  lane('robinhood-long-only-cash', 'robinhood', 'cash-account', ['buying-power', 'long-only', 'settlement']),
  lane('robinhood-benchmarks', 'robinhood', 'benchmarks', ['cash', 'buy-and-hold', 'sector', 'broad-market', 'asset-specific']),
  lane('robinhood-agentic-mcp-readiness', 'robinhood', 'adapter-readiness', ['official-oauth', 'dedicated-account', 'explicit-authorization'], ['adapter-boundary-only']),
]);

export const RESEARCH_LANES = Object.freeze([...POLYMARKET_LANES, ...ROBINHOOD_LANES]);
export function getResearchLane(id) { return RESEARCH_LANES.find(x => x.id === String(id)) || null; }
export function laneStatus(id, patch = {}) {
  const base = getResearchLane(id);
  if (!base) throw new Error(`unknown research lane: ${id}`);
  const status = READINESS.includes(patch.readiness) ? patch.readiness : base.readiness;
  return { ...base, ...patch, readiness: status, promotion: { ...base.promotion, live: false, automaticLivePromotionAllowed: false } };
}
export function assertPaperOnlyLane(record) {
  if (!record || record.promotion?.live === true || record.promotion?.automaticLivePromotionAllowed === true) throw new Error('research lane cannot grant live authority');
  return record;
}
