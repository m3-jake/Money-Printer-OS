// Robinhood paper charts (docs/ROBINHOOD-AUTO-TRADER.md §24). Pure: no fs, network or clock.
// Builds the read-only payload behind GET /api/robinhood/chart: a downsampled price series with the
// strategy's own indicators, entry/exit markers for both paper books, stop/take lines of open
// positions, an equity curve per book with the fee drag, and a trade table.
export const CHART_RANGES = Object.freeze({ '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 });
export const CHART_MAX_POINTS = 800, CHART_MAX_MARKERS = 400, CHART_MAX_TRADES = 100;
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Bucket rows into at most maxPoints buckets. Each bucket keeps the last timestamp, mid and
// indicators, the lowest bid and the highest ask, so the band is an envelope and never hides a spike.
export function downsample(rows, maxPoints = CHART_MAX_POINTS) {
  const n = rows.length, cap = Math.max(1, Math.floor(maxPoints));
  if (n <= cap) return rows.slice();
  const out = [];
  for (let b = 0; b < cap; b++) {
    const a = Math.floor(b * n / cap), z = Math.floor((b + 1) * n / cap);
    if (z <= a) continue;
    const last = rows[z - 1];
    let bid = Infinity, ask = -Infinity;
    for (let i = a; i < z; i++) { if (rows[i].bid < bid) bid = rows[i].bid; if (rows[i].ask > ask) ask = rows[i].ask; }
    out.push({ ...last, bid, ask });
  }
  return out;
}

// Indicators over the full-resolution series, the same way computeFeatures sees them: EMA of mids,
// Donchian over the previous lookbackSamples mids (the current sample excluded).
export function withIndicators(rows, { emaFast = 12, emaSlow = 48, lookbackSamples = 90 } = {}) {
  const out = new Array(rows.length), af = 2 / (emaFast + 1), as = 2 / (emaSlow + 1);
  let ef = null, es = null;
  const dq = [], lq = []; // monotonic deques of indexes for the rolling max/min
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], mid = Number.isFinite(r.mid) ? r.mid : (r.bid + r.ask) / 2;
    ef = ef === null ? mid : af * mid + (1 - af) * ef;
    es = es === null ? mid : as * mid + (1 - as) * es;
    while (dq.length && dq[0] < i - lookbackSamples) dq.shift();
    while (lq.length && lq[0] < i - lookbackSamples) lq.shift();
    const dh = dq.length ? out[dq[0]].mid : null, dl = lq.length ? out[lq[0]].mid : null;
    out[i] = { t: r.t, bid: r.bid, ask: r.ask, mid, dh, dl, ef, es, src: r.src || null };
    while (dq.length && out[dq[dq.length - 1]].mid <= mid) dq.pop(); dq.push(i);
    while (lq.length && out[lq[lq.length - 1]].mid >= mid) lq.pop(); lq.push(i);
  }
  return out;
}

const feesOf = x => (Number(x.feeUsd) || 0) + (Number(x.exit?.feeUsd) || 0);

function bookMarkers(book, name, symbol, from, to) {
  const out = [];
  for (const x of [...(book?.positions || []), ...(book?.history || [])]) {
    if (x.symbol !== symbol) continue;
    const opened = Number(x.openedAt ?? x.at);
    if (opened >= from && opened <= to && fin(x.fillPrice) !== null) out.push({ book: name, kind: 'entry', t: opened, price: x.fillPrice, id: x.id });
    const e = x.exit;
    if (e && Number(e.at) >= from && Number(e.at) <= to && fin(e.fillPrice) !== null) out.push({ book: name, kind: 'exit', t: Number(e.at), price: e.fillPrice, reason: e.reason || null, pnlUsd: fin(x.pnlUsd), id: x.id });
  }
  return out;
}

function positionLines(book, name, symbol) {
  return (book?.positions || []).filter(x => x.symbol === symbol && fin(x.fillPrice) !== null).map(x => ({
    book: name, id: x.id, entry: x.fillPrice,
    stop: fin(x.stopPct) !== null ? x.fillPrice * (1 - x.stopPct) : null,
    take: fin(x.takePct) !== null ? x.fillPrice * (1 + x.takePct) : null,
    trail: fin(x.trailStop),
  }));
}

// Realized equity per book: start + cumulative net after every close, plus the gross line (net with
// the fees added back). The gap between the two is the fee drag the HUD shades.
export function equityCurve(book, { now = null, maxPoints = CHART_MAX_POINTS } = {}) {
  const start = Number(book?.startUsd) || 0;
  const closes = (book?.history || []).filter(x => x.status === 'CLOSED' && Number.isFinite(Number(x.pnlUsd)) && Number(x.closedAt) > 0)
    .sort((a, b) => a.closedAt - b.closedAt);
  let net = start, fees = 0;
  const first = Number(book?.createdAt) || (closes[0] ? Number(closes[0].openedAt ?? closes[0].closedAt) : now);
  const pts = first ? [{ t: first, net: start, gross: start, fees: 0 }] : [];
  for (const x of closes) { net += Number(x.pnlUsd); fees += feesOf(x); pts.push({ t: Number(x.closedAt), net, gross: net + fees, fees }); }
  if (now && pts.length) pts.push({ ...pts[pts.length - 1], t: now });
  // Evenly spaced closes when there are too many; the first and last points always survive.
  const points = pts.length > maxPoints ? Array.from({ length: maxPoints }, (_, i) => pts[Math.round(i * (pts.length - 1) / (maxPoints - 1))]) : pts;
  return { startUsd: start, closes: closes.length, netUsd: net - start, feesUsd: fees, grossUsd: net - start + fees, points };
}

export function tradeRows(book, name) {
  return (book?.history || []).filter(x => x.status === 'CLOSED').map(x => {
    const fees = feesOf(x), net = fin(Number(x.pnlUsd));
    return {
      book: name, id: x.id, symbol: x.symbol, openedAt: Number(x.openedAt ?? x.at) || null, closedAt: Number(x.closedAt) || null,
      entry: fin(x.fillPrice), exit: fin(x.exit?.fillPrice), reason: x.exit?.reason || null, closedBy: x.closedBy || null,
      holdMs: Number(x.closedAt) && Number(x.openedAt ?? x.at) ? Number(x.closedAt) - Number(x.openedAt ?? x.at) : null,
      grossUsd: net === null ? null : net + fees, feesUsd: fees, netUsd: net,
    };
  });
}

export function buildChart({ symbol, range = '6h', rows = [], params = {}, books = {}, now, maxPoints = CHART_MAX_POINTS } = {}) {
  const rangeMs = CHART_RANGES[range];
  if (!rangeMs) throw new Error('range must be one of ' + Object.keys(CHART_RANGES).join(', '));
  const to = now, from = to - rangeMs;
  const full = withIndicators(rows, params), inRange = full.filter(r => r.t >= from && r.t <= to);
  const points = downsample(inRange, maxPoints);
  const markers = [], lines = [], trades = [], equity = {};
  for (const [name, book] of Object.entries(books)) {
    if (!book) continue;
    markers.push(...bookMarkers(book, name, symbol, from, to));
    lines.push(...positionLines(book, name, symbol));
    trades.push(...tradeRows(book, name));
    equity[name] = equityCurve(book, { now, maxPoints });
  }
  markers.sort((a, b) => a.t - b.t);
  trades.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const sources = {}; for (const r of inRange) { const k = r.src || 'unknown'; sources[k] = (sources[k] || 0) + 1; }
  return {
    symbol, range, from, to, rawCount: inRange.length, sources,
    indicators: { emaFast: params.emaFast, emaSlow: params.emaSlow, lookbackSamples: params.lookbackSamples },
    points, markers: markers.slice(-CHART_MAX_MARKERS), lines, equity, trades: trades.slice(0, CHART_MAX_TRADES),
    caps: { maxPoints, maxMarkers: CHART_MAX_MARKERS, maxTrades: CHART_MAX_TRADES },
  };
}
