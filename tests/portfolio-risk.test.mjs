import test from 'node:test';
import assert from 'node:assert/strict';
import { correlationMatrix, drawdownTier, assessPortfolioRisk } from '../src/portfolioRisk.js';

test('correlation matrix uses explicit pair data or narrative defaults', () => {
  const ps = [{ symbol: 'DOGE' }, { symbol: 'PEPE dog' }, { symbol: 'AAPL' }], m = correlationMatrix(ps);
  assert.equal(m['0:1'], 0.75); assert.equal(m['0:2'], 0); assert.equal(m['1:1'], 1);
  assert.equal(correlationMatrix(ps, { 'DOGE|PEPE dog': 0.9 })['0:1'], 0.9);
});

test('drawdown tiers move from size cut to entry halt to flatten', () => {
  assert.equal(drawdownTier({ equity: 96, peak: 100 }).sizeMultiplier, 1);
  assert.equal(drawdownTier({ equity: 94, peak: 100 }).sizeMultiplier, 0.5);
  assert.equal(drawdownTier({ equity: 89, peak: 100 }).haltNewEntries, true);
  assert.equal(drawdownTier({ equity: 79, peak: 100 }).flatten, true);
});

test('correlated exposure and narrative caps gate only the aggressive paper profile', () => {
  const state = { mode: 'PAPER', runtime: { profile: 'AGGRESSIVE_PAPER' }, cashSol: 8, paperStartSol: 10, portfolio: { equitySol: 8 }, positions: [{ symbol: 'DOGE', remainingSol: 1 }, { symbol: 'PEPE', remainingSol: 1 }] };
  const risk = assessPortfolioRisk(state, { symbol: 'DOGE', name: 'dog' }, { maxNarrativeExposureSol: 1.5 });
  assert.equal(risk.allowed, false); assert.ok(risk.reasons.includes('narrative-exposure-cap')); assert.ok(risk.effectiveExposureSol > 1);
  assert.equal(assessPortfolioRisk(state, { symbol: 'DOGE' }, { mode: 'live' }).enabled, false);
});
