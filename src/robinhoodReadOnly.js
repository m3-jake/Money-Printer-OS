// Deny by default. This is the READ surface used by the existing transport wrappers, not an order API.
const QUERY_KEYS = new Set(['symbol','asset_code','account_number','side','quantity','state','created_at_start','cursor','page','page_size','limit','offset']);
const RESERVED_ACTIONS = new Set(['cancel','cancel-all','create','submit','replace','amend','execute','accept','confirm','batch','bulk']);
export function isRobinhoodReadOnlyRequest({ method = 'GET', path = '', json } = {}) {
  if (String(method).toUpperCase() !== 'GET' || json !== undefined && json !== null) return false;
  try {
    const raw = String(path);
    const u = new URL(raw, 'https://read-only.invalid');
    if (u.hash || [...u.searchParams.keys()].some(k => !QUERY_KEYS.has(k))) return false;
    const p = decodeURIComponent(u.pathname);
    if (/^\/api\/v[12]\/crypto\/trading\/(?:accounts|holdings|trading_pairs|estimated_price)\/$/.test(p)) return true;
    if (/^\/api\/v[12]\/crypto\/marketdata\/best_bid_ask\/$/.test(p)) return true;
    const order = p.match(/^\/api\/v[12]\/crypto\/trading\/orders\/(?:([A-Za-z0-9_-]{1,160})\/)?$/);
    return Boolean(order && (!order[1] || !RESERVED_ACTIONS.has(order[1].toLowerCase())));
  } catch { return false; }
}
