import { estimatePaperExecution } from './executionSim.js';
import { exitPresets, operatingProfiles } from './runtime.js';

// Solana paper economics: the cost gate, the break-even hit rate and the book stats the HUD shows.
// Pure functions; src/index.js and src/dashboard.js call them.

export const COST_GATE_MULTIPLE = 3;

// Modeled round trip in percent: the fee on both legs plus entry and exit simulated slippage.
export function roundTripCostPct({ feeBps = 0, entrySlippageBps = 0, exitSlippageBps = 0 } = {}) {
  return (2 * Number(feeBps || 0) + Number(entrySlippageBps || 0) + Number(exitSlippageBps || 0)) / 100;
}

// Hit rate p where p*(tp1 - c) = (1 - p)*(stop + c): the share of trades that must reach tp1
// before the stop for the book to break even after costs. Partial take-profits and the
// break-even stop are ignored, so this is the plain tp1-vs-stop coin.
export function breakEvenHitRate({ tp1, stop } = {}, costPct = 0) {
  const t = Number(tp1), l = Number(stop), c = Math.max(0, Number(costPct) || 0);
  if (!(t > 0) || !(l > 0)) return null;
  if (t <= c) return 1;
  return Math.min(1, (l + c) / (t + l));
}

export function activeExitPreset(runtime = {}, config = {}) {
  return exitPresets[runtime.exitPreset] || {
    tp1: config.takeProfit1Pct, tp2: config.takeProfit2Pct, stop: config.stopLossPct,
    trail: config.trailingStopPct, maxHold: config.maxHoldMin,
  };
}

// The config-only round trip (no size impact): the floor any trade pays.
export function baselineRoundTripPct(config = {}) {
  const slip = Number(config.simulatedSlippageBps ?? 80), fee = Number(config.simulatedFeeBps ?? 25);
  return roundTripCostPct({ feeBps: fee, entrySlippageBps: slip, exitSlippageBps: slip });
}

// Paper-only auto-demote: a profile whose own preset tp1 cannot clear the cost gate even at the
// config-floor round trip refuses every entry, so it produces no fills and no evidence. Returns the
// switch to FAIR, or null. Never promotes: FAIR (or any profile that passes) is left alone.
export function paperProfileDemotion({ mode, runtime = {}, config = {}, multiple = COST_GATE_MULTIPLE } = {}) {
  if (mode !== 'paper' || runtime.profile === 'FAIR') return null;
  const tp1 = Number(activeExitPreset(runtime, config).tp1);
  const requiredTp1Pct = baselineRoundTripPct(config) * multiple;
  if (tp1 >= requiredTp1Pct) return null;
  const fairTp1 = Number(exitPresets[operatingProfiles.FAIR.exitPreset].tp1);
  if (!(fairTp1 >= requiredTp1Pct)) return null;
  return { from: runtime.profile || null, to: 'FAIR', tp1, requiredTp1Pct, baselineRoundTripPct: baselineRoundTripPct(config), multiple };
}

// Refuse an entry unless tp1 >= multiple x the modeled round trip for this pick at this size.
// Exit slippage is modeled at the take-profit notional, the leg that has to pay for the win.
export function solanaCostGate({ pick, sizeSol, solUsd = 0, tp1, config = {}, multiple = COST_GATE_MULTIPLE, venueRoundTripPct = null } = {}) {
  const slip = Number(config.simulatedSlippageBps ?? 80), fee = Number(config.simulatedFeeBps ?? 25);
  const entry = estimatePaperExecution(pick, sizeSol, solUsd, slip, fee);
  const exit = estimatePaperExecution(pick, Number(sizeSol || 0) * (1 + Math.max(0, Number(tp1) || 0) / 100), solUsd, slip, fee);
  const modeledRoundTripPct = roundTripCostPct({ feeBps: fee, entrySlippageBps: entry.slippageBps, exitSlippageBps: exit.slippageBps });
  const venue = Number(venueRoundTripPct), hasVenue = Number.isFinite(venue) && venue >= 0;
  // A fresh executable Jupiter quote may only make the paper gate stricter, never looser than the simulator.
  const roundTripPct = hasVenue ? Math.max(modeledRoundTripPct, venue) : modeledRoundTripPct;
  const requiredTp1Pct = roundTripPct * multiple;
  return {
    ok: Number(tp1) >= requiredTp1Pct, reason: Number(tp1) >= requiredTp1Pct ? null : 'costGate',
    tp1: Number(tp1), roundTripPct, modeledRoundTripPct, venueRoundTripPct: hasVenue ? venue : null, costSource: hasVenue && venue > modeledRoundTripPct ? 'jupiter-quote' : 'paper-model', requiredTp1Pct, multiple,
    entrySlippageBps: entry.slippageBps, exitSlippageBps: exit.slippageBps, feeBps: fee, entry,
  };
}

// Typical modeled cost of the recent book: the median of closed trades' fee + entry + exit
// slippage, falling back to the config floor when there are fewer than 5 such trades.
export function typicalRoundTripPct(history = [], config = {}) {
  const fee = Number(config.simulatedFeeBps ?? 25);
  const xs = (Array.isArray(history) ? history : []).slice(-200)
    .filter(h => Number.isFinite(Number(h?.entrySlippageBps)) && Number.isFinite(Number(h?.exitSlippageBps)))
    .map(h => roundTripCostPct({ feeBps: fee, entrySlippageBps: h.entrySlippageBps, exitSlippageBps: h.exitSlippageBps }))
    .sort((a, b) => a - b);
  if (xs.length < 5) return { pct: baselineRoundTripPct(config), source: 'config', n: xs.length };
  const m = xs.length >> 1;
  return { pct: xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2, source: 'history', n: xs.length };
}

// Book stats after costs. pnlSol on a closed trade already carries both fees and both slippages.
export function solanaBookStats(history = []) {
  let trades = 0, wins = 0, grossWin = 0, grossLoss = 0, net = 0, fees = 0;
  for (const h of Array.isArray(history) ? history : []) {
    const p = Number(h?.pnlSol);
    if (!Number.isFinite(p)) continue;
    trades++; net += p; fees += Number(h.feesSol || 0);
    if (p > 0) { wins++; grossWin += p; } else grossLoss += -p;
  }
  return {
    trades, wins, losses: trades - wins,
    hitRate: trades ? wins / trades : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    netPnlSol: net, feesSol: fees,
  };
}

// Wilson score interval for a binomial proportion (95 % by default).
export function wilsonInterval(wins, n, z = 1.959964) {
  if (!(n > 0)) return { low: null, high: null };
  const p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

// FAIR expectancy after measured cost, from closed trades opened under the FAIR preset (positions carry exitPreset
// since Batch B; older closes have none and are not counted). A win is a close with pnlSol > 0.
// expectancy = p*tp1 - (1-p)*stop - C, in percent of size, with C the realised round trip of those fills.
export function fairExpectancy(history = [], config = {}) {
  const pr = exitPresets.fair, closes = (Array.isArray(history) ? history : []).filter(h => h?.exitPreset === 'fair' && Number.isFinite(Number(h.pnlSol)));
  const n = closes.length, wins = closes.filter(h => Number(h.pnlSol) > 0).length;
  const cost = typicalRoundTripPct(closes, config), p = n ? wins / n : null, ci = wilsonInterval(wins, n);
  const breakEven = breakEvenHitRate(pr, cost.pct);
  return {
    preset: 'fair', closes: n, wins, hitRate: p, hitRate95: ci, breakEvenHitRate: breakEven,
    realisedRoundTripPct: cost.pct, roundTripSource: cost.source,
    expectancyPct: p == null ? null : p * pr.tp1 - (1 - p) * pr.stop - cost.pct,
    // Park rule input: after 100 FAIR closes, an upper bound below break-even means no edge after costs.
    verdict: n < 100 ? 'COLLECTING' : ci.high < breakEven ? 'PARK' : 'KEEP_RESEARCHING',
  };
}

// The HUD's Solana card.
export function solanaBookView(s = {}, config = {}) {
  const runtime = s.runtime || {};
  const pr = activeExitPreset(runtime, config);
  const cost = typicalRoundTripPct(s.history, config);
  const be = breakEvenHitRate(pr, cost.pct);
  const floor = baselineRoundTripPct(config);
  const sprintBe = breakEvenHitRate(exitPresets.sprint, cost.pct);
  const mode=String(s.pnlMode||s.mode||config.mode||'PAPER').toUpperCase()==='LIVE'?'LIVE':'PAPER';
  return {
    mode,pnlMode:mode,profile: runtime.profile || null, exitPreset: runtime.exitPreset || null,
    preset: { tp1: pr.tp1, tp2: pr.tp2, stop: pr.stop, trail: pr.trail, maxHold: pr.maxHold },
    ...solanaBookStats(s.history),
    fair: fairExpectancy(s.history, config),
    roundTripPct: cost.pct, roundTripSource: cost.source,
    breakEvenHitRate: be,
    sprintBreakEvenHitRate: sprintBe,
    costGate: {
      multiple: COST_GATE_MULTIPLE, floorRoundTripPct: floor,
      presetPasses: Number(pr.tp1) >= floor * COST_GATE_MULTIPLE,
      skips: Number(s.stats?.skipReasons?.costGate || 0),
      last: s.stats?.lastCostGate || null,
    },
  };
}
