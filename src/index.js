import { exec } from 'node:child_process';
import { cfg } from './config.js';
import { discoverCandidates, refreshPair, refreshPositionPairs, discoveryHealth, solUsdPrice, batchTokenPrices } from './dexscreener.js';
import { analyze, explain, marketRegime } from './strategy.js';
import { mintRisk, benchmarkRpcs } from './rpc.js';
import { loadState, saveState, appendJournal, appendJournalBatch, drainActions, resetPaper } from './store.js';
import { buyWithSol, sellTokenForSol, walletSolBalance } from './jupiter.js';
import { startDashboard } from './dashboard.js';
import { alert } from './alerts.js';
import { pushTick, microFeatures, explosionScore, moonScore, buildCandles, narrative, walletSignals } from './intelligence.js';
import { socialSignals } from './providers.js';
import { startProgramStream } from './stream.js';
import { aggressionParams, exitPresets, operatingProfiles } from './runtime.js';
import { recordUniverse, postmortemTrade } from './research.js';
import { supervisorTick } from './supervisor.js';
import { proposeTrade, proposeExit, resolveProposal, expireProposals } from './proposals.js';
import { memeIndex } from './indexer.js';
import { mapLimit, sleep, compactError } from './utils.js';
import { fastEdgeScore, queueOutcomeSamples, settleOutcomeSamples, dueOutcomeMints, learnerSnapshot, evolutionChampionPolicy, evolutionChampionScore } from './learner.js';
import { recordChampionPublication } from './researchControlPlane.js';
import { syncLabLink, publishLabFeed } from './labLink.js';
import { estimatePaperExecution, deterministicFillAllowed, estimateRoundTripFrictionPct } from './executionSim.js';
import { enqueueAlphaEvent } from './alphaQueue.js';
import { dailyPnl, recentPnl, bookClosedPnl, unrealizedPnl, equity, updatePortfolio } from './accounting.js';
import { startAlphaWorker, stopAlphaWorker } from './alphaWorkerManager.js';
import { exitSimulation, paperExitQuote, reviewPositionPrice, entrySizing, paperEntryRejection } from './positionExecution.js';
import { apiUnitEconomicsSnapshot, persistApiUnitEconomics, attributeScanCycle, strategyNetPnlAfterDataCost } from './apiUnitEconomics.js';

const once = process.argv.includes('--once');
const dashboardOnly = process.argv.includes('--dashboard-only');
const pct = x => `${x >= 0 ? '+' : ''}${Number(x || 0).toFixed(1)}%`;

function openBrowser() {
  if (!cfg.openDashboard) return;
  const url = `http://127.0.0.1:${cfg.dashboardPort}`;
  setTimeout(() => exec(
    process.platform === 'darwin' ? `open '${url}'` : process.platform === 'win32' ? `start ${url}` : `xdg-open '${url}'`,
    () => {},
  ), 700);
}

const exposure = s => (s.positions || []).reduce((q, p) => q + (p.remainingSol ?? p.sizeSol ?? 0), 0);

function consecutiveLosses(s) {
  let n = 0;
  for (const x of [...(s.history || [])].reverse()) {
    if ((x.pnlSol || 0) < 0) n++;
    else break;
  }
  return n;
}

const cooldownActive = (s, mint) => (s.cooldowns[mint] || 0) > Date.now();

function stat(s, name) {
  return s.strategies[name] || (s.strategies[name] = {
    signals: 0, trades: 0, wins: 0, losses: 0, pnlSol: 0, avgReturnPct: 0, shadowScore: 0,
  });
}

function recordClosed(s, trade) {
  bookClosedPnl(s, trade);
  const x = stat(s, 'UNIFIED_EDGE');
  x.trades++;
  (trade.pnlSol || 0) >= 0 ? x.wins++ : x.losses++;
  x.pnlSol += trade.pnlSol || 0;
  x.avgReturnPct = ((x.avgReturnPct * (x.trades - 1)) + (trade.returnPct || 0)) / x.trades;
}

function preset(s) {
  return exitPresets[s.runtime.exitPreset] || {
    tp1: cfg.takeProfit1Pct, tp2: cfg.takeProfit2Pct, stop: cfg.stopLossPct,
    trail: cfg.trailingStopPct, maxHold: cfg.maxHoldMin,
  };
}

function paperSell(s, p, fraction, price, reason, final = false, market = null) {
  fraction = Math.min(1, Math.max(0, fraction));
  const rem = Number(p.remainingSol ?? p.sizeSol ?? 0);
  const basis = rem * fraction;
  if (!(basis > 0) || !(price > 0)) return false;
  const sim = exitSimulation(p,{...market,priceUsd:price},Number(s.market?.solUsd||0),cfg.simulatedSlippageBps,cfg.simulatedFeeBps,fraction);
  if (!deterministicFillAllowed(p.mint, Date.now() + String(reason).length * 997, Math.min(65, sim.failurePct * 0.75))) {
    appendJournal({ type:'paper-exit-missed', mint:p.mint, symbol:p.symbol, reason, failurePct:sim.failurePct, slippageBps:sim.slippageBps });
    return false;
  }
  const {exitPrice:exit,fee,proceeds}=paperExitQuote(p,price,sim,fraction);
  s.cashSol += proceeds;
  p.remainingSol = Math.max(0, rem - basis);
  p.realizedSol = (p.realizedSol || 0) + (proceeds - basis);
  p.feesSol = (p.feesSol || 0) + fee;
  p.exitSlippageBps = sim.slippageBps;

  if (final || p.remainingSol < 1e-8) {
    s.positions = s.positions.filter(x => x.id !== p.id);
    const cooldownMin = cfg.mode === 'paper' && s.runtime?.profile === 'SPRINT' ? 2 : cfg.cooldownMin;
    s.cooldowns[p.mint] = Date.now() + cooldownMin * 60_000;
    const rr = p.realizedSol / (p.sizeSol || 1) * 100;
    const trade = { ...p, closedAt: Date.now(), exitPrice: exit, returnPct: rr, pnlSol: p.realizedSol, reason, exitSlippageBps: sim.slippageBps };
    s.history.push(trade);
    recordClosed(s, trade);
    postmortemTrade(s, trade);
    appendJournal({ type: 'trade-close', trade });
    alert(`EXIT ${p.symbol} ${pct(rr)} · ${reason}`).catch(() => {});
  }
  return true;
}

async function liveSell(s, p, fraction, reason) {
  const raw = BigInt(p.remainingRaw || 0);
  const amount = raw * BigInt(Math.round(fraction * 10_000)) / 10_000n;
  if (amount <= 0n) return false;
  const result = await sellTokenForSol(p.mint, amount.toString());
  p.remainingRaw = (raw - amount).toString();
  const remSol = Number(p.remainingSol ?? p.sizeSol ?? 0);
  const soldBasis = remSol * Math.min(1,Math.max(0,Number(fraction||0)));
  p.remainingSol = Math.max(0, remSol - soldBasis);
  if (Number.isFinite(Number(result.receivedSol))) p.realizedSol = Number(p.realizedSol||0) + Number(result.receivedSol) - soldBasis;
  appendJournal({ type: 'live-sell', mint: p.mint, symbol: p.symbol, fraction, reason, receivedSol:result.receivedSol??null, signature: result.signature || null, via: result.via || 'jupiter' });
  if (BigInt(p.remainingRaw) <= 0n || fraction >= 0.999) {
    s.positions = s.positions.filter(x => x.id !== p.id);
    s.cooldowns[p.mint] = Date.now() + cfg.cooldownMin * 60_000;
    const closedAt=Date.now();
    const pnlSol=Number(p.realizedSol||0);
    const trade={...p,closedAt,reason,signature:result.signature||null,pnlSol,returnPct:Number(p.sizeSol||0)>0?pnlSol/Number(p.sizeSol)*100:0};
    s.history.push(trade);
    recordClosed(s,trade);
    appendJournal({type:'trade-close',mode:'live',trade});
    await alert(`LIVE EXIT ${p.symbol} · ${reason}`);
  }
  return true;
}

async function enter(s, pick, manual = false) {
  if (!pick || s.runtime.blacklist.includes(pick.mint) || s.positions.some(p => p.mint === pick.mint)) return;
  if(!(Number(pick.priceUsd)>0)||!Number.isFinite(Number(pick.priceUsd))||Date.now()-Number(pick.priceObservedAt||0)>30000){
    s.stats.skipped++;return;
  }
  const ap = aggressionParams(s.runtime.aggression);
  const isPaper = cfg.mode === 'paper';
  const sprintPaper = isPaper && s.runtime.profile === 'SPRINT';
  // F8 (ACCOUNTING-AUDIT §4 RC-C): identical arithmetic to before, except that PAPER sizing is now
  // levered off min(marked equity, cash + cost basis). Live keeps cfg.maxPositionSol /
  // cfg.maxTotalExposureSol exactly as before. See src/positionExecution.js.
  const { size } = entrySizing({
    state: s, config: cfg, sizeFactor: ap.sizeFactor, aggression: s.runtime.aggression,
    stopPct: preset(s).stop, paper: isPaper, sprint: sprintPaper,
  });
  if (size < 0.005) return;

  // History review: weak-liquidity / high-friction SPRINT fills produced the largest avoidable losses.
  // Keep this paper-only so live execution policy is unchanged.
  let sprintPreview = null;
  if (sprintPaper) {
    const liq = Number(pick.liq || pick.liquidity?.usd || 0);
    const execution = Number(pick.executionScore || 0);
    if (liq < 15_000 || execution < 40) {
      s.stats.skipped++;
      appendJournal({type:'sprint-entry-reject',mint:pick.mint,symbol:pick.symbol,reason:liq<15_000?'liquidity':'execution',liquidityUsd:liq,executionScore:execution});
      return;
    }
    sprintPreview = estimatePaperExecution(pick, size, Number(s.market?.solUsd || 0), cfg.simulatedSlippageBps, cfg.simulatedFeeBps);
    if (Number(sprintPreview.slippageBps || 0) > 250 || Number(sprintPreview.failurePct || 0) > 40) {
      s.stats.skipped++;
      appendJournal({type:'sprint-entry-reject',mint:pick.mint,symbol:pick.symbol,reason:'friction',slippageBps:sprintPreview.slippageBps,failurePct:sprintPreview.failurePct});
      return;
    }
  }

  const strategy = 'UNIFIED_EDGE';
  enqueueAlphaEvent({type:'latency-stage',mint:pick.mint,kind:'PROPOSAL',ts:Date.now()});
  stat(s, strategy).signals++;
  if (manual) s.stats.manualEntries++;

  if (cfg.mode === 'paper') {
    // F7 (ACCOUNTING-AUDIT §4 RC-B): bind the position to a pool at entry. Without it
    // reviewPositionPrice accepts a price from any pool of the mint and index.js back-fills
    // pairAddress from the first accepted tick, which can latch onto the wrong pool for good.
    const entryReject = paperEntryRejection(pick);
    if (entryReject) {
      s.stats.skipped++;
      appendJournal({ type: 'paper-entry-reject', mint: pick.mint, symbol: pick.symbol, reason: entryReject });
      return;
    }
    const sim = sprintPreview || estimatePaperExecution(pick, size, Number(s.market?.solUsd || 0), cfg.simulatedSlippageBps, cfg.simulatedFeeBps);
    const entryFee = size * sim.feeBps / 10_000;
    if (s.cashSol < size + entryFee) return;
    if (!deterministicFillAllowed(pick.mint, Date.now(), sim.failurePct)) {
      s.stats.skipped++;
      appendJournal({ type:'paper-fill-failed', mint:pick.mint, symbol:pick.symbol, sizeSol:size, simulatedFailurePct:sim.failurePct, slippageBps:sim.slippageBps });
      return;
    }
    s.cashSol -= size + entryFee;
    const ep = pick.priceUsd * (1 + sim.slippageBps / 10_000);
    s.positions.push({
      id: `${Date.now()}-${pick.mint.slice(0, 6)}`, mint: pick.mint, symbol: pick.symbol, name: pick.name,
      sizeSol: size, remainingSol: size, entryPrice: ep, lastPrice: pick.priceUsd, highPrice: pick.priceUsd, pairAddress: pick.pairAddress || null,
      openedAt: Date.now(), score: pick.score, fastEdgeScore:pick.fastEdgeScore||pick.edgeScore||pick.score, riskScore: pick.risk?.score, executionScore:pick.executionScore, strategy, reasons: explain(pick),
      tp1Done: false, tp2Done: false, breakEvenArmed: false, realizedSol: -entryFee, feesSol: entryFee, manual,
      maxFavorablePct: 0, maxAdversePct: 0, entrySlippageBps:sim.slippageBps, simulatedLatencyMs:sim.latencyMs,
      lastLiquidityUsd:pick.liq, lastMicro:pick.micro, lastPriceAccel:pick.priceAccel,
    });
    s.stats.signals++;
    appendJournal({ type: 'trade-open', mode: 'paper', mint: pick.mint, symbol: pick.symbol, sizeSol: size, score: pick.score, fastEdgeScore:pick.fastEdgeScore||pick.score, strategy, manual, slippageBps:sim.slippageBps, simulatedFailurePct:sim.failurePct });
    return;
  }

  if (cfg.mode === 'live') {
    if (!manual) {
      proposeTrade(s, pick, size);
      appendJournal({ type: 'live-proposal', mint: pick.mint, symbol: pick.symbol, sizeSol: size, score: pick.score, strategy });
      return;
    }
    if (!cfg.enableLiveTrading) throw new Error('Live gate disabled');
    const bal = await walletSolBalance();
    if (bal < size + cfg.minSolReserve) throw new Error('Wallet balance below reserve');
    const r = await buyWithSol(pick.mint, size);
    if (!r.acquiredRaw || BigInt(r.acquiredRaw) <= 0n) throw new Error('Acquired token balance could not be verified');
    s.positions.push({
      id: `${Date.now()}-${pick.mint.slice(0, 6)}`, mint: pick.mint, symbol: pick.symbol, name: pick.name,
      sizeSol: size, entryPrice: pick.priceUsd, lastPrice: pick.priceUsd, highPrice: pick.priceUsd, openedAt: Date.now(), pairAddress: pick.pairAddress || null,
      score: pick.score, fastEdgeScore:pick.fastEdgeScore||pick.score, executionScore:pick.executionScore, strategy, reasons: explain(pick), remainingRaw: r.acquiredRaw, remainingSol:size, realizedSol:0,
      tp1Done: false, tp2Done: false, signature: r.signature || null, manual,
    });
    appendJournal({ type: 'live-buy', mint: pick.mint, sizeSol: size, signature: r.signature || null, via: r.via || 'jupiter', manual });
  }
}

async function actions(s) {
  const xs = [...(s.pendingActions || []), ...drainActions()];
  s.pendingActions = [];
  for (const a of xs) {
    if (a.type === 'reset-paper') {
      const amount = Number(a.amountSol);
      const keep = {
        runtime: s.runtime,
        research: s.research,
        watchlist: s.watchlist,
        snapshots: s.snapshots,
        tickHistory: s.tickHistory,
        candles: s.candles,
        market: s.market,
        memeIndex: s.memeIndex,
        rpcHealth: s.rpcHealth,
        evolution: s.evolution,
        evolutionLoop: s.evolutionLoop,
        system: { ...s.system },
      };
      const next = resetPaper(Number.isFinite(amount) && amount > 0 ? amount : (s.paperStartSol || cfg.paperStartSol), false);
      Object.assign(next, keep);
      next.paperStartSol = Number.isFinite(amount) && amount > 0 ? amount : next.paperStartSol;
      next.cashSol = next.paperStartSol;
      next.positions = [];
      next.history = [];
      next.cooldowns = {};
      next.stats = { ...next.stats, cycles: s.stats?.cycles || 0 };
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, next);
      appendJournal({ type: 'paper-reset', amountSol: s.cashSol });
    }
    else if (a.type === 'toggle-pause') s.system.paused = !s.system.paused;
    else if (a.type === 'toggle-kill') {
      s.system.killSwitch = !s.system.killSwitch;
      if (s.system.killSwitch) s.system.paused = true;
    } else if (a.type === 'exit') {
      const p = s.positions.find(x => x.mint === a.mint);
      if (p) {
        const pair = await refreshPair(p.mint, p.pairAddress || null).catch(() => null);
        const price = Number(pair?.priceUsd || p.lastPrice || p.entryPrice);
        cfg.mode === 'paper' ? paperSell(s, p, 1, price, 'manual-exit', true, pair) : await liveSell(s, p, 1, 'manual-exit');
      }
    } else if (a.type === 'enter') {
      const pick = s.watchlist.find(x => x.mint === a.mint);
      if (pick) await enter(s, pick, true);
    } else if (a.type === 'runtime') {
      const raw = { ...(a.patch || {}) };
      const patch = {};
      if (raw.aggression != null) patch.aggression = Math.max(0, Math.min(100, Number(raw.aggression) || 0));
      if (raw.maxCandidates != null) patch.maxCandidates = Math.max(30, Math.min(600, Math.round(Number(raw.maxCandidates) || cfg.maxCandidates)));
      if (raw.entryFrequency != null && ['normal','high','max'].includes(String(raw.entryFrequency))) patch.entryFrequency = String(raw.entryFrequency);
      if (raw.exitPreset != null && ['ultraScalp','sprint','scalper','runner','moonbag','yolo','custom'].includes(String(raw.exitPreset))) patch.exitPreset = String(raw.exitPreset);
      if (raw.visualIntensity != null) patch.visualIntensity = Math.max(0, Math.min(100, Number(raw.visualIntensity) || 0));
      Object.assign(s.runtime, patch);
    } else if (a.type === 'evolution-sync') {
      if (a.evolutionLoop && typeof a.evolutionLoop === 'object') s.evolutionLoop = a.evolutionLoop;
      if (a.evolution && typeof a.evolution === 'object') s.evolution = a.evolution;
    } else if (a.type === 'profile') {
      const pr = operatingProfiles[a.profile];
      if (pr) { s.runtime.profile = a.profile; Object.assign(s.runtime, pr); }
    } else if (a.type === 'autonomy') {
      s.research.autonomyLevel = Math.max(0, Math.min(5, Number(a.level) || 0));
      s.runtime.autonomyLevel = s.research.autonomyLevel;
    } else if (a.type === 'approve-proposal') {
      const prop = resolveProposal(s, a.proposalId || a.id, 'APPROVED');
      if (prop?.status === 'APPROVED' && prop.kind === 'EXIT') {
        const p = s.positions.find(x => x.id === prop.positionId || x.mint === prop.mint);
        if (p) {
          const sold = await liveSell(s, p, prop.fraction || 1, prop.reason || 'approved-exit');
          if (sold && prop.reason === 'take-profit-1') p.tp1Done = true;
          if (sold && prop.reason === 'take-profit-2') p.tp2Done = true;
        }
      } else if (prop?.status === 'APPROVED') {
        const pick = s.watchlist.find(x => x.mint === prop.mint);
        if (pick) await enter(s, pick, true);
      }
    } else if (a.type === 'reject-proposal') resolveProposal(s, a.proposalId || a.id, 'REJECTED');
    else if (a.type === 'favorite') {
      const k = a.kind === 'blacklist' ? 'blacklist' : a.kind === 'pin' ? 'pinned' : 'favorites';
      const set = new Set(s.runtime[k]);
      set.has(a.mint) ? set.delete(a.mint) : set.add(a.mint);
      s.runtime[k] = [...set];
    } else if (a.type === 'clear-error') s.system.lastError = null;
    s.system.lastAction = { id: a.id || null, type: a.type, appliedAt: Date.now() };
  }
  expireProposals(s);
}

async function updatePositions(s) {
  const basePr=preset(s),evolutionExit=cfg.mode==='paper'?evolutionChampionPolicy(s):null;
  const pr=evolutionExit?{...basePr,tp1:evolutionExit.takePct,tp2:evolutionExit.takePct,stop:evolutionExit.stopPct,maxHold:evolutionExit.maxHoldMin}:basePr;
  const positions = [...s.positions];
  const refreshed = await refreshPositionPairs(positions);
  for (const row of refreshed) {
    if (!row || row.__error || !row.p) continue;
    const { p, pair } = row;
    if (!pair) {p.priceStatus='UNAVAILABLE';continue;}
    const price = Number(pair.priceUsd || 0);
    if (!price || !p.entryPrice) continue;
    // Quarantine discontinuities; corroborated exact-pool paper crashes can be
    // recognized after repeated refreshes instead of trapping capital forever.
    const anchor = Number(p.lastPrice || p.entryPrice || 0);
    const tickRatio = anchor > 0 ? price / anchor : 1;
    const review=reviewPositionPrice(p,pair,{paper:cfg.mode==='paper',ticks:s.tickHistory?.[p.mint]});
    if (!review.accepted) {
      p.priceStatus=review.reason;
      p.priceIntegrityRejects = Number(p.priceIntegrityRejects || 0) + 1;
      if(Date.now()-Number(p.lastPriceIntegrityRejectAt||0)>=30000){
        p.lastPriceIntegrityRejectAt = Date.now();
        appendJournal({ type:'price-integrity-reject', mint:p.mint, symbol:p.symbol, pairAddress:pair?.pairAddress || null, expectedPairAddress:p.pairAddress || null, anchorPrice:anchor, rejectedPrice:price, ratio:tickRatio });
      }
      continue;
    }
    p.priceStatus='FRESH';p.priceObservedAt=review.at;
    if(review.corrected)appendJournal({type:'paper-price-correction',mint:p.mint,symbol:p.symbol,oldPrice:anchor,price,evidence:review.evidence});
    if (!p.pairAddress && pair?.pairAddress) p.pairAddress = pair.pairAddress;
    p.lastPrice = price;
    p.lastLiquidityUsd = Number(pair.liquidity?.usd || p.lastLiquidityUsd || 0);
    const currentPc5 = Number(pair.priceChange?.m5 || 0);
    p.lastPriceAccel = currentPc5 - Number(p.lastPc5 ?? currentPc5);
    p.lastPc5 = currentPc5;
    p.lastMicro = { ...(p.lastMicro||{}), p10: Math.max(0, p.lastPriceAccel * .25) };
    p.highPrice = Math.max(p.highPrice || p.entryPrice, price);
    const ret = (price / p.entryPrice - 1) * 100;
    const draw = (price / p.highPrice - 1) * 100;
    const held = (Date.now() - p.openedAt) / 60_000;
    const netQuote=cfg.mode==='paper'?paperExitQuote(p,price,exitSimulation(p,pair,Number(s.market?.solUsd||0),cfg.simulatedSlippageBps,cfg.simulatedFeeBps)):null;
    p.exitNetReturnPct=netQuote?.netReturnPct??null;
    p.maxFavorablePct = Math.max(Number(p.maxFavorablePct || 0), ret);
    p.maxAdversePct = Math.min(Number(p.maxAdversePct || 0), ret);
    const profitReturn=netQuote?netQuote.netReturnPct:ret;
    if (profitReturn >= Math.min(cfg.breakEvenTriggerPct, pr.tp1 * 0.8)) p.breakEvenArmed = true;

    let action = null;
    let fraction = 1;
    let tpFlag = null;
    if (!p.tp1Done && ret >= pr.tp1) { action = 'take-profit-1'; fraction = cfg.mode === 'paper' && s.runtime?.profile === 'SPRINT' ? 1 : Math.max(.01,Math.min(1,cfg.takeProfit1SellPct/100)); tpFlag = 'tp1Done'; }
    else if (!p.tp2Done && ret >= pr.tp2) { action = 'take-profit-2'; fraction = cfg.mode === 'paper' && s.runtime?.profile === 'SPRINT' ? 1 : Math.max(.01,Math.min(1,cfg.takeProfit2SellPct/100)); tpFlag = 'tp2Done'; }
    else if (ret <= -pr.stop) action = 'stop-loss';
    else if (p.breakEvenArmed && profitReturn <= 0) action = 'break-even';
    else if (draw <= -pr.trail && ret > 0) action = 'trailing';
    else if (held >= pr.maxHold) action = 'stale-purge';

    if (action) {
      const final = !action.startsWith('take-profit');
      if (cfg.mode === 'paper') {
        const filled = paperSell(s, p, fraction, price, action, final, pair);
        if (filled && tpFlag) p[tpFlag] = true;
      } else {
        proposeExit(s, p, fraction, action, price);
        appendJournal({type:'live-exit-proposal',mint:p.mint,symbol:p.symbol,fraction,reason:action,price});
      }
    }
  }
}

function blockStatus(s) {
  const ap = aggressionParams(s.runtime.aggression);
  const start = Math.max(.001, Number(s.paperStartSol || cfg.paperStartSol));
  const dailyLimit = cfg.mode === 'paper' ? Math.max(cfg.dailyLossLimitSol, start * .05) : cfg.dailyLossLimitSol;
  const hourlyLimit = cfg.mode === 'paper' ? Math.max(cfg.hourlyLossLimitSol, start * .025) : cfg.hourlyLossLimitSol;
  const sprintPaper = cfg.mode === 'paper' && s.runtime.profile === 'SPRINT';
  const openLimit = cfg.mode === 'paper' ? (sprintPaper ? Math.max(16,ap.maxOpenPositions) : ap.maxOpenPositions) : Math.min(ap.maxOpenPositions, cfg.maxOpenPositions);
  const currentOpenPnl = unrealizedPnl(s);
  const reasons=[];
  if (s.system.paused) reasons.push('paused');
  if (s.system.killSwitch) reasons.push('kill-switch');
  if (s.positions.length >= openLimit) reasons.push('position-limit');
  // Sprint research is intentionally allowed to experience large drawdowns. The loss rails
  // remain strict in live mode, where they cannot be bypassed by this research loop.
  if (cfg.mode !== 'paper') {
    if (dailyPnl(s) + currentOpenPnl <= -dailyLimit) reasons.push('daily-loss-limit');
    if (recentPnl(s, 3_600_000) + currentOpenPnl <= -hourlyLimit) reasons.push('hourly-loss-limit');
    if (consecutiveLosses(s) >= cfg.maxConsecutiveLosses) reasons.push('consecutive-loss-limit');
  }
  return {blocked:reasons.length>0,reasons,openLimit,dailyLimit,hourlyLimit};
}
function blocked(s) { return blockStatus(s).blocked; }

let latestRpcHealth = null;
let rpcBenchInFlight = false;
let lastRpcBenchAt = 0;
function refreshRpcHealthAsync() {
  const now = Date.now();
  if (rpcBenchInFlight || now - lastRpcBenchAt < 120_000) return;
  rpcBenchInFlight = true; lastRpcBenchAt = now;
  benchmarkRpcs().then(rows => { latestRpcHealth = rows; }).catch(() => {}).finally(() => { rpcBenchInFlight = false; });
}

async function cycle() {
  const cycleStart = performance.now();
  const s = loadState();
  s.system.lastError = null;
  s.stats.cycles++;
  await actions(s);
  // The Evolution Lab is a separate app now: pull its latest status/champion over the lab link
  // (local files, or the signed bridge for a lab on another machine). Gates are re-checked below.
  try { syncLabLink(s); } catch (e) { s.labLink = { connected: false, source: 'error', error: compactError(e) }; }
  const hotPolicy=cfg.mode==='paper'?evolutionChampionPolicy(s):null;
  if(hotPolicy){
    if(s.runtime.activeEvolutionChampionId!==hotPolicy.id){
      appendJournal({type:'strategy-upgrade',mode:'paper',from:s.runtime.activeEvolutionChampionId||'BASE',to:hotPolicy.id,stage:'PAPER_CANARY',threshold:hotPolicy.threshold,stopPct:hotPolicy.stopPct,takePct:hotPolicy.takePct,maxHoldMin:hotPolicy.maxHoldMin});
      try{recordChampionPublication({dataDir:process.env.MONEY_PRINTER_DATA_DIR||'data',from:s.runtime.activeEvolutionChampionId||'BASE',to:hotPolicy.id,stage:'PAPER_CANARY'});}catch{}
    }
    s.runtime.activeEvolutionChampionId=hotPolicy.id;s.system.activeEvolutionPolicy={...hotPolicy,stage:'PAPER_CANARY',hotReload:true,applied:true,liveActivationAllowed:false,automaticLivePromotionAllowed:false,liveExecution:'manual'};
  }else if(cfg.mode==='paper'){s.runtime.activeEvolutionChampionId='BASE';s.system.activeEvolutionPolicy={id:'BASE',stage:'BASE',hotReload:true,applied:false,liveActivationAllowed:false,automaticLivePromotionAllowed:false,liveExecution:'manual'};}
  else {const existing=s.system.activeEvolutionPolicy||{};s.system.activeEvolutionPolicy={...existing,hotReload:false,applied:false,liveActivationAllowed:false,automaticLivePromotionAllowed:false,liveExecution:'manual'};}
  if (['paper', 'live'].includes(cfg.mode)) await updatePositions(s);

  if (s.stats.cycles === 1 || Date.now() - lastRpcBenchAt >= 120_000) refreshRpcHealthAsync();
  const solPricePromise = solUsdPrice().catch(() => Number(s.market?.solUsd || 0));

  const max = Math.max(30, Math.min(600, Number(s.runtime.maxCandidates) || cfg.maxCandidates));
  const discoveryStart = performance.now();
  const pairs = await discoverCandidates(max);
  s.system.metrics.discoveryMs = Math.round(performance.now() - discoveryStart);
  s.system.discoveryHealth = discoveryHealth();
  s.system.unitEconomics={externalApi:apiUnitEconomicsSnapshot(),caps:{marketRequestsPerMinute:cfg.marketRequestsPerMinute,heliusRequestsPerMinute:cfg.heliusRequestsPerMinute,dailySpendCapUsd:cfg.apiDailySpendCapUsd}};
  try{persistApiUnitEconomics('trader')}catch{}
  s.research.feedStats ||= {};
  for (const [name, h] of Object.entries(s.system.discoveryHealth || {})) {
    const f = s.research.feedStats[name] || (s.research.feedStats[name] = { seen:0,lastSeen:0,errors:0,latencyMs:0 });
    if (h.ok) { f.lastSeen = h.ts || Date.now(); f.latencyMs = Number(h.latencyMs || f.latencyMs || 0); f.lastCount = Number(h.count || 0); }
    else { f.errors = Number(f.errors || 0) + 1; f.lastError = h.error || 'feed error'; f.lastErrorAt = h.ts || Date.now(); }
  }

  const riskStart = performance.now();
  const riskMap = new Map();
  const prelim = pairs
    .map(p => analyze(p, null, s.snapshots[p.baseToken?.address], s.runtime, {}))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(cfg.mode === 'live' ? 8 : 6, pairs.length));
  // SPRINT paper research must not wait seconds for holder RPC enrichment before every entry.
  // Live mode and non-SPRINT profiles keep the existing synchronous verification path.
  const sprintResearch = cfg.mode === 'paper' && s.runtime.profile === 'SPRINT';
  const riskRows = sprintResearch ? [] : await mapLimit(prelim, cfg.mode === 'live' ? 1 : 2, async a => a.mint ? { mint: a.mint, risk: await mintRisk(a.mint) } : null);
  for (const row of riskRows) if (row && !row.__error && row.mint && row.risk) riskMap.set(row.mint, row.risk);
  s.system.metrics.riskMs = Math.round(performance.now() - riskStart);

  const analysisStart = performance.now();
  const ranked = [];
  const alphaCandidateRows = [];
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    if (!mint) continue;
    const history = s.tickHistory[mint] || [];
    const micro = microFeatures(history);
    const a = analyze(p, riskMap.get(mint) || null, s.snapshots[mint], s.runtime, micro);
    a.priceObservedAt=Number(p.priceObservedAt||0);
    const xs = pushTick(s, a);
    a.micro = microFeatures(xs);
    a.explosionScore = explosionScore(a, a.micro);
    a.moonScore = moonScore(a, a.micro);
    a.deterministicEdgeScore = a.edgeScore;
    a.fastEdgeScore = fastEdgeScore(s, a);
    const evolutionScore=cfg.mode==='paper'?evolutionChampionScore(s,a):null;
    if(evolutionScore){a.fastEdgeScore=evolutionScore.score;a.evolutionChampion=evolutionScore.id;a.evolutionPolicyStage='PAPER_CANARY';}
    a.edgeScore = a.fastEdgeScore;
    a.score = a.fastEdgeScore;
    const ap = aggressionParams(s.runtime.aggression);
    const threshold = evolutionScore?evolutionScore.threshold:Math.min(95, Math.max(20, ap.minScore * .62 + ap.minStrategyScore * .38));
    a.entryThreshold = threshold;
    const checkedRisk = riskMap.get(mint) || null;
    // PAPER/REPLAY research must not mechanically reject every candidate that was not
    // selected for expensive holder enrichment. Live mode remains verification-gated.
    const riskVerifiedEnough = cfg.mode === 'paper' || (!!checkedRisk && !checkedRisk.holderDataUnavailable);
    a.eligible = riskVerifiedEnough && !(a.critical || []).length && a.fastEdgeScore >= threshold;
    a.riskVerification = checkedRisk ? (checkedRisk.holderDataUnavailable ? 'PARTIAL' : 'VERIFIED') : 'UNSAMPLED';
    if (checkedRisk?.holderDataUnavailable && !(a.warnings || []).includes('holder-data-unavailable')) a.warnings.push('holder-data-unavailable');
    a.stage = a.eligible ? 'READY' : a.fastEdgeScore >= 30 ? 'WATCH' : 'DISCOVERED';
    a.narratives = narrative(a.symbol, a.name);
    a.walletSignals = walletSignals(a.risk);
    a.candles = buildCandles(xs);
    a.regime = s.market?.regime;
    recordUniverse(s, a);
    const universe=s.research?.universe?.[a.mint]||{};
    const holderRows=a.risk?.largest||[];
    const firstQuality=holderRows.length ? holderRows.reduce((q,h)=>q+Number(s.research?.walletProfiles?.[h.owner||h.address]?.recurrenceScore||50),0)/holderRows.length : 50;
    const createdTs=Number(p.pairCreatedAt||0);const sourceEventTs=createdTs>0&&Math.abs(Date.now()-createdTs)<=15*60_000?createdTs:0;
    alphaCandidateRows.push({a,firstQuality,sourceEventTs,universe});
    if (s.runtime.favorites.includes(mint)) a.score = Math.min(100, a.score + 8);
    if (s.runtime.pinned.includes(mint)) a.pinned = true;
    ranked.push(a);
  }
  ranked.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.fastEdgeScore - a.fastEdgeScore || b.explosionScore - a.explosionScore || b.executionScore - a.executionScore);
  s.system.metrics.analysisMs = Math.round(performance.now() - analysisStart);
  s.market = { ...marketRegime(ranked), updatedAt: Date.now(), solUsd: Number(s.market?.solUsd || 0) };
  for (const row of alphaCandidateRows) {
    const { a, firstQuality, sourceEventTs, universe } = row; a.regime = s.market.regime;
    const ts=Date.now();
    enqueueAlphaEvent({type:'candidate',observation:{ts,mint:a.mint,symbol:a.symbol,regime:s.market.regime||'UNKNOWN',price:Number(a.priceUsd||0),liquidity:Number(a.liq||0),edge:Number(a.fastEdgeScore||a.score||0),explosion:Number(a.explosionScore||0),moon:Number(a.moonScore||0),execution:Number(a.executionScore||0),momentum5:Number(a.pc5||0),velocity:Number(a.micro?.velocity||0),flowAccel:Number(a.micro?.flowAccel||0),crowding:Math.max(0,Number(a.micro?.velocity||0)*7+Math.max(0,Number(a.micro?.flowAccel||0))*10),holderQuality:firstQuality,authority:a.risk?.mintAuthority||null,clusterId:a.risk?.mintAuthority||null,source:(a.discovery?.sources||[]).join(','),raw:{stage:a.stage,warnings:(a.warnings||[]).slice(0,5),top1:a.risk?.top1Pct,top10:a.risk?.top10Pct}},latency:Number(universe.observations||0)<=1?{ts,mint:a.mint,sourceEventTs:sourceEventTs||null,discoveredTs:Number(universe.firstSeen||ts),analyzedTs:ts,readyTs:a.stage==='READY'?ts:null,discoveryMs:sourceEventTs?Math.max(0,Number(universe.firstSeen||ts)-sourceEventTs):null,analysisMs:Math.max(0,ts-Number(universe.firstSeen||ts)),readyMs:a.stage==='READY'?Math.max(0,ts-Number(universe.firstSeen||ts)):null}:null});
    if(a.stage==='READY') enqueueAlphaEvent({type:'latency-stage',mint:a.mint,kind:'READY',ts});
  }
  const dueMints = dueOutcomeMints(s, ranked, 90);
  const followupPrices = dueMints.length ? await batchTokenPrices(dueMints) : new Map();
  const outcomeCutoff=Date.now()-2500;
  const settledOutcomes = settleOutcomeSamples(s, ranked, followupPrices);
  const scanAttribution = attributeScanCycle({
    candidates: ranked.length,
    ready: ranked.filter(x => x.stage === 'READY').length,
    watch: ranked.filter(x => x.stage === 'WATCH').length,
    outcomesSettled: settledOutcomes,
  });
  for(const o of (s.research?.learner?.outcomes||[]).filter(x=>Number(x.ts)>=outcomeCutoff)){
    const c=o.context||{}; const liq=Math.max(1,Number(c.liquidity||0)),execution=Math.max(0,Math.min(100,Number(c.execution||50)));
    const frictionPct=estimateRoundTripFrictionPct({liquidity:liq,executionScore:execution,rawReturnPct:Number(o.returnPct||0),feeBps:25});
    enqueueAlphaEvent({type:'outcome',outcome:{mint:o.mint,horizonMin:o.horizonMin,entryTs:o.entryTs,rawReturn:Number(o.returnPct||0),adjustedReturn:Number(o.returnPct||0)-frictionPct,regime:c.regime||'UNKNOWN',edge:Number(o.predicted||0),execution,liquidity:liq,clusterId:c.clusterId||null}});
  }
  queueOutcomeSamples(s, ranked);
  s.system.learner = learnerSnapshot(s);
  s.system.learner.settledThisCycle = settledOutcomes;
  // Feed the lab: labeled outcomes + a status line, throttled, only when something changed.
  try { publishLabFeed(s, { mode: cfg.mode, version: process.env.MONEY_PRINTER_VERSION || null }); } catch {}

  s.memeIndex = memeIndex(ranked);
  s.watchlist = ranked.slice(0, Math.min(150, max));

  const edgeStat=stat(s,'UNIFIED_EDGE');
  const avgEdge=ranked.slice(0,40).reduce((q,a)=>q+Number(a.edgeScore||a.score||0),0)/Math.max(1,Math.min(40,ranked.length));
  edgeStat.shadowScore=edgeStat.shadowScore*.92+avgEdge*.08;

  if (s.stats.cycles % 10 === 0) {
    const socialRows = await mapLimit(ranked.slice(0, 8).filter(a => a.score > 65), 3, async a => ({ mint: a.mint, social: await socialSignals(a) }));
    const socialMap = new Map(socialRows.filter(x => x && !x.__error).map(x => [x.mint, x.social]));
    for (const a of ranked) if (socialMap.has(a.mint)) a.social = socialMap.get(a.mint);
  }

  const now = Date.now();
  for (const a of ranked) s.snapshots[a.mint] = { liq: a.liq, priceUsd: a.priceUsd, v5: a.v5, flow5: a.flow5, pc5: a.pc5, score: a.score, ts: now };

  // Compact journal: preserve rich snapshots for the strongest movers plus a cycle summary, avoiding unbounded disk churn.
  const journalRows = ranked.slice(0, 30).map(a => ({
    type: 'scan-candidate',
    a: {
      mint: a.mint, symbol: a.symbol, priceUsd: a.priceUsd, score: a.score, fastEdgeScore:a.fastEdgeScore, deterministicEdgeScore:a.deterministicEdgeScore, stage: a.stage,
      explosionScore: a.explosionScore, moonScore: a.moonScore, rugScore: a.rugScore,
      executionScore: a.executionScore, pc5: a.pc5, liq: a.liq, v5: a.v5,
      dominantSignal: a.dominantSignal, eligible: a.eligible, warnings: a.warnings?.slice(0, 6), discovery: a.discovery,
    },
  }));
  journalRows.push({
    type: 'scan-summary', tracked: ranked.length, ready: ranked.filter(x => x.stage === 'READY').length,
    watch: ranked.filter(x => x.stage === 'WATCH').length, regime: s.market.regime, memeIndex: s.memeIndex,
  });
  appendJournalBatch(journalRows);

  if (cfg.mode === 'live' && cfg.privateKey) {
    s.cashSol = await walletSolBalance().catch(() => s.cashSol);
  }
  s.dailyPnlSol = dailyPnl(s);
  s.hourlyPnlSol = recentPnl(s, 3_600_000);
  s.consecutiveLosses = consecutiveLosses(s);
  if (latestRpcHealth) s.rpcHealth = latestRpcHealth;
  s.market.solUsd = Number(await solPricePromise) || Number(s.market.solUsd || 0);
  updatePortfolio(s);
  const econSnap=apiUnitEconomicsSnapshot();
  const dataCostUsd=econSnap.totals.pricedRequests?econSnap.totals.configuredCostUsd:null; // total priced data cost, not scan-purpose-only attribution
  const strategyNet=strategyNetPnlAfterDataCost({grossPnlSol:Number(stat(s,'UNIFIED_EDGE').pnlSol||0),dataCostUsd,solUsd:s.market.solUsd});
  const edgeStatNet=stat(s,'UNIFIED_EDGE');
  edgeStatNet.dataCostUsd=strategyNet.dataCostUsd;
  edgeStatNet.netPnlSol=strategyNet.netPnlSol;
  s.system.unitEconomics={
    externalApi:econSnap,
    caps:{marketRequestsPerMinute:cfg.marketRequestsPerMinute,heliusRequestsPerMinute:cfg.heliusRequestsPerMinute,dailySpendCapUsd:cfg.apiDailySpendCapUsd},
    scanAttribution,
    strategyNetPnl:strategyNet,
    roiGuard:econSnap.roiGuard,
  };
  try{persistApiUnitEconomics('trader')}catch{}
  const lead=ranked[0];
  s.system.lastCycle = Date.now();
  supervisorTick(s, ranked);
  const missingPrices=s.positions.filter(p=>p.priceStatus&&p.priceStatus!=='FRESH');
  if(missingPrices.length){s.system.diagnostics.push({level:'WARN',code:'HELD_PRICE_UNVERIFIED',message:`${missingPrices.length} held positions await a verified price`});if(s.system.health==='HEALTHY')s.system.health='CAUTION';}
  const requestHealth=discoveryHealth().marketRequests;
  if(requestHealth&&!requestHealth.ok){s.system.diagnostics.push({level:'WARN',code:'MARKET_RATE_LIMIT',message:'Market provider rate-limited; retry backoff is active'});if(s.system.health==='HEALTHY')s.system.health='CAUTION';}

  const block = blockStatus(s);
  const rejectionReasons={score:0,invalidMarket:0,riskUnverified:0,execution:0,cooldown:0,alreadyOpen:0,blacklist:0};
  for (const x of ranked) {
    if ((x.critical||[]).length) rejectionReasons.invalidMarket++;
    else if (Number(x.fastEdgeScore||0) < Number(x.entryThreshold||0)) rejectionReasons.score++;
    else if (cfg.mode !== 'paper' && x.riskVerification !== 'VERIFIED') rejectionReasons.riskUnverified++;
    else if (Number(x.executionScore||0) < 15) rejectionReasons.execution++;
    else if (cooldownActive(s,x.mint)) rejectionReasons.cooldown++;
    else if (s.positions.some(p=>p.mint===x.mint)) rejectionReasons.alreadyOpen++;
    else if (s.runtime.blacklist.includes(x.mint)) rejectionReasons.blacklist++;
  }
  const picks = ranked.filter(x => x.eligible && Number(x.executionScore||0) >= 15 && !cooldownActive(s, x.mint) && !s.positions.some(p => p.mint === x.mint) && !s.runtime.blacklist.includes(x.mint));
  const sprintPaper=cfg.mode==='paper'&&s.runtime.profile==='SPRINT';
  const entryBurst=sprintPaper?5:(cfg.mode==='paper'&&s.runtime.entryFrequency==='max'?2:1);
  const signalsBefore=Number(s.stats.signals||0);let approved=0;
  // Rejected top candidates must not starve the fillable candidates below them.
  const attemptLimit=sprintPaper?Math.min(30,picks.length):entryBurst;
  if(!block.blocked){for(const pick of picks.slice(0,attemptLimit)){
    if(blockStatus(s).blocked||Number(s.stats.signals||0)-signalsBefore>=entryBurst)break;
    approved++;await enter(s,pick,false);
  }}
  updatePortfolio(s);
  const postBlock=blockStatus(s),eqNow=Math.max(.000001,equity(s));
  const funnel={ts:Date.now(),discovered:pairs.length,parsed:ranked.length,riskSampled:ranked.filter(x=>x.riskVerification!=='UNSAMPLED').length,
    scorePassed:ranked.filter(x=>Number(x.fastEdgeScore||0)>=Number(x.entryThreshold||0)).length,eligible:ranked.filter(x=>x.eligible).length,
    executionPassed:ranked.filter(x=>x.eligible&&Number(x.executionScore||0)>=15).length,approved,
    opened:Number(s.stats.signals||0)-signalsBefore,blocked:postBlock.blocked,blockReasons:postBlock.reasons,rejectionReasons,
    openPositions:s.positions.length,openLimit:postBlock.openLimit,capitalDeploymentPct:exposure(s)/eqNow*100,cashPct:Number(s.cashSol||0)/eqNow*100};
  s.system.opportunityFunnel=funnel;
  s.research.improvementLoop ||= {iteration:0,funnelHistory:[]};
  s.research.improvementLoop.iteration=Number(s.research.improvementLoop.iteration||0)+1;
  s.research.improvementLoop.funnelHistory=[funnel,...(s.research.improvementLoop.funnelHistory||[])].slice(0,240);

  s.system.metrics.cycleMs = Math.round(performance.now() - cycleStart);
  s.system.metrics.saveMs = saveState(s) || s.system.metrics.saveMs || 0;

  console.clear();
  console.log(`MONEY PRINTER ENGINE 12.6 // ${cfg.mode.toUpperCase()} // ${s.market.regime} ${s.market.score} // ${ranked.length} TRACKED // ${s.positions.length} HELD // ${s.system.metrics.cycleMs}ms`);
  for (const a of ranked.slice(0, 10)) {
    console.log(`${String(a.score).padStart(3)} X${String(a.explosionScore).padStart(3)} M${String(a.moonScore).padStart(3)} ${a.symbol.padEnd(11)} ${String(a.dominantSignal||'EDGE').padEnd(18)} ${pct(a.pc5).padStart(7)} ${a.stage}`);
  }
}

async function main() {
  // A one-shot scan must actually terminate; do not leave servers/workers alive.
  const dashboard = once ? null : startDashboard();
  if (!once && cfg.alphaWorkerEnabled) startAlphaWorker();
  if (!once) openBrowser();
  const stream = once ? null : startProgramStream(() => appendJournal({ type: 'program-stream-event' }));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { stream?.close?.(); } catch {}
    try { stopAlphaWorker(); } catch {}
    try { dashboard?.close?.(); } catch {}
  };
  process.once('SIGINT', () => { shutdown(); process.exit(0); });
  process.once('SIGTERM', () => { shutdown(); process.exit(0); });
  if (process.env.MONEY_PRINTER_SUPERVISED === '1') {
    // The desktop supervisor holds our stdin. If it dies for any reason the pipe closes and we exit
    // instead of living on as an orphan holding the port.
    process.stdin.on('end', () => { shutdown(); process.exit(0); });
    process.stdin.on('error', () => { shutdown(); process.exit(0); });
    process.stdin.resume();
  }
  if (dashboardOnly) return;

  do {
    const loopStarted = Date.now();
    try {
      await cycle();
    } catch (error) {
      const s = loadState();
      s.system.lastError = compactError(error);
      s.stats.errors++;
      saveState(s);
      appendJournal({ type: 'error', error: compactError(error) });
      console.error(compactError(error));
    }
    if (once) { shutdown(); break; }
    const current = loadState();
    const sprintPaperLoop = cfg.mode === 'paper' && current.runtime?.profile === 'SPRINT';
    const systemCpu = Number(current.system?.metrics?.cpuPct || 0);
    let sprintIntervalSec = Math.min(cfg.scanIntervalSec, 2);
    if (systemCpu >= 90) sprintIntervalSec = Math.max(sprintIntervalSec, 4);
    else if (systemCpu >= 75) sprintIntervalSec = Math.max(sprintIntervalSec, 3);
    const targetMs = Math.max(1, sprintPaperLoop ? sprintIntervalSec : cfg.scanIntervalSec) * 1000;
    const elapsed = Date.now() - loopStarted;
    await sleep(Math.max(250, targetMs - elapsed));
  } while (true);
}

main().catch(error => {
  console.error(compactError(error));
  process.exitCode = 1;
});
