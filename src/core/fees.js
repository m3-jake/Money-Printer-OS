// Venue taker-fee models, from the venues' published schedules. Arbitrage crosses the book, so
// only taker fees apply. A model that can't be read or isn't understood returns null (fees
// unavailable), which blocks any after-fee or locked-return figure. Nothing is guessed.
//
// Kalshi (docs.kalshi.com, Get Series; kalshi.com/docs/kalshi-fee-schedule.pdf; Fee Rounding):
//   series.fee_type 'quadratic' | 'quadratic_with_maker_fees' | 'quadratic_with_combo_maker_fees'
//   taker fee = 0.07 × fee_multiplier × C × P × (1 − P). 'flat' uses a separate table: unsupported.
//   Non-direct members settle to $0.01 per order, so the charged fee is modelled as
//   ceil_cent(cost + fee) − cost (fee plus rounding; conservative).
// Polymarket (docs.polymarket.com/trading/fees): fee = C × rate × p × (1 − p), takers only,
//   rounded to 5 decimals. market.feesEnabled === false means no fee. Only exponent 1 is documented.
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const ceilTo = (v, dp) => { const f = 10 ** dp; return Math.ceil(v * f - 1e-9) / f + 0; }; // + 0: no -0
const KALSHI_QUADRATIC = new Set(['quadratic', 'quadratic_with_maker_fees', 'quadratic_with_combo_maker_fees']);

export function kalshiFeeModel(series) {
  if (!series || typeof series !== 'object') return { model: null, reason: 'Kalshi series fee data not loaded' };
  const mult = num(series.fee_multiplier);
  if (!KALSHI_QUADRATIC.has(series.fee_type)) return { model: null, reason: `Kalshi fee type ${series.fee_type || 'unknown'} not supported` };
  if (mult === null || mult < 0) return { model: null, reason: 'Kalshi fee multiplier missing' };
  return { model: { venue: 'kalshi', kind: 'KALSHI_QUADRATIC_TAKER', rate: Math.round(0.07 * mult * 1e8) / 1e8, feeType: series.fee_type, multiplier: mult, rounding: 'CENT_PER_ORDER',
    source: `Kalshi series ${series.ticker || ''}`.trim(), overridesChecked: false }, reason: null };
}

export function polymarketFeeModel(raw) {
  if (!raw || typeof raw !== 'object') return { model: null, reason: 'Polymarket fee data not loaded' };
  if (raw.feesEnabled === false) return { model: { venue: 'polymarket', kind: 'POLYMARKET_NO_FEE', rate: 0, exponent: 1, rounding: '5DP', source: 'market.feesEnabled=false' }, reason: null };
  const s = raw.feeSchedule, rate = num(s?.rate), exp = num(s?.exponent);
  if (raw.feesEnabled !== true || !s) return { model: null, reason: 'Polymarket fee schedule missing' };
  if (rate === null || rate < 0 || exp !== 1) return { model: null, reason: `Polymarket fee schedule not understood (rate ${s.rate}, exponent ${s.exponent})` };
  return { model: { venue: 'polymarket', kind: 'POLYMARKET_TAKER', rate, exponent: 1, takerOnly: s.takerOnly !== false, rounding: '5DP', source: `market.feeSchedule (${raw.feeType || 'unnamed'})` }, reason: null };
}

// fills: [{price, quantity}] actually taken from the book. Returns total USD fee or null.
export function takerFee(model, fills) {
  if (!model || !Array.isArray(fills)) return null;
  let raw = 0, cost = 0;
  for (const f of fills) {
    const p = num(f.price), c = num(f.quantity);
    if (p === null || c === null || p < 0 || p > 1 || c < 0) return null;
    raw += c * model.rate * p * (1 - p); cost += c * p;
  }
  if (model.rounding === 'CENT_PER_ORDER') return Math.round((ceilTo(cost + ceilTo(raw, 6), 2) - cost) * 1e6) / 1e6;
  if (model.rounding === '5DP') return ceilTo(raw, 5);
  return null;
}

export function describeFeeModel(model, reason = null) {
  if (!model) return `Unavailable: ${reason || 'no fee model'}`;
  if (model.kind === 'KALSHI_QUADRATIC_TAKER') return `Kalshi ${model.feeType} × ${model.multiplier} → ${model.rate} × C × P(1−P), rounded to the cent per order (${model.source}; event overrides not checked)`;
  if (model.kind === 'POLYMARKET_NO_FEE') return 'Polymarket: fees disabled for this market';
  if (model.rate === 0) return `Polymarket: zero-fee market (${model.source})`;
  return `Polymarket taker ${model.rate} × C × p(1−p), rounded to 5 decimals (${model.source})`;
}
