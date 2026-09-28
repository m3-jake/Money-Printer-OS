// Summarize the public Jupiter round-trip quote tape into executable-price evidence.
// Quotes are read-only market observations: this module never signs, swaps, or touches wallet credentials.
import fs from 'node:fs';
import path from 'node:path';
import { JUP_QUOTE_SCHEMA } from './jupiterQuoteSampler.js';

const DAY_MS = 864e5;
const CACHE = new Map();
const finite = v => Number.isFinite(Number(v)) ? Number(v) : null;
const positiveIntString = v => /^\d+$/.test(String(v || '')) && Number(v) > 0;

function validRow(r) {
  return r?.schema === JUP_QUOTE_SCHEMA
    && r?.source === 'jupiter-quote'
    && finite(r.t) > 0
    && finite(r.notionalSol) > 0
    && positiveIntString(r?.buy?.inLamports)
    && positiveIntString(r?.buy?.outRaw)
    && positiveIntString(r?.sell?.inRaw)
    && positiveIntString(r?.sell?.outLamports)
    && finite(r.roundTripPct) !== null;
}

function fileKey(files) {
  return files.map(f => `${f.name}:${f.size}:${Math.trunc(f.mtimeMs)}`).join('|');
}

export function summarizeJupiterEvidence(dataDir, { now = Date.now(), maxAgeMs = DAY_MS } = {}) {
  const rawDir = path.join(dataDir, 'research-evidence', 'raw');
  let files = [];
  try {
    files = fs.readdirSync(rawDir, { withFileTypes: true })
      .filter(x => x.isFile() && /^jupiter-quotes-\d{4}-\d{2}-\d{2}\.ndjson$/.test(x.name))
      .map(x => ({ name: x.name, ...fs.statSync(path.join(rawDir, x.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return { executablePrices: false, quoteRows: 0, invalidRows: 0, spanDays: 0, venueShare: null, syntheticShare: null, firstAt: null, lastAt: null, medianRoundTripPct: null, mintCount: 0, fresh: false };
  }

  const key = fileKey(files);
  let base = CACHE.get(rawDir);
  if (!base || base.key !== key) {
    let quoteRows = 0, invalidRows = 0, firstAt = Infinity, lastAt = -Infinity;
    const costs = [], mints = new Set(), latestByMint = new Map();
    for (const f of files) {
      const text = fs.readFileSync(path.join(rawDir, f.name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row; try { row = JSON.parse(line); } catch { invalidRows++; continue; }
        if (!validRow(row)) { invalidRows++; continue; }
        quoteRows++; firstAt = Math.min(firstAt, Number(row.t)); lastAt = Math.max(lastAt, Number(row.t));
        costs.push(Number(row.roundTripPct));
        if (row.mint) {
          const mint = String(row.mint); mints.add(mint);
          const prior = latestByMint.get(mint); if (!prior || Number(row.t) > Number(prior.t)) latestByMint.set(mint, row);
        }
      }
    }

    costs.sort((a, b) => a - b);
    const quantile = p => costs.length ? costs[Math.min(costs.length - 1, Math.floor((costs.length - 1) * p))] : null;
    base = { key, quoteRows, invalidRows, firstAt: Number.isFinite(firstAt) ? firstAt : null, lastAt: Number.isFinite(lastAt) ? lastAt : null,
      medianRoundTripPct: quantile(0.5), p75RoundTripPct: quantile(0.75), p90RoundTripPct: quantile(0.9), mintCount: mints.size, latestByMint };
    CACHE.set(rawDir, base);
  }

  const total = base.quoteRows + base.invalidRows;
  const fresh = base.lastAt !== null && now - base.lastAt <= maxAgeMs;
  return {
    quoteRows: base.quoteRows, invalidRows: base.invalidRows, firstAt: base.firstAt, lastAt: base.lastAt,
    medianRoundTripPct: base.medianRoundTripPct, p75RoundTripPct: base.p75RoundTripPct, p90RoundTripPct: base.p90RoundTripPct, mintCount: base.mintCount,
    executablePrices: fresh && base.quoteRows >= 20,
    spanDays: base.firstAt !== null && base.lastAt !== null ? Math.max(0, (base.lastAt - base.firstAt) / DAY_MS) : 0,
    venueShare: total ? base.quoteRows / total : null,
    syntheticShare: base.quoteRows ? 0 : null,
    fresh,
  };
}

export function latestJupiterQuote(dataDir, mint, { now = Date.now(), maxAgeMs = 5 * 60_000 } = {}) {
  const id = String(mint || ''); if (!id) return null;
  summarizeJupiterEvidence(dataDir, { now, maxAgeMs: DAY_MS });
  const base = CACHE.get(path.join(dataDir, 'research-evidence', 'raw')), row = base?.latestByMint?.get(id);
  if (!row) return null;
  const ageMs = now - Number(row.t); if (ageMs < -60_000 || ageMs > maxAgeMs) return null;
  return { mint: id, t: Number(row.t), ageMs, roundTripPct: finite(row.roundTripPct), notionalSol: finite(row.notionalSol), source: 'jupiter-quote' };
}
