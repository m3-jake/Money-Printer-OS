import { handleRobinhoodRequest, startRobinhoodLoops, stopRobinhoodLoops, startPracticeLoop, stopPracticeLoop } from './robinhoodHttp.js';
import { handleRobinhoodEquitiesRequest, startRobinhoodEquitiesLoop, stopRobinhoodEquitiesLoop } from './robinhoodEquitiesHttp.js';
import { exitPresets, customExitPolicy, openLimitFor, aggressionParams, customExitBounds, MAX_OPEN_OVERRIDE } from './runtime.js';
import { evolutionChampionPolicy } from './learner.js';
import { dataCoverage } from './dataCoverage.js';
import { solanaBookView } from './solanaEconomics.js';
import { traderSwitches } from './killSwitches.js';
import { robinhoodReadiness } from './robinhoodAutoTrader.js';
import { holderRpcHealth } from './rpc.js';
import { walletScorecardView } from './walletScorecard.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, loadStateCached, stateStamp, readJournal, enqueueAction } from './store.js';
import { cfg } from './config.js';
import { readEvidenceMonitor } from './researchEvidenceStore.js';
import { readResearchControlPlane, attachControlPlaneToMonitor, leaderboardRows, championPublicationView, controlPlaneFiles } from './researchControlPlane.js';
import { seedProjectJournal } from './projectJournal.js';
import { fitnessSnapshot, writeFitnessFiles, solanaFitnessParts, polymarketFitnessParts } from './fitnessLedger.js';
import { robinhoodFitnessParts } from './robinhoodAutoTrader.js';
import { runSelfReport, latestSelfReport } from './selfReport.js';
import { saveResourcePolicy, resourceSnapshot, systemTelemetry } from './resourcePolicy.js';
// polymarketUS.js is parked except for credentials and the session arm: its scanner and single-order routes are not served.
import { usReadiness, configurePolymarketUS, armPolymarketUS, polymarketUSAccount } from './polymarketUS.js';
import { usComboJournalView, usComboSnapshot, buildUSCombo, quoteUSCombo, placeUSCombo, cancelUSRfq, setUSComboSettings, settleUSCombos, forgetUSCombo, startUSComboLoops, setUSComboAutopilot } from './polymarketUSCombos.js';
import { readApiUnitEconomics } from './apiUnitEconomics.js';
import { productEconomics, productIngestionAuthorized, productReadAuthorized } from './productEconomics.js';
import updateChannel from '../desktop/update-channel.cjs';
import { handlePlatformRequest, localMutationAllowed } from './core/http.js';
import { marketPlatform, closeMarketPlatform } from './core/platform.js';
import { practiceSnapshot,loadPracticeBook } from './robinhoodPractice.js';
import { comboPerformance } from './core/comboPerformance.js';
import { alphaDb } from './alphaDb.js';
import { creds as rhCreds,fetchAccount as rhFetchAccount,fetchHoldings as rhFetchHoldings } from './robinhoodTransport.js';
import { JOURNAL_FILE as RH_JOURNAL_FILE } from './robinhoodJournal.js';
import { BUILD_PROVENANCE } from './buildInfo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
const packageMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); 
const MAX_BODY = 32 * 1024;
const DATA_DIR = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || path.join(ROOT,'data'));
const UPDATE_STATUS_FILE = path.join(DATA_DIR,'update-status.json');
const UPDATE_REQUEST_FILE = path.join(DATA_DIR,'update-request.json');
// Desktop-shell preferences (read by desktop/main.cjs every ~1 s): background operation,
// login startup, and local Lab recovery. The shell owns applying them; this stores the choice.
const DESKTOP_PREFS_FILE = path.join(DATA_DIR,'desktop-prefs.json');
const DESKTOP_PREF_DEFAULTS = { runInBackground: true, startWithWindows: true, autoStartLab: true };
function readDesktopPrefs(){try{const v=JSON.parse(fs.readFileSync(DESKTOP_PREFS_FILE,'utf8'));return {...DESKTOP_PREF_DEFAULTS,...(v&&typeof v==='object'?v:{})}}catch{return {...DESKTOP_PREF_DEFAULTS}}}
function writeDesktopPrefs(patch={}){const next={...readDesktopPrefs()};for(const k of Object.keys(DESKTOP_PREF_DEFAULTS))if(typeof patch[k]==='boolean')next[k]=patch[k];next.updatedAt=Date.now();const tmp=DESKTOP_PREFS_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2));fs.renameSync(tmp,DESKTOP_PREFS_FILE);return next}
const RESEARCH_MONITOR_FILE = path.join(DATA_DIR,'research-monitor.json');
const RESEARCH_EVIDENCE_MONITOR_FILE = path.join(DATA_DIR,'research-evidence-monitor.json');
const RESEARCH_CAPTURE_STATUS_FILE = path.join(DATA_DIR,'research-capture-status.json');
function json(res, obj, status = 200, extraHeaders = {}) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-payload-bytes': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  });
  res.end(payload);
}

function queue(type, data = {}) {
  return enqueueAction({ type, ...data });
}
// Telemetry failure must never make a completed paper order look rejected.
function productTelemetry(fn) { try { return fn(productEconomics()); } catch (error) { console.warn('Product telemetry unavailable:', error.message); } }
function comboBuildResult(req, result) { productTelemetry(ledger => ledger.recordComboBuildActivation(req, result)); return result; }
// The channel is whatever desktop/main.cjs resolves from the same env (docs/RELEASE-CHANNEL.md). The
// supervisor records a `LAN <peer>` label when a cluster peer won the last check; anything else (or a
// status file written by an older build) shows the configured channel, never a stale URL.
function updaterState(){
  const resolved=updateChannel.resolveUpdateChannel(process.env);
  const base={current:packageMeta.version,channelKind:resolved.kind,channelUrl:resolved.url,channelError:resolved.configError};
  try { const st=JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE,'utf8')); const lan=typeof st.channel==='string'&&st.channel.startsWith('LAN '); return {...st,...base,channel:lan?st.channel:resolved.label}; }
  catch { return {status:'IDLE',available:null,...base,channel:resolved.label}; }
}
function requestUpdater(action){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const tmp=UPDATE_REQUEST_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify({action,ts:Date.now()}));fs.renameSync(tmp,UPDATE_REQUEST_FILE);
  return {ok:true,action};
}

function researchCaptureStatus(){try{return JSON.parse(fs.readFileSync(RESEARCH_CAPTURE_STATUS_FILE,'utf8'))}catch{return {schema:'mpo.research-capture-status.v1',updatedAt:null}}}
function labModuleStatuses(){const out={};for(const id of ['robinhood','robinhood-equities','polymarket','polymarket-combo']){try{const v=JSON.parse(fs.readFileSync(path.join(DATA_DIR,'lab-link','modules',`${id}.json`),'utf8'));if(v&&v.module===id)out[id]=v}catch{}}return out}
const readJupiterStatus = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'research-capture-status.json'), 'utf8')).jupiter || null; } catch { return null; } };
// One fitness record per module (docs/FITNESS-LEDGER.md). A failing module reports a blocker instead of throwing.
async function fitnessNow(s = loadStateCached()) {
  const at = Date.now(), part = fn => { try { return fn(); } catch (e) { return { blockers: [`unavailable: ${String(e?.message || e).slice(0, 160)}`] }; } };
  let pm; try { const ev = await import('./polymarketUSEvidence.js'); pm = part(() => polymarketFitnessParts(ev.polymarketFitness(), { now: at })); } catch (e) { pm = { blockers: [`unavailable: ${String(e?.message || e).slice(0, 160)}`] }; }
  return fitnessSnapshot({ now: at, solana: part(() => solanaFitnessParts(s, cfg, { now: at, jupiter: readJupiterStatus() })), robinhood: part(() => robinhoodFitnessParts({ at })), polymarket: pm });
}
function researchPlane(s = loadStateCached(), opts = {}){
  return readResearchControlPlane({dataDir:DATA_DIR,journalLimit:300,state:s,mode:cfg.mode,...opts});
}
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function enrichLeaderRow(row = {}, extra = {}) {
  const m = row.metrics || extra.metrics || {};
  const startedAt = finiteOrNull(row.startedAt || row.ts || row.createdAt || extra.startedAt);
  const realized = finiteOrNull(m.realizedPnl);
  const shadow = finiteOrNull(m.shadowPnl ?? m.validationPnl ?? m.heldOutAvgPct ?? m.geometricMeanPct);
  const dd = finiteOrNull(m.maxDrawdownPct);
  const trades = finiteOrNull(m.n ?? m.trades ?? m.tradeCount ?? m.samples ?? m.heldOutN);
  const confidence = finiteOrNull(m.confidence ?? m.monteCarloPassPct ?? m.winRatePct);
  const status = row.status || row.decision || extra.status || row.gate?.nextMode || row.gate?.reason || extra.reason || null;
  return {
    ...row,
    config: row.config || extra.config || '?',
    startedAt,
    status,
    decision: row.decision || row.gate?.reason || extra.reason || status,
    metrics: {
      ...m,
      n: trades,
      realizedPnl: realized,
      shadowPnl: shadow,
      maxDrawdownPct: dd,
      confidence,
    },
    gate: row.gate || { reason: extra.reason || 'unknown', eligible: false, nextMode: extra.nextMode || null, live: false },
  };
}
function experimentLeaderRow(x = {}) {
  const gate = x.evidence?.gate || {};
  const metrics = x.evidence?.metrics || x.metrics || {};
  return enrichLeaderRow({
    config: x.candidateId || x.id,
    startedAt: x.createdAt || x.observedAt,
    status: x.lifecycle?.stage || x.evidenceStage || 'RESEARCH',
    decision: x.lifecycle?.stage || x.evidenceStage || null,
    metrics: {
      n: metrics.n ?? metrics.trials ?? gate.trials,
      shadowPnl: metrics.shadowPnl ?? metrics.heldOutAvgPct ?? gate.netImprovementPct,
      validationPnl: metrics.validationPnl ?? metrics.geometricMeanPct,
      maxDrawdownPct: metrics.maxDrawdownPct ?? gate.maxDrawdownPct,
      confidence: metrics.confidence ?? metrics.monteCarloPassPct,
    },
    gate: { reason: x.lifecycle?.stage || x.evidenceStage || 'research-only', eligible: false, nextMode: x.paperEligible ? 'shadow' : null, live: false },
  });
}
function decorateResearchMonitor(raw = {}, s = {}) {
  const e = evolutionLoopView(s.evolutionLoop || s.evolution?.loop || {});
  const policy = s.system?.activeEvolutionPolicy || raw.activeEvolutionPolicy || null;
  const champ = e.champion || {};
  const plane = readResearchControlPlane({ dataDir: DATA_DIR, journalLimit: 1 });
  const experiments = (plane.experiments || []).slice(0, 12).map(experimentLeaderRow);
  const champRow = champ.id && champ.id !== 'BASE'
    ? [enrichLeaderRow({ config: champ.id, metrics: champ.metrics || {}, startedAt: champ.promotedAt, status: champ.stage || policy?.stage || 'SHADOW', gate: { reason: 'evolution-champion', eligible: false, nextMode: 'shadow', live: false } })]
    : [];
  const incoming = Array.isArray(raw.leaderboard) ? raw.leaderboard.map(row => enrichLeaderRow(row)) : [];
  const seen = new Set();
  const leaderboard = [];
  for (const row of [...incoming, ...champRow, ...experiments]) {
    const key = String(row.config || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    leaderboard.push(row);
    if (leaderboard.length >= 12) break;
  }
  const stage = policy?.stage || champ.stage || 'BASE';
  return {
    ...raw,
    evidence: raw.evidence || readEvidenceMonitor(RESEARCH_EVIDENCE_MONITOR_FILE),
    capture: raw.capture || researchCaptureStatus(),
    activeEvolutionPolicy: policy
      ? { id: policy.id || champ.id || 'BASE', stage: policy.stage || stage, hotReload: !!policy.hotReload }
      : { id: champ.id || 'BASE', stage, hotReload: false },
    champion: {
      id: champ.id || 'BASE',
      stage: champ.stage || policy?.stage || 'BASE',
      promotedAt: champ.promotedAt || null,
      metrics: champ.metrics || {},
    },
    promotion: {
      automaticLivePromotionAllowed: false,
      paperCanary: String(stage).toUpperCase() === 'PAPER_CANARY',
      stage,
      championId: s.runtime?.activeEvolutionChampionId || champ.id || 'BASE',
    },
    experiments,
    leaderboard,
  };
}
function evolutionFallbackMonitor(s) {
  const e = evolutionLoopView(s.evolutionLoop || s.evolution?.loop || {});
  return {
    schema: 1,
    source: s.labLink?.connected ? 'evolution-lab' : 'evolution-fallback',
    labLink: labLinkView(s),
    status: String(s.labLink && !s.labLink.connected && s.labLink.source !== 'none' ? 'stale' : e.status || 'COLLECTING').toLowerCase(),
    phase: 'evolution',
    updatedAt: s.system?.lastCycle || Date.now(),
    machine: s.labLink?.labName || process.env.COMPUTERNAME || process.env.HOSTNAME || 'local',
    workers: Number(e.workerCount || 0),
    researchMode: e.researchMode || 'NORMAL',
    researchProfile: e.researchProfile || null,
    generation: Number(e.activeGeneration || e.generation || 0),
    lifetimeTested: Number(e.variantsTested || 0),
    total: Number(e.currentBatchSize || 0),
    completed: Number(e.currentBatchCompleted || 0),
    queueRemaining: Math.max(0, Number(e.currentBatchSize || 0) - Number(e.currentBatchCompleted || 0)),
    running: String(e.currentBatchStatus || '').toUpperCase() === 'SCORING' ? [{ config: `GEN ${e.activeGeneration || Number(e.generation || 0) + 1}`, params: { workers: Number(e.workerCount || 0), batch: Number(e.currentBatchSize || 0) } }] : [],
    recent: (e.events || []).slice(0, 5).map(x => ({ ts: x.ts, config: x.type || 'EVOLUTION', pnl: null, gate: x.message || '' })),
    leaderboard: [],
    rejections: {},
    current: String(e.currentBatchStatus || '').toUpperCase() === 'SCORING' ? `${e.researchMode === 'BEAST' || e.researchMode === 'FURNACE' ? `${e.researchMode} · ` : ''}Generation ${e.activeGeneration || Number(e.generation || 0) + 1} scoring ${Number(e.currentBatchCompleted || 0)}/${Number(e.currentBatchSize || 0)} variants` : `${e.researchMode === 'BEAST' || e.researchMode === 'FURNACE' ? `${e.researchMode} · ` : ''}Generation ${e.generation || 0} complete · next batch scheduled`,
    note: `Evolution ${e.researchMode === 'BEAST' ? 'beast furnace' : e.researchMode === 'FURNACE' ? 'furnace' : 'engine'} active · ${Number(e.variantsTested || 0).toLocaleString()} lifetime variants tested.`,
  };
}
function researchMonitorState() {
  const s = loadStateCached();
  const plane = researchPlane(s);
  const evidence = readEvidenceMonitor(RESEARCH_EVIDENCE_MONITOR_FILE);
  const capture = researchCaptureStatus();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RESEARCH_MONITOR_FILE, 'utf8'));
    raw = { ...raw, source: raw.source || 'replay-lab', evidence, capture };
  } catch {
    raw = { ...evolutionFallbackMonitor(s), evidence, capture };
  }
  return {...decorateResearchMonitor(attachControlPlaneToMonitor(raw, plane), s),modules:labModuleStatuses()};
}

function meshRequest(method, pathname, payload) {
  return new Promise(resolve => {
    const data = payload ? JSON.stringify(payload) : '';
    const req = http.request({ host:'127.0.0.1', port:Number(process.env.MONEY_PRINTER_MESH_HTTP_PORT||18800), path:pathname, method, headers:data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{} }, res => {
      let raw=''; res.on('data',c=>raw+=c); res.on('end',()=>{ try{resolve({status:res.statusCode||200,body:JSON.parse(raw||'{}')})}catch{resolve({status:502,body:{error:'mesh response invalid'}})} });
    });
    req.on('error',e=>resolve({status:503,body:{error:'network mesh unavailable',detail:e.message}}));
    req.setTimeout(1200,()=>req.destroy(new Error('mesh timeout'))); if(data)req.write(data); req.end();
  });
}

async function body(req) {
  return new Promise(resolve => {
    let raw = '';
    let tooLarge = false;
    req.on('data', d => {
      if (tooLarge) return;
      raw += d;
      if (Buffer.byteLength(raw) > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ __error: 'body too large' });
      try {
        const parsed = JSON.parse(raw || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { __error: 'JSON body must be an object' });
      } catch { resolve({ __error: 'invalid JSON' }); }
    });
  });
}


function candidateView(a = {}) {
  return {
    mint: a.mint, symbol: a.symbol, name: a.name, stage: a.stage,
    score: a.score, edgeScore: a.edgeScore, fastEdgeScore: a.fastEdgeScore,
    explosionScore: a.explosionScore, moonScore: a.moonScore,
    executionScore: a.executionScore, rugScore: a.rugScore,
    pc5: a.pc5, liq: a.liq, ageMin: a.ageMin,
    dominantSignal: a.dominantSignal,
    priceUsd: a.priceUsd, volumeH1: a.volumeH1, volumeH24: a.volumeH24,
    txnsH1: a.txnsH1, fdv: a.fdv, marketCap: a.marketCap,
    warnings: Array.isArray(a.warnings) ? a.warnings.slice(0, 6) : [],
  };
}

function positionView(p = {}) {
  return {
    id: p.id, mint: p.mint, symbol: p.symbol,
    sizeSol: p.sizeSol, remainingSol: p.remainingSol,
    entryPrice: p.entryPrice, lastPrice: p.lastPrice,
    openedAt: p.openedAt, score: p.score, fastEdgeScore: p.fastEdgeScore,
    executionScore: p.executionScore,
  };
}

function historyView(h = {}) {
  return { symbol: h.symbol, mint: h.mint, pnlSol: h.pnlSol, returnPct: h.returnPct, reason: h.reason, closedAt: h.closedAt };
}

function journalView(x = {}) {
  return { ts: x.ts, type: x.type, message: x.message, symbol: x.symbol, error: x.error, mint: x.mint };
}

function proposalView(p = {}) {
  return { id: p.id, status: p.status, type: p.type, title: p.title, reason: p.reason, createdAt: p.createdAt };
}

function systemView(s = {}, policy = null) {
  return {
    paused: !!s.paused, killSwitch: !!s.killSwitch, health: s.health, lastCycle: s.lastCycle,
    lastError: s.lastError, startedAt: s.startedAt, streamEvents: s.streamEvents, learner: s.learner || null,
    metrics: { ...(s.metrics || {}), ...systemTelemetry() }, resources: resourceSnapshot(), opportunityFunnel: s.opportunityFunnel || null, diagnostics: (s.diagnostics || []).slice(-20),
    activeEvolutionPolicy: policy || s.activeEvolutionPolicy || null,
  };
}

function compactSeries(xs,max=1600,recent=600){
  const a=Array.isArray(xs)?xs:[];if(a.length<=max)return a;
  const tail=a.slice(-Math.min(recent,max-2)),head=a.slice(0,a.length-tail.length),slots=max-tail.length;
  const sampled=[];if(slots>1&&head.length){const step=(head.length-1)/(slots-1);for(let i=0;i<slots;i++)sampled.push(head[Math.round(i*step)])}
  return [...sampled,...tail];
}
// alpha.53: what the trader knows about the (external) Evolution Lab. Always present, so the
// HUD can say 'not connected' instead of showing a stale in-process loop as if it were alive.
function labLinkView(s={}){
  const l=s.labLink||{};
  return {connected:!!l.connected,source:l.source||'none',ageMs:l.ageMs??null,labNodeId:l.labNodeId||null,labName:l.labName||null,labVersion:l.labVersion||null,
    generation:Number(l.generation||0),status:l.status||null,championId:l.championId||null,championPublishedAt:l.championPublishedAt||null,checkedAt:l.checkedAt||null,error:l.error||null,
    bridgeConfigured:!!(process.env.MONEY_PRINTER_BRIDGE_DIR&&process.env.MONEY_PRINTER_BRIDGE_KEY)};
}
function evolutionLoopView(e={}, {now=Date.now()}={}){
  const c=e?.champion||{},m=c.metrics||{},pub=championPublicationView(c,{now});
  return {generation:e.generation||0,variantsTested:e.variantsTested||0,survivors:e.survivors||0,status:e.status||'COLLECTING',workerCount:e.workerCount||0,
    activeGeneration:e.activeGeneration??null,currentBatchSize:e.currentBatchSize||0,currentBatchCompleted:e.currentBatchCompleted||0,currentBatchStatus:e.currentBatchStatus||null,
    researchMode:e.researchMode||'NORMAL',researchProfile:e.researchProfile||null,
    lastGenerationMs:e.lastGenerationMs||0,lastGenerationCompletedAt:e.lastGenerationCompletedAt||null,
    cluster:{enabled:!!e.cluster?.enabled},datasetSamples:e.datasetSamples||0,nextGenerationProgress:e.nextGenerationProgress||0,
    champion:{id:pub.id,stage:pub.stage,previousId:pub.previousId,promotedAt:pub.promotedAt,ageMs:pub.ageMs,metrics:{heldOutAvgPct:m.heldOutAvgPct,geometricMeanPct:m.geometricMeanPct,compoundedMultiple:m.compoundedMultiple,activityPct:m.activityPct,profitVelocityPctPerMin:m.profitVelocityPctPerMin,maxDrawdownPct:m.maxDrawdownPct,monteCarloPassPct:m.monteCarloPassPct}},
    challengers:leaderboardRows(e,{now}),
    events:(e.events||[]).slice(0,25).map(x=>({ts:x.ts,type:x.type,message:x.message}))};
}

function snapshot() {
  const s = loadStateCached();
  const plane = researchPlane(s, {includeJournal:false,includeExperiments:false,journalLimit:1});
  const now = Number(plane.updatedAt || Date.now());
  return {
    paperStartSol: s.paperStartSol,
    cashSol: s.cashSol,
    positions: (s.positions || []).map(positionView),
    proposals: (s.proposals || []).filter(x => x.status === 'PENDING').slice(0, 20).map(proposalView),
    history: (s.history || []).slice(-40).map(historyView),
    watchlist: (s.watchlist || []).slice(0, 48).map(candidateView),
    market: s.market || {},
    memeIndex: s.memeIndex || {},
    runtime: s.runtime || {},
    effectiveControls: (() => { const rt = s.runtime || {}, champ = cfg.mode === 'paper' ? evolutionChampionPolicy(s) : null; return { exit: exitPresets[rt.exitPreset] || customExitPolicy(rt), customExit: customExitPolicy(rt), labChampionExit: champ ? { takePct: champ.takePct, stopPct: champ.stopPct, maxHoldMin: champ.maxHoldMin } : null, openLimit: openLimitFor(rt), autoOpenLimit: aggressionParams(rt.aggression).maxOpenPositions, bounds: { ...customExitBounds, maxOpenPositions: MAX_OPEN_OVERRIDE }, presets: Object.keys(exitPresets) }; })(),
    system: systemView(s.system, plane.activeEvolutionPolicy),
    stats: s.stats || {},
    solanaBook: solanaBookView(s, cfg),
    portfolio: s.portfolio || null,
    portfolioSeries: compactSeries(s.portfolioSeries,1600,600),
    dailyPnlSol: s.dailyPnlSol || 0,
    hourlyPnlSol: s.hourlyPnlSol || 0,
    consecutiveLosses: s.consecutiveLosses || 0,
    evolutionLoop: evolutionLoopView(s.evolutionLoop || s.evolution?.loop || {}, {now}),
    labLink: labLinkView(s),
    furnaceActivity: plane.furnaceActivity,
    activeEvolutionPolicy: plane.activeEvolutionPolicy,
    latestChampion: plane.latestChampion,
    paperCanary: plane.paperCanary,
    liveActivationAllowed: false,
    automaticLivePromotionAllowed: false,
    liveExecution: 'manual',
    walletIntel: {
      wallets: Object.values(s.research?.walletProfiles || {}).sort((a,b)=>(b.recurrenceScore||0)-(a.recurrenceScore||0)).slice(0,24),
      holderRpc: holderRpcHealth(),
      scorecard: walletScorecardView(),
    },
    researchSummary: {
      universeCount: Object.keys(s.research?.universe || {}).length,
      postmortemCount: (s.research?.postmortems || []).length,
      lessonsCount: (s.research?.lessons || []).length,
      experimentCount: (s.research?.experiments || []).length,
      modelHealth: s.research?.modelHealth || { status: 'COLLECTING' },
      learner: s.system?.learner || null,
    },
    mode: cfg.mode,
    build: { version: packageMeta.version, productName: packageMeta.productName || 'Money Printer OS',provenance:BUILD_PROVENANCE },
    config: {
      scanIntervalSec: cfg.scanIntervalSec,
      maxOpenPositions: cfg.maxOpenPositions,
      maxTotalExposureSol: cfg.maxTotalExposureSol,
      dailyLossLimitSol: cfg.dailyLossLimitSol,
      stopLossPct: cfg.stopLossPct,
      jitoEnabled: cfg.jitoEnabled,
      directStreamEnabled: cfg.directStreamEnabled,
      socialConfigured: !!cfg.socialFeedUrl,
    },
  };
}

export function startDashboard() {
  marketPlatform().setLegacyReaders({solana:loadStateCached,robinhoodPractice:()=>practiceSnapshot({dataDir:path.dirname(RH_JOURNAL_FILE)}),robinhoodPracticeBook:()=>loadPracticeBook(path.dirname(RH_JOURNAL_FILE)),usCombos:usComboJournalView,
    solanaResearch:()=>loadStateCached().research,walletScorecard:()=>walletScorecardView(),
    // Read-only venue account readers for reconciliation (GET requests only).
    venueAccounts:{
      robinhood:async()=>{if(!rhCreds().apiKey||!rhCreds().privateKeyBase64)return {ok:false,code:'NO_CREDENTIALS',error:'ROBINHOOD_API_KEY / ROBINHOOD_PRIVATE_KEY not set'};const a=await rhFetchAccount(),h=await rhFetchHoldings(a.accountNumber);return {ok:true,cashUsd:a.buyingPowerUsd,cashLabel:'crypto buying power',positions:h.map(x=>({asset:x.assetCode,qty:x.totalQty}))};},
      'polymarket-us':async()=>{const r=await polymarketUSAccount({force:true});if(r.keyStatus==='KEYS_NEEDED')return {ok:false,code:'NO_CREDENTIALS',error:'Polymarket US keys not set'};if(!r.ok)return {ok:false,code:/401|403|key/i.test(String(r.error||r.keyStatus))?'AUTH_ERROR':'READ_FAILED',error:String(r.error||r.keyStatus||'read failed')};return {ok:true,cashUsd:r.balance?.currentBalance??null,cashLabel:'current balance',positions:null};},
    },
    txEvents:({since,limit})=>alphaDb().prepare('SELECT signature,event_index eventIndex,ts,slot,mint,wallet,side,token_delta tokenDelta,sol_delta solDelta FROM tx_events WHERE ts>=? ORDER BY ts DESC LIMIT ?').all(since,limit)});
  // Lab champions -> strategy registry, once now and every minute. Failures stay in the snapshot, never thrown.
  // Lab champions -> registry and legacy books -> ledger mirror, now and every minute.
  const syncLab=()=>{try{marketPlatform().syncLab();}catch{}try{marketPlatform().syncLegacyLedger();}catch{}try{marketPlatform().publishPredictionHandoff();}catch{}};syncLab();const labSyncTimer=setInterval(syncLab,60_000);labSyncTimer.unref();
  // Catch the project journal up with this build's history (packaged builds ship it; no git there).
  const seeded = seedProjectJournal({ journalFile: controlPlaneFiles(DATA_DIR).journal, appRoot: ROOT });
  if (seeded.appended || seeded.error) console.log(`[journal] +${seeded.appended} from ${seeded.source || 'none'}${seeded.error ? ' error: ' + seeded.error : ''}`);
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if(u.pathname.startsWith('/api/platform/'))return await handlePlatformRequest(req,res,u,{json,body});
      if(u.pathname==='/api/robinhood'||u.pathname.startsWith('/api/robinhood/'))return await handleRobinhoodRequest(req,res,u,{json,body});
      if(u.pathname==='/api/robinhood-equities'||u.pathname.startsWith('/api/robinhood-equities/'))return await handleRobinhoodEquitiesRequest(req,res,u,{json});
      if (req.method === 'GET' && u.pathname === '/') {
        productTelemetry(ledger => ledger.recordVisit(req, res, u));
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        });
        return res.end(html);
      }
      if (req.method === 'GET' && u.pathname.startsWith('/assets/')) {
        const rel = decodeURIComponent(u.pathname.slice('/assets/'.length));
        const base = path.join(ROOT, 'public', 'assets');
        const file = path.resolve(base, rel);
        if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404); return res.end('not found');
        }
        const ext = path.extname(file).toLowerCase();
        const types = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.glb':'model/gltf-binary'};
        res.writeHead(200, {'content-type': types[ext] || 'application/octet-stream','cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && u.pathname.startsWith('/js/')) {
        const rel = decodeURIComponent(u.pathname.slice('/js/'.length));
        const base = path.join(ROOT, 'public', 'js');
        const file = path.resolve(base, rel);
        if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || path.extname(file).toLowerCase() !== '.js') {
          res.writeHead(404); return res.end('not found');
        }
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && u.pathname.startsWith('/css/')) {
        const rel = decodeURIComponent(u.pathname.slice('/css/'.length));
        const base = path.join(ROOT, 'public', 'css');
        const file = path.resolve(base, rel);
        if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.writeHead(404); return res.end('not found');
        }
        if (path.extname(file).toLowerCase() !== '.css') { res.writeHead(404); return res.end('not found'); }
        const cssType = 'text/css';
        res.writeHead(200, {
          'content-type': cssType + '; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'GET' && u.pathname === '/api/state') {
        // This response contains live CPU/RAM telemetry. A persisted-state-only
        // ETag can pin an idle UI to the first CPU sample (which is intentionally 0).
        const tag = `\"${stateStamp()}-${Math.floor(Date.now() / 1000)}\"`;
        res.setHeader('etag', tag);
        return json(res, snapshot(), 200, { etag: tag });
      }
      if (req.method === 'GET' && u.pathname === '/api/health') {
        const s = loadState();
        return json(res, {
          ok: s.system?.health !== 'DEGRADED',
          health: s.system?.health || 'UNKNOWN',
          lastCycle: s.system?.lastCycle || null,
          metrics: { ...(s.system?.metrics || {}), ...systemTelemetry() },
          diagnostics: s.system?.diagnostics || [],
          switches: traderSwitches({ readiness: (() => { try { return robinhoodReadiness(); } catch { return null; } })(), state: s }),
        });
      }
      if (req.method === 'GET' && u.pathname === '/api/journal') {
        const requested = Number(u.searchParams.get('limit') || 220);
        const limit = Math.max(20, Math.min(500, Number.isFinite(requested) ? Math.trunc(requested) : 220));
        return json(res, readJournal(limit).map(journalView));
      }
      if (req.method === 'GET' && u.pathname === '/api/evolution') { const st = loadStateCached(); return json(res, { ...(st.evolution || {}), loop: evolutionLoopView(st.evolutionLoop || st.evolution?.loop || {}), labLink: labLinkView(st) }); }
      if (req.method === 'GET' && u.pathname === '/api/network') { const r=await meshRequest('GET','/state'); return json(res,r.body,r.status); }
      if (req.method === 'GET' && u.pathname === '/api/resources') return json(res, resourceSnapshot());
      if (req.method === 'GET' && u.pathname === '/api/scoreboard') { const sb=await import('./scoreboard.js'); return json(res, await sb.readScoreboard()); }
      if (req.method === 'GET' && u.pathname === '/api/data-coverage') return json(res, dataCoverage(DATA_DIR, { force: u.searchParams.get('force') === '1' }));
      if (req.method === 'GET' && u.pathname === '/api/desktop-prefs') return json(res, readDesktopPrefs());
      if (req.method === 'GET' && u.pathname === '/api/unit-economics') return json(res, readApiUnitEconomics());
      if (req.method === 'GET' && u.pathname === '/api/product-economics') {
        if (!productReadAuthorized(req)) return json(res, {ok:false,error:'Product reporting requires localhost or a server token'}, 403);
        return json(res, productEconomics().summary());
      }
      if (req.method === 'GET' && u.pathname === '/api/polymarket-us/readiness') return json(res, usReadiness());
      if (req.method === 'GET' && u.pathname === '/api/polymarket-us/evidence') { const ev=await import('./polymarketUSEvidence.js'); return json(res, {...ev.evidenceSummary(),lab:{proposal:ev.labComboProposal(),status:labModuleStatuses()['polymarket-combo']||null}}); }
      if (req.method === 'GET' && u.pathname === '/api/polymarket-us/account') return json(res, await polymarketUSAccount());
      if (req.method === 'GET' && u.pathname === '/api/polymarket-us/combos/journal') { const j=usComboJournalView({historyLimit:500}); return json(res, {...j,performance:comboPerformance(j.history,j.open)}); }
      if (req.method === 'GET' && u.pathname === '/api/polymarket-us/combos') return json(res, await usComboSnapshot());
      if (req.method === 'GET' && u.pathname === '/api/update') return json(res, updaterState());
      if (req.method === 'GET' && u.pathname === '/api/research-monitor') return json(res, researchMonitorState());
      if (req.method === 'GET' && u.pathname === '/api/research-control-plane') return json(res, researchPlane());
      if (req.method === 'GET' && u.pathname === '/api/fitness') return json(res, await fitnessNow());
      if (req.method === 'GET' && u.pathname === '/api/self-report/latest') { const r = latestSelfReport(DATA_DIR); return r ? json(res, r) : json(res, { ok: false, error: 'No self-report yet; the first one is written about a minute after start.' }, 404); }
      if (req.method === 'GET' && u.pathname === '/api/project-journal') return json(res, researchPlane().journal);

      if (req.method !== 'POST') {
        res.writeHead(404);
        return res.end('not found');
      }

      if (u.pathname === '/api/product-economics/event') {
        if (!productIngestionAuthorized(req)) return json(res, {ok:false,error:'Authenticated server ingestion is required'}, 401);
        const event = await body(req);
        if (event.__error) return json(res, {ok:false,error:event.__error}, 400);
        try { return json(res, productEconomics().record(event)); }
        catch (error) { return json(res, {ok:false,error:error.message}, 400); }
      }

      // Server-to-server revenue ingestion above retains its explicit bearer authentication.
      // Every desktop mutation below, including legacy queues and updater requests, is local JSON.
      if(!localMutationAllowed(req))return json(res,{ok:false,error:'Local same-origin JSON request required'},403);
      if (u.pathname === '/api/pause') { const a = queue('toggle-pause'); return json(res, { ok: true, queued: true, actionId: a.id }); }
      if (u.pathname === '/api/kill') { const a = queue('toggle-kill'); return json(res, { ok: true, queued: true, actionId: a.id }); }
      if (u.pathname === '/api/reset') {
        const b = await body(req);
        if (b.__error) return json(res, { ok: false, error: b.__error }, 400);
        const amount = Number(b.amountSol);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return json(res, { ok: false, error: 'amountSol must be between 0 and 1,000,000' }, 400);
        const a = queue('reset-paper', { amountSol: amount });
        return json(res, { ok: true, queued: true, actionId: a.id, amountSol: amount });
      }
      if (u.pathname === '/api/clear-error') { queue('clear-error'); return json(res, { ok: true }); }
      if (u.pathname === '/api/resources') { const b=await body(req); if(b.__error)return json(res,{ok:false,error:b.__error},400); return json(res,{ok:true,policy:saveResourcePolicy({cpuPercent:b.cpuPercent,memoryGB:b.memoryGB,diskGB:b.diskGB},'manual')}); }
      if (u.pathname === '/api/resources/sync') return json(res,{ok:true,policy:saveResourcePolicy({},'hive')});
      if (u.pathname === '/api/polymarket-us/config') { const b=await body(req); if(b.__error)return json(res,{ok:false,error:b.__error},400); try{return json(res,{ok:true,readiness:configurePolymarketUS(b)})}catch(e){return json(res,{ok:false,error:String(e.message||e)},400)} }
      if (u.pathname === '/api/polymarket-us/arm') { const b=await body(req); if(b.__error)return json(res,{ok:false,error:b.__error},400); try{return json(res,{ok:true,readiness:armPolymarketUS(!!b.armed)})}catch(e){return json(res,{ok:false,error:String(e.message||e)},400)} }
      if (u.pathname.startsWith('/api/polymarket-us/combos/')) {
        const b = await body(req); if (b.__error) return json(res, { ok:false, error:b.__error }, 400);
        const comboFail = e => json(res, { ok:false, error:String(e.message||e), code:e.code||'unknown' }, 400);
        if (u.pathname === '/api/polymarket-us/combos/build') { try{return json(res,comboBuildResult(req,{ok:true,combo:buildUSCombo({legKeys:b.legKeys,stakeUsd:b.stakeUsd})}))}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/quote') { try{return json(res,{ok:true,quote:await quoteUSCombo({legKeys:b.legKeys,stakeUsd:b.stakeUsd})})}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/place') { try{return json(res,await placeUSCombo({legKeys:b.legKeys,stakeUsd:b.stakeUsd,mode:b.mode,rfqId:b.rfqId,quoteId:b.quoteId,limitPrice:b.limitPrice,confirmation:b.confirmation,placedBy:'manual'}))}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/cancel-rfq') { try{return json(res,{ok:true,...await cancelUSRfq({rfqId:b.rfqId})})}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/apply-lab') { try{const ev=await import('./polymarketUSEvidence.js');const p=ev.labComboProposal();if(!p||!p.valid)return json(res,{ok:false,error:p?.reason||'No Lab proposal to apply'},400);if(!p.paperAllowed)return json(res,{ok:false,error:`Lab proposal is ${p.championState}, not cleared for paper`},409);return json(res,{ok:true,settings:setUSComboSettings(p.params),applied:p.id})}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/autopilot') { try{return json(res,{ok:true,autopilot:await setUSComboAutopilot(b)})}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/settings') { try{return json(res,{ok:true,settings:setUSComboSettings(b)})}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/settle') { try{return json(res,{ok:true,...await settleUSCombos({force:true})})}catch(e){return comboFail(e)} }
        if (u.pathname === '/api/polymarket-us/combos/forget') { try{return json(res,forgetUSCombo({id:b.id,confirmation:b.confirmation}))}catch(e){return comboFail(e)} }
        res.writeHead(404); return res.end('not found');
      }
      if (u.pathname === '/api/desktop-prefs') { const b=await body(req); if(b.__error)return json(res,{ok:false,error:b.__error},400); return json(res,{ok:true,prefs:writeDesktopPrefs(b)}); }
      if (u.pathname === '/api/update/check') return json(res, requestUpdater('check'));
      if (u.pathname === '/api/update/install') return json(res, requestUpdater('install')); 
      if (u.pathname === '/api/network/chat') { const b=await body(req); if(b.__error)return json(res,{ok:false,error:b.__error},400); const r=await meshRequest('POST','/chat',{text:b.text}); return json(res,r.body,r.status); }

      const mint = u.searchParams.get('mint');
      if (u.pathname === '/api/exit') {
        if (!mint) return json(res, { ok: false, error: 'missing mint' }, 400);
        const a = queue('exit', { mint });
        return json(res, { ok: true, queued: true, actionId: a.id });
      }
      if (u.pathname === '/api/enter') {
        if (!mint) return json(res, { ok: false, error: 'missing mint' }, 400);
        const a = queue('enter', { mint });
        return json(res, { ok: true, queued: true, actionId: a.id });
      }

      const b = await body(req);
      if (b.__error) return json(res, { ok: false, error: b.__error }, 400);
      let action;
      if (u.pathname === '/api/favorite') action = queue('favorite', { mint: b.mint, kind: b.kind || 'favorite' });
      else if (u.pathname === '/api/runtime') action = queue('runtime', { patch: b });
      else if (u.pathname === '/api/profile') action = queue('profile', { profile: b.profile });
      else if (u.pathname === '/api/autonomy') action = queue('autonomy', { level: b.level });
      else if (u.pathname === '/api/proposal') action = queue(b.action === 'approve' ? 'approve-proposal' : 'reject-proposal', { proposalId: b.id });
      else { res.writeHead(404); return res.end('not found'); }
      return json(res, { ok: true, queued: true, actionId: action.id });
    } catch (error) {
      return json(res, { ok: false, error: String(error.message || error) }, 500);
    }
  });

  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  // The combo loop only settles journalled combos; it never places anything.
  try { startUSComboLoops(); } catch { /* combo loops are optional */ }
  startRobinhoodLoops();
  startPracticeLoop({ dataDir: DATA_DIR });
  server.on('close',()=>{ clearInterval(labSyncTimer); stopRobinhoodLoops(); stopPracticeLoop(); closeMarketPlatform(); });
  startRobinhoodEquitiesLoop();
  // The Lab reads <data>/lab-link/fitness/*.json; refresh it every minute (first write shortly after start).
  const writeFitness = () => fitnessNow().then(snap => writeFitnessFiles(DATA_DIR, snap)).catch(() => {});
  const fitnessTimer = setInterval(writeFitness, 60000), fitnessFirst = setTimeout(writeFitness, 5000);
  fitnessTimer.unref?.(); fitnessFirst.unref?.();
  server.on('close', () => { clearInterval(fitnessTimer); clearTimeout(fitnessFirst); });
  // Daily self-report: rewritten hourly; the first run on a new day finalizes yesterday's and journals it.
  const writeReport = () => fitnessNow().then(fitness => { const r = runSelfReport({ dataDir: DATA_DIR, fitness, state: { ...loadStateCached(), mode: cfg.mode } }); if (r.error) console.log(`[self-report] ${r.error}`); }).catch(() => {});
  const reportTimer = setInterval(writeReport, 60 * 60000), reportFirst = setTimeout(writeReport, 60000);
  reportTimer.unref?.(); reportFirst.unref?.();
  server.on('close', () => { clearInterval(reportTimer); clearTimeout(reportFirst); });
  server.on('close',()=>stopRobinhoodEquitiesLoop());
  server.listen(cfg.dashboardPort, cfg.dashboardHost, () => console.log(`Dashboard: http://${cfg.dashboardHost}:${cfg.dashboardPort}`));
  return server;
}
