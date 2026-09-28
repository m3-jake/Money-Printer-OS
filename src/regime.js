const n = x => Number.isFinite(Number(x)) ? Number(x) : 0;
export function marketRegime(snapshot = {}) {
  const ret = n(snapshot.returnPct ?? snapshot.pc5 ?? snapshot.changePct), vol = Math.abs(n(snapshot.volatilityPct ?? snapshot.volatility));
  const breadth = n(snapshot.breadthPct ?? snapshot.activityPct);
  const state = snapshot.riskOff === true ? 'risk-off' : ret > 1 && breadth >= 50 ? 'trending' : vol > 8 || (ret < -2 && breadth < 35) ? 'choppy' : ret >= 0 ? 'risk-on' : 'risk-off';
  return { regime: state, returnPct: ret, volatilityPct: vol, breadthPct: breadth };
}

export function regimeSnapshot(input = {}) {
  const out = {};
  for (const [assetClass, snapshot] of Object.entries(input)) out[assetClass] = marketRegime(snapshot);
  return out;
}

const STRATEGY_REGIMES = Object.freeze({ momentum: ['trending'], 'mean-reversion': ['choppy'], breakout: ['trending', 'risk-on'], carry: ['risk-on', 'choppy'], defensive: ['risk-off'] });
export function strategyAllowedInRegime(strategy, regime) { return (STRATEGY_REGIMES[String(strategy).toLowerCase()] || ['trending', 'choppy', 'risk-on']).includes(String(regime).toLowerCase()); }

export function routeAssetClass(assetClass) {
  const key = String(assetClass || '').toLowerCase();
  if (key === 'memecoin' || key === 'solana-token') return 'pumpfun';
  if (key === 'weather' || key === 'sports') return 'kalshi';
  if (key === 'politics' || key === 'culture') return 'polymarket';
  if (key === 'crypto' || key === 'equity' || key === 'etf') return 'robinhood';
  return 'unrouted';
}

export function routeDecision({ assetClass, strategy, regimes = {}, proposalId = null, now = Date.now() } = {}) {
  const platform = routeAssetClass(assetClass), regime = regimes[assetClass]?.regime || 'unknown';
  const allowed = strategy ? strategyAllowedInRegime(strategy, regime) : true;
  return { ts: now, regime, assetClass, platform, proposalId, decision: platform !== 'unrouted' && allowed ? 'ALLOW' : 'BLOCK', reason: platform === 'unrouted' ? 'unknown-asset-class' : allowed ? null : 'strategy-regime-mismatch' };
}
