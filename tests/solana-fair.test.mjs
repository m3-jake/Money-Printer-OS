import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { exitPresets, operatingProfiles, defaults } from '../src/runtime.js';
import {
  roundTripCostPct, breakEvenHitRate, baselineRoundTripPct, solanaCostGate, solanaBookStats,
  solanaBookView, typicalRoundTripPct, COST_GATE_MULTIPLE,
} from '../src/solanaEconomics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const config = { simulatedSlippageBps: 80, simulatedFeeBps: 25 };
// A deep, clean pool: the modeled round trip sits at the config floor (2.1%).
const deep = { liq: 5_000_000, executionScore: 80, micro: {}, priceAccel: 0 };

test('preset math: FAIR breaks even below 60%, SPRINT needs about 83%', () => {
  assert.deepEqual(exitPresets.fair, { tp1: 12, tp2: 30, stop: 8, trail: 7, maxHold: 90 });
  assert.equal(operatingProfiles.FAIR.exitPreset, 'fair');
  assert.equal(roundTripCostPct({ feeBps: 25, entrySlippageBps: 80, exitSlippageBps: 80 }), 2.1);
  assert.equal(baselineRoundTripPct(config), 2.1);
  const fair = breakEvenHitRate(exitPresets.fair, 2.5);
  assert.ok(fair < 0.6, `FAIR break-even ${fair}`);
  assert.equal(Number(fair.toFixed(3)), 0.525);
  const sprint = breakEvenHitRate(exitPresets.sprint, 2.5);
  assert.equal(Number(sprint.toFixed(3)), 0.833);
  // Even at the worst cost the gate admits (tp1 / 3 = 4%) FAIR stays at or under 60%.
  assert.ok(breakEvenHitRate(exitPresets.fair, 12 / COST_GATE_MULTIPLE) <= 0.6 + 1e-12);
  assert.equal(breakEvenHitRate({ tp1: 2, stop: 5 }, 3), 1, 'a take-profit under cost can never break even');
  assert.equal(breakEvenHitRate({ tp1: 0, stop: 5 }, 1), null);
});

test('new installs default to FAIR; SPRINT stays selectable', () => {
  const d = defaults();
  assert.equal(d.profile, 'FAIR');
  assert.equal(d.exitPreset, 'fair');
  assert.ok(operatingProfiles.SPRINT);
  assert.match(read('src/index.js'), /\['ultraScalp','sprint','fair',/);
});

test('cost gate: SPRINT is refused, FAIR passes on a deep pool and fails on a thin one', () => {
  const sprint = solanaCostGate({ pick: deep, sizeSol: 0.05, solUsd: 150, tp1: exitPresets.sprint.tp1, config });
  assert.equal(sprint.ok, false);
  assert.equal(sprint.reason, 'costGate');
  assert.ok(sprint.requiredTp1Pct >= 6.3 - 1e-9);
  const fair = solanaCostGate({ pick: deep, sizeSol: 0.05, solUsd: 150, tp1: exitPresets.fair.tp1, config });
  assert.equal(fair.ok, true);
  assert.equal(fair.reason, null);
  assert.ok(Math.abs(fair.roundTripPct - 2.1) < 0.05);
  // A thin pool: size impact pushes the round trip above 4%, so even tp1 12 is refused.
  const thin = solanaCostGate({ pick: { liq: 1_500, executionScore: 50, micro: {} }, sizeSol: 0.1, solUsd: 150, tp1: 12, config });
  assert.equal(thin.ok, false);
  assert.ok(thin.roundTripPct > 4);
  assert.ok(thin.exitSlippageBps >= thin.entrySlippageBps, 'exit is modeled at the take-profit notional');
});

test('cost gate is wired into the Solana entry path and records costGate skips', () => {
  const src = read('src/index.js');
  const enter = src.slice(src.indexOf('async function enter('), src.indexOf('const strategy = \'UNIFIED_EDGE\''));
  assert.match(enter, /solanaCostGate\(\{ pick, sizeSol: size,.*tp1: exitPolicy\(s\)\.tp1/);
  assert.match(enter, /skipReasons.*costGate/);
  assert.match(enter, /reason: 'costGate'/);
  assert.ok(enter.indexOf('solanaCostGate') < enter.indexOf('sprintPaper) {'), 'the gate runs before the SPRINT gates');
});

test('entry funnel exposes post-selection paper blockers instead of hiding approved-but-unfilled attempts', () => {
  const src = read('src/index.js');
  const enter = src.slice(src.indexOf('function noteEntryReject('), src.indexOf('async function actions('));
  for (const reason of ['price-stale-or-invalid','size-too-small','cost-gate','sprint-liquidity','sprint-execution','sprint-friction','paper-integrity','insufficient-paper-cash','simulated-fill-failure']) {
    assert.ok(enter.includes(reason), reason);
  }
  assert.match(src, /entryRejectionReasons=Object\.fromEntries/);
  assert.match(src, /rejectionReasons,entryRejectionReasons/);
  assert.match(src, /lastEntryReject:s\.stats\.lastEntryReject/);
});

test('book stats and view: hit rate, profit factor, net after costs, costGate skips', () => {
  const history = [
    { pnlSol: 0.01, feesSol: 0.001, entrySlippageBps: 90, exitSlippageBps: 110 },
    { pnlSol: -0.005, feesSol: 0.001, entrySlippageBps: 90, exitSlippageBps: 110 },
    { pnlSol: -0.005, feesSol: 0.001, entrySlippageBps: 90, exitSlippageBps: 110 },
    { pnlSol: 0.004, feesSol: 0.001, entrySlippageBps: 90, exitSlippageBps: 110 },
    { pnlSol: -0.002, feesSol: 0.001, entrySlippageBps: 90, exitSlippageBps: 110 },
  ];
  const st = solanaBookStats(history);
  assert.equal(st.trades, 5);
  assert.equal(st.hitRate, 0.4);
  assert.equal(Number(st.profitFactor.toFixed(4)), Number((0.014 / 0.012).toFixed(4)));
  assert.equal(Number(st.netPnlSol.toFixed(6)), 0.002);
  assert.equal(typicalRoundTripPct(history, config).source, 'history');
  assert.equal(typicalRoundTripPct(history, config).pct, 2.5);
  assert.equal(typicalRoundTripPct(history.slice(0, 3), config).source, 'config');
  const v = solanaBookView({ runtime: { profile: 'FAIR', exitPreset: 'fair' }, history, stats: { skipReasons: { costGate: 7 } } }, config);
  assert.equal(v.costGate.skips, 7);
  assert.ok(v.breakEvenHitRate < 0.6);
  assert.equal(v.costGate.presetPasses, true);
  const s = solanaBookView({ runtime: { profile: 'SPRINT', exitPreset: 'sprint' }, history: [] }, config);
  assert.equal(s.costGate.presetPasses, false);
  assert.ok(s.sprintBreakEvenHitRate > 0.75, 'SPRINT needs ~79% at the 2.1% floor');
  assert.equal(s.hitRate, null);
});

test('HUD contract: Solana card, one-click FAIR/SPRINT switch and SPRINT warning', () => {
  const html = read('public/dashboard.html');
  const dash = read('src/dashboard.js');
  assert.match(dash, /solanaBook: solanaBookView\(s, cfg\)/);
  for (const needle of ['id="solanaBook"', 'BREAK-EVEN HIT RATE', 'COSTGATE SKIPS', 'NET P/L AFTER COSTS', 'PROFIT FACTOR', 'HIT RATE',
    'data-profile="FAIR"', 'data-profile="SPRINT"', 'id="solSprintWarn"', "post('/api/profile',{profile:b.dataset.profile})"]) {
    assert.ok(html.includes(needle), needle);
  }
  assert.match(html, /\['FAIR','CALM','FAST','DEGEN','MAX','SPRINT','RESEARCH'\]/);
  assert.match(html, /s\.positions,s\.solanaBook\],renderTrade/);
  const start = html.indexOf('<script>') + 8, end = html.lastIndexOf('</script>');
  assert.doesNotThrow(() => new vm.Script(html.slice(start, end)));
});

test('paper auto-demote: SPRINT fails the cost gate at the floor round trip and drops to FAIR, never back', async () => {
  const { paperProfileDemotion } = await import('../src/solanaEconomics.js');
  const sprint = { profile: 'SPRINT', ...operatingProfiles.SPRINT };
  const d = paperProfileDemotion({ mode: 'paper', runtime: sprint, config });
  assert.equal(d.from, 'SPRINT'); assert.equal(d.to, 'FAIR');
  assert.equal(d.tp1, 4); assert.ok(Math.abs(d.requiredTp1Pct - 6.3) < 1e-9);
  assert.equal(paperProfileDemotion({ mode: 'live', runtime: sprint, config }), null, 'live is never touched');
  assert.equal(paperProfileDemotion({ mode: 'paper', runtime: { profile: 'FAIR', ...operatingProfiles.FAIR }, config }), null);
  assert.equal(paperProfileDemotion({ mode: 'paper', runtime: { profile: 'RESEARCH', ...operatingProfiles.RESEARCH }, config }), null, 'runner tp1 15 passes');
  // If even FAIR would fail the gate, do not churn profiles.
  assert.equal(paperProfileDemotion({ mode: 'paper', runtime: sprint, config: { simulatedSlippageBps: 400, simulatedFeeBps: 100 } }), null);
  const src = read('src/index.js');
  assert.match(src, /paperProfileDemotion\(\{ mode: cfg\.mode, runtime: s\.runtime, config: cfg \}\)/);
  assert.match(src, /type: 'profile-auto-demote'/);
  assert.doesNotMatch(src, /profile = 'SPRINT'/, 'nothing promotes to SPRINT automatically');
});

test('FAIR expectancy: only FAIR-tagged closes, Wilson 95 % interval, measured cost, PARK only after 100 closes', async () => {
  const { fairExpectancy, wilsonInterval } = await import('../src/solanaEconomics.js');
  const w = wilsonInterval(50, 100);
  assert.ok(Math.abs(w.low - 0.4038) < 1e-3 && Math.abs(w.high - 0.5962) < 1e-3, JSON.stringify(w));
  assert.deepEqual(wilsonInterval(0, 0), { low: null, high: null });
  const close = (win, preset = 'fair') => ({ exitPreset: preset, pnlSol: win ? 0.01 : -0.01, entrySlippageBps: 80, exitSlippageBps: 80 });
  const empty = fairExpectancy([], config);
  assert.equal(empty.closes, 0); assert.equal(empty.expectancyPct, null); assert.equal(empty.verdict, 'COLLECTING');
  const mixed = [...Array.from({ length: 10 }, (_, i) => close(i < 6)), close(true, 'sprint'), { pnlSol: 1 }];
  const e = fairExpectancy(mixed, config);
  assert.equal(e.closes, 10, 'SPRINT and untagged legacy closes are not FAIR evidence'); assert.equal(e.hitRate, 0.6);
  assert.equal(e.roundTripSource, 'history'); assert.equal(e.realisedRoundTripPct, 2.1);
  assert.ok(Math.abs(e.expectancyPct - (0.6 * 12 - 0.4 * 8 - 2.1)) < 1e-9);
  // 100 closes at a 30 % hit rate: the upper bound sits under the ~52 % break-even, so the lane parks itself.
  const poor = fairExpectancy(Array.from({ length: 100 }, (_, i) => close(i < 30)), config);
  assert.ok(poor.hitRate95.high < poor.breakEvenHitRate); assert.equal(poor.verdict, 'PARK');
  const ok = fairExpectancy(Array.from({ length: 100 }, (_, i) => close(i < 55)), config);
  assert.equal(ok.verdict, 'KEEP_RESEARCHING');
  assert.ok(solanaBookView({ history: mixed, runtime: { profile: 'FAIR', exitPreset: 'fair' } }, config).fair.closes === 10);
  assert.match(read('src/index.js'), /exitPreset: s\.runtime\.exitPreset \|\| null/);
  assert.match(read('src/labLink.js'), /solanaFair: fairExpectancy\(/);
});
