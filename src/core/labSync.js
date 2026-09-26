import fs from 'node:fs';
import path from 'node:path';
import { championState, championPaperAllowed } from '../championState.js';
import { labChampionLifecycle, promotionCheck, STRATEGY_STATES } from './strategies.js';

// Evolution Lab champions mirrored into the common strategy registry. The Lab keeps its own
// lifecycle and gates; the registry applies the common promotion gate on top, so a Lab PAPER
// champion only reaches PAPER here when the common criteria pass too. Read-only on the Lab side.
export const LAB_CHAMPION_SOURCES = Object.freeze([
  { id: 'lab-solana', file: 'champion.json', name: 'Solana meme (Lab champion)', markets: ['solana'], probabilistic: false },
  { id: 'lab-robinhood', file: 'robinhood-champion.json', name: 'Robinhood crypto (Lab champion)', markets: ['robinhood'], probabilistic: false },
  { id: 'lab-robinhood-equities', file: 'robinhood-equities-champion.json', name: 'Robinhood equities (Lab champion)', markets: ['robinhood'], probabilistic: false },
  { id: 'lab-polymarket', file: 'polymarket-champion.json', name: 'Polymarket CLOB (Lab champion)', markets: ['polymarket'], probabilistic: true },
  { id: 'lab-polymarket-combo', file: 'polymarket-combo-champion.json', name: 'Polymarket US combos (Lab champion)', markets: ['polymarket-us'], probabilistic: true },
]);

const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const abs = v => (num(v) === null ? null : Math.abs(num(v)));

// Only fields a Lab record states explicitly are mapped. Anything else stays null and the
// common gate names it as a blocker. Percent returns map to outOfSampleNetPct, never to USD.
export function labEvidence(doc) {
  if (!doc || typeof doc !== 'object') return {};
  if (doc.schema === 'mpo.lab-champion.v1') {
    const m = doc.champion?.metrics || {};
    return { sampleSize: num(m.heldOutN), outOfSampleNetPct: num(m.heldOutAvgPct), maxDrawdownPct: abs(m.maxDrawdownPct),
      positiveFoldShare: num(m.consistencyPct) === null ? null : num(m.consistencyPct) / 100, costsModeled: doc.evidence?.feesModeled === true ? true : null,
      source: 'lab-champion.v1' };
  }
  const c = doc.candidate || {}, h = c.holdout && typeof c.holdout === 'object' ? c.holdout : null;
  return { sampleSize: num(h?.trades ?? h?.combos), outOfSampleNetPct: num(h?.netReturnPct ?? h?.netPct), maxDrawdownPct: abs(h?.maxDrawdownPct),
    positiveFoldShare: null, costsModeled: doc.evidence?.feesModeled === true || num(doc.evidence?.markup) !== null ? true : null,
    brier: num(h?.brier), source: 'lab-module-champion.v1' };
}

export function readLabChampion(dir, source) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, source.file), 'utf8'));
    // Never mirror a record that claims live authority.
    if (!doc || typeof doc !== 'object' || doc.liveActivationAllowed === true || doc.automaticLivePromotionAllowed === true) return null;
    return doc;
  } catch { return null; }
}

const rank = s => STRATEGY_STATES.indexOf(s);
// Brings one registry strategy in line with its Lab champion. PAUSED/RETIRED are user decisions
// and are never overridden. Moves up one step at a time through the common gate.
export function syncLabChampion(registry, source, doc, { transition = (id, to, opts) => registry.transition(id, to, opts), now = Date.now() } = {}) {
  const out = { id: source.id, present: !!doc, labState: null, target: null, state: null, blockers: [], skipped: null };
  const existing = registry.get(source.id);
  if (!doc) { out.state = existing?.state ?? null; out.skipped = 'No Lab champion published'; return out; }
  const lab = championState(doc).state, version = String(doc.champion?.id || doc.candidate?.id || doc.publishedAt || '1');
  out.labState = lab;
  let target = labChampionLifecycle(lab);
  if (target === 'PAPER' && !championPaperAllowed(doc)) target = 'BACKTESTING';
  if (doc.qualificationStage === 'WITHDRAWN') target = 'DRAFT';
  out.target = target;
  let s = existing || registry.register({ id: source.id, name: source.name, version, markets: source.markets, probabilistic: source.probabilistic }, now);
  if (['PAUSED', 'RETIRED'].includes(s.state)) { out.state = s.state; out.skipped = `Strategy is ${s.state} (user decision)`; return out; }
  if (s.version !== version) s = registry.revise(source.id, { version, params: doc.champion?.variant ?? doc.candidate?.params ?? null, reason: 'Lab published a new champion' }, now);
  const evidence = labEvidence(doc), steps = ['DRAFT', 'BACKTESTING', 'PAPER'];
  const reason = `Lab champion sync: Lab state ${lab}, stage ${doc.qualificationStage || 'unknown'}`;
  // Down one step at a time (demotions have no gate).
  const lower = { LIVE: 'CANDIDATE', CANDIDATE: 'PAPER', PAPER: 'BACKTESTING', BACKTESTING: 'DRAFT' };
  while (rank(s.state) > rank(target) && lower[s.state]) s = transition(source.id, lower[s.state], { reason, evidence });
  while (rank(s.state) < rank(target)) {
    const next = steps[steps.indexOf(s.state) + 1];
    if (!next) break;
    const check = promotionCheck(next, evidence, { probabilistic: source.probabilistic });
    if (!check.allowed) { out.blockers = check.blockers; break; }
    s = transition(source.id, next, { reason, evidence });
  }
  out.state = s.state;
  return out;
}

export function syncLabChampions(registry, labLinkDir, opts = {}) {
  return LAB_CHAMPION_SOURCES.map(src => {
    try { return syncLabChampion(registry, src, readLabChampion(labLinkDir, src), opts); }
    catch (e) { return { id: src.id, error: String(e?.message || e).slice(0, 200) }; }
  });
}
