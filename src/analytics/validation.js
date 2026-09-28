export function priceDivergenceBps(prices = []) {
  const valid = prices.map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0);
  if (valid.length < 2) return null;
  const mid = (Math.max(...valid) + Math.min(...valid)) / 2;
  return mid > 0 ? (Math.max(...valid) - Math.min(...valid)) / mid * 10_000 : null;
}

export function validateCrossSourcePrices({ mint, dexscreener, jupiter, onchain, maxDivergenceBps = 150, log = () => {} } = {}) {
  const sources = { dexscreener: Number(dexscreener), jupiter: Number(jupiter), onchain: Number(onchain) };
  const present = Object.fromEntries(Object.entries(sources).filter(([, p]) => Number.isFinite(p) && p > 0));
  const divergenceBps = priceDivergenceBps(Object.values(present));
  const enoughSources = Object.keys(present).length >= 2;
  const result = { mint: mint == null ? null : String(mint), sources: present, divergenceBps, maxDivergenceBps, skipTrade: !enoughSources || divergenceBps > maxDivergenceBps,
    reason: !enoughSources ? 'insufficient-price-sources' : divergenceBps > maxDivergenceBps ? 'price-divergence' : null };
  if (result.skipTrade) log({ type: 'price-validation-skip', ...result });
  return result;
}
