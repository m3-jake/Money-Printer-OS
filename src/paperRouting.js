import fs from 'node:fs';
import path from 'node:path';
import { proposeTrade } from './proposals.js';
import { routeDecision, marketRegime } from './regime.js';
import { isAggressivePaper } from './runtime.js';
import { appendJournal } from './store.js';

// Dollar venue proposals have sizeSol=0 and a separate stakeUsd. No implicit FX or
// scanner-account debit is introduced when another venue joins the paper router.
export function routePaperProposal({ state = null, existingProposal = null, pick = {}, assetClass = pick.assetClass || 'memecoin', sizeSol = 0, stakeUsd = null,
  strategy = null, regimes = state?.system?.regimes || {}, runtime = state?.runtime || {}, mode = 'paper', automatic = false, proposalId = null,
  platform = null, file = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data', 'paper-routing.json'), logger = appendJournal } = {}) {
  const paper = String(mode).toLowerCase() === 'paper', aggressive = isAggressivePaper(runtime, mode);
  if (!paper || automatic && !aggressive) return { proposal: null, decision: { decision: 'BLOCK', reason: 'paper-routing-mode-required', platform: null, proposalId: null } };
  const key = String(assetClass).toLowerCase(), observed = ['returnPct','pc5','changePct','volatilityPct','breadthPct'].some(k => Number.isFinite(pick[k]));
  const inputs = { ...regimes, [key]: regimes[key] || (observed ? marketRegime(pick) : { regime: 'unknown' }) };
  const decision = routeDecision({ assetClass: key, strategy: aggressive ? strategy : null, regimes: inputs });
  if (!automatic && ['pumpfun', 'kalshi', 'polymarket', 'robinhood'].includes(platform)) {
    decision.mappedPlatform = decision.platform; decision.platform = platform;
    decision.manualVenueSelection = true;
    if (decision.reason === 'unknown-asset-class') { decision.decision = 'ALLOW'; decision.reason = null; }
  }
  if (decision.decision === 'BLOCK') { logger({ type: 'central-route-decision', mode: 'PAPER', ...decision }); return { proposal: null, decision }; }
  let book = state;
  if (!book) {
    book = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { mode: 'PAPER', proposals: [] };
    if (book.mode !== 'PAPER' || !Array.isArray(book.proposals)) throw new Error('Invalid central paper proposal record');
  }
  const candidate = { ...pick, mint: String(pick.mint || pick.instrumentKey || `${key}:${pick.marketId || pick.ticker || pick.symbol || ''}`) };
  if (!candidate.mint.split(':').at(-1)) throw new Error('Paper route requires an instrument identifier');
  const proposal = existingProposal || proposeTrade(book, candidate, Number(sizeSol));
  if (proposalId) proposal.id = proposalId;
  if (!existingProposal) proposal.status = 'ROUTED';
  Object.assign(proposal, { assetClass: key, platform: decision.platform, stakeUsd, signalSource: pick.signalSource || pick.source || 'manual-paper', routeDecision: { ...decision, proposalId: proposal.id } });
  if (!state) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(book, null, 2)); fs.renameSync(tmp, file);
  }
  logger({ type: 'central-route-decision', mode: 'PAPER', ...proposal.routeDecision, automatic, signalSource: proposal.signalSource });
  return { proposal, decision: proposal.routeDecision };
}

export function bookRouteLogger(book) {
  return row => { book.routeDecisions ||= []; book.routeDecisions.push(row); book.routeDecisions = book.routeDecisions.slice(-100); };
}
