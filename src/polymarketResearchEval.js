#!/usr/bin/env node
/**
 * Polymarket independent research evaluator.
 *
 * Research-only as-of backtest over a captured opportunity tape. Does not
 * place orders, size live risk, touch wallets/credentials, or import the
 * live Polymarket execution module. Historical depth and fee schedules are
 * never invented: missing or stale executable quotes fail closed.
 *
 * Fee math matches src/polymarket.js sports_fees_v3 (rate * p^exp * (1-p)^exp)
 * but is copied here so this module stays import-fenced from live feeds.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { recordPolymarketResearchReport } from './polymarketExperimentBridge.js';

export const SCHEMA = 'polymarket-research-tape/v1';
export const FEE_MODEL = 'docs:C*rate*p*(1-p) sports_fees_v3';
export const DEFAULT_QUOTE_STALE_MS = 15_000;   // live overlayBook BOOK_FRESH_MS
export const DEFAULT_DEPTH_STALE_MS = 15_000;
export const DEFAULT_SPORTS_STALE_MS = 120_000; // live enrichCandidate freshness
export const DEFAULT_FEE_STALE_MS = 24 * 3600_000;
export const DEFAULT_FEE_RATE = 0.05;
export const DEFAULT_FEE_EXPONENT = 1;

const ODDS = new Set(['odds', 'quote']);
const DEPTH = new Set(['depth', 'book']);
const FEE = new Set(['fee', 'fee-metadata']);
const SPORTS = new Set(['sports', 'sports-signal']);
const OUTCOME = new Set(['outcome', 'resolution']);

const num = v => Number.isFinite(Number(v)) ? Number(v) : NaN;
const finite = v => { const x = num(v); return Number.isFinite(x) ? x : null; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r4 = x => Math.round((Number(x) || 0) * 1e4) / 1e4;
const r5 = x => Math.round((Number(x) || 0) * 1e5) / 1e5;
const asStr = v => v == null ? '' : String(v);

export class AsOfClock {
  constructor() { this.t = 0; }
  set(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t)) throw new Error('research clock requires a finite as-of timestamp');
    if (t < this.t) throw new Error('research clock moved backward');
    this.t = t;
  }
  now() { return this.t; }
  assert(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t)) throw new Error('lookahead: observation missing as-of timestamp');
    if (t > this.t) throw new Error(`lookahead: ${t}>${this.t}`);
  }
}

function hashStr(s = '') {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed = 1) {
  let x = seed >>> 0 || 1;
  return () => { x = (Math.imul(1664525, x) + 1013904223) >>> 0; return x / 4294967296; };
}

export function takerFeePerShare(price, feeMeta) {
  const p = num(price);
  if (!(p > 0 && p < 1)) return 0;
  if (feeMeta && feeMeta.feesEnabled === false) return 0;
  const sched = feeMeta && typeof feeMeta.feeSchedule === 'object' ? feeMeta.feeSchedule : null;
  const schedRate = sched ? Number(sched.rate) : NaN;
  const base = Number(feeMeta?.takerBaseFee);
  // No fallback to DEFAULT_FEE_RATE: a tape without captured rate/base is missing fees.
  const rate = Number.isFinite(schedRate) && schedRate >= 0
    ? schedRate
    : (Number.isFinite(base) && base > 0 ? base / 10000 : NaN);
  const schedExp = sched ? Number(sched.exponent) : NaN;
  const exp = Number.isFinite(schedExp) && schedExp > 0 ? schedExp : DEFAULT_FEE_EXPONENT;
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.max(0, rate * Math.pow(p, exp) * Math.pow(1 - p, exp));
}

function normalizeLevels(levels, side) {
  const xs = (Array.isArray(levels) ? levels : [])
    .map(l => ({ price: num(l?.price), size: num(l?.size) }))
    .filter(l => l.price > 0 && l.price <= 1 && l.size > 0);
  xs.sort((a, b) => side === 'ask' ? a.price - b.price : b.price - a.price);
  return xs;
}

/**
 * Walk captured ask depth with cash that already includes taker fees.
 * Partial fills are returned when the book is thinner than the requested stake.
 * Missing/empty books are not invented.
 */
export function walkAsksForStake(asks, stakeUsd, feeMeta) {
  const levels = normalizeLevels(asks, 'ask');
  const stake = Math.max(0, num(stakeUsd) || 0);
  if (!levels.length || !(stake > 0)) {
    return { ok: false, reason: 'missing-executable-quote', fillPrice: null, shares: 0, costUsd: 0, feeUsd: 0, spentUsd: 0, unfilledUsd: stake, partial: false, bestAsk: null, askDepthUsd: 0 };
  }
  const askDepthUsd = levels.reduce((a, l) => a + l.price * l.size, 0);
  let remaining = stake, shares = 0, costUsd = 0, feeUsd = 0;
  const fills = [];
  for (const l of levels) {
    if (remaining <= 1e-12) break;
    const feePer = takerFeePerShare(l.price, feeMeta);
    if (feePer == null) return { ok: false, reason: 'missing-fees', fillPrice: null, shares: 0, costUsd: 0, feeUsd: 0, spentUsd: 0, unfilledUsd: stake, partial: false, bestAsk: levels[0].price, askDepthUsd };
    const allIn = l.price + feePer;
    if (!(allIn > 0)) continue;
    const take = Math.min(l.size, remaining / allIn);
    if (take <= 0) break;
    shares += take;
    costUsd += take * l.price;
    feeUsd += take * feePer;
    remaining -= take * allIn;
    fills.push({ price: l.price, size: take, feePerShare: feePer });
  }
  const spentUsd = costUsd + feeUsd;
  if (!(shares > 0) || !(spentUsd > 0)) {
    return { ok: false, reason: 'missing-executable-quote', fillPrice: null, shares: 0, costUsd: 0, feeUsd: 0, spentUsd: 0, unfilledUsd: stake, partial: false, bestAsk: levels[0].price, askDepthUsd };
  }
  return {
    ok: true,
    reason: remaining > 1e-8 ? 'partial-fill' : 'filled',
    fillPrice: costUsd / shares,
    shares,
    costUsd,
    feeUsd,
    spentUsd,
    unfilledUsd: Math.max(0, remaining),
    partial: remaining > 1e-8,
    bestAsk: levels[0].price,
    bestBid: null,
    askDepthUsd,
    fills,
    model: FEE_MODEL,
  };
}

export function latestAtOrBefore(sorted, ts) {
  if (!sorted?.length) return null;
  let lo = 0, hi = sorted.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].asOfTs <= ts) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? sorted[best] : null;
}

function obsKind(obs) {
  return String(obs?.type || obs?.kind || '').toLowerCase();
}

export function observationRole(obs) {
  const k = obsKind(obs);
  if (ODDS.has(k)) return 'odds';
  if (DEPTH.has(k)) return 'depth';
  if (FEE.has(k)) return 'fee';
  if (SPORTS.has(k)) return 'sports';
  if (OUTCOME.has(k)) return 'outcome';
  return null;
}

function pushIdx(map, key, obs) {
  const k = asStr(key);
  if (!k) return;
  const arr = map.get(k) || [];
  arr.push(obs);
  map.set(k, arr);
}

export function indexObservations(observations = []) {
  const odds = new Map(), depth = new Map(), fees = new Map(), sports = new Map(), outcomes = new Map();
  const rejected = [];
  for (const raw of observations || []) {
    const role = observationRole(raw);
    if (!role) { rejected.push({ reason: 'unknown-observation-type', observation: raw }); continue; }
    const asOfTs = finite(raw?.asOfTs);
    if (asOfTs == null) { rejected.push({ reason: 'missing-as-of', role, observation: raw }); continue; }
    const obs = { ...raw, asOfTs, role };
    if (role === 'odds') {
      pushIdx(odds, obs.tokenId || obs.marketId, obs);
      if (Array.isArray(obs.asks) && obs.asks.length) pushIdx(depth, obs.tokenId || obs.marketId, obs);
    } else if (role === 'depth') pushIdx(depth, obs.tokenId || obs.marketId, obs);
    else if (role === 'fee') pushIdx(fees, obs.marketId, obs);
    else if (role === 'sports') pushIdx(sports, obs.eventId || obs.gameId, obs);
    else if (role === 'outcome') pushIdx(outcomes, obs.marketId, obs);
  }
  for (const m of [odds, depth, fees, sports, outcomes]) {
    for (const arr of m.values()) arr.sort((a, b) => a.asOfTs - b.asOfTs || asStr(a.marketId).localeCompare(asStr(b.marketId)));
  }
  return { odds, depth, fees, sports, outcomes, rejected };
}

function ageOk(obs, ts, staleMs) {
  if (!obs) return false;
  if (staleMs == null) return true;
  return ts - obs.asOfTs <= staleMs;
}

function quoteFrom(oddsObs, depthObs) {
  const asks = depthObs?.asks || oddsObs?.asks || null;
  const bids = depthObs?.bids || oddsObs?.bids || null;
  const ask = finite(oddsObs?.ask ?? depthObs?.ask ?? (Array.isArray(asks) && asks[0]?.price));
  const bid = finite(oddsObs?.bid ?? depthObs?.bid ?? (Array.isArray(bids) && bids[0]?.price));
  const mid = ask != null && bid != null ? (ask + bid) / 2 : finite(oddsObs?.mid);
  return {
    ask, bid, mid,
    asks: Array.isArray(asks) ? asks : null,
    bids: Array.isArray(bids) ? bids : null,
    oddsAsOfTs: oddsObs?.asOfTs ?? null,
    depthAsOfTs: depthObs?.asOfTs ?? oddsObs?.asOfTs ?? null,
    tokenId: oddsObs?.tokenId || depthObs?.tokenId || null,
    marketId: oddsObs?.marketId || depthObs?.marketId || null,
  };
}

function feeFrom(obs) {
  if (!obs) return null;
  return {
    asOfTs: obs.asOfTs,
    marketId: obs.marketId,
    feesEnabled: obs.feesEnabled !== false,
    feeSchedule: obs.feeSchedule && typeof obs.feeSchedule === 'object' ? {
      rate: finite(obs.feeSchedule.rate),
      exponent: finite(obs.feeSchedule.exponent),
      takerOnly: obs.feeSchedule.takerOnly !== false,
    } : null,
    takerBaseFee: finite(obs.takerBaseFee),
    captured: true,
  };
}

export function selectAsOf(index, opportunity, ts, limits, clock) {
  const reasons = [];
  const legs = opportunityLegs(opportunity);
  const asOf = { ts, legs: [], sports: null, complete: true };
  if (clock) clock.assert(ts);

  const eventId = opportunity.eventId || opportunity.gameId || legs[0]?.eventId;
  const sportsObs = latestAtOrBefore(index.sports.get(asStr(eventId)) || [], ts);
  if (sportsObs && clock) clock.assert(sportsObs.asOfTs);
  if (!sportsObs) reasons.push('missing-sports');
  else if (!ageOk(sportsObs, ts, limits.sportsStaleMs)) reasons.push('stale-sports');
  else {
    const lastUpdate = finite(sportsObs.lastUpdate);
    if (lastUpdate != null && lastUpdate > ts) reasons.push('future-signal');
    else if (lastUpdate != null && ts - lastUpdate > limits.sportsStaleMs) reasons.push('stale-sports');
    else asOf.sports = { ...sportsObs, captured: true };
  }

  const signalTs = finite(opportunity.signal?.asOfTs);
  if (signalTs != null && signalTs > ts) reasons.push('future-signal');

  for (const leg of legs) {
    const tokenKey = asStr(leg.tokenId || leg.marketId);
    const marketKey = asStr(leg.marketId);
    const oddsObs = latestAtOrBefore(index.odds.get(tokenKey) || index.odds.get(marketKey) || [], ts);
    const depthObs = latestAtOrBefore(index.depth.get(tokenKey) || index.depth.get(marketKey) || [], ts);
    const feeObs = latestAtOrBefore(index.fees.get(marketKey) || [], ts);
    const outcomeObs = latestAtOrBefore(index.outcomes.get(marketKey) || [], ts);
    if (oddsObs && clock) clock.assert(oddsObs.asOfTs);
    if (depthObs && clock) clock.assert(depthObs.asOfTs);
    if (feeObs && clock) clock.assert(feeObs.asOfTs);
    if (outcomeObs && clock) clock.assert(outcomeObs.asOfTs);

    const legReasons = [];
    if (!oddsObs) legReasons.push('missing-quote');
    else if (!ageOk(oddsObs, ts, limits.quoteStaleMs)) legReasons.push('stale-quote');
    const depthSource = depthObs || (oddsObs && Array.isArray(oddsObs.asks) && oddsObs.asks.length ? oddsObs : null);
    if (!depthSource || !(Array.isArray(depthSource.asks) && depthSource.asks.length)) legReasons.push('missing-depth');
    else if (depthObs && !ageOk(depthObs, ts, limits.depthStaleMs)) legReasons.push('stale-depth');
    else if (!depthObs && oddsObs && !ageOk(oddsObs, ts, limits.depthStaleMs)) legReasons.push('stale-depth');
    if (!feeObs) legReasons.push('missing-fees');
    else if (!ageOk(feeObs, ts, limits.feeStaleMs)) legReasons.push('stale-fees');
    else {
      const captured = feeFrom(feeObs);
      const usable = captured.feesEnabled === false
        || (captured.feeSchedule && Number.isFinite(Number(captured.feeSchedule.rate)))
        || Number.isFinite(Number(captured.takerBaseFee));
      if (!usable) legReasons.push('missing-fees');
    }

    const quote = quoteFrom(oddsObs, depthSource);
    if (quote.ask == null || !(quote.ask > 0 && quote.ask < 1)) {
      if (!legReasons.includes('missing-quote') && !legReasons.includes('stale-quote')) legReasons.push('missing-executable-quote');
    }
    const fee = feeFrom(feeObs);
    const alreadyResolved = outcomeObs && outcomeObs.asOfTs <= ts && (outcomeObs.resolved === true || finite(outcomeObs.resolvedPrice) != null);
    if (alreadyResolved) legReasons.push('already-resolved');
    asOf.legs.push({
      eventId: leg.eventId || opportunity.eventId,
      marketId: leg.marketId,
      tokenId: leg.tokenId,
      outcome: leg.outcome,
      quote,
      fee,
      resolution: outcomeObs && outcomeObs.asOfTs <= ts ? outcomeObs : null,
      reasons: legReasons,
    });
    reasons.push(...legReasons);
  }

  asOf.reasons = [...new Set(reasons)];
  asOf.complete = asOf.reasons.length === 0;
  return asOf;
}

export function opportunityLegs(opportunity) {
  if (Array.isArray(opportunity?.legs) && opportunity.legs.length) {
    return opportunity.legs.map(l => ({
      eventId: l.eventId || opportunity.eventId,
      marketId: l.marketId,
      tokenId: l.tokenId,
      outcome: l.outcome,
      requestedStakeUsd: finite(l.requestedStakeUsd),
    }));
  }
  return [{
    eventId: opportunity.eventId || opportunity.gameId,
    marketId: opportunity.marketId,
    tokenId: opportunity.tokenId,
    outcome: opportunity.outcome,
    requestedStakeUsd: finite(opportunity.requestedStakeUsd),
  }];
}

export const PRESETS = {
  'take-none': { id: 'take-none', take: () => false },
  'take-all': { id: 'take-all', take: () => true },
  'favorites': {
    id: 'favorites',
    take: (_opp, asOf) => asOf.legs.every(l => (l.quote?.ask ?? 0) >= 0.85),
  },
  'mid-price-favorites': {
    id: 'mid-price-favorites',
    take: (_opp, asOf) => asOf.legs.every(l => {
      const mid = l.quote?.mid;
      return Number.isFinite(mid) && mid >= 0.85;
    }),
  },
};

export function resolveStrategy(spec) {
  if (!spec) return { ...PRESETS['take-none'] };
  if (typeof spec.take === 'function') return { id: spec.id || 'custom', take: spec.take, preset: spec.preset || null };
  const id = spec.preset || spec.id || spec;
  const p = PRESETS[id];
  if (!p) throw new Error(`unknown research strategy ${id}`);
  return { ...p, preset: id };
}

function tapeLimits(tape = {}) {
  return {
    quoteStaleMs: finite(tape.quoteStaleMs) ?? DEFAULT_QUOTE_STALE_MS,
    depthStaleMs: finite(tape.depthStaleMs) ?? DEFAULT_DEPTH_STALE_MS,
    sportsStaleMs: finite(tape.sportsStaleMs) ?? DEFAULT_SPORTS_STALE_MS,
    feeStaleMs: finite(tape.feeStaleMs) ?? DEFAULT_FEE_STALE_MS,
    bankrollUsd: finite(tape.bankrollUsd) ?? 100,
    maxRelatedEventExposureUsd: finite(tape.maxRelatedEventExposureUsd) ?? 25,
    maxOpenPositions: finite(tape.maxOpenPositions) ?? 8,
  };
}

export function validateTape(tape) {
  if (!tape || typeof tape !== 'object') throw new Error('tape required');
  const schema = tape.schema || tape.schemaVersion;
  if (schema !== SCHEMA && schema !== 1 && schema !== '1') {
    throw new Error(`unsupported tape schema ${schema}; expected ${SCHEMA}`);
  }
  const synthetic = tape.synthetic === true || tape.testOnly === true
    || /synthetic|test/i.test(String(tape.source || ''));
  if (synthetic && tape.testOnly !== true) {
    throw new Error('synthetic tapes must set testOnly: true; historical depth/fees must not be invented');
  }
  if (!Array.isArray(tape.observations)) throw new Error('tape.observations[] required');
  if (!Array.isArray(tape.opportunities)) throw new Error('tape.opportunities[] required');
  for (const obs of tape.observations) {
    if (finite(obs?.asOfTs) == null) throw new Error('every observation requires asOfTs');
    if (!observationRole(obs)) throw new Error(`observation missing recognized type: ${obsKind(obs)}`);
  }
  for (const opp of tape.opportunities) {
    if (finite(opp?.decisionTs) == null) throw new Error(`opportunity ${opp?.id || '?'} missing decisionTs`);
    const legs = opportunityLegs(opp);
    if (!legs.length || !legs.every(l => l.marketId)) throw new Error(`opportunity ${opp?.id || '?'} missing marketId`);
    if (!opp.eventId && !opp.gameId && !legs[0].eventId) throw new Error(`opportunity ${opp?.id || '?'} missing eventId`);
  }
  return { synthetic, testOnly: tape.testOnly === true };
}

function relatedEventIds(opportunity) {
  const ids = new Set();
  if (opportunity.eventId) ids.add(asStr(opportunity.eventId));
  if (opportunity.gameId) ids.add(asStr(opportunity.gameId));
  for (const id of opportunity.relatedEventIds || []) ids.add(asStr(id));
  for (const leg of opportunityLegs(opportunity)) if (leg.eventId) ids.add(asStr(leg.eventId));
  ids.delete('');
  return [...ids];
}

function fillOpportunity(opportunity, asOf, requestedStakeUsd) {
  const stake = Math.max(0, requestedStakeUsd);
  const legs = asOf.legs;
  if (legs.length === 1) {
    const fill = walkAsksForStake(legs[0].quote.asks, stake, legs[0].fee);
    if (!fill.ok) return fill;
    return {
      ...fill,
      kind: 'single',
      legs: [{ ...fill, marketId: legs[0].marketId, tokenId: legs[0].tokenId, eventId: legs[0].eventId, outcome: opportunity.outcome || legs[0].outcome }],
    };
  }
  // Combo: shares = stake / Π(fill+fee). Probe each book, then size to available depth.
  const probes = legs.map(l => walkAsksForStake(l.quote.asks, stake, l.fee));
  if (probes.some(p => !p.ok)) {
    return { ok: false, reason: probes.find(p => !p.ok).reason, fillPrice: null, shares: 0, spentUsd: 0, feeUsd: 0, partial: false };
  }
  let product = 1, feePerShareTotal = 0;
  for (const p of probes) {
    const feePer = p.feeUsd / p.shares;
    product *= (p.fillPrice + feePer);
    feePerShareTotal += feePer;
  }
  if (!(product > 0)) return { ok: false, reason: 'missing-executable-quote', shares: 0, spentUsd: 0 };
  let shares = stake / product;
  for (let i = 0; i < legs.length; i++) {
    const avail = (legs[i].quote.asks || []).reduce((a, l) => a + num(l.size), 0);
    if (avail + 1e-12 < shares) shares = avail;
  }
  if (!(shares > 0)) return { ok: false, reason: 'missing-executable-quote', shares: 0, spentUsd: 0 };
  const spentUsd = shares * product;
  const feeUsd = shares * feePerShareTotal;
  return {
    ok: true,
    reason: spentUsd + 1e-8 < stake ? 'partial-fill' : 'filled',
    kind: 'combo',
    fillPrice: product - feePerShareTotal,
    shares,
    costUsd: spentUsd - feeUsd,
    feeUsd,
    spentUsd,
    unfilledUsd: Math.max(0, stake - spentUsd),
    partial: spentUsd + 1e-8 < stake,
    bestAsk: probes.reduce((a, p) => a * p.bestAsk, 1),
    askDepthUsd: Math.min(...probes.map(p => p.askDepthUsd)),
    legs: probes.map((p, i) => ({
      marketId: legs[i].marketId, tokenId: legs[i].tokenId, eventId: legs[i].eventId,
      outcome: legs[i].outcome, fillPrice: p.fillPrice, shares, feeUsd: shares * (p.feeUsd / p.shares),
    })),
    model: FEE_MODEL,
  };
}

function outcomeOf(index, marketId, ts, clock) {
  const obs = latestAtOrBefore(index.outcomes.get(asStr(marketId)) || [], ts);
  if (!obs) return null;
  if (clock) clock.assert(obs.asOfTs);
  const resolvedPrice = finite(obs.resolvedPrice);
  if (resolvedPrice == null && obs.resolved !== true) return null;
  return { asOfTs: obs.asOfTs, resolvedPrice: resolvedPrice == null ? (obs.won === false ? 0 : 1) : resolvedPrice, winningOutcome: obs.winningOutcome ?? obs.outcome ?? null };
}

function settleDue(state, index, ts, clock) {
  for (const pos of [...state.positions]) {
    const legs = pos.legs.map(l => outcomeOf(index, l.marketId, ts, clock));
    if (legs.some(x => !x)) continue;
    const win = legs.every(x => Number(x.resolvedPrice) === 1);
    const resolvedAt = Math.max(...legs.map(x => x.asOfTs));
    const payoutUsd = win ? pos.shares * 1 : 0;
    const pnlUsd = payoutUsd - pos.spentUsd;
    state.cash += payoutUsd;
    state.lockedUsd -= pos.spentUsd;
    state.realizedPnlUsd += pnlUsd;
    state.feesUsd += pos.feeUsd;
    for (const ev of pos.eventIds) state.eventExposure.set(ev, (state.eventExposure.get(ev) || 0) - pos.spentUsd);
    state.positions = state.positions.filter(p => p !== pos);
    const trade = {
      id: pos.id, opportunityId: pos.opportunityId, eventId: pos.eventId, eventIds: pos.eventIds,
      kind: pos.kind, openedAt: pos.openedAt, settledAt: resolvedAt, spentUsd: pos.spentUsd,
      shares: pos.shares, feeUsd: pos.feeUsd, payoutUsd, pnlUsd, status: win ? 'WON' : 'LOST',
      fillPrice: pos.fillPrice, partial: pos.partial, winRateIgnored: true,
    };
    state.trades.push(trade);
    const evPnl = state.eventPnl.get(pos.eventId) || 0;
    state.eventPnl.set(pos.eventId, evPnl + pnlUsd);
  }
}

function markEquity(state, ts) {
  const equity = state.cash;
  state.curve.push({ ts, equity, cash: state.cash, lockedUsd: state.lockedUsd, open: state.positions.length });
  return equity;
}

function runSim(prepared, strategy, limits) {
  const clock = new AsOfClock();
  const state = {
    cash: limits.bankrollUsd,
    lockedUsd: 0,
    realizedPnlUsd: 0,
    feesUsd: 0,
    positions: [],
    trades: [],
    rejections: [],
    skipped: [],
    eventExposure: new Map(),
    eventPnl: new Map(),
    curve: [{ ts: prepared.startTs, equity: limits.bankrollUsd, cash: limits.bankrollUsd, lockedUsd: 0, open: 0 }],
  };
  const times = prepared.timeline;
  const oppByTs = prepared.oppByTs;
  for (const ts of times) {
    clock.set(ts);
    settleDue(state, prepared.index, ts, clock);
    markEquity(state, ts);
    const opps = oppByTs.get(ts) || [];
    for (const opp of opps) {
      const asOf = selectAsOf(prepared.index, opp, ts, limits, clock);
      if (!asOf.complete) {
        state.rejections.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reasons: asOf.reasons });
        continue;
      }
      if (!strategy.take(opp, asOf)) {
        state.skipped.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reason: 'strategy-filter' });
        continue;
      }
      if (state.positions.length >= limits.maxOpenPositions) {
        state.rejections.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reasons: ['open-position-cap'] });
        continue;
      }
      const requested = finite(opp.requestedStakeUsd) ?? Math.min(5, state.cash);
      if (!(requested > 0) || state.cash + 1e-12 < Math.min(requested, 1e-6)) {
        state.rejections.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reasons: ['bankroll'] });
        continue;
      }
      const stake = Math.min(requested, state.cash);
      const eventIds = relatedEventIds(opp);
      const fill = fillOpportunity(opp, asOf, stake);
      if (!fill.ok) {
        state.rejections.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reasons: [fill.reason] });
        continue;
      }
      const spent = fill.spentUsd;
      if (state.cash + 1e-12 < spent) {
        state.rejections.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reasons: ['bankroll'] });
        continue;
      }
      let capHit = false;
      for (const ev of eventIds) {
        const cur = state.eventExposure.get(ev) || 0;
        if (cur + spent > limits.maxRelatedEventExposureUsd + 1e-12) { capHit = true; break; }
      }
      if (capHit) {
        state.rejections.push({ opportunityId: opp.id, decisionTs: ts, eventId: opp.eventId, reasons: ['related-event-cap'] });
        continue;
      }
      state.cash -= spent;
      state.lockedUsd += spent;
      for (const ev of eventIds) state.eventExposure.set(ev, (state.eventExposure.get(ev) || 0) + spent);
      state.positions.push({
        id: `${strategy.id}:${opp.id}`,
        opportunityId: opp.id,
        eventId: asStr(opp.eventId || opp.gameId || eventIds[0]),
        eventIds,
        kind: fill.kind,
        openedAt: ts,
        spentUsd: spent,
        shares: fill.shares,
        feeUsd: fill.feeUsd,
        fillPrice: fill.fillPrice,
        partial: fill.partial,
        legs: fill.legs,
      });
      markEquity(state, ts);
    }
  }
  const endTs = prepared.endTs;
  clock.set(endTs);
  settleDue(state, prepared.index, endTs, clock);
  markEquity(state, endTs);
  const unresolved = state.positions.map(p => ({
    opportunityId: p.opportunityId, eventId: p.eventId, spentUsd: p.spentUsd, feeUsd: p.feeUsd, openedAt: p.openedAt,
  }));
  return summarizeSim(state, strategy, limits, unresolved, prepared);
}

function maxDrawdownUsd(curve) {
  let peak = -Infinity, dd = 0;
  for (const x of curve || []) {
    peak = Math.max(peak, x.equity);
    dd = Math.max(dd, peak - x.equity);
  }
  return dd;
}

function summarizeSim(state, strategy, limits, unresolved, prepared) {
  const trades = state.trades;
  const wins = trades.filter(t => t.status === 'WON').length;
  const losses = trades.filter(t => t.status === 'LOST').length;
  const decided = wins + losses;
  const eventPnls = [...state.eventPnl.entries()].map(([eventId, pnlUsd]) => ({ eventId, pnlUsd }));
  const eventWins = eventPnls.filter(e => e.pnlUsd > 0).length;
  const coverageDenom = prepared.opportunities.length || 0;
  const completeN = prepared.completeOpportunityIds.size;
  const taken = trades.length + unresolved.length;
  return {
    strategyId: strategy.id,
    preset: strategy.preset || strategy.id,
    bankrollUsd: limits.bankrollUsd,
    netPnlUsd: r5(state.realizedPnlUsd),
    conservativePnlUsd: r5(state.realizedPnlUsd - unresolved.reduce((a, p) => a + p.spentUsd, 0)),
    lockedUsd: r5(unresolved.reduce((a, p) => a + p.spentUsd, 0)),
    feesUsd: r5(state.feesUsd + unresolved.reduce((a, p) => a + (p.feeUsd || 0), 0)),
    cashUsd: r5(state.cash),
    maxDrawdownUsd: r5(maxDrawdownUsd(state.curve)),
    trades: trades.length,
    unresolved: unresolved.length,
    wins,
    losses,
    winRatePct: decided ? r4(wins / decided * 100) : null,
    eventWinRatePct: eventPnls.length ? r4(eventWins / eventPnls.length * 100) : null,
    independentEventCount: eventPnls.length,
    eventPnls,
    coverage: coverageDenom ? r4(completeN / coverageDenom) : 0,
    completeOpportunities: completeN,
    opportunities: coverageDenom,
    taken,
    rejections: state.rejections,
    skipped: state.skipped.length,
    rejectionCounts: countReasons(state.rejections),
    curve: state.curve,
    tradeLog: trades,
    unresolvedPositions: unresolved,
    notes: [
      'Win rate is not profitability.',
      'Quoted prices alone are not a predictive edge.',
      'Net PnL is after captured taker fees and executable depth.',
    ],
  };
}

function countReasons(rejections) {
  const out = {};
  for (const r of rejections || []) for (const reason of r.reasons || []) out[reason] = (out[reason] || 0) + 1;
  return out;
}

export function eventGroupedBootstrap(eventPnls, { iterations = 500, seed = 1 } = {}) {
  const xs = (eventPnls || []).map(e => Number(e.pnlUsd || 0));
  if (xs.length < 5) return { n: xs.length, mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, ciLow: null, ciHigh: null, pPositive: null, groupedBy: 'event' };
  const random = rng(hashStr(String(seed)));
  const means = [];
  let pos = 0;
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(random() * xs.length)];
    const m = s / xs.length;
    means.push(m);
    if (m > 0) pos++;
  }
  means.sort((a, b) => a - b);
  const q = p => means[Math.min(means.length - 1, Math.floor((means.length - 1) * p))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean, ciLow: q(0.025), ciHigh: q(0.975), pPositive: pos / iterations, groupedBy: 'event', iterations };
}

export function eventGroupedSplits(eventPnls) {
  const xs = [...(eventPnls || [])];
  if (xs.length < 4) return { splits: [], note: 'insufficient independent events for an event-grouped split' };
  const cut = Math.max(1, Math.floor(xs.length * 0.6));
  const train = xs.slice(0, cut), test = xs.slice(cut);
  const sum = a => a.reduce((s, x) => s + Number(x.pnlUsd || 0), 0);
  return {
    groupedBy: 'event',
    splits: [
      { id: 'chron-event', trainEvents: train.length, testEvents: test.length, trainPnlUsd: r5(sum(train)), testPnlUsd: r5(sum(test)) },
    ],
  };
}

export function prepareTape(tape) {
  const safety = validateTape(tape);
  const limits = tapeLimits(tape);
  const index = indexObservations(tape.observations);
  const opportunities = [...tape.opportunities].sort((a, b) => a.decisionTs - b.decisionTs || asStr(a.id).localeCompare(asStr(b.id)));
  const oppByTs = new Map();
  const times = new Set();
  for (const opp of opportunities) {
    times.add(opp.decisionTs);
    const list = oppByTs.get(opp.decisionTs) || [];
    list.push(opp);
    oppByTs.set(opp.decisionTs, list);
  }
  for (const obs of tape.observations) if (observationRole(obs) === 'outcome') times.add(obs.asOfTs);
  const timeline = [...times].sort((a, b) => a - b);
  const startTs = timeline[0] ?? 0;
  const endTs = (timeline.at(-1) ?? 0) + 1;
  const completeOpportunityIds = new Set();
  const qualityRejections = [];
  const clock = new AsOfClock();
  for (const opp of opportunities) {
    clock.set(opp.decisionTs);
    const asOf = selectAsOf(index, opp, opp.decisionTs, limits, clock);
    if (asOf.complete) completeOpportunityIds.add(opp.id);
    else qualityRejections.push({ opportunityId: opp.id, decisionTs: opp.decisionTs, eventId: opp.eventId, reasons: asOf.reasons });
  }
  const required = { odds: index.odds.size, depth: index.depth.size, fee: index.fees.size, sports: index.sports.size, outcome: index.outcomes.size };
  const missingKinds = Object.entries(required).filter(([, n]) => n === 0).map(([k]) => k);
  return {
    safety, limits, index, opportunities, oppByTs, timeline, startTs, endTs,
    completeOpportunityIds, qualityRejections, required, missingKinds,
    hash: createHash('sha256').update(JSON.stringify({
      schema: SCHEMA, observations: tape.observations, opportunities: tape.opportunities.map(o => ({
        id: o.id, decisionTs: o.decisionTs, eventId: o.eventId, marketId: o.marketId, tokenId: o.tokenId,
        requestedStakeUsd: o.requestedStakeUsd, legs: o.legs || null, signal: o.signal || null,
      })),
    })).digest('hex'),
  };
}

export function promotionDecision(report, thresholds = {}) {
  const t = {
    minIndependentEvents: thresholds.minIndependentEvents ?? 20,
    minCoverage: thresholds.minCoverage ?? 0.8,
    minNetPnlUsd: thresholds.minNetPnlUsd ?? 0,
    maxDrawdownUsd: thresholds.maxDrawdownUsd ?? Infinity,
    ...thresholds,
  };
  const cand = report.candidate || {};
  const fail = [];
  if (report.dataset?.missingRequiredKinds?.length) fail.push('missing-required-observations');
  if (report.dataset?.observationIndexRejected > 0) fail.push('invalid-observations');
  if ((cand.unresolved || 0) > 0) fail.push('unresolved-outcomes');
  if ((cand.coverage || 0) < t.minCoverage) fail.push('insufficient-coverage');
  if ((cand.independentEventCount || 0) < t.minIndependentEvents) fail.push('insufficient-independent-events');
  if (!Number.isFinite(Number(cand.netPnlUsd)) || Number(cand.netPnlUsd) <= t.minNetPnlUsd) fail.push('no-positive-net-pnl');
  if (Number(cand.maxDrawdownUsd || 0) > t.maxDrawdownUsd) fail.push('drawdown');
  if ((cand.winRatePct || 0) > 50 && Number(cand.netPnlUsd) <= 0) fail.push('win-rate-is-not-profit');
  if (cand.bootstrap && cand.bootstrap.ciLow == null) fail.push('bootstrap-unavailable-event-grouped');
  if (cand.bootstrap && cand.bootstrap.ciLow != null && !(cand.bootstrap.ciLow > 0)) fail.push('event-grouped-ci-not-positive');
  const incumbentPnl = Number(report.incumbent?.netPnlUsd);
  if (Number.isFinite(incumbentPnl) && Number(cand.netPnlUsd) <= incumbentPnl) fail.push('did-not-beat-incumbent');
  return {
    eligible: fail.length === 0,
    live: false,
    reason: fail[0] || 'research-only',
    fail,
    note: 'Fail closed. High win rate is not profitability. Prices alone are not edge. Promotion never enables live execution.',
  };
}

export function evaluateTape(tape, { incumbent, candidate, thresholds, bootstrapIterations = 500 } = {}) {
  const prepared = prepareTape(tape);
  const inc = resolveStrategy(incumbent || tape.incumbent || { preset: 'take-none' });
  const cand = resolveStrategy(candidate || tape.candidate || { preset: 'take-all' });
  const incumbentSim = runSim(prepared, inc, prepared.limits);
  const candidateSim = runSim(prepared, cand, prepared.limits);
  incumbentSim.bootstrap = eventGroupedBootstrap(incumbentSim.eventPnls, { iterations: bootstrapIterations, seed: 'incumbent' });
  candidateSim.bootstrap = eventGroupedBootstrap(candidateSim.eventPnls, { iterations: bootstrapIterations, seed: 'candidate' });
  incumbentSim.splits = eventGroupedSplits(incumbentSim.eventPnls);
  candidateSim.splits = eventGroupedSplits(candidateSim.eventPnls);
  const report = {
    schema: SCHEMA,
    version: 1,
    researchOnly: true,
    live: false,
    dataset: {
      hash: prepared.hash,
      testOnly: prepared.safety.testOnly,
      synthetic: prepared.safety.synthetic,
      opportunities: prepared.opportunities.length,
      completeOpportunities: prepared.completeOpportunityIds.size,
      coverage: prepared.opportunities.length ? r4(prepared.completeOpportunityIds.size / prepared.opportunities.length) : 0,
      independentEventUniverse: new Set(prepared.opportunities.map(o => asStr(o.eventId || o.gameId))).size,
      missingRequiredKinds: prepared.missingKinds,
      observationIndexRejected: prepared.index.rejected.length,
      qualityRejections: prepared.qualityRejections,
      asOfTs: prepared.endTs,
      limits: prepared.limits,
    },
    incumbent: incumbentSim,
    candidate: candidateSim,
    comparison: {
      sameOpportunities: true,
      netPnlUsd: r5(candidateSim.netPnlUsd - incumbentSim.netPnlUsd),
      drawdownUsd: r5(candidateSim.maxDrawdownUsd - incumbentSim.maxDrawdownUsd),
      coverage: candidateSim.coverage,
      independentEventCount: candidateSim.independentEventCount,
      candidateWinRatePct: candidateSim.winRatePct,
      note: 'Compared on the same as-of opportunity set. Correlated legs are grouped by event for splits/bootstrap.',
    },
    criteria: {
      pricesAloneAreNotEdge: true,
      winRateIsNotProfitability: true,
      requireAsOf: ['odds', 'sports', 'fee', 'depth', 'outcome'],
      groupBy: 'event',
      failClosedIfMissingObservations: true,
    },
  };
  report.promotion = promotionDecision(report, thresholds || tape.thresholds);
  return report;
}

export function markdownReport(report) {
  const yn = ok => ok ? 'PASS' : 'FAIL';
  const L = [
    '# Polymarket independent research evaluator',
    '',
    'Research-only. No live orders, wallets, credentials, or risk sizing.',
    '',
    `Promotion: **${yn(report.promotion?.eligible)}** (${report.promotion?.reason})`,
    `Dataset hash: \`${report.dataset?.hash}\``,
    `Coverage: ${report.dataset?.coverage} · independent events (candidate): ${report.candidate?.independentEventCount}`,
    `Test-only tape: ${report.dataset?.testOnly === true}`,
    '',
    '## Comparison (same opportunities)',
    '',
    '| Book | Net PnL | Drawdown | Trades | Win rate | Event win rate | Independent events | Unresolved | Fees |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of [report.incumbent, report.candidate]) {
    L.push(`| ${row.strategyId} | ${row.netPnlUsd} | ${row.maxDrawdownUsd} | ${row.trades} | ${row.winRatePct} | ${row.eventWinRatePct} | ${row.independentEventCount} | ${row.unresolved} | ${row.feesUsd} |`);
  }
  L.push('', `Delta net PnL: ${report.comparison?.netPnlUsd}`, '', '## Promotion fails', '');
  for (const f of report.promotion?.fail || []) L.push(`- ${f}`);
  if (!report.promotion?.fail?.length) L.push('- none (still research-only; live stays false)');
  L.push('', '## Limitations', '',
    '- Missing or stale executable quotes, depth, fees, sports signals, or outcomes fail closed.',
    '- Depth and fee schedules are never invented.',
    '- Splits and bootstrap resample events, not correlated legs.',
    '- A high win rate after favorite prices is not evidence of profitability.',
    `- Fail reasons: ${(report.promotion?.fail || []).join(', ') || 'n/a'}`,
  );
  return L.join('\n');
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--tape') { a.tape = v; i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--incumbent') { a.incumbent = v; i++; }
    else if (k === '--candidate') { a.candidate = v; i++; }
    else if (k === '--min-events') { a.minEvents = Number(v); i++; }
    else if (k === '--min-coverage') { a.minCoverage = Number(v); i++; }
  }
  return a;
}

export function isMainModule(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argv1); }
  catch { return false; }
}

function loadTape(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.tape) {
    console.error('Usage: node src/polymarketResearchEval.js --tape <file.json> [--out reports/poly-research] [--incumbent take-none] [--candidate take-all]');
    process.exit(2);
  }
  const tape = loadTape(a.tape);
  const report = evaluateTape(tape, {
    incumbent: a.incumbent ? { preset: a.incumbent } : undefined,
    candidate: a.candidate ? { preset: a.candidate } : undefined,
    thresholds: {
      minIndependentEvents: Number.isFinite(a.minEvents) ? a.minEvents : undefined,
      minCoverage: Number.isFinite(a.minCoverage) ? a.minCoverage : undefined,
    },
  });
  const out = a.out || path.resolve('reports', 'polymarket-research-eval');
  const dest = path.resolve(out);
  const appData = path.resolve(os.homedir(), 'Library', 'Application Support', 'Money Printer OS');
  if (dest.startsWith(appData)) throw new Error('refusing to write into the app data directory');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const jsonPath = dest.endsWith('.json') ? dest : dest + '.json';
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, markdownReport(report));
  let controlPlane = null;
  try {
    const dataDir = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
    controlPlane = recordPolymarketResearchReport({ dataDir, report });
  } catch (e) {
    controlPlane = { error: String(e?.message || e), automaticLivePromotionAllowed: false };
  }
  console.log(JSON.stringify({
    ok: true,
    json: jsonPath,
    md: mdPath,
    live: false,
    promotionEligible: report.promotion.eligible,
    reason: report.promotion.reason,
    netPnlUsd: report.candidate.netPnlUsd,
    drawdownUsd: report.candidate.maxDrawdownUsd,
    coverage: report.candidate.coverage,
    independentEventCount: report.candidate.independentEventCount,
    hash: report.dataset.hash,
    lifecycleStage: controlPlane?.experiment?.lifecycle?.stage || null,
  }, null, 2));
}

if (isMainModule()) {
  try { main(); }
  catch (e) { console.error(e?.stack || e); process.exit(1); }
}
