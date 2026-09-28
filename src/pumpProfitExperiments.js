// Bounded counterfactual books inside Money Printer OS; never connected to a wallet or order API.
import { policyHash, num, finite, decidePumpSize, candidateExit, outcomeMetrics, markedDrawdown } from './pumpProfitPolicy.js';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const raw = x => /^\d+$/.test(String(x || '')) && BigInt(x) > 0n;
const sum = xs => xs.reduce((a, b) => a + b, 0);
export function experimentLegacySize(book, baseline, config) {
  const positions = book.positions || [], pending = (book.pending || []).filter(x => x.side === 'BUY');
  const basis = sum(positions.map(x => num(x.remainingSol))) + sum(pending.map(x => x.amountSol));
  const marked = sum(positions.map(p => num(p.remainingSol) * num(p.lastPrice, p.entryPrice) / p.entryPrice * (num(p.entrySolUsd,1)/num(p.lastSolUsd,num(p.entrySolUsd,1)))));
  const eq = Math.min(book.cashSol + marked, book.cashSol + sum(positions.map(x => num(x.remainingSol))));
  const agg = num(baseline.aggression), sprint = baseline.profile === 'SPRINT', factor = .25 + agg / 95;
  const positionCap = Math.max(num(config.maxPositionSol), eq * (sprint ? .15 : .035 + agg / 2200));
  const exposureCap = Math.max(num(config.maxTotalExposureSol), eq * (sprint ? .88 : .12 + agg / 330));
  const targetSize = Math.max(num(config.tradeSizeSol) * factor, eq * (sprint ? .06 : .012 + agg / 1800));
  const riskSized = eq * num(config.riskPerTradePct) / Math.max(3, num(config.sizingStopPct, baseline.exit.stop));
  return { eq, markedEquity: book.cashSol + marked, positionCap, exposureCap, targetSize, riskSized, headroom: Math.max(0, exposureCap - basis) };
}
export function createProfitExperiments(protocol, baseline, config) {
  const books = protocol.capitalsSol.flatMap(startSol => protocol.candidates.map(candidate => ({ id: `${candidate.id}@${startSol}`, candidateId: candidate.id,
    candidate: structuredClone(candidate), mode: 'PAPER', startSol, cashSol: startSol, positions: [], history: [], pending: [], receipts: [], series: [],
    seen: [], usedQuotes: [], usedPoolSlots: [], rejections: {}, missing: 0, opportunities: 0, estimatedNetworkFeesSol: 0, maxExposureSol: 0 })));
  return { schema: 'mpo.pump-profit-experiments.v1', protocolHash: protocol.hash, baselineHash: baseline.hash, protocol:structuredClone(protocol), baseline:structuredClone(baseline), config:structuredClone(config),
    createdAt: protocol.createdAt, updatedAt: protocol.createdAt, phase: 'DISCOVERY', books, discoveryClusters: [], observedIds: [], observations: 0, opportunities: [],
    inputHash: null, status: 'COLLECTING_EXECUTABLE_EVIDENCE', holdoutEvaluations: [], liveExecutionAllowed: false, networkCalls: 0 };
}
const reject = (book, reason) => { book.rejections[reason] = num(book.rejections[reason]) + 1; };
const quoteKey = o => `${o.mint}:${o.side}:${o.amountRaw}`;
export function validExactQuote(q, order, now, maxAgeMs = 30000) {
  return q?.source === 'jupiter-keyless-quote' && q.swapMode === 'ExactIn' && q.mint === order.mint && q.side === order.side && q.inputMint === (order.side==='BUY'?SOL_MINT:order.mint) && q.outputMint === (order.side==='BUY'?order.mint:SOL_MINT) && String(q.inAmount) === order.amountRaw &&
    raw(q.outAmount) && raw(q.otherAmountThreshold) && BigInt(q.otherAmountThreshold) <= BigInt(q.outAmount) && q.requestedAt >= order.submittedAt && q.receivedAt >= q.requestedAt && q.receivedAt <= now && now - q.receivedAt <= maxAgeMs && Array.isArray(q.routePlan) && q.routePlan.length > 0 && q.routePlan.every(r=>typeof r.swapInfo?.ammKey==='string'&&r.swapInfo.ammKey.length>0) && Number.isSafeInteger(q.contextSlot) && q.contextSlot>0;
}

function settleOrders(book, quotes, experiment, now) {
  for (const order of [...book.pending]) {
    if (now > order.expiresAt) { book.pending = book.pending.filter(x => x.id !== order.id); book.missing++; reject(book, 'missing-exact-executable-quote'); continue; }
    const q = quotes.find(q => !book.usedQuotes.includes(q.id) && validExactQuote(q, order, now, experiment.protocol.maxQuoteAgeMs));
    if (!q) continue;
    const slots = q.routePlan.map(r => `${r.swapInfo?.ammKey}:${q.contextSlot}`);
    if (slots.some(k => book.usedPoolSlots.includes(k))) { reject(book, 'same-pool-slot-capacity-already-used'); continue; }
    const fee = num(experiment.config.networkFeeEstimateSol, .000005), before = book.cashSol;
    if (order.side === 'BUY') {
      if (before + 1e-12 < order.amountSol + fee + num(experiment.config.minSolReserve)) { reject(book, 'cash-or-network-reserve'); book.pending = book.pending.filter(x => x.id !== order.id); continue; }
      if (!Number.isInteger(order.decimals) || order.decimals < 0 || order.decimals > 18) { reject(book, 'missing-token-decimals'); continue; }
      const tokenAmount = Number(q.otherAmountThreshold) / 10 ** order.decimals, entryPrice = order.amountSol * order.solUsd / tokenAmount;
      if (!(entryPrice > 0) || !Number.isFinite(entryPrice)) { reject(book, 'invalid-executable-entry-price'); continue; }
      book.cashSol -= order.amountSol + fee;
      book.positions.push({ id: order.id, mint: order.mint, pairAddress: order.pairAddress, decimals: order.decimals, remainingRaw: q.otherAmountThreshold,
        sizeSol: order.amountSol, remainingSol: order.amountSol, realizedSol: -fee, feesSol: fee, entryPrice, lastPrice: order.markUsd, highPrice: order.markUsd,
        openedAt: now, entrySolUsd:order.solUsd,lastSolUsd:order.solUsd,lastMomentumAt: now, entryLiquidity: order.liquidityUsd, tp1Done: false, tp2Done: false, breakEvenArmed: false,
        maxFavorablePct: 0, maxAdversePct: 0, policyHash: policyHash(book.candidate), tickHistory: [], cluster: order.cluster, exit: structuredClone(book.candidate.exit) });
    } else {
      const p = book.positions.find(p => p.id === order.positionId);
      if (!p || BigInt(order.amountRaw) > BigInt(p.remainingRaw)) { reject(book, 'invalid-sell-inventory'); book.pending = book.pending.filter(x => x.id !== order.id); continue; }
      const fraction = Number(BigInt(order.amountRaw)) / Number(BigInt(p.remainingRaw)), basis = p.remainingSol * fraction, proceeds = Number(q.otherAmountThreshold) / 1e9 - fee;
      if (proceeds < 0) { reject(book, 'uneconomic-exit'); continue; }
      book.cashSol += proceeds; p.remainingSol -= basis; p.remainingRaw = String(BigInt(p.remainingRaw) - BigInt(order.amountRaw)); p.realizedSol += proceeds - basis; p.feesSol += fee;
      if (order.flag) p[order.flag] = true;
      if (p.remainingRaw === '0') { book.positions = book.positions.filter(x => x.id !== p.id); book.history.push({ ...p, closedAt: now, pnlSol: p.realizedSol, reason: order.reason, postExit: {} }); }
    }
    book.estimatedNetworkFeesSol += fee; book.usedQuotes.push(q.id); book.usedPoolSlots.push(...slots);
    book.receipts.push({ id: order.id, side: order.side, positionId: order.positionId || order.id, quoteId: q.id, at: now, cashBeforeSol: before, cashAfterSol: book.cashSol,
      deltaSol: book.cashSol - before, networkFeeEstimateSol: fee, executionEvidence: 'EXACT_SIZE_QUOTE_CONSERVATIVE_MIN_OUT_NOT_A_TRANSACTION', allCostsKnown: false, mode: 'PAPER' });
    book.pending = book.pending.filter(x => x.id !== order.id);
  }
}
function acceptTick(p, tick, now) {
  if (!tick || tick.pairAddress !== p.pairAddress || tick.mint !== p.mint || !(tick.priceUsd > 0) || now - tick.at > 30000 || tick.at > now + 1000 || tick.integrityPassed !== true) return false;
  const ratio = tick.priceUsd / num(p.lastPrice, p.entryPrice), prices = p.tickHistory.slice(-12).map(x => x.price).sort((a, b) => a - b);
  if (ratio > 20 || (prices.length >= 4 && tick.priceUsd > prices[Math.floor(prices.length / 2)] * 5)) return false;
  if(ratio<.05){
    const prior=p.crashReview||{firstAt:now,lastAt:0,count:0};
    if(tick.at>prior.lastAt){prior.count++;prior.lastAt=tick.at;} p.crashReview=prior;
    if(prior.count<3||now-prior.firstAt<15000)return false;
    p.crashReview=null;
  }
  if (tick.at > num(p.tickHistory.at(-1)?.ts)) p.tickHistory = [...p.tickHistory, { ts: tick.at, price: tick.priceUsd }].slice(-12);
  return true;
}
function observePositions(book, ticks, experiment, now) {
  for (const p of book.positions) {
    const tick = ticks.find(x => x.mint === p.mint && x.pairAddress === p.pairAddress);
    if (!acceptTick(p, tick, now)) { p.priceEvidence = 'MISSING_OR_QUARANTINED'; continue; }
    p.priceEvidence = 'OBSERVED'; p.lastPrice = tick.priceUsd;if(num(tick.solUsd)>0)p.lastSolUsd=tick.solUsd; p.lastLiquidityUsd = tick.liquidityUsd;
    if (tick.priceUsd > p.highPrice) p.lastMomentumAt = now;
    p.highPrice = Math.max(p.highPrice, tick.priceUsd); const ret = (tick.priceUsd / p.entryPrice - 1) * 100;
    p.maxFavorablePct = Math.max(p.maxFavorablePct, ret); p.maxAdversePct = Math.min(p.maxAdversePct, ret);
    const cfg=experiment.config,liq=Math.max(1,num(tick.liquidityUsd)),value=p.remainingSol*tick.priceUsd/p.entryPrice*(p.entrySolUsd/p.lastSolUsd);
    const speed=Math.max(0,num(tick.micro?.p10))*2.2+Math.max(0,num(tick.priceAccel))*1.2;
    const impact=value*Math.max(50,num(tick.solUsd))/liq*5500,thin=liq<5000?(5000/liq-1)*45:0;
    const slip=Math.max(num(cfg.simulatedSlippageBps),Math.min(3500,Math.round(num(cfg.simulatedSlippageBps)+impact+speed+thin)));
    const proceeds=value*(1-slip/10000)*(1-num(cfg.simulatedFeeBps)/10000);
    const netReturnPct=(p.realizedSol+proceeds-p.remainingSol)/p.sizeSol*100;
    if (netReturnPct >= Math.min(p.exit.breakEvenTriggerPct, p.exit.tp1 * .8)) p.breakEvenArmed = true;
    if (book.pending.some(o => o.positionId === p.id)) continue;
    const action = candidateExit(p.exit, p, { ...tick, netReturnPct, liquidityRatio: p.entryLiquidity > 0 ? tick.liquidityUsd / p.entryLiquidity : null }, now);
    if (!action) continue;
    const amountRaw = (BigInt(p.remainingRaw) * BigInt(Math.round(action.fraction * 1000000)) / 1000000n).toString();
    if (!raw(amountRaw)) continue;
    book.pending.push({ id: `${p.id}:SELL:${book.receipts.length}`, side: 'SELL', mint: p.mint, amountRaw, positionId: p.id, reason: action.reason, flag: action.flag,
      submittedAt: now, expiresAt: now + 30000, quoteKey: `${p.mint}:SELL:${amountRaw}` });
  }
}

function offerOpportunity(book, opportunity, experiment, now) {
  if (book.seen.includes(opportunity.id)) return;
  book.seen.push(opportunity.id); book.opportunities++;
  if (!opportunity.eligible || now - opportunity.at > 30000 || opportunity.at > now) { reject(book, 'stale-or-ineligible-opportunity'); return; }
  if (book.positions.some(p => p.mint === opportunity.mint) || book.pending.some(p => p.side === 'BUY' && p.mint === opportunity.mint)) { reject(book, 'already-exposed'); return; }
  if (book.history.some(p => p.mint === opportunity.mint && now - p.closedAt < num(experiment.config.cooldownMin, 5) * 60000)) { reject(book, 'cooldown'); return; }
  if (book.positions.length + book.pending.filter(p => p.side === 'BUY').length >= num(experiment.config.openLimit, 7)) { reject(book, 'position-count-limit'); return; }
  const legacy = experimentLegacySize(book, experiment.baseline, experiment.config), reserved = sum(book.pending.filter(p => p.side === 'BUY').map(p => p.amountSol + .000005));
  const decision = decidePumpSize({ legacy, state: { mode: 'PAPER', cashSol: book.cashSol, pendingCashReserveSol: reserved, pendingExposureSol: sum(book.pending.filter(p=>p.side==='BUY').map(p=>p.amountSol)), paperStartSol:book.startSol, realizedLifetimePnlSol:sum(book.history.map(p=>p.pnlSol)), positions: book.positions, history: book.history,
    runtime: { pumpSafety: experiment.baseline.operatorSafety } }, config: experiment.config, pick: opportunity, policy: { kind: 'EXPERIMENTAL', multiplier: book.candidate.multiplier } });
  book.lastDecision = { ...decision, mint: opportunity.mint, at: now };
  if (!decision.sizeSol) { reject(book, decision.bindingLimit); return; }
  if (!Number.isInteger(opportunity.decimals)) { reject(book, 'missing-token-decimals'); book.missing++; return; }
  const amountRaw = String(Math.round(decision.sizeSol * 1e9));
  book.pending.push({ id: `${book.id}:${opportunity.id}`, side: 'BUY', mint: opportunity.mint, pairAddress: opportunity.pairAddress,
    amountRaw, amountSol: decision.sizeSol, decimals: opportunity.decimals, markUsd: opportunity.priceUsd, solUsd: opportunity.solUsd,
    liquidityUsd: opportunity.liquidityUsd, executionScore: opportunity.executionScore, cluster: opportunity.cluster, submittedAt: now, expiresAt: now + 30000, quoteKey: `${opportunity.mint}:BUY:${amountRaw}` });
}
export function advanceProfitExperiments(experiment, { opportunities = [], ticks = [], quotes = [], now = Date.now() } = {}) {
  if (experiment?.protocol?.mode !== 'PAPER' || experiment.liveExecutionAllowed !== false) throw new Error('Experimental book is PAPER-only');
  const protocol = experiment.protocol;
  if(experiment.observations>=protocol.maxObservations){experiment.status='OBSERVATION_BUDGET_SPENT';experiment.updatedAt=now;return experiment;}
  if (now < experiment.updatedAt) throw new Error('Chronological replay cannot move backwards');
  if (now > protocol.validation.end) { experiment.status = 'BATCH_CLOSED_AWAITING_EVIDENCE_REVIEW'; experiment.updatedAt = now; return experiment; }
  const phase = now < protocol.discovery.end ? 'DISCOVERY' : now < protocol.validation.start ? 'EMBARGO' : 'VALIDATION';
  if (phase === 'VALIDATION' && experiment.phase !== 'VALIDATION') {
    experiment.discoveryBooks = experiment.books;
    experiment.books = createProfitExperiments(protocol, experiment.baseline, experiment.config).books;
  }
  experiment.phase = phase;
  const phaseCount=experiment.opportunities.filter(o=>o.phase===phase).length;
  const fresh = phase==='EMBARGO'?[]:opportunities.filter(o => !experiment.observedIds.includes(o.id)).slice(0, Math.max(0, Math.min(protocol.maxOpportunities-experiment.opportunities.length,(protocol.maxOpportunitiesPerPhase||128)-phaseCount)));
  for (const o of fresh) { experiment.observedIds.push(o.id); experiment.opportunities.push({ id: o.id, at: o.at, mint: o.mint, cluster: o.cluster, phase }); }
  const accepted = phase === 'EMBARGO' ? [] : fresh.filter(o => phase !== 'VALIDATION' || (!experiment.discoveryClusters.includes('mint:'+o.mint)&&!experiment.discoveryClusters.includes('cluster:'+o.cluster)));
  if (phase === 'DISCOVERY') experiment.discoveryClusters = [...new Set([...experiment.discoveryClusters, ...accepted.flatMap(o => ['mint:'+o.mint,'cluster:'+o.cluster])])];
  const availableTicks = ticks.slice(0,Math.max(0,protocol.maxObservations-experiment.observations));
  experiment.observations += availableTicks.length;
  for (const book of experiment.books) {
    settleOrders(book, quotes, experiment, now);
    observePositions(book, availableTicks, experiment, now);
    for (const opportunity of accepted) offerOpportunity(book, opportunity, experiment, now);
    const basis = sum(book.positions.map(p => p.remainingSol)), marked = sum(book.positions.map(p => p.remainingSol * p.lastPrice / p.entryPrice*(p.entrySolUsd/p.lastSolUsd)));
    book.maxExposureSol = Math.max(book.maxExposureSol, basis + sum(book.pending.filter(p => p.side === 'BUY').map(p => p.amountSol)));
    if (!book.series.length || now - book.series.at(-1).ts >= 60000) book.series.push({ ts: now, equitySol: book.cashSol + marked, cashSol: book.cashSol, exposureSol: basis });
    for (const p of book.history) for (const horizon of protocol.postExitHorizonsMinutes) {
      if (p.postExit[horizon]) continue;
      const due = p.closedAt + horizon * 60000, t = availableTicks.find(t => t.mint === p.mint && t.pairAddress === p.pairAddress && Math.abs(t.at - due) <= 30000 && t.integrityPassed === true);
      if (t) p.postExit[horizon] = { at: t.at, priceReturnPct: (t.priceUsd / p.lastPrice - 1) * 100, evidence: 'FIXED_HORIZON_MARK_NOT_EXECUTABLE_PROFIT' };
      else if (now > due + 30000) p.postExit[horizon] = { at: null, priceReturnPct: null, evidence: 'MISSING_OBSERVATION' };
    }
  }
  experiment.updatedAt = now;
  experiment.status = experiment.observations >= protocol.maxObservations ? 'OBSERVATION_BUDGET_SPENT' : experiment.opportunities.length >= protocol.maxOpportunities ? 'ENTRY_BATCH_FULL_OBSERVING_EXITS' : 'COLLECTING_EXECUTABLE_EVIDENCE';
  const frame={schema:'mpo.pump-profit-input.v1',protocolHash:experiment.protocolHash,sequence:num(experiment.inputFrames)+1,at:now,phase,previousHash:experiment.inputHash,opportunities:fresh,ticks:availableTicks,quoteIds:quotes.map(q=>q.id)};
  frame.hash=policyHash(frame);experiment.inputHash=frame.hash;experiment.inputFrames=frame.sequence;experiment.lastInputFrame=frame;
  return experiment;
}
export function profitQuoteRequests(experiment) {
  if (!experiment || ['OBSERVATION_BUDGET_SPENT', 'BATCH_CLOSED_AWAITING_EVIDENCE_REVIEW'].includes(experiment.status)) return [];
  return [...new Map(experiment.books.flatMap(b => b.pending).map(o => [quoteKey(o), { key: quoteKey(o), mint: o.mint, side: o.side, amountRaw: o.amountRaw, submittedAt: o.submittedAt, expiresAt: o.expiresAt }])).values()].sort((a, b) => (a.side === 'SELL' ? -1 : 1) - (b.side === 'SELL' ? -1 : 1));
}

export function profitExperimentView(experiment) {
  if (!experiment) return { state: 'NOT_INITIALIZED', books: [], liveExecutionAllowed: false };
  const blind=experiment.phase==='VALIDATION'&&experiment.updatedAt<=experiment.protocol.validation.end;
  return { holdoutBlinded:blind, state: experiment.status, phase: experiment.phase, protocolHash: experiment.protocolHash, baselineHash: experiment.baselineHash,
    createdAt: experiment.createdAt, updatedAt: experiment.updatedAt, observations: experiment.observations, opportunityCount: experiment.opportunities.length,
    maxOpportunities: experiment.protocol.maxOpportunities, maxObservations: experiment.protocol.maxObservations, validation: experiment.protocol.validation,
    candidatesTried: experiment.protocol.candidates.length, capitalScenarios: experiment.protocol.capitalsSol, exposurePolicy: experiment.protocol.exposurePolicy,
    quoteRequests: profitQuoteRequests(experiment).length, liveExecutionAllowed: false, promotionState: 'NOT_QUALIFIED',
    missingEvidence: ['independent untouched validation', 'network/priority/account-creation fee evidence', 'latency and transaction-success calibration', 'all prescribed stress scenarios'],
    books: experiment.books.map(b => {
      const m = outcomeMetrics(b.history), basis = sum(b.positions.map(p => p.remainingSol)), dd = markedDrawdown(b.series);
      return { id: b.id, candidateId: b.candidateId, startSol: b.startSol, cashSol: b.cashSol, netSol: !blind&&b.receipts.length ? m.netSol : null,
        outcomeCount: m.outcomeCount, winRate: blind?null:m.winRate, withoutBestSol: blind?null:m.withoutBestSol, drawdownPct: blind?null:dd.pct, drawdownSol: blind?null:dd.sol,
        currentExposureSol: basis, maxExposureSol: b.maxExposureSol, maxExposurePct: b.maxExposureSol / b.startSol * 100,
        allocatedReturnPct: blind?null:m.meanReturnOnAllocatedPct, openPositions: b.positions.length, pendingOrders: b.pending.length,
        missing: b.missing, rejections: b.rejections, lastDecision: b.lastDecision || null, validationState: blind?'UNTOUCHED_HOLDOUT_BLINDED':b.receipts.length ? 'PROVISIONAL_QUOTES_ONLY' : 'MISSING_EXECUTABLE_FILLS' };
    }) };
}
