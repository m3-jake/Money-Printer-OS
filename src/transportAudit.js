// Bounded, allowlisted transport diagnostics. Never retain request/response payloads or credentials.
export const TRANSPORT_LOG_CAPACITY = 256;
const METHODS = new Set(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE']);
const ROUTES = ['accounts','holdings','trading_pairs','orders','best_bid_ask','estimated_price'];
export function transportRouteClass(value) {
  const raw = String(value || '').split('?')[0];
  const match = raw.match(/^\/?api\/v[12]\/crypto\/(?:trading|marketdata)\/([a-z_]+)(?:\/|$)/);
  return match && ROUTES.includes(match[1]) ? match[1] : 'other';
}
export function appendTransportAudit(records, { method, path, at } = {}) {
  if (!Array.isArray(records)) throw new TypeError('Transport audit requires an array');
  const verb = String(method || '').toUpperCase();
  const row = Object.freeze({
    method: METHODS.has(verb) ? verb : 'OTHER',
    route: transportRouteClass(path),
    at: Number.isFinite(at) ? at : null
  });
  // Discard only ephemeral diagnostics; accounting journals are not involved.
  if (records.length >= TRANSPORT_LOG_CAPACITY) records.splice(0, records.length - TRANSPORT_LOG_CAPACITY + 1);
  records.push(row);
  return row;
}
