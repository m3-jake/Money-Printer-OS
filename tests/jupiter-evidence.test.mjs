import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeJupiterEvidence, latestJupiterQuote } from '../src/jupiterEvidence.js';
import { fitnessDoc, solanaFitnessParts } from '../src/fitnessLedger.js';

const DAY = 864e5;
const row = t => ({
  schema: 'mpo.jupiter-quote.v1', t, source: 'jupiter-quote',
  mint: 'GpuxEQPLFftuDZeo5nXm2UJWH7uAWDDaG94aa54SRQjc', symbol: 'T',
  notionalSol: 0.1, slippageBps: 100,
  buy: { inLamports: 100000000, outRaw: '200000000', priceImpactPct: 0.1, hops: 2, ms: 10 },
  sell: { inRaw: '200000000', outLamports: '93000000', priceImpactPct: 0.1, hops: 2, ms: 10 },
  roundTripPct: 7,
});

test('Jupiter tape becomes executable-price evidence only when rows validate and stay fresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-jup-'));
  try {
    const raw = path.join(dir, 'research-evidence', 'raw'); fs.mkdirSync(raw, { recursive: true });
    const now = 10 * DAY;
    const rows = Array.from({ length: 20 }, (_, i) => row(now - 8 * DAY + i * (8 * DAY / 19)));
    fs.writeFileSync(path.join(raw, 'jupiter-quotes-2026-09-27.ndjson'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    const s = summarizeJupiterEvidence(dir, { now: now + 1000 });
    assert.equal(s.quoteRows, 20); assert.equal(s.invalidRows, 0);
    assert.equal(s.executablePrices, true); assert.equal(s.venueShare, 1); assert.equal(s.syntheticShare, 0);
    assert.ok(s.spanDays >= 7.9); assert.equal(s.mintCount, 1);
    const latest = latestJupiterQuote(dir, rows[0].mint, { now: now + 1000 });
    assert.equal(latest.roundTripPct, 7); assert.equal(latest.source, 'jupiter-quote'); assert.ok(latest.ageMs <= 1000);
    assert.equal(latestJupiterQuote(dir, rows[0].mint, { now: now + 10 * 60_000 }), null, 'stale per-token quote cannot tighten a new entry');
    assert.equal(summarizeJupiterEvidence(dir, { now: now + 2 * DAY }).executablePrices, false, 'stale tape fails closed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Solana fitness can clear the shared evidence gate from validated Jupiter quotes plus real paper closes', () => {
  const now = 20 * DAY;
  const history = Array.from({ length: 20 }, (_, i) => ({
    exitPreset: 'fair', pnlSol: i % 2 ? 0.01 : -0.005,
    closedAt: now - 8 * DAY + i * (8 * DAY / 19),
  }));
  const jupiter = {
    executablePrices: true, fresh: true, quoteRows: 1000, spanDays: 8,
    venueShare: 1, syntheticShare: 0, medianRoundTripPct: 7.1,
  };
  const parts = solanaFitnessParts({ runtime: { profile: 'FAIR', exitPreset: 'fair' }, history }, {}, { now, jupiter });
  const doc = fitnessDoc('solana', parts, { now });
  assert.equal(doc.evidence.executablePrices, true);
  assert.equal(doc.evidence.quoteSources['jupiter-quote'], 1000);
  assert.equal(doc.evidence.closes, 20); assert.ok(doc.evidence.spanDays >= 7.9);
  assert.equal(doc.evidence.venueShare, 1); assert.equal(doc.evidence.syntheticShare, 0);
  assert.equal(doc.mayPropose.ok, true, JSON.stringify(doc.mayPropose.blockers));
});
