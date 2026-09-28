import {observationTargets} from './pumpProfitMarkets.js';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomicRename.js';
import { exitPresets, customExitPolicy, openLimitFor, aggressionParams } from './runtime.js';
import { evolutionChampionPolicy } from './learner.js';
import { equity } from './accounting.js';
import { entrySizing, exitSimulation, paperExitQuote } from './positionExecution.js';
import { frictionConfigFor } from './core/paperTrading.js';
import { auditPumpBook, describePumpPolicy, pinPumpPolicy, decidePumpSize, makeProfitProtocol, policyHash, num, sanitizePumpSafety } from './pumpProfitPolicy.js';
import { createProfitExperiments, advanceProfitExperiments, profitExperimentView, profitQuoteRequests } from './pumpProfitExperiments.js';
const directory = () => path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomicSync(file, JSON.stringify(value)); };
let experimentCache = null, experimentDirectory = null, lastAudit = 0;
export function effectivePumpPolicy(s, config) {
  return describePumpPolicy(s.runtime, config, exitPresets[s.runtime?.exitPreset] || customExitPolicy(s.runtime), evolutionChampionPolicy(s));
}
export function baselineConfig(s, config) {
  const keys = ['tradeSizeSol', 'riskPerTradePct', 'maxPositionSol', 'maxTotalExposureSol', 'minSolReserve', 'simulatedFeeBps', 'simulatedSlippageBps', 'cooldownMin'];
  return { ...Object.fromEntries(keys.map(k => [k, num(config[k])])), openLimit: openLimitFor(s.runtime, 'paper'),
    sizingStopPct: num((exitPresets[s.runtime?.exitPreset] || customExitPolicy(s.runtime)).stop), networkFeeEstimateSol: .000005 };
}
export function initializePumpCapture(s, config, now = Date.now()) {
  if (config.mode !== 'paper') return 0;
  const dir = directory(), policy = effectivePumpPolicy(s, config);
  s.pumpProfitCapture ||= { schema: 'mpo.pump-profit-runtime.v1', decisions: [], initializedAt: now, experimentPaused: false };
  const c = s.pumpProfitCapture;
  c.currentPolicy=policy;let pinned=0;
  for(const p of s.positions||[])if(pinPumpPolicy(p,policy,{now,migration:true}))pinned++;
  if(pinned)c.lastPinMigration={at:now,positions:pinned,hash:policy.hash,reason:'Policy in force at upgrade; historical entry policy is unknown.'};
  if (!c.baseline) {
    const file = path.join(dir, 'pump-profit-baseline.json');
    let baseline = read(file);
    if (!baseline) {
      baseline = { schema: 'mpo.pump-profit-baseline.v1', createdAt: now, policy, config: baselineConfig(s, config), audit: auditPumpBook(s),
        currentMarkedCapitalSol: equity(s), currentCashCapitalSol:num(s.cashSol), currentScenarioBasis:'RECONCILED_AVAILABLE_CASH_NO_ASSUMED_LIQUIDATION', sourceStateHash: policyHash({ history: s.history, positions: s.positions, cashSol: s.cashSol, runtime: s.runtime }) };
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(baseline), { flag: 'wx' });
    }
    if (baseline.schema !== 'mpo.pump-profit-baseline.v1' || baseline.policy?.hash !== policyHash(Object.fromEntries(Object.entries(baseline.policy).filter(([k]) => k !== 'hash')))) throw new Error('Immutable Pump baseline integrity check failed');
    c.baseline = baseline;
  }
  c.currentPolicy = policy;
  if (experimentDirectory !== dir || !experimentCache) {
    experimentDirectory = dir;
    experimentCache = read(path.join(dir, 'pump-profit-experiments.json'));
    if(!experimentCache&&fs.existsSync(path.join(dir,'pump-profit-experiments.json')))throw new Error('Corrupt experiment checkpoint: preserve files and recover, never reset the study');
    if (!experimentCache) {
      if(fs.existsSync(path.join(dir,'pump-profit-protocol.json')))throw new Error('Study protocol exists without its checkpoint: recovery is required; automatic reset refused');
      const protocol = makeProfitProtocol(c.baseline.policy, c.baseline.currentCashCapitalSol ?? c.baseline.audit.cashSol, now);
      experimentCache = createProfitExperiments(protocol, c.baseline.policy, c.baseline.config);
      write(path.join(dir, 'pump-profit-protocol.json'), protocol);
    }
    if (experimentCache.baselineHash !== c.baseline.policy.hash) throw new Error('Pump experiment baseline changed; refusing to reuse its holdout');
  }
  return pinned;
}
export function pumpSizingDecision(s, config, pick, legacy) {
  const tuned = frictionConfigFor('pumpfun'), effective = { ...config, simulatedFeeBps: num(config.simulatedFeeBps) + num(tuned.fee?.bps) };
  return {...decidePumpSize({ state: s, config: effective, pick, legacy }),policyHash:effectivePumpPolicy(s,config).hash};
}

export function recordPumpDecision(s, decision, pick) {
  if (!s.pumpProfitCapture) return decision;
  Object.assign(decision, { at: Date.now(), mint: pick.mint, symbol: pick.symbol || pick.mint, policyHash: decision.policyHash || s.pumpProfitCapture.currentPolicy?.hash });
  s.pumpProfitCapture.decisions = [...(s.pumpProfitCapture.decisions || []), decision].slice(-200);
  return decision;
}
function observedMarket(x, solUsd, now) {
  const priceUsd = num(x.priceUsd, num(x.lastPrice)), at = num(x.priceObservedAt, num(x.at));
  return { mint: x.mint, pairAddress: x.pairAddress, priceUsd, at, solUsd, liquidityUsd: num(x.liq, num(x.lastLiquidityUsd)), liq:num(x.liq,num(x.lastLiquidityUsd)),
    decimals: x.decimals ?? x.risk?.decimals ?? x.riskDetails?.decimals, executionScore: num(x.executionScore), micro: x.micro || x.lastMicro || {}, priceAccel: num(x.priceAccel),
    signalValid: x.eligible !== false, volatilityPct: Math.abs(num(x.micro?.p10)), integrityPassed: !!x.pairAddress && priceUsd > 0 && at > 0 && now - at <= 30000 && at <= now + 1000 };
}
export function persistPumpCapture(s, config, ranked = [], now = Date.now()) {
  if (config.mode !== 'paper' || !s.pumpProfitCapture) return;
  const c = s.pumpProfitCapture, dir = directory(); c.currentPolicy = effectivePumpPolicy(s, config);
  const previewPick=ranked.find(x=>x.eligible)||ranked[0];
  if(previewPick){const legacy=entrySizing({state:s,config,sizeFactor:aggressionParams(s.runtime.aggression).sizeFactor,aggression:s.runtime.aggression,stopPct:(exitPresets[s.runtime.exitPreset]||customExitPolicy(s.runtime)).stop,paper:true,sprint:s.runtime.profile==='SPRINT'});c.sizingPreview={...pumpSizingDecision(s,config,previewPick,legacy),symbol:previewPick.symbol,at:now,previewOnly:true};}
  if (!c.audit || now - lastAudit >= 30000) {
    c.audit = auditPumpBook(s); lastAudit = now;
    let proceeds = 0, uncertain = 0;
    for (const p of s.positions || []) {
      if (p.priceStatus !== 'FRESH' || now - num(p.priceObservedAt) > 30000) uncertain++;
      const market = { priceUsd: p.lastPrice, liquidity: { usd: p.lastLiquidityUsd } }, sim = exitSimulation(p, market, num(s.market?.solUsd), config.simulatedSlippageBps, config.simulatedFeeBps);
      proceeds += paperExitQuote(p, p.lastPrice, sim).proceeds;
    }
    Object.assign(c.audit, { at: now, markedEquitySol: equity(s), estimatedLiquidationEquitySol: num(s.cashSol) + proceeds, unverifiedOpenMarks: uncertain,
      liquidationEvidence: 'MODELED_SLIPPAGE_AND_TRADING_FEES_ONLY_NOT_ROUTE_EXECUTABLE', cashOnlyOpenLossScenarioSol: num(s.cashSol) });
  }
  if (!experimentCache || experimentDirectory !== dir) initializePumpCapture(s, config, now);
  if (!c.experimentPaused) {
    const markets = [...ranked, ...(s.positions || [])].map(x => observedMarket(x, num(s.market?.solUsd), now));
    const followup=read(path.join(dir,'pump-profit-markets.json'),{});
    if(followup.protocolHash===experimentCache.protocolHash)markets.push(...(followup.ticks||[]).filter(t=>t.at<=now&&now-t.at<=30000));
    markets.sort((a,b)=>a.at-b.at);
    const tracked = new Set(experimentCache.books.flatMap(b => [...b.positions, ...b.history.filter(p => now - p.closedAt < 121 * 60000)].map(p => p.mint)));
    const ticks = [...new Map(markets.filter(x => tracked.has(x.mint)).map(x => [`${x.mint}:${x.pairAddress}`, x])).values()];
    const hourStart = Math.floor(now / 3600000) * 3600000, recent = experimentCache.opportunities.filter(o => o.at >= hourStart).length;
    const samePolicy = c.currentPolicy.hash === c.baseline.policy.hash;
    const opportunities = samePolicy ? ranked.filter(x => x.eligible && x.pairAddress).slice(0, Math.max(0, 3 - recent)).map(x => ({ ...observedMarket(x, num(s.market?.solUsd), now),
      id: `${x.mint}:${Math.floor(now / 60000)}`, at: now, eligible: true, cluster: x.risk?.mintAuthority || x.mint })) : [];
    c.entryStreamState = samePolicy ? 'FROZEN_BASELINE_MATCH' : 'ACTIVE_POLICY_CHANGED_NO_NEW_BASELINE_OPPORTUNITIES';
    const quoteCache = read(path.join(dir, 'pump-profit-quotes.json'), { quotes: [] });
    try { advanceProfitExperiments(experimentCache, { opportunities, ticks, quotes: quoteCache.quotes || [], now }); }
    catch (error) { c.experimentError = String(error.message || error); c.experimentPaused = true; }
  }
  if(experimentCache.lastInputFrame&&experimentCache.lastArchivedHash!==experimentCache.lastInputFrame.hash){
    const tape=path.join(dir,'pump-profit-evidence',experimentCache.protocolHash,'inputs.ndjson');fs.mkdirSync(path.dirname(tape),{recursive:true});
    fs.appendFileSync(tape,JSON.stringify(experimentCache.lastInputFrame)+'\n');experimentCache.lastArchivedHash=experimentCache.lastInputFrame.hash;
  }
  c.experiments = profitExperimentView(experimentCache);
  const requests = c.experimentPaused ? [] : profitQuoteRequests(experimentCache);
  write(path.join(dir, 'pump-profit-requests.json'), { schema: 'mpo.pump-profit-requests.v1', protocolHash: experimentCache.protocolHash, mode: 'PAPER',
    createdAt: experimentCache.createdAt, expiresAt: experimentCache.protocol.validation.end, maxCalls: 4096, maxCallsPerHour: 180, requests, observations:c.experimentPaused?[]:observationTargets(experimentCache.books,now), liveExecutionAllowed: false });
  write(path.join(dir, 'pump-profit-experiments.json'), experimentCache);
  write(path.join(dir, 'pump-profit-report.json'), pumpProfitView(s));
  write(path.join(dir, 'pump-profit-checkpoint.json'), { stage: c.experiments.state, at: now, baselineHash: c.baseline.policy.hash,
    protocolHash: experimentCache.protocolHash, inputHash: experimentCache.inputHash, candidateCount: experimentCache.protocol.candidates.length, promoted: false, liveExecutionAllowed: false });
}

export function applyPumpSafety(s, raw) {
  s.runtime.pumpSafety = sanitizePumpSafety(raw);
  return s.runtime.pumpSafety;
}
export function pumpProfitView(s) {
  const c = s?.pumpProfitCapture;
  if (!c) return { state: 'AWAITING_ENGINE', liveExecutionAllowed: false, experiments: { books: [] } };
  const decisions = c.decisions || [], counts = {};
  for (const d of decisions) { const k = d.rejected || d.bindingLimit || 'unknown'; counts[k] = (counts[k] || 0) + 1; }
  const recent = decisions.slice(-12).reverse();
  return { schema: c.schema, state: 'PAPER_ONLY', initializedAt: c.initializedAt, currentPolicy: c.currentPolicy,
    baselineHash: c.baseline?.policy?.hash, baselinePolicy: c.baseline?.policy, baselineAudit: c.baseline?.audit,
    currentAudit: c.audit, pinnedMigration: c.lastPinMigration || null, experimentPaused: c.experimentPaused,
    experimentError: c.experimentError || null, entryStreamState: c.entryStreamState, experiments: c.experiments || { books: [] },
    sizingPreview:c.sizingPreview||null, recentDecisions: recent, recentBindingLimits: counts, decisionSampleSize: decisions.length,
    sizingMode: 'BASELINE_WITH_BUDGET_FIXES', adaptiveState: 'IMPLEMENTED_BUT_NOT_VALIDATED_OR_APPLIED',
    appliedProfitChampion: null, baselineRollback: 'ACTIVE_BASELINE_UNCHANGED_NO_PROFIT_CHAMPION_PROMOTED',
    liveExecutionAllowed: false, paidApiCallsAllowed: false,
    evidenceNote: 'Cash posting reconciliation is not proof of executable profit. Historical missing receipts remain missing. Experiment quotes are provisional, not transactions.' };
}
