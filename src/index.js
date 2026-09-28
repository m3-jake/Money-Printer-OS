import { writeCrowdBaselineFeed } from './crowdRuntime.js';
import { initializePumpCapture, persistPumpCapture, effectivePumpPolicy, pumpSizingDecision, recordPumpDecision, applyPumpSafety } from './pumpProfitRuntime.js';
import { paperCashReceipt } from './paperCashReceipts.js';
import { exec } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { assertLiveConfig } from './liveConfig.js';
import { discoverCandidates, refreshPair, refreshPositionPairs, discoveryHealth, discoveryFanout, setCycleSignal, solUsdPrice, batchTokenPrices } from './dexscreener.js';
import { analyze, explain, marketRegime } from './strategy.js';
import { mintRisk, benchmarkRpcs } from './rpc.js';
import { loadState, saveState, appendJournal, appendJournalBatch, drainActions, resetPaper } from './store.js';
import { recordCycleError, markCleanCycle, recordCycleBudgetAbort } from './cycleRecovery.js';
import { createCycleBudget, isCycleBudgetError } from './cycleBudget.js';
import { buyWithSol, sellTokenForSol, walletSolBalance } from './jupiter.js';
import { startDashboard } from './dashboard.js';
import { marketPlatform } from './core/platform.js';
import { alert } from './alerts.js';
import { pushTick, microFeatures, explosionScore, moonScore, buildCandles, narrative, walletSignals } from './intelligence.js';
import { socialSignals } from './providers.js';
import { startProgramStream } from './stream.js';
import { indexedFlowSnapshot } from './onchainFlow.js';
import { startTrackedWalletStream, smartWallets, copySignalForMint } from './walletTracker.js';
import { copyTradeSignals } from './copyTrade.js';
import { simulateAggressivePaperExecution } from './executionSimAggressive.js';
import { parsePumpfunLaunch, PUMPFUN_PROGRAM_ID } from './pumpfun.js';
import { pumpfunPaperLane } from './pumpfunPaper.js';
import { aggressionParams, exitPresets, operatingProfiles, customExitPolicy, sanitizeCustomExit, openLimitFor, MAX_OPEN_OVERRIDE, isAggressivePaper } from './runtime.js';
import { recordUniverse, postmortemTrade } from './research.js';
import { supervisorTick } from './supervisor.js';
import { proposeTrade, proposeExit, resolveProposal, expireProposals } from './proposals.js';
import { runArbitragePaperTick } from './arbitragePoller.js';
import { scheduleShadowTick } from './shadowCollector.js';
import { routePaperProposal } from './paperRouting.js';
import { memeIndex } from './indexer.js';
import { mapLimit, sleep, compactError } from './utils.js';
import { fastEdgeScore, queueOutcomeSamples, settleOutcomeSamples, dueOutcomeMints, learnerSnapshot, evolutionChampionPolicy, evolutionChampionScore } from './learner.js';
import { recordChampionPublication } from './researchControlPlane.js';
import { syncLabLink, publishLabFeed } from './labLink.js';
import { estimatePaperExecution, simulatePumpPaperExecution, estimateRoundTripFrictionPct } from './executionSim.js';
import { enqueueAlphaEvent as enqueueAlphaRaw } from './alphaQueue.js';
import { dailyPnl, recentPnl, bookClosedPnl, unrealizedPnl, equity, updatePortfolio } from './accounting.js';
import { startAlphaWorker, stopAlphaWorker } from './alphaWorkerManager.js';
// With the alpha worker off (the default since batch 11) nothing drains alpha-queue.ndjson, so don't write it.
const enqueueAlphaEvent = row => { if (cfg.alphaWorkerEnabled) enqueueAlphaRaw(row); };
// Evolution Lab is the separate research backend for Money Printer OS. The link is on by default;
// champions are still re-validated locally and can only affect paper mode. Set MPO_LAB_LINK=false to isolate it.
const LAB_LINK = String(process.env.MPO_LAB_LINK ?? 'true').toLowerCase() === 'true';
import { solanaCostGate, paperProfileDemotion } from './solanaEconomics.js';
import { latestJupiterQuote } from './jupiterEvidence.js';
import { exitSimulation, simulatePaperExit, paperExitQuote, reviewPositionPrice, entrySizing, paperEntryRejection, emptyPriceReviewTally, tallyPriceReview } from './positionExecution.js';
import { apiUnitEconomicsSnapshot, persistApiUnitEconomics, attributeScanCycle, strategyNetPnlAfterDataCost } from './apiUnitEconomics.js';
import { assessPortfolioRisk } from './portfolioRisk.js';
import { estimateRoutedPaperExecution } from './executionSimAggressive.js';
import { sizeFromEdge, splitTranches, recentClosedReturns } from './sizing.js';

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

const exposure = s => (s.positions || []).reduce((q, p) => q + (p.remainingSol ?? p.sizeSol ?? 0) + Math.max(0,Number(p.stagedRemainingSol||0)), 0);
const stagedExposure = s => (s.positions || []).reduce((q,p)=>q+Math.max(0,Number(p.stagedRemainingSol||0)),0);

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

// The exit policy updatePositions actually uses: the preset, overridden by a paper champion.
function exitPolicy(s) {
  const basePr=preset(s),evolutionExit=cfg.mode==='paper'?evolutionChampionPolicy(s,{paperAggressive:isAggressivePaper(s.runtime)}):null;
  return evolutionExit?{...basePr,tp1:evolutionExit.takePct,tp2:evolutionExit.takePct,stop:evolutionExit.stopPct,maxHold:evolutionExit.maxHoldMin}:basePr;
}

function preset(s) {
  return exitPresets[s.runtime.exitPreset] || customExitPolicy(s.runtime);
}

function paperSell(s, p, fraction, price, reason, final = false, market = null) {
  fraction = Math.min(1, Math.max(0, fraction));
  const rem = Number(p.remainingSol ?? p.sizeSol ?? 0);
  const requestedBasis = rem * fraction, now = Date.now();
  if (!(requestedBasis > 0) || !(price > 0)) return false;
  const sim = simulatePaperExit(p,{...market,priceUsd:price},Number(s.market?.solUsd||0),cfg.simulatedSlippageBps,cfg.simulatedFeeBps,fraction,{now,seed:`pump-exit:${p.id||p.mint}:${reason}:${Math.floor(now/8000)}`});
  if (sim.status === 'REJECTED' || !(sim.filledBasisSol > 0)) {
    appendJournal({ type:'paper-exit-missed', mode:'PAPER', pnlMode:'PAPER', mint:p.mint, symbol:p.symbol, reason, fillReason:sim.reason, failurePct:sim.failurePct, slippageBps:sim.slippageBps??null, latencyMs:sim.latencyMs??null });
    return false;
  }
  const soldBasis=Math.min(rem,Number(sim.filledBasisSol)),fee=Math.max(0,Number(sim.feeSol||0)),proceeds=Math.max(0,Number(sim.gross||0)-fee),exit=Number(sim.fillPriceUsd||price);
  const cashReceipt=paperCashReceipt({positionId:String(p.id),sequence:(p.paperCashEvents||[]).length,side:'SELL',postedAt:now,modeledFillAt:sim.fillAt,basisSol:soldBasis,grossSol:proceeds+fee,feeSol:fee,cashBeforeSol:s.cashSol,cashAfterSol:s.cashSol+proceeds});
  s.cashSol += proceeds;
  p.paperCashCoverage ||= 'PARTIAL_FROM_FIRST_RECORDED_POSTING';
  (p.paperCashEvents ||= []).push(cashReceipt);
  p.remainingSol = Math.max(0, rem - soldBasis);
  p.realizedSol = (p.realizedSol || 0) + (proceeds - soldBasis);
  p.feesSol = (p.feesSol || 0) + fee;
  p.exitSlippageBps = sim.slippageBps;
  p.lastPaperExecution={mode:'PAPER',status:sim.status,fillRatio:sim.fillRatio,latencyMs:sim.latencyMs,slippageBps:sim.slippageBps,feeSol:fee,requestedBasisSol:requestedBasis,soldBasisSol:soldBasis,fillAt:sim.fillAt,model:sim.executionModel};

  if (p.remainingSol < 1e-8 || (final && fraction >= .999999 && Number(sim.fillRatio||0) >= .999999)) {
    s.positions = s.positions.filter(x => x.id !== p.id);
    const cooldownMin = cfg.mode === 'paper' && s.runtime?.profile === 'SPRINT' ? 2 : cfg.cooldownMin;
    s.cooldowns[p.mint] = Date.now() + cooldownMin * 60_000;
    const rr = p.realizedSol / (p.sizeSol || 1) * 100;
    const trade = { ...p, mode:'PAPER', pnlMode:'PAPER', closedAt: Date.now(), exitPrice: exit, returnPct: rr, pnlSol: p.realizedSol, reason, exitSlippageBps: sim.slippageBps };
    s.history.push(trade);
    recordClosed(s, trade);
    postmortemTrade(s, trade);
    appendJournal({ type: 'trade-close', mode:'PAPER', pnlMode:'PAPER', trade });
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
  if(pick?.routeDecision?.decision==='BLOCK'){appendJournal({type:'entry-skip',mode:cfg.mode.toUpperCase(),reason:'strategy-regime-route',mint:pick.mint,symbol:pick.symbol,routeDecision:pick.routeDecision});s.stats.skipped++;return;}
  const copySignal=cfg.mode==='paper'?copySignalForMint(pick?.mint):null;
  if(copySignal){pick={...pick,signalSource:copySignal.source,dominantSignal:'copy-trade'};}
  if (!pick || s.runtime.blacklist.includes(pick.mint) || s.positions.some(p => p.mint === pick.mint)) return;
  if(!(Number(pick.priceUsd)>0)||!Number.isFinite(Number(pick.priceUsd))||Date.now()-Number(pick.priceObservedAt||0)>30000){
    s.stats.skipped++;return;
  }
  const ap = aggressionParams(s.runtime.aggression);
  const isPaper = cfg.mode === 'paper';
  const sprintPaper = isPaper && s.runtime.profile === 'SPRINT';
  const effectiveConfig=isAggressivePaper(s.runtime)?{...cfg,...s.runtime.paperOverrides}:cfg;
  const stagedSol=stagedExposure(s);
  const sizingState=stagedSol>0?{...s,cashSol:Math.max(0,Number(s.cashSol||0)-stagedSol),positions:(s.positions||[]).map(p=>({...p,remainingSol:Number(p.remainingSol??p.sizeSol??0)+Number(p.stagedRemainingSol||0)}))}:s;
  // F8 (ACCOUNTING-AUDIT §4 RC-C): identical arithmetic to before, except that PAPER sizing is now
  // levered off min(marked equity, cash + cost basis). Live keeps cfg.maxPositionSol /
  // cfg.maxTotalExposureSol exactly as before. See src/positionExecution.js.
  const legacySizing = entrySizing({
    state: sizingState, config: effectiveConfig, sizeFactor: ap.sizeFactor, aggression: s.runtime.aggression,
    stopPct: preset(s).stop, paper: isPaper, sprint: sprintPaper,
  });
  const decision = isPaper ? recordPumpDecision(s, pumpSizingDecision(sizingState, effectiveConfig, pick, legacySizing), pick) : null;
  let size = decision ? decision.sizeSol : legacySizing.size;
  if (isAggressivePaper(s.runtime)) {
    const returns=recentClosedReturns(s.history,40);
    const avg=returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0;
    const variance=returns.length>1?returns.reduce((q,x)=>q+(x-avg)**2,0)/(returns.length-1):0;
    const cap=Math.min(Number(effectiveConfig.maxPositionSol||3),Number(decision?.allowedSol??3));
    if(returns.length>=2){
      const kelly=sizeFromEdge({runtime:s.runtime,mode:cfg.mode,expectancy:avg,variance,equity:equity(s),floor:.005,ceiling:cap,logger:appendJournal});
      size=Math.min(kelly.finalSize,Number(decision?.allowedSol??kelly.finalSize));
      if(decision){decision.kelly=kelly;decision.sizeSol=size;}
    }else appendJournal({type:'sizing-decision',mode:'PAPER',profile:'AGGRESSIVE_PAPER',sampleCount:returns.length,expectancy:avg,variance,kelly:null,cap,finalSize:size,fallback:'existing-paper-budget-until-two-closed-samples'});
  }
  if (size < 0.005) { if(decision) decision.rejected='uneconomic-or-sizing-budget'; return; }
  const portfolioRisk=assessPortfolioRisk(s,pick);
  if(portfolioRisk.enabled&&!portfolioRisk.allowed){appendJournal({type:'entry-skip',mode:'PAPER',reason:'portfolio-risk',mint:pick.mint,symbol:pick.symbol,portfolioRisk});return;}
  if(portfolioRisk.enabled&&portfolioRisk.sizeMultiplier<1)size*=portfolioRisk.sizeMultiplier;

  // Cost gate: in paper mode a fresh Jupiter round-trip quote may only make the simulator stricter.
  // This keeps toxic / effectively unsellable Pump.fun tokens out of the evidence the Lab learns from.
  const venueQuote = isPaper ? latestJupiterQuote(path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data'), pick.mint) : null;
  const gate = solanaCostGate({ pick, sizeSol: size, solUsd: Number(s.market?.solUsd || 0), tp1: exitPolicy(s).tp1, config: cfg, venueRoundTripPct: venueQuote?.roundTripPct });
  if (decision) { decision.estimatedRoundTripPct=gate.roundTripPct; decision.costSource=gate.costSource; }
  if (!gate.ok) {
    if(decision) decision.rejected='costGate';
    s.stats.skipped++;
    s.stats.skipReasons = { ...(s.stats.skipReasons || {}), costGate: Number(s.stats.skipReasons?.costGate || 0) + 1 };
    s.stats.lastCostGate = { at: Date.now(), symbol: pick.symbol, tp1: gate.tp1, roundTripPct: gate.roundTripPct, modeledRoundTripPct: gate.modeledRoundTripPct, venueRoundTripPct: gate.venueRoundTripPct, costSource: gate.costSource, requiredTp1Pct: gate.requiredTp1Pct };
    appendJournal({ type: 'entry-skip', reason: 'costGate', mint: pick.mint, symbol: pick.symbol, tp1: gate.tp1, roundTripPct: gate.roundTripPct, modeledRoundTripPct: gate.modeledRoundTripPct, venueRoundTripPct: gate.venueRoundTripPct, quoteAgeMs: venueQuote?.ageMs ?? null, costSource: gate.costSource, requiredTp1Pct: gate.requiredTp1Pct });
    return;
  }

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
  const paperProposal=cfg.mode==='paper'?proposeTrade(s,pick,size):null;
  if(paperProposal){paperProposal.signalSource=pick.signalSource||copySignal?.source||'scanner';paperProposal.routeDecision=pick.routeDecision||null;}
  if(paperProposal) {
    const routed=routePaperProposal({state:s,existingProposal:paperProposal,pick,assetClass:pick.assetClass||'memecoin',sizeSol:size,mode:cfg.mode});
    if(!routed.proposal){paperProposal.status='REJECTED';return;}
  }
  const resolvePaperProposal=status=>{if(paperProposal){paperProposal.status=status;paperProposal.resolvedAt=Date.now();}};

  if (cfg.mode === 'paper') {
    // F7 (ACCOUNTING-AUDIT §4 RC-B): bind the position to a pool at entry. Without it
    // reviewPositionPrice accepts a price from any pool of the mint and index.js back-fills
    // pairAddress from the first accepted tick, which can latch onto the wrong pool for good.
    const entryReject = paperEntryRejection(pick);
    if (entryReject) {
      if(decision) decision.rejected=entryReject;
      resolvePaperProposal('REJECTED');
      s.stats.skipped++;
      appendJournal({ type: 'paper-entry-reject', mint: pick.mint, symbol: pick.symbol, reason: entryReject });
      return;
    }
    const now=Date.now(),clips=isAggressivePaper(s.runtime)?splitTranches(size,{threshold:.25,clips:3,intervalMs:5000}):[{sizeSol:size,delayMs:0}],initialSize=clips[0].sizeSol;
    const routedExecution=estimateRoutedPaperExecution(pick,initialSize,Number(s.market?.solUsd||0),s.runtime,cfg.mode,(c,z,usd)=>estimatePaperExecution(c,z,usd,cfg.simulatedSlippageBps,cfg.simulatedFeeBps)),execModel=routedExecution.selected;
    const sim=isAggressivePaper(s.runtime)?simulateAggressivePaperExecution(pick,initialSize,Number(s.market?.solUsd||0),{side:'BUY',now,seed:`pump-entry:${pick.mint}:${Math.floor(now/8000)}`}):simulatePumpPaperExecution(pick,initialSize,Number(s.market?.solUsd||0),cfg.simulatedSlippageBps,cfg.simulatedFeeBps,{side:'BUY',now,seed:`pump-entry:${pick.mint}:${Math.floor(now/8000)}`});
    if(sim.status==='REJECTED'||!(Number(sim.gross)>0)){
      if(decision) { decision.rejected=sim.reason||'modeled-no-fill'; decision.failedTransactionCostEvidence='UNKNOWN_NOT_CHARGED_AS_A_REAL_TRANSACTION'; }
      resolvePaperProposal('REJECTED');
      s.stats.skipped++;
      appendJournal({type:'paper-fill-failed',mode:'PAPER',pnlMode:'PAPER',mint:pick.mint,symbol:pick.symbol,requestedSizeSol:size,fillReason:sim.reason,simulatedFailurePct:sim.failurePct,slippageBps:sim.slippageBps??null,latencyMs:sim.latencyMs??null});
      return;
    }
    const filledBasis=Math.max(0,Number(sim.gross||0)),entryFee=Math.max(0,Number(sim.feeSol||0)),debit=filledBasis+entryFee;
    if(!(debit>0)||s.cashSol-decision.reserveSol+1e-9<debit||filledBasis>decision.allowedSol+1e-9){decision.rejected='execution-budget-or-reserve';resolvePaperProposal('REJECTED');return;}
    decision.filledSol=filledBasis;decision.actualEntryFeeSol=entryFee;decision.executionModel=sim.executionModel;
    const cashReceipt=paperCashReceipt({positionId:`${now}-${pick.mint.slice(0,6)}`,sequence:0,side:'BUY',postedAt:now,modeledFillAt:sim.fillAt,basisSol:filledBasis,grossSol:filledBasis,feeSol:entryFee,cashBeforeSol:s.cashSol,cashAfterSol:s.cashSol-debit});
    s.cashSol-=debit;
    const ep=Number(sim.fillPriceUsd||pick.priceUsd);
    s.positions.push({
      id:`${now}-${pick.mint.slice(0,6)}`,mode:'PAPER',pnlMode:'PAPER',mint:pick.mint,symbol:pick.symbol,name:pick.name,
      paperCashCoverage:'COMPLETE_FROM_ENTRY',paperCashEvents:[cashReceipt],
      pumpSizing:{...decision},pumpPolicy:effectivePumpPolicy(s,cfg),pumpPolicyPinnedAt:now,pumpPolicyProvenance:'PINNED_AT_ENTRY',entrySolUsd:Number(s.market.solUsd),lastSolUsd:Number(s.market.solUsd),paperTokenQuantity:Number(sim.filledQuantity),valuationModel:'SOL_FX_V1',decimals:pick.risk?.decimals??null,
      sizeSol:filledBasis,remainingSol:filledBasis,requestedSizeSol:size,stagedRemainingSol:clips.slice(1).reduce((a,x)=>a+x.sizeSol,0),stagedTranches:clips.slice(1).map(x=>({sizeSol:x.sizeSol,dueAt:now+x.delayMs})),entryPrice:ep,lastPrice:pick.priceUsd,highPrice:pick.priceUsd,pairAddress:pick.pairAddress||null,
      openedAt:now,score:pick.score,fastEdgeScore:pick.fastEdgeScore||pick.edgeScore||pick.score,riskScore:pick.risk?.score,executionScore:pick.executionScore,strategy,reasons:explain(pick),
      tp1Done:false,tp2Done:false,breakEvenArmed:false,realizedSol:-entryFee,feesSol:entryFee,manual,
      executionEstimates:{pessimistic:routedExecution.pessimistic,aggressive:routedExecution.aggressive,deltaBps:routedExecution.deltaBps},
      maxFavorablePct:0,maxAdversePct:0,entrySlippageBps:sim.slippageBps,simulatedLatencyMs:sim.latencyMs,
      paperExecution:{mode:'PAPER',status:sim.status,fillRatio:sim.fillRatio,requestedSizeSol:size,filledBasisSol:filledBasis,latencyMs:sim.latencyMs,slippageBps:sim.slippageBps,feeSol:entryFee,fillAt:sim.fillAt,model:sim.executionModel},
      lastLiquidityUsd:pick.liq,lastMicro:pick.micro,lastPriceAccel:pick.priceAccel,
      profile: s.runtime.profile || null, exitPreset: s.runtime.exitPreset || null, championId: s.runtime.activeEvolutionChampionId || 'BASE',
    });
    s.stats.signals++;
    resolvePaperProposal('PAPER_SIMULATED');
    appendJournal({type:'trade-open',mode:'PAPER',pnlMode:'PAPER',mint:pick.mint,symbol:pick.symbol,sizeSol:filledBasis,requestedSizeSol:size,stagedTranches:clips.length-1,score:pick.score,fastEdgeScore:pick.fastEdgeScore||pick.score,strategy,signalSource:copySignal?.source||pick.signalSource||'scanner',executionModel:sim.executionModel,executionEstimates:routedExecution,manual,fillStatus:sim.status,fillRatio:sim.fillRatio,slippageBps:sim.slippageBps,simulatedFailurePct:sim.failurePct,latencyMs:sim.latencyMs});
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

function applyRuntimeControlPatch(s,raw={},opts={}){
  s.runtime ||= {};
  const profile=String(opts.profile||'').toUpperCase();
  if(profile && operatingProfiles[profile]){
    s.runtime.profile=profile;
    Object.assign(s.runtime,operatingProfiles[profile]);
  }
  const patch={};
  if(raw.aggression!=null)patch.aggression=Math.max(0,Math.min(100,Number(raw.aggression)||0));
  if(raw.maxCandidates!=null)patch.maxCandidates=Math.max(30,Math.min(600,Math.round(Number(raw.maxCandidates)||cfg.maxCandidates)));
  if(raw.entryFrequency!=null&&['normal','high','max'].includes(String(raw.entryFrequency)))patch.entryFrequency=String(raw.entryFrequency);
  if(raw.exitPreset!=null&&['ultraScalp','sprint','fair','scalper','runner','moonbag','yolo','custom'].includes(String(raw.exitPreset)))patch.exitPreset=String(raw.exitPreset);
  if(raw.customExit!=null)patch.customExit={...(s.runtime.customExit||{}),...sanitizeCustomExit(raw.customExit)};
  if(raw.maxOpenPositions!==undefined){const o=Math.round(Number(raw.maxOpenPositions));patch.maxOpenPositions=raw.maxOpenPositions===null||raw.maxOpenPositions===''||!Number.isFinite(o)?null:Math.max(MAX_OPEN_OVERRIDE[0],Math.min(MAX_OPEN_OVERRIDE[1],o));}
  if(raw.visualIntensity!=null)patch.visualIntensity=Math.max(0,Math.min(100,Number(raw.visualIntensity)||0));
  if(raw.pumpSafety!=null)patch.pumpSafety=applyPumpSafety(s,raw.pumpSafety);
  if(raw.pumpExperimentsPaused!=null&&s.pumpProfitCapture)s.pumpProfitCapture.experimentPaused=raw.pumpExperimentsPaused===true;
  Object.assign(s.runtime,patch);
  if(opts.manual){
    s.runtime.followLabBest=false;
    s.runtime.controlMode='MANUAL';
    s.runtime.controlUpdatedAt=Date.now();
  }
  return patch;
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
      applyRuntimeControlPatch(s,{...(a.patch||{})});
    } else if (a.type === 'control-settings') {
      const raw={...(a.patch||{})};
      applyRuntimeControlPatch(s,raw,{profile:raw.profile,manual:true});
      appendJournal({type:'control-settings',source:'MANUAL',profile:s.runtime.profile,aggression:s.runtime.aggression,entryFrequency:s.runtime.entryFrequency,exitPreset:s.runtime.exitPreset,maxCandidates:s.runtime.maxCandidates,maxOpenPositions:s.runtime.maxOpenPositions});
    } else if (a.type === 'lab-sync') {
      if(cfg.mode!=='paper'){
        appendJournal({type:'action-rejected',actionType:a.type,reason:'Lab champion sync is paper-only.'});
      }else{
        const champion=evolutionChampionPolicy(s,{ignoreFollowSetting:true});
        s.runtime.followLabBest=true;
        s.runtime.controlMode=champion?'LAB_AUTO':'LAB_WAITING';
        s.runtime.controlUpdatedAt=Date.now();
        s.runtime.labSyncedChampionId=champion?.id||null;
        appendJournal(champion
          ?{type:'control-settings',source:'EVOLUTION_LAB',championId:champion.id,threshold:champion.threshold,takePct:champion.takePct,stopPct:champion.stopPct,maxHoldMin:champion.maxHoldMin}
          :{type:'control-settings',source:'EVOLUTION_LAB_WAITING',message:'Auto-follow enabled; waiting for the next validated paper champion.'});
      }
    } else if (a.type === 'evolution-sync') {
      appendJournal({ type: 'action-rejected', actionType: a.type, reason: 'Legacy evolution sync is retired; use the validated Lab link.' });
    } else if (a.type === 'profile') {
      const pr = operatingProfiles[a.profile];
      if (pr) { s.runtime.profile = a.profile; Object.assign(s.runtime, pr); s.runtime.followLabBest=false; s.runtime.controlMode='MANUAL'; s.runtime.controlUpdatedAt=Date.now(); }
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

async function updatePositions(s, reviewTally = null) {
  const pr=exitPolicy(s);
  const positions = [...s.positions];
  const refreshed = await refreshPositionPairs(positions);
  for (const row of refreshed) {
    if (!row || row.__error || !row.p) continue;
    const { p, pair } = row;
    const pr=cfg.mode==='paper'&&p.pumpPolicy?.exit?p.pumpPolicy.exit:exitPolicy(s);
    if (!pair) {p.priceStatus='UNAVAILABLE';continue;}
    const price = Number(pair.priceUsd || 0);
    if (!price || !p.entryPrice) continue;
    // Quarantine discontinuities; corroborated exact-pool paper crashes can be
    // recognized after repeated refreshes instead of trapping capital forever.
    const anchor = Number(p.lastPrice || p.entryPrice || 0);
    const tickRatio = anchor > 0 ? price / anchor : 1;
    const review=reviewPositionPrice(p,pair,{paper:cfg.mode==='paper',ticks:s.tickHistory?.[p.mint]});
    if (reviewTally) tallyPriceReview(reviewTally, review, Date.now());
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
    if(p.entrySolUsd>0&&Number(s.market?.solUsd)>0)p.lastSolUsd=Number(s.market.solUsd);
    p.lastLiquidityUsd = Number(pair.liquidity?.usd ?? p.lastLiquidityUsd ?? 0);
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
    if (profitReturn >= Math.min(pr.breakEvenTriggerPct ?? cfg.breakEvenTriggerPct, pr.tp1 * 0.8)) p.breakEvenArmed = true;

    let action = null;
    let fraction = 1;
    let tpFlag = null;
    if (!p.tp1Done && ret >= pr.tp1) { action = 'take-profit-1'; fraction = pr.tp1Fraction ?? (cfg.mode === 'paper' && s.runtime?.profile === 'SPRINT' ? 1 : Math.max(.01,Math.min(1,cfg.takeProfit1SellPct/100))); tpFlag = 'tp1Done'; }
    else if (!p.tp2Done && ret >= pr.tp2) { action = 'take-profit-2'; fraction = pr.tp2Fraction ?? (cfg.mode === 'paper' && s.runtime?.profile === 'SPRINT' ? 1 : Math.max(.01,Math.min(1,cfg.takeProfit2SellPct/100))); tpFlag = 'tp2Done'; }
    else if (ret <= -pr.stop) action = 'stop-loss';
    else if (p.breakEvenArmed && profitReturn <= 0) action = 'break-even';
    else if (draw <= -pr.trail && ret > 0) action = 'trailing';
    else if (held >= pr.maxHold) action = 'stale-purge';

    if(!action&&cfg.mode==='paper'&&Array.isArray(p.stagedTranches)&&p.stagedTranches.length&&Date.now()>=Number(p.stagedTranches[0].dueAt||0)){
      const clip=p.stagedTranches.shift(),clipSize=Math.max(0,Number(clip.sizeSol||0));
      const candidate={mint:p.mint,symbol:p.symbol,priceUsd:price,priceObservedAt:review.at,liq:Number(pair.liquidity?.usd||p.lastLiquidityUsd||0),executionScore:p.executionScore};
      const trancheNow=Date.now(),sim=p.paperExecution?.model==='AGGRESSIVE_PAPER_V1'?simulateAggressivePaperExecution(candidate,clipSize,Number(s.market?.solUsd||0),{side:'BUY',now:trancheNow,seed:`paper-tranche:${p.id}:${p.stagedTranches.length}`}):simulatePumpPaperExecution(candidate,clipSize,Number(s.market?.solUsd||0),cfg.simulatedSlippageBps,cfg.simulatedFeeBps,{side:'BUY',now:trancheNow,seed:`paper-tranche:${p.id}:${p.stagedTranches.length}`});
      const basis=Math.max(0,Number(sim.gross||0)),fee=Math.max(0,Number(sim.feeSol||0)),debit=basis+fee,reserve=Number(p.pumpSizing?.reserveSol||cfg.minSolReserve);
      p.stagedRemainingSol=Math.max(0,Number(p.stagedRemainingSol||0)-clipSize);
      if(sim.status!=='REJECTED'&&basis>0&&s.cashSol-reserve+1e-9>=debit&&Number(p.sizeSol||0)+basis<=Number(p.pumpSizing?.allowedSol||p.requestedSizeSol)+1e-8){
        const before=Number(p.sizeSol||0),quantity=Math.max(0,Number(sim.filledQuantity||0)),oldQty=Math.max(0,Number(p.paperTokenQuantity||0));
        const receipt=paperCashReceipt({positionId:String(p.id),sequence:(p.paperCashEvents||[]).length,side:'BUY',postedAt:Date.now(),modeledFillAt:sim.fillAt,basisSol:basis,grossSol:basis,feeSol:fee,cashBeforeSol:s.cashSol,cashAfterSol:s.cashSol-debit});
        s.cashSol-=debit;p.sizeSol=before+basis;p.remainingSol=Number(p.remainingSol||0)+basis;p.paperTokenQuantity=oldQty+quantity;p.entryPrice=(Number(p.entryPrice||price)*oldQty+Number(sim.fillPriceUsd||price)*quantity)/Math.max(1e-12,oldQty+quantity);p.realizedSol=Number(p.realizedSol||0)-fee;p.feesSol=Number(p.feesSol||0)+fee;p.paperCashEvents.push(receipt);
        (p.paperExecution.tranches||=[]).push({basisSol:basis,feeSol:fee,fillAt:sim.fillAt,slippageBps:sim.slippageBps});
        appendJournal({type:'paper-tranche-fill',mode:'PAPER',mint:p.mint,symbol:p.symbol,basisSol:basis,feeSol:fee,remainingStagedSol:p.stagedRemainingSol,executionModel:sim.executionModel});
      }else appendJournal({type:'paper-tranche-missed',mode:'PAPER',mint:p.mint,symbol:p.symbol,requestedSol:clipSize,reason:sim.reason||'reserve-or-sizing-cap',remainingStagedSol:p.stagedRemainingSol});
    }
    if (action) {
      p.stagedTranches=[];p.stagedRemainingSol=0;
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
  const openLimit = openLimitFor(s.runtime);
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

async function cycle(budget = null) {
  const cycleStart = performance.now();
  // P0.4: the deadline for this cycle. The signal reaches the market requester through
  // dexscreener.setCycleSignal (one hook covers every dex/gecko read), and the phase boundaries
  // below stop a cycle that ran past it instead of letting it drag the loop's cadence.
  budget?.assertAlive('actions');
  const s = loadState();
  let pinned=0;
  try{pinned=initializePumpCapture(s,cfg);}catch(e){s.system.profitCaptureError=compactError(e);if(s.pumpProfitCapture)s.pumpProfitCapture.experimentPaused=true;}
  if(pinned)appendJournal({type:'pump-policy-pinned-at-upgrade',positions:pinned,hash:s.pumpProfitCapture.currentPolicy.hash});
  s.system.lastError = null;
  s.stats.cycles++;
  await actions(s);
  // In Lab-auto mode, an impossible fallback profile may still demote to FAIR so the engine keeps
  // producing evidence. Explicit Manual mode is never rewritten behind the user's back; its
  // per-trade cost gate can still reject entries that cannot cover modeled fees/slippage.
  const demotion = s.runtime.followLabBest===false ? null : paperProfileDemotion({ mode: cfg.mode, runtime: s.runtime, config: cfg });
  if (demotion) {
    Object.assign(s.runtime, operatingProfiles.FAIR); s.runtime.profile = 'FAIR';
    appendJournal({ type: 'profile-auto-demote', ...demotion, reason: 'costGate' });
  }
  // The Evolution Lab is a separate app now: pull its latest status/champion over the lab link
  // (local files, or the signed bridge for a lab on another machine). Gates are re-checked below.
  if (LAB_LINK) { try { syncLabLink(s); } catch (e) { s.labLink = { connected: false, source: 'error', error: compactError(e) }; } }
  else s.labLink = { connected: false, source: 'disabled', checkedAt: Date.now() };
  const hotPolicy=cfg.mode==='paper'?evolutionChampionPolicy(s):null;
  if(hotPolicy){
    if(s.runtime.activeEvolutionChampionId!==hotPolicy.id){
      appendJournal({type:'strategy-upgrade',mode:'paper',from:s.runtime.activeEvolutionChampionId||'BASE',to:hotPolicy.id,stage:'PAPER_CANARY',threshold:hotPolicy.threshold,stopPct:hotPolicy.stopPct,takePct:hotPolicy.takePct,maxHoldMin:hotPolicy.maxHoldMin});
      try{recordChampionPublication({dataDir:process.env.MONEY_PRINTER_DATA_DIR||'data',from:s.runtime.activeEvolutionChampionId||'BASE',to:hotPolicy.id,stage:'PAPER_CANARY'});}catch{}
    }
    s.runtime.activeEvolutionChampionId=hotPolicy.id;s.system.activeEvolutionPolicy={...hotPolicy,stage:'PAPER_CANARY',hotReload:true,applied:true,liveActivationAllowed:false,automaticLivePromotionAllowed:false,liveExecution:'manual'};
  }else if(cfg.mode==='paper'){s.runtime.activeEvolutionChampionId='BASE';s.system.activeEvolutionPolicy={id:'BASE',stage:'BASE',hotReload:true,applied:false,liveActivationAllowed:false,automaticLivePromotionAllowed:false,liveExecution:'manual'};}
  else {const existing=s.system.activeEvolutionPolicy||{};s.system.activeEvolutionPolicy={...existing,hotReload:false,applied:false,liveActivationAllowed:false,automaticLivePromotionAllowed:false,liveExecution:'manual'};}
  // P1.5: what the position price review returned this cycle, per reason — the tick band's rejection
  // count is published in the funnel instead of only living in each position's priceStatus field.
  const priceReviews=emptyPriceReviewTally();
  if (['paper', 'live'].includes(cfg.mode)) await updatePositions(s, priceReviews);
  budget?.assertAlive('positions');

  if (s.stats.cycles === 1 || Date.now() - lastRpcBenchAt >= 120_000) refreshRpcHealthAsync();
  const solPricePromise = solUsdPrice().catch(() => Number(s.market?.solUsd || 0));

  const max = Math.max(30, Math.min(600, Number(s.runtime.maxCandidates) || cfg.maxCandidates));
  const discoveryStart = performance.now();
  const pairs = await discoverCandidates(max);
  budget?.assertAlive('discovery');
  s.system.metrics.discoveryMs = Math.round(performance.now() - discoveryStart);
  // P0.3: the fan-out is sized from what is left of the per-minute budget, and the refusal counter
  // is compared cycle over cycle so a budget that is still tripping shows up in the funnel instead
  // of only inside the scan. discoveryBudget stays out of discoveryHealth on purpose: index.js walks
  // that object as a list of feeds, and a non-feed key would be counted as a failing one.
  const priorBudgetRejects = Number(s.system.discoveryHealth?.marketRequests?.budgetRejects || 0);
  s.system.discoveryHealth = discoveryHealth();
  const budgetRejects = Number(s.system.discoveryHealth.marketRequests?.budgetRejects || 0);
  const fanout = discoveryFanout();
  s.system.marketBudget = {
    requestsPerMinute: cfg.marketRequestsPerMinute, rejectsTotal: budgetRejects,
    rejectsDelta: Math.max(0, budgetRejects - priorBudgetRejects),
    fanoutRequested: fanout?.requested ?? null, fanoutAddresses: fanout?.allowed ?? null,
    fanoutBatches: fanout?.batches ?? null, fanoutUsedInWindow: fanout?.usedInWindow ?? null,
  };
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
    a.priceObservedAt=Date.now();a.priceEvidenceSource='MARKET_POLL_OBSERVATION_NOT_EXCHANGE_TIMESTAMP';
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
  const flowSnapshot=await indexedFlowSnapshot().catch(()=>null);
  if(flowSnapshot){
    const flows=flowSnapshot.value||[];s.system.onchainFlow={at:flowSnapshot.at,cached:flowSnapshot.cached,assets:flows.length,signals:flows.reduce((n,x)=>n+(x.signals||[]).length,0)};
    const byMint=new Map(flows.filter(x=>x.asset!=='SOL').map(x=>[x.asset,x]));
    for(const a of ranked){const flow=byMint.get(a.mint);if(!flow)continue;a.onchainSignals=flow.signals||[];if(a.onchainSignals.length)a.signalSource=a.onchainSignals[0].source;}
    if(!flowSnapshot.cached)for(const f of flows)for(const signal of f.signals||[])appendJournal({type:'onchain-flow-signal',mode:'PAPER',asset:f.asset,...signal,at:flowSnapshot.at,cached:flowSnapshot.cached});
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
  if (LAB_LINK) { try { publishLabFeed(s, { mode: cfg.mode, version: process.env.MONEY_PRINTER_VERSION || null, config: cfg }); } catch {} }

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

  budget?.assertAlive('enrichment');

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
  try { s.system.arbitragePaper = await runArbitragePaperTick(marketPlatform(), s, cfg.mode); }
  catch (e) { s.system.arbitragePaper = { error: compactError(e), ordersSubmitted: 0 }; }
  try { s.system.pumpfunPaper = await pumpfunPaperLane().maintain({ runtime: s.runtime, mode: cfg.mode, solUsd: s.market?.solUsd }); }
  catch (e) { s.system.pumpfunPaper = { error: compactError(e), ordersSubmitted: 0 }; }
  try { s.system.shadowPaper = scheduleShadowTick(marketPlatform(), s, cfg.mode); }
  catch (e) { s.system.shadowPaper = { error: compactError(e), ordersSubmitted: 0 }; }
  if(cfg.mode==='paper'&&s.runtime?.profile==='AGGRESSIVE_PAPER'&&s.system.portfolioRisk?.some(x=>x.flatten)){
    for(const p of [...s.positions])paperSell(s,p,1,Number(p.lastPrice||p.entryPrice),'portfolio-drawdown-tier3',true);
    appendJournal({type:'portfolio-risk-flatten',mode:'PAPER',reason:'drawdown-tier3'});
  }
  const missingPrices=s.positions.filter(p=>p.priceStatus&&p.priceStatus!=='FRESH');
  if(missingPrices.length){s.system.diagnostics.push({level:'WARN',code:'HELD_PRICE_UNVERIFIED',message:`${missingPrices.length} held positions await a verified price`});if(s.system.health==='HEALTHY')s.system.health='CAUTION';}
  const requestHealth=discoveryHealth().marketRequests;
  if(requestHealth&&!requestHealth.ok){s.system.diagnostics.push({level:'WARN',code:'MARKET_RATE_LIMIT',message:'Market provider rate-limited; retry backoff is active'});if(s.system.health==='HEALTHY')s.system.health='CAUTION';}
  // P0.3: a refused call is a dropped candidate, not just a slow one, so say so. Diagnostics are
  // rebuilt each cycle by supervisorTick above, which is why this is pushed here and not earlier.
  const marketBudget= s.system.marketBudget||{};
  if(Number(marketBudget.rejectsDelta||0)>0){s.system.diagnostics.push({level:'WARN',code:'MARKET_BUDGET_REJECTED',message:`${marketBudget.rejectsDelta} market request(s) refused by the ${marketBudget.requestsPerMinute}/min budget last discovery; fan-out allowed ${marketBudget.fanoutBatches ?? '?'} batch(es) after ${marketBudget.fanoutUsedInWindow ?? '?'} call(s) in the window`});if(s.system.health==='HEALTHY')s.system.health='CAUTION';}

  const block = blockStatus(s);
  const rejectionReasons={score:0,invalidMarket:0,riskUnverified:0,execution:0,regime:0,cooldown:0,alreadyOpen:0,blacklist:0};
  for (const x of ranked) {
    if (x.routeDecision?.decision==='BLOCK') rejectionReasons.regime++;
    else if ((x.critical||[]).length) rejectionReasons.invalidMarket++;
    else if (Number(x.fastEdgeScore||0) < Number(x.entryThreshold||0)) rejectionReasons.score++;
    else if (cfg.mode !== 'paper' && x.riskVerification !== 'VERIFIED') rejectionReasons.riskUnverified++;
    else if (Number(x.executionScore||0) < 15) rejectionReasons.execution++;
    else if (cooldownActive(s,x.mint)) rejectionReasons.cooldown++;
    else if (s.positions.some(p=>p.mint===x.mint)) rejectionReasons.alreadyOpen++;
    else if (s.runtime.blacklist.includes(x.mint)) rejectionReasons.blacklist++;
  }
  const picks = ranked.filter(x => x.eligible && x.routeDecision?.decision!=='BLOCK' && Number(x.executionScore||0) >= 15 && !cooldownActive(s, x.mint) && !s.positions.some(p => p.mint === x.mint) && !s.runtime.blacklist.includes(x.mint));
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
    openPositions:s.positions.length,openLimit:postBlock.openLimit,capitalDeploymentPct:exposure(s)/eqNow*100,cashPct:Number(s.cashSol||0)/eqNow*100,
    // P1.5: position price reviews (accepted/rejected per reason). `bandRejects` with
    // `bandMedianRatioMin/Max` shows how often and how far the one-sided tick band fired (V8).
    priceReviews:{...priceReviews,reasons:{...priceReviews.reasons}}};
  s.system.opportunityFunnel=funnel;
  s.research.improvementLoop ||= {iteration:0,funnelHistory:[]};
  s.research.improvementLoop.iteration=Number(s.research.improvementLoop.iteration||0)+1;
  s.research.improvementLoop.funnelHistory=[funnel,...(s.research.improvementLoop.funnelHistory||[])].slice(0,240);

  s.system.metrics.cycleMs = Math.round(performance.now() - cycleStart);
  try{persistPumpCapture(s,cfg,ranked);}catch(e){s.system.profitCaptureError=compactError(e);if(s.pumpProfitCapture)s.pumpProfitCapture.experimentPaused=true;}
  try{writeCrowdBaselineFeed(s,cfg,ranked);}catch(e){s.system.crowdCaptureError=compactError(e);}
  s.system.metrics.saveMs = saveState(s) || s.system.metrics.saveMs || 0;

  console.clear();
  console.log(`MONEY PRINTER ENGINE 12.6 // ${cfg.mode.toUpperCase()} // ${s.market.regime} ${s.market.score} // ${ranked.length} TRACKED // ${s.positions.length} HELD // ${s.system.metrics.cycleMs}ms`);
  for (const a of ranked.slice(0, 10)) {
    console.log(`${String(a.score).padStart(3)} X${String(a.explosionScore).padStart(3)} M${String(a.moonScore).padStart(3)} ${a.symbol.padEnd(11)} ${String(a.dominantSignal||'EDGE').padEnd(18)} ${pct(a.pc5).padStart(7)} ${a.stage}`);
  }
}

async function main() {
  // P4.2: refuse a live configuration that could never dispatch, before any provider work (the
  // message names the env var to fix; main()'s catch reports it and exits 1). A coherent but inert
  // live config is reported line by line instead -- the default (paper, gate off) prints nothing.
  // Fail-closed only: this cannot arm anything, and the execution boundary still locks dispatch.
  const liveConfig = assertLiveConfig(cfg);
  for (const w of liveConfig.warnings) console.warn(`[MPOS][LIVE] ${w.code}: ${w.message}`);
  console.info(`[MPOS][MODE] BING PUMPO=${String(cfg.mode).toUpperCase()} | P&L=${cfg.mode==='live'?'LIVE':'PAPER'} | live signing/risk switch unchanged`);
  marketPlatform();
  // A one-shot scan must actually terminate; do not leave servers/workers alive.
  const dashboard = once ? null : startDashboard();
  if (!once && cfg.alphaWorkerEnabled) startAlphaWorker();
  if (!once) openBrowser();
  const nativePaperLane = pumpfunPaperLane();
  const stream = once ? null : startProgramStream(event => {
    // startProgramStream owns bounded log persistence; do not duplicate every event.
    if(!event.programHints?.includes(PUMPFUN_PROGRAM_ID))return;
    const launch=parsePumpfunLaunch(event.logs,{signature:event.signature,ts:event.ts});if(!launch)return;
    const state = loadState();
    nativePaperLane.onLaunch({ ...launch, slot: event.slot }, { runtime: state.runtime, mode: cfg.mode, solUsd: state.market?.solUsd })
      .then(decision => appendJournal({ type: 'pumpfun-sniper-signal', mode: cfg.mode.toUpperCase(), ...launch, ...decision, source: 'pumpfun:sniper', orderSubmitted: false }))
      .catch(error => appendJournal({ type: 'pumpfun-sniper-error', mode: 'PAPER', mint: launch.mint, error: compactError(error), orderSubmitted: false }));
  }, { programIds: [...cfg.programLogIds, PUMPFUN_PROGRAM_ID], enabled: () => cfg.directStreamEnabled || isAggressivePaper(loadState().runtime, cfg.mode) });
  const walletStream = once ? null : startTrackedWalletStream(event=>copyTradeSignals([event],{mode:cfg.mode,wallets:smartWallets(),log:appendJournal}));
  let shuttingDown = false;
  let activeBudget = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // P0.4: cancel in-flight cycle work (a fetch holding the loop open would delay the exit).
    try { activeBudget?.abort('shutdown'); } catch {}
    try { stream?.close?.(); } catch {}
    try { walletStream?.close?.(); } catch {}
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
    const budget = createCycleBudget();
    activeBudget = budget;
    setCycleSignal(budget.signal);
    try {
      await cycle(budget);
    } catch (error) {
      if (isCycleBudgetError(error)) {
        // Abandoned at its budget, not broken: its own journal type and counter, so a slow provider
        // never looks like an engine error (recordCycleBudgetAbort degrades only if it repeats).
        const aborted = recordCycleBudgetAbort({ error, budgetMs: budget.budgetMs });
        console.error(`${compactError(error)} [aborted ${aborted.aborts} time(s), streak ${aborted.abortStreak}]`);
      } else {
        // A refused recovery save must never end the loop: recordCycleError journals first, then
        // tries state.json, then flags /api/health in memory (see cycleRecovery.js).
        const recovery = recordCycleError({ error });
        console.error(recovery.saveFailed
          ? `${recovery.message} [recovery save refused at ${recovery.stage}: ${recovery.failure?.message}]`
          : recovery.message);
      }
    } finally {
      setCycleSignal(null);
    }
    if (once) { shutdown(); break; }
    const current = loadState();
    // A cycle that did not throw clears the failure streak; nothing is written unless one was set.
    markCleanCycle({ state: current });
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

// Robust entry check: import.meta.url is realpath'd by the loader while argv[1] is not
// (e.g. /var -> /private/var, symlinked installs), and the desktop supervisor spawns this
// file via ELECTRON_RUN_AS_NODE from inside app.asar. Compare resolved real paths, and
// always run when supervised by desktop/main.cjs.
const isMainModule = (() => {
  if (process.env.MONEY_PRINTER_SUPERVISED === '1') return true;
  try {
    if (!process.argv[1]) return false;
    const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
    return real(fileURLToPath(import.meta.url)) === real(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch(error => {
    console.error(compactError(error));
    process.exitCode = 1;
  });
}

// P4.3 / AUDIT exec #5: the trade path is published so a test can drive it in-process.
// Importing this file has never run a cycle (main() has been behind the isMainModule guard
// above since bbc8f4d), but `export { main }` was the whole surface, so cycle/enter/
// updatePositions could only be exercised by spawning a whole process or by grep. See
// tests/trade-path.test.mjs. Nothing here changes runtime behaviour.
export { main, cycle, enter, updatePositions };
