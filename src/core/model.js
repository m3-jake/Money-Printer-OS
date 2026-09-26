import { createHash } from 'node:crypto';

export const ENTITY_KINDS = Object.freeze(['Event', 'Market', 'Instrument', 'Contract', 'Asset', 'Outcome', 'Price', 'Probability', 'OrderBook', 'Trade', 'Position', 'Portfolio', 'NewsEvent', 'EconomicRelease', 'SportsEvent', 'Wallet', 'Entity', 'Strategy', 'Signal', 'Opportunity', 'RiskExposure', 'Filing', 'WeatherAlert']);
// SportsEvent is also a kind above; canonical events are MPOS-derived (fact=false).
export const EXECUTION_MODES = Object.freeze(['PAPER', 'MANUAL_APPROVAL', 'LIVE']);
export function requiredText(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is required (max ${max} characters)`);
  return value.trim();
}
export function stableId(kind, provider, sourceId) {
  if (!ENTITY_KINDS.includes(kind)) throw new Error('Unknown entity kind');
  return `${kind.toLowerCase()}:${encodeURIComponent(requiredText(provider, 'provider'))}:${encodeURIComponent(requiredText(String(sourceId ?? ''), 'sourceId'))}`;
}
export function finite(value) { return value === null || value === undefined || value === '' || typeof value === 'boolean' ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
export function timestamp(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function probability(value) { const n = finite(value); return n !== null && n >= 0 && n <= 1 ? n : null; }
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-JSON value');
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function entity(kind, provider, sourceId, data, { observedAt = Date.now(), availableAt = observedAt, sourceUrl = null, fact = true } = {}) {
  if (!timestamp(observedAt) || !timestamp(availableAt) || availableAt > observedAt) throw new Error('Invalid observation/availability time');
  return { id: stableId(kind, provider, sourceId), kind, provider, sourceId: String(sourceId), observedAt, availableAt, sourceUrl, fact: fact === true, data };
}
// Fixed-point decimal parsing: never silently round financial input or accept exponent notation.
export function units(value, decimals = 6) {
  const s = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error('Expected a decimal amount');
  const [whole, fraction = ''] = s.replace('-', '').split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error(`Amount exceeds ${decimals} decimal places`);
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0'));
  return s.startsWith('-') ? -result : result;
}
export function decimal(value, decimals = 6) {
  const n = BigInt(value), sign = n < 0n ? '-' : '', abs = n < 0n ? -n : n, scale = 10n ** BigInt(decimals);
  return `${sign}${abs / scale}.${String(abs % scale).padStart(decimals, '0')}`;
}

export function availableHistory(records, asOf) {
  if (!timestamp(asOf)) throw new Error('Valid replay time required');
  return records.filter(r => timestamp(r.availableAt) && r.availableAt <= asOf && (!r.revisionAvailableAt || r.revisionAvailableAt <= asOf))
    .sort((a, b) => a.availableAt - b.availableAt || String(a.id).localeCompare(String(b.id)));
}
