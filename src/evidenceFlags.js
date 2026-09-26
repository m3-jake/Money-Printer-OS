// Shared evidence gate: may a research lane propose paper settings at all?
// This file is copied verbatim between Money Printer OS (src/evidenceFlags.js) and the
// Evolution Lab (src/evidenceFlags.js). Change both together. It only ever says "no" more
// often: thresholds below the defaults are ignored.
export const EVIDENCE_FLAGS_SCHEMA = 'mpo.evidence-flags.v1';
export const EVIDENCE_DEFAULTS = Object.freeze({
  requireExecutablePrices: true,
  minSpanDays: 7,
  minCloses: 20,
  minVenueShare: 0.9,
  maxSyntheticShare: 0.1,
});

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

// Thresholds can be tightened, never loosened.
export function evidenceThresholds(overrides = {}) {
  const d = EVIDENCE_DEFAULTS, o = overrides && typeof overrides === 'object' ? overrides : {};
  const atLeast = (k) => { const n = num(o[k]); return Number.isFinite(n) && n > d[k] ? n : d[k]; };
  const atMost = (k) => { const n = num(o[k]); return Number.isFinite(n) && n >= 0 && n < d[k] ? n : d[k]; };
  return { requireExecutablePrices: true, minSpanDays: atLeast('minSpanDays'), minCloses: atLeast('minCloses'), minVenueShare: Math.min(1, atLeast('minVenueShare')), maxSyntheticShare: atMost('maxSyntheticShare') };
}

// evidence: { executablePrices, spanDays, closes, venueShare, syntheticShare }.
// Missing or non-numeric values fail closed with a named blocker.
export function laneMayPropose(evidence, overrides = {}) {
  const t = evidenceThresholds(overrides), e = evidence && typeof evidence === 'object' ? evidence : {};
  const blockers = [];
  if (t.requireExecutablePrices && e.executablePrices !== true) blockers.push('no executable venue prices');
  const span = num(e.spanDays), closes = num(e.closes), venue = num(e.venueShare), synthetic = num(e.syntheticShare);
  if (!(span >= t.minSpanDays)) blockers.push(`evidence spans ${Number.isFinite(span) ? span.toFixed(2) : 'unknown'} of ${t.minSpanDays} days`);
  if (!(closes >= t.minCloses)) blockers.push(`${Number.isFinite(closes) ? closes : 'unknown'} of ${t.minCloses} paper closes`);
  if (!(venue >= t.minVenueShare)) blockers.push(`venue-sourced quotes ${Number.isFinite(venue) ? (venue * 100).toFixed(0) + '%' : 'unknown'}; need ${(t.minVenueShare * 100).toFixed(0)}%`);
  if (!(synthetic <= t.maxSyntheticShare)) blockers.push(`synthetic rows ${Number.isFinite(synthetic) ? (synthetic * 100).toFixed(0) + '%' : 'unknown'}; max ${(t.maxSyntheticShare * 100).toFixed(0)}%`);
  return { schema: EVIDENCE_FLAGS_SCHEMA, ok: blockers.length === 0, blockers, thresholds: t };
}
