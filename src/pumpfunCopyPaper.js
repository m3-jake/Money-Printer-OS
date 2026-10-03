// A separate $25 paper book for scored Pump.fun wallets. Every fill comes from an exact-size
// executable quote observed after the signal; leader transaction prices are never used as fills.
// The adapter exposes reads/unsigned plans only. Nothing in this module can sign or submit.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { createNativePaperAdapter } from './pumpfunNativePaper.js';
import { walletScorecardView, isWalletAddress, MIN_GRADED_ROUND_TRIPS } from './walletScorecard.js';
import { writeFileAtomicSync } from './atomicRename.js';
import { assertPaperPrimaryAvailable,markPaperInitialized } from './paperBookStore.js';

export const PUMP_COPY_SCHEMA = 'mpo.pumpfun-copy-paper.v1';
export const PUMP_COPY_DEFAULTS = Object.freeze({ startUsd: 25, stakeUsd: 2.5, minTrips: MIN_GRADED_ROUND_TRIPS,
  maxLeaders: 8, maxOpen: 3, reservePct: 20, maxExposurePct: 60, slippageBps: 100,
  fallbackNetworkFeeSol: .00001, maxRoundTripCostPct: 5, takeProfitPct: 15, stopLossPct: 8,
  maxHoldMs: 60 * 60_000, maxSignalAgeMs: 120_000, maxScorecardAgeMs: 10 * 60_000,
  maxQuoteAgeMs: 10_000, markEveryMs: 30_000, maxQuotesPerMinute: 12 });
const SOURCES = new Set(['pumpfun-native-curve', 'jupiter-quote-fallback']);
const positive = x => Number.isFinite(Number(x)) && Number(x) > 0;
const integerRaw = x => /^\d+$/.test(String(x)) && BigInt(String(x)) > 0n;
const assetAddress = x => { try { new PublicKey(String(x)); return true; } catch { return false; } };
const errorText = e => String(e?.message || e).slice(0, 200);
const finiteNumber = x => typeof x === 'number' && Number.isFinite(x);
const timestamp = (x, t) => Number.isSafeInteger(x) && x > 0 && x <= t;
function validSettings(s) {
  if (!s || Object.keys(s).length !== Object.keys(PUMP_COPY_DEFAULTS).length
    || Object.keys(PUMP_COPY_DEFAULTS).some(k => !finiteNumber(s[k]) || s[k] <= 0)) return false;
  return ['minTrips','maxLeaders','maxOpen','slippageBps','maxQuotesPerMinute','maxHoldMs','maxSignalAgeMs','maxScorecardAgeMs','maxQuoteAgeMs','markEveryMs'].every(k => Number.isSafeInteger(s[k]))
    && s.slippageBps <= 1000 && s.reservePct < 100 && s.maxExposurePct <= 100 && s.maxOpen <= 25 && s.maxLeaders <= 32
    && s.maxQuotesPerMinute <= 60 && s.stakeUsd <= s.startUsd && s.stopLossPct < 100
    && s.maxQuoteAgeMs <= 30_000 && s.maxSignalAgeMs <= 300_000 && s.maxScorecardAgeMs <= 60 * 60_000;
}

// The card must already have existed when the leader bought. This prevents a later winning
// round trip from retroactively qualifying its entry. The best trip alone cannot qualify a wallet.
export function qualifiedPumpCopyWallets(card, { asOf = Date.now(), settings = PUMP_COPY_DEFAULTS } = {}) {
  const at = Number(card?.asOf), cutoff = asOf - 30 * 86_400_000;
  if (!(at > 0) || at > asOf || asOf - at > settings.maxScorecardAgeMs) return [];
  return (card?.wallets || []).filter(w => isWalletAddress(w.wallet) && Number(w.lastTs) >= cutoff && Number(w.lastTs) < at
    && Number(w.roundTrips) >= settings.minTrips && Number(w.realizedPnlSol) > 0 && Number(w.pnlWithoutBestSol) > 0)
    .sort((a, b) => Number(b.shrunkReturnPct || 0) - Number(a.shrunkReturnPct || 0))
    .slice(0, settings.maxLeaders).map(w => ({ ...w, scorecardAsOf: at }));
}
export function selectedPumpCopyWallets(card,{asOf=Date.now(),settings=PUMP_COPY_DEFAULTS,experiment=null}={}){
 if(!experiment)return qualifiedPumpCopyWallets(card,{asOf,settings});
 const at=Number(card?.asOf);
 if(!timestamp(at,asOf)||asOf-at>settings.maxScorecardAgeMs)return [];
 return (card?.wallets||[]).filter(w=>isWalletAddress(w.wallet)&&Number(w.roundTrips)>=settings.minTrips&&Number(w.lastTs)<at&&Number(w.lastTs)>asOf-7*86400e3)
  .sort((a,b)=>Number(b.shrunkReturnPct||0)-Number(a.shrunkReturnPct||0)).slice(0,settings.maxLeaders)
  .map(w=>({...w,scorecardAsOf:at,qualificationStage:'EXPLORATORY'}));
}

export function createPumpfunCopyPaper({ dataDir = process.env.MONEY_PRINTER_DATA_DIR || 'data', adapter = null,
  now = Date.now, scorecard = () => walletScorecardView({ dir: path.resolve(dataDir), now: now(), full: true }), logger = () => {}, settings: overrides = {}, experiment = null } = {}) {
  const settings = { ...PUMP_COPY_DEFAULTS, ...overrides };
  if (!validSettings(settings)) throw new Error('Invalid Pump copy risk limits');
  if(experiment&&!['emerging','consensus'].includes(experiment.policy))throw new Error('Unsupported Pump exploratory policy');
  const file = path.resolve(dataDir, experiment ? `pumpfun-copy-${experiment.policy}-paper.json` : 'pumpfun-copy-paper.json'), activatedAt = now();
  let queue = Promise.resolve(), pending = 0, quoteWindowAt = 0, quotesThisMinute = 0;
  let maintenanceRunning = false, maintenanceResult = { closed: 0, ordersSubmitted: 0 };
  const freshBook = () => ({ schema: PUMP_COPY_SCHEMA, mode: 'PAPER', startedAt: activatedAt, startUsd: settings.startUsd,
    startSol: null, cashSol: null, fundedAt: null, fundingSolUsd: null, solUsd: null, fxAt: null,
    realizedPnlSol: 0, settings, experiment:experiment?{...experiment,strategyHash:createHash('sha256').update(JSON.stringify({experiment,settings,source:'observed-native-wallet-swap'})).digest('hex'),startedAt:activatedAt,qualificationStage:'EXPLORATORY',qualificationEffect:'NONE',capitalUsd:settings.startUsd}:null, open: [], history: [], seen: [], decisions: [], lastRunAt: null, lastMarkAt: null, lastError: null, ordersSubmitted: 0 });
  function leaders(card,asOf,limits){
    return selectedPumpCopyWallets(card,{asOf,settings:limits,experiment});
  }
  function read() {
    if (!assertPaperPrimaryAvailable(file)) return freshBook();
    if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error('Pump copy account exceeds its read budget; existing bytes preserved');
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if(experiment&&(b.experiment?.id!==experiment.id||b.experiment?.policy!==experiment.policy))throw new Error('Pump experiment identity mismatch; existing bytes preserved');
    const t = now(), validPosition = p => p && p.mode === 'PAPER' && p.orderSubmitted === false && typeof p.id === 'string' && p.id
      && typeof p.rawAmount === 'string' && p.rawAmount.length <= 64 && integerRaw(p.rawAmount) && assetAddress(p.mint) && isWalletAddress(p.wallet)
      && finiteNumber(p.costSol) && p.costSol > 0 && finiteNumber(p.sizeSol) && p.sizeSol > 0 && p.costSol >= p.sizeSol
      && timestamp(p.openedAt, t) && p.openedAt >= b.startedAt && timestamp(p.signalAt, p.openedAt) && p.signalAt >= b.startedAt
      && p.leaderAtEntry?.wallet === p.wallet && timestamp(p.leaderAtEntry?.scorecardAsOf, p.signalAt)
      && (p.markedNetSol === null || finiteNumber(p.markedNetSol)) && (p.lastQuoteAt === null || timestamp(p.lastQuoteAt, t))
      && Number.isSafeInteger(p.slippageBps) && p.slippageBps > 0 && p.slippageBps <= 1000
      && p.exitPolicy && Object.values(p.exitPolicy).every(x => finiteNumber(x) && x > 0)
      && finiteNumber(p.exitPolicy.takeProfitPct) && finiteNumber(p.exitPolicy.stopLossPct) && p.exitPolicy.stopLossPct < 100
      && Number.isSafeInteger(p.exitPolicy.maxHoldMs) && p.exitPolicy.maxHoldMs > 0;
    const validHistory = p => validPosition(p) && timestamp(p.closedAt, t) && p.closedAt >= p.openedAt && finiteNumber(p.pnlSol)
      && finiteNumber(p.proceedsSol) && Math.abs(p.pnlSol - (p.proceedsSol - p.costSol)) < 1e-10
      && finiteNumber(p.returnPct) && Math.abs(p.returnPct - (p.proceedsSol / p.costSol - 1) * 100) < 1e-8;
    const funded = b.startSol !== null;
    if (b.schema !== PUMP_COPY_SCHEMA || b.mode !== 'PAPER' || b.ordersSubmitted !== 0 || !validSettings(b.settings)
      || !timestamp(b.startedAt, t) || !finiteNumber(b.startUsd) || b.startUsd !== b.settings.startUsd || !finiteNumber(b.realizedPnlSol)
      || !Array.isArray(b.open) || b.open.length > b.settings.maxOpen || !b.open.every(validPosition) || new Set(b.open.map(p => p.id)).size !== b.open.length
      || !Array.isArray(b.history) || !b.history.every(validHistory) || new Set(b.history.map(p => p.id)).size !== b.history.length
      || b.history.some(p => b.open.some(o => o.id === p.id)) || !Array.isArray(b.seen) || b.seen.length > 2048 || b.seen.some(x => typeof x !== 'string')
      || !Array.isArray(b.decisions) || b.decisions.length > 100 || b.decisions.some(d => !timestamp(d.at, t) || d.orderSubmitted !== false)
      || ![b.lastRunAt,b.lastMarkAt].every(x => x === null || timestamp(x, t))
      || funded && (!finiteNumber(b.startSol) || b.startSol <= 0 || !finiteNumber(b.cashSol) || b.cashSol < 0
        || !timestamp(b.fundedAt,t) || !finiteNumber(b.fundingSolUsd) || b.fundingSolUsd <= 0 || Math.abs(b.startSol - b.startUsd / b.fundingSolUsd) > 1e-10
        || !finiteNumber(b.solUsd) || b.solUsd <= 0 || !timestamp(b.fxAt,t)
        || Math.abs(b.cashSol + b.open.reduce((sum,p) => sum + p.costSol,0) - b.startSol - b.realizedPnlSol) > 1e-8
        || Math.abs(b.realizedPnlSol - b.history.reduce((sum,p) => sum + p.pnlSol,0)) > 1e-8)
      || !funded && (b.cashSol !== null || b.open.length || b.history.length || b.realizedPnlSol !== 0 || [b.fundedAt,b.fundingSolUsd,b.solUsd,b.fxAt].some(x => x !== null))) {
      throw new Error('Invalid Pump copy paper account; existing bytes preserved');
    }
    markPaperInitialized(file);return b;
  }
  const write = b => {assertPaperPrimaryAvailable(file);writeFileAtomicSync(file, JSON.stringify(b, null, 2));markPaperInitialized(file);};
  function serialize(fn) {
    if (pending >= 8) return Promise.resolve({ accepted: false, reason: 'paper-copy-queue-full', ordersSubmitted: 0 });
    pending++; const result = queue.then(fn); queue = result.catch(() => {}).finally(() => pending--); return result;
  }
  function fund(b, solUsd, solUsdAt) {
    const t = now();
    if (!positive(solUsd) || !positive(solUsdAt) || solUsdAt > t || t - solUsdAt > b.settings.maxSignalAgeMs) return false;
    b.solUsd = Number(solUsd); b.fxAt = Number(solUsdAt);
    if (b.startSol === null) { b.startSol = b.startUsd / b.solUsd; b.cashSol = b.startSol; b.fundedAt = t; b.fundingSolUsd = b.solUsd; }
    return true;
  }
  function decision(b, signal, action, reason, extra = {}) {
    const d = { at: now(), mint: signal?.mint || null, wallet: signal?.wallet || null, signature: signal?.signature || null,
      action, reason, mode: 'PAPER', orderSubmitted: false, ...extra };
    b.decisions.unshift(d); b.decisions = b.decisions.slice(0, 100); write(b);
    try { logger({ type: 'pumpfun-copy-decision', ...d }); } catch { /* A completed paper fill stays completed when telemetry fails. */ }
    return { accepted: action === 'OPEN', reason, ...extra, orderSubmitted: false, ordersSubmitted: 0 };
  }
  function networkFee(q, limits) {
    if (!q.plan) return limits.fallbackNetworkFeeSol;
    const fees = [q.plan.signatureFeeLamports, q.plan.priorityFeeLamports, q.plan.jito?.tipLamports ?? 0];
    if (fees[0] < 5000 || fees.some(x => !Number.isSafeInteger(x) || x < 0)) throw new Error('Executable quote network fees unavailable');
    return fees.reduce((a, b) => a + b, 0) / 1e9;
  }
  function validate(q, limits, earliest, input = null) {
    const t = now(), at = q?.observedAt;
    if (!q || !SOURCES.has(q.source) || !integerRaw(q.rawAmount) || !finiteNumber(q.solAmount) || q.solAmount <= 0
      || !timestamp(at,t) || at < earliest || t - at > limits.maxQuoteAgeMs
      || q.orderSubmitted === true || q.plan?.orderSubmitted === true || q.plan?.jito?.submitted === true) throw new Error('Fresh executable paper quote unavailable');
    if (q.source === 'pumpfun-native-curve' && (!q.plan || q.plan.unsigned !== true || q.plan.mode !== 'PAPER' || q.plan.orderSubmitted !== false || q.plan.jito?.submitted !== false
      || input && (q.plan.mint !== input.mint || q.plan.action !== input.action)
      || q.plan.quote?.rawAmount !== q.rawAmount || q.plan.quote?.solAmount !== q.solAmount || q.plan.quote?.observedAt !== q.observedAt)) throw new Error('Native quote does not match its unsigned paper plan');
    if (q.source === 'jupiter-quote-fallback' && q.plan) throw new Error('Fallback quote must not include an execution plan');
    return q;
  }
  async function quote(b, input, earliest = 0) {
    const t = now(); if (t - quoteWindowAt >= 60_000 || t < quoteWindowAt) { quoteWindowAt = t; quotesThisMinute = 0; }
    if (quotesThisMinute >= b.settings.maxQuotesPerMinute) throw new Error('paper-copy-quote-budget');
    quotesThisMinute++;
    adapter ||= createNativePaperAdapter();
    // This fixed runtime only authorizes unsigned quote construction inside the read adapter.
    const q = await adapter.quote({ ...input, runtime: { profile: 'AGGRESSIVE_PAPER', paperOverrides: { maxPositionSol: 3 } }, mode: 'paper' });
    validate(q, b.settings, earliest, input);
    if (input.action === 'SELL' && String(q.rawAmount) !== String(input.rawAmount)) throw new Error('Executable sell quote amount mismatch');
    return q;
  }
  const haircutRaw = (raw, bps) => (BigInt(raw) * BigInt(10_000 - bps) / 10_000n).toString();
  const sellCredit = (q, limits) => q.solAmount * (1 - limits.slippageBps / 10_000) - networkFee(q, limits);
  const quoteEvidence = q => ({ source: q.source, rawAmount: q.rawAmount, solAmount: q.solAmount, observedAt: q.observedAt,
    networkFeesModeled: !q.plan, plan: q.plan ? { mode: q.plan.mode, mint: q.plan.mint, action: q.plan.action, unsigned: true,
      orderSubmitted: false, signatureFeeLamports: q.plan.signatureFeeLamports, priorityFeeLamports: q.plan.priorityFeeLamports,
      jito: q.plan.jito, quote: q.plan.quote } : null });
  function status(b, card, t) {
    if (b.startSol === null) return 'WAITING_FOR_SOL_PRICE';
    if (!leaders(card,t,b.settings).length) return 'WAITING_FOR_WALLET_EVIDENCE';
    return b.lastError ? 'QUOTE_UNAVAILABLE' : 'PAPER_READY';
  }
  function view() {
    const b = read(), t = now(), card = scorecard(), selected = leaders(card,t,b.settings);
    const marksFresh = b.open.every(p => timestamp(p.lastQuoteAt,t) && t - p.lastQuoteAt <= b.settings.maxQuoteAgeMs && finiteNumber(p.markedNetSol));
    const equitySol = b.cashSol === null || !marksFresh ? null : b.cashSol + b.open.reduce((sum, p) => sum + p.markedNetSol, 0);
    const fxFresh = timestamp(b.fxAt,t) && t - b.fxAt <= b.settings.maxSignalAgeMs;
    return { ...b, status: status(b, card, t), leaders:selected, equitySol, equityUsd: equitySol === null || !fxFresh ? null : equitySol * b.solUsd,
      markedValueStatus: marksFresh ? 'FRESH' : 'UNAVAILABLE', stats: { closed: b.history.length, wins: b.history.filter(p => p.pnlSol > 0).length,
        pnlSol: b.realizedPnlSol, retainedHistory: b.history.length },
      note: experiment?'Unqualified exploratory cohort; weaker leader evidence is explicit. Exact-size follower quotes and modeled costs still required. Independent consensus requires observed distinct cluster labels.':'Only new buys by wallets with prior profitable round trips, also profitable without their best trip. Fills use fresh exact-size native/Jupiter quotes plus modeled slippage and network fees. Missing quotes never become fills or closes.',
      liveExecutionAllowed: false, ordersSubmitted: 0 };
  }
  async function onSignal(signal, { mode = 'paper', entriesAllowed = true, solUsd, solUsdAt, card = scorecard() } = {}) {
    if (mode !== 'paper') return { accepted: false, reason: 'paper-only', orderSubmitted: false, ordersSubmitted: 0 };
    if (!entriesAllowed) return { accepted: false, reason: 'engine-paused-or-killed', orderSubmitted: false, ordersSubmitted: 0 };
    return serialize(async () => {
      const b = read(), t = now(), limits = b.settings;
      if (signal?.side !== 'BUY' || signal?.source !== `copy:${signal?.wallet}` || !assetAddress(signal?.mint) || !isWalletAddress(signal?.wallet)
        || !timestamp(signal.ts,t) || signal.ts < b.startedAt || t - signal.ts > limits.maxSignalAgeMs) return decision(b, signal, 'SKIP', 'old-or-invalid-source-signal');
      const key = `${signal.wallet}:${signal.mint}:${signal.signature || signal.ts}`;
      if (b.seen.includes(key)) return { accepted: false, reason: 'duplicate-signal', orderSubmitted: false, ordersSubmitted: 0 };
      const leader = leaders(card,Number(signal.ts),limits).find(w => w.wallet === signal.wallet);
      if (!leader) return decision(b, signal, 'SKIP', 'wallet-evidence-unqualified');
      if(experiment?.policy==='consensus'){
        const witnesses=(b.decisions||[]).filter(d=>d.mint===signal.mint&&d.reason==='awaiting-independent-consensus'&&t-d.at<=60_000&&d.wallet!==signal.wallet);
        // Cluster labels must be observed; unlabeled wallets cannot establish independence.
        const cluster=leader.clusterId||leader.cluster;
        if(!cluster||!witnesses.some(d=>d.cluster&&d.cluster!==cluster))return decision(b,signal,'SKIP','awaiting-independent-consensus',{cluster:cluster||null});
      }
      if (!fund(b, solUsd, solUsdAt)) return decision(b, signal, 'SKIP', 'fresh-sol-price-required');
      if (b.open.length >= limits.maxOpen || b.open.some(p => p.mint === signal.mint)) return decision(b, signal, 'SKIP', 'open-cap-or-mint-held');
      const reserve = b.startSol * limits.reservePct / 100, exposure = b.open.reduce((sum, p) => sum + p.costSol, 0);
      const sizeSol = Math.floor(Math.min(limits.stakeUsd / b.solUsd, b.cashSol - reserve - limits.fallbackNetworkFeeSol,
        b.startSol * limits.maxExposurePct / 100 - exposure - limits.fallbackNetworkFeeSol, 3) * 1e9) / 1e9;
      if (!(sizeSol > limits.fallbackNetworkFeeSol * 10)) return decision(b, signal, 'SKIP', 'paper-budget-reserve');
      let buy, sell, rawAmount, costSol, roundTripNetSol, roundTripCostPct;
      try {
        buy = await quote(b, { mint: signal.mint, user: signal.wallet, action: 'BUY', sizeSol }, t);
        if (Math.abs(buy.solAmount - sizeSol) > 1e-9) throw new Error('Executable buy quote amount mismatch');
        rawAmount = haircutRaw(buy.rawAmount, limits.slippageBps);
        if (!integerRaw(rawAmount)) throw new Error('Executable output rounded to zero');
        costSol = sizeSol + networkFee(buy, limits);
        sell = await quote(b, { mint: signal.mint, user: signal.wallet, action: 'SELL', rawAmount }, Number(signal.ts));
        validate(buy, limits, Number(signal.ts));
        roundTripNetSol = sellCredit(sell, limits); roundTripCostPct = Math.max(0, (1 - roundTripNetSol / costSol) * 100);
      } catch (e) { b.lastError = errorText(e); return decision(b, signal, 'SKIP', 'executable-quote-unavailable', { error: b.lastError }); }
        if (now() - signal.ts > limits.maxSignalAgeMs || !timestamp(Number(solUsdAt),now()) || now() - solUsdAt > limits.maxSignalAgeMs) return decision(b, signal, 'SKIP', 'signal-or-fx-expired-during-quote');
        if (roundTripCostPct > limits.maxRoundTripCostPct) return decision(b, signal, 'SKIP', 'round-trip-cost-wall', { roundTripCostPct });
        if (costSol > b.cashSol - reserve || costSol + exposure > b.startSol * limits.maxExposurePct / 100) return decision(b, signal, 'SKIP', 'paper-budget-reserve');
        const p = { id: key, mode: 'PAPER', strategy: 'PUMPFUN_COPY', source: signal.source, mint: signal.mint, wallet: signal.wallet,
          sourceSignature: signal.signature, signalAt: signal.ts, detectedAt: t, openedAt: now(), rawAmount, quotedRawAmount: buy.rawAmount,
          sizeSol, costSol, entryQuote: quoteEvidence(buy), entryNetworkFeeSol: networkFee(buy, limits), slippageBps: limits.slippageBps,
          leaderAtEntry: leader, roundTripCostPct, markedNetSol: roundTripNetSol, lastQuoteAt: sell.observedAt,
          exitPolicy: { takeProfitPct: limits.takeProfitPct, stopLossPct: limits.stopLossPct, maxHoldMs: limits.maxHoldMs }, orderSubmitted: false };
        b.seen.push(key); b.seen=b.seen.slice(-2048);
        b.cashSol -= costSol; b.open.push(p); b.lastError = null; b.lastRunAt = now();
        return decision(b, signal, 'OPEN', 'scored-wallet-new-buy', { position: p });
    });
  }
  async function maintain({ mode = 'paper', solUsd, solUsdAt } = {}) {
    if (mode !== 'paper') return { closed: 0, ordersSubmitted: 0, reason: 'paper-only' };
    return serialize(async () => {
      const b = read(), t = now();
      if (b.lastMarkAt && t - b.lastMarkAt < b.settings.markEveryMs) return { closed: 0, ordersSubmitted: 0 };
      fund(b, solUsd, solUsdAt); b.lastRunAt = t;
      b.lastMarkAt = t; let closed = 0; const errors = [];
      for (const p of [...b.open]) {
        let q, credit, ret, reason;
        try {
          q = await quote(b, { mint: p.mint, user: p.wallet, action: 'SELL', rawAmount: p.rawAmount }, p.openedAt);
          credit = sellCredit(q, { ...b.settings, slippageBps: p.slippageBps }); ret = (credit / p.costSol - 1) * 100;
          p.markedNetSol = credit; p.lastQuoteAt = q.observedAt; p.lastQuoteError = null;
          const policy = p.exitPolicy; reason = ret >= policy.takeProfitPct ? 'take-profit' : ret <= -policy.stopLossPct ? 'stop-loss'
            : now() - p.openedAt >= policy.maxHoldMs ? 'max-hold' : null;
          if (!reason) continue;
          if (b.cashSol + credit < 0) throw new Error('Paper cash cannot cover the quoted exit network fee');
        } catch (e) { p.markedNetSol = null; p.lastQuoteError = errorText(e); errors.push(p.lastQuoteError); continue; }
          const trade = { ...p, closedAt: now(), exitQuote: quoteEvidence(q), exitNetworkFeeSol: networkFee(q, b.settings), proceedsSol: credit,
            pnlSol: credit - p.costSol, returnPct: ret, reason, orderSubmitted: false };
          b.cashSol += credit; b.open = b.open.filter(x => x.id !== p.id); b.history.unshift(trade);
          b.realizedPnlSol += trade.pnlSol;
          decision(b, p, 'CLOSE', reason, { trade }); closed++;
      }
      b.lastError = errors[0] || null; write(b); return { closed, errors, ordersSubmitted: 0 };
    });
  }
  // One background mark pass at a time; slow public RPC quotes never hold the engine cycle open.
  function scheduleMaintain(context = {}) {
    if (context.mode && context.mode !== 'paper') return { closed: 0, ordersSubmitted: 0, reason: 'paper-only', running: false };
    if (!maintenanceRunning) {
      maintenanceRunning = true;
      Promise.resolve().then(() => maintain(context)).then(result => { maintenanceResult = result; })
        .catch(e => { maintenanceResult = { error: errorText(e), ordersSubmitted: 0 }; }).finally(() => { maintenanceRunning = false; });
    }
    return { ...maintenanceResult, running: maintenanceRunning };
  }
  function summary() {
    const b = view();
    return { status: b.status, startUsd: b.startUsd, cashSol: b.cashSol, equityUsd: b.equityUsd, equitySol: b.equitySol,
      open: b.open.length, leaders: b.leaders.length, stats: b.stats, lastRunAt: b.lastRunAt, lastError: b.lastError,
      lastDecision: b.decisions[0] ? { at: b.decisions[0].at, action: b.decisions[0].action, reason: b.decisions[0].reason } : null,
      orderSubmitted: false };
  }
  return { onSignal, maintain, scheduleMaintain, view, summary, file };
}
let singleton;
export function pumpfunCopyPaper() { return singleton ||= createPumpfunCopyPaper(); }
let explorers;
export function pumpfunCopyExperiments(){return explorers||= ['emerging','consensus'].map(policy=>createPumpfunCopyPaper({experiment:{id:`pump-${policy}-v1`,policy},settings:{minTrips:2,stakeUsd:5,maxOpen:4,reservePct:5,maxExposurePct:90,maxRoundTripCostPct:10,markEveryMs:10_000,maxQuotesPerMinute:24,maxHoldMs:30*60_000}}));}
