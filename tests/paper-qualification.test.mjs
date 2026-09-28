import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { qualificationMetrics, qualifiesForLivePromotion, paperQualificationBadge } from '../src/paperQualification.js';

function sampleRows(n = 120) { const start = Date.parse('2026-01-01T00:00:00Z'); return Array.from({ length: n }, (_, i) => ({ trade: { strategy: 'A', mode: 'PAPER', returnPct: i % 5 ? 2 : -1, closedAt: start + i * 86_400_000, pnlSol: i % 5 ? 0.02 : -0.01, replayPnl: 0.01, shadowDivergenceBps: 25 } })); }

test('qualification metrics cover Sharpe, drawdown, win rate, count, days and optimism/shadow gaps', () => {
  const m = qualificationMetrics('A', sampleRows(), { now: Date.parse('2026-09-01') });
  assert.equal(m.sampleCount, 120); assert.equal(m.winRate, 0.8); assert.ok(m.sharpe > 0); assert.ok(m.maxDrawdownSol > 0); assert.ok(m.daysObserved > 30);
  assert.ok(m.optimismGap != null); assert.equal(m.shadowGapBps, 25);
});

test('promotion verdict is thresholded, read-only and never authorizes auto-promotion', () => {
  const rows = sampleRows();
  const pass = qualifiesForLivePromotion('A', rows, { minSharpe: 0, minSamples: 100, minDays: 30, maxDrawdownPct: 100, markedEquitySeries: rows.map(x => ({ strategy: 'A', at: x.trade.closedAt, equitySol: 10 + (x.trade.closedAt-rows[0].trade.closedAt)/86_400_000 * .01 })) });
  assert.equal(pass.ok, true); assert.deepEqual(pass.reasons, []); assert.equal(pass.automaticLivePromotionAllowed, false);
  const fail = qualifiesForLivePromotion('A', rows, { minSamples: 200 }); assert.equal(fail.ok, false); assert.ok(fail.reasons.includes('insufficient-samples'));
  assert.deepEqual(paperQualificationBadge(fail), { label: 'NOT QUALIFIED', status: 'BLOCKED', reasons: fail.reasons, readOnly: true, liveActivationAllowed: false });
});

test('dashboard exposes qualification through a read-only GET route', () => {
  const source = fs.readFileSync(new URL('../src/dashboard.js', import.meta.url), 'utf8');
  assert.match(source, /req\.method === 'GET' && u\.pathname === '\/api\/paper-qualification'/);
  assert.match(source, /qualifiesForLivePromotion\(id,closes\)/);
});

test('dashboard shows qualification as a read-only badge and does not expose live controls', () => {
  const html = fs.readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /id="paperQualificationBadge"/);
  assert.match(html, /\/api\/paper-qualification/);
  assert.match(html, /This never unlocks or starts live trading/);
});
