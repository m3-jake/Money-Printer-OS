// Command Center coordination loop. Deterministic and evidence-driven, built on the Intelligence memory
// and run tables and the event bus (no second store, no model calls, no execution authority):
//   observe -> identify bottleneck -> prioritize collection/repair -> dispatch research to the Lab ->
//   freeze an eligible exploratory candidate -> trader admission -> prospective paper outcomes ->
//   retain / revise / reject (recommendations only; books, gates and pauses are never changed here).
// Dispatch is a durable, deduplicated request file the Lab reads (<data>/lab-link/coordinator-requests.json,
// also served by GET /api/coordinator). The Lab answers with receipts (<data>/lab-link/coordinator-acks.json).
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint as strictFingerprint } from './model.js';
import { writeFileAtomicSync } from '../atomicRename.js';
import { exploratoryVariants } from '../botFarm.js';
import { LAB_CHAMPION_SOURCES, readLabChampion, verifyLabProvenance } from './labSync.js';

export const COORDINATOR_SCHEMA = 'mpo.coordinator.v1';
export const REQUESTS_SCHEMA = 'mpo.coordinator-requests.v1';
export const ACKS_SCHEMA = 'mpo.coordinator-acks.v1';
export const STAGES = Object.freeze(['REPAIR', 'COLLECT', 'RESEARCH', 'FREEZE', 'ADMISSION', 'EVALUATE', 'DECIDE']);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const LIMITS = Object.freeze({ dispatchPerTick: 3, maxPending: 8, minBackoffMs: 2 * MIN, maxBackoffMs: 6 * HOUR, requestHistory: 500, maxFileBytes: 2 * 1024 * 1024 });
const ids = (...xs) => row => xs.includes(row.id);
const prefix = (...xs) => row => xs.some(p => row.id.startsWith(p));
const farmKind = k => row => row.id.startsWith('kalshi-farm-') && row.kind === k;
const any = (...fs) => row => fs.some(f => f(row));

// One declaration per module. resources is the bounded request a dispatch carries; the Lab treats it as a
// hint inside its own shared capacity limits.
export const MODULES = Object.freeze([
  { id: 'pumpfun', title: 'Pump.fun tokens', basePriority: 50, freshnessMs: 10 * MIN, labModule: null, champion: 'lab-solana', dependencies: [],
    objective: 'Find Pump.fun entry/exit policies that stay positive after both fees and both slippages on unseen tokens.',
    requiredEvidence: ['Fresh token ticks', 'At least 20 closed paper trades per book', 'Net above cash without the single best trade', 'Lab champion with verified provenance'],
    resources: { cpuSlots: 1, providerCallsPerHour: 0 }, rows: any(ids('pumpfun-fair', 'pumpfun-sprint', 'pumpfun-other', 'pumpfun-native-sniper'), prefix('pump-profit-')) },
  { id: 'pump-wallet-copy', title: 'Pump wallet copy', basePriority: 35, freshnessMs: 30 * MIN, labModule: null, champion: null, dependencies: ['wallet-flows'],
    objective: 'Measure whether copying scored Pump wallets beats cash after latency, fees and slippage; strict copy needs qualifying wallets.',
    requiredEvidence: ['Wallet follow-up transactions', 'Qualifying scored wallets', 'At least 20 closed copies per cohort'],
    resources: { cpuSlots: 1, providerCallsPerHour: 0 }, rows: prefix('pumpfun-copy') },
  { id: 'robinhood-crypto', title: 'Robinhood crypto', basePriority: 60, freshnessMs: 10 * MIN, labModule: 'robinhood', champion: 'lab-robinhood', dependencies: [],
    objective: 'Beat buy-and-hold of the same coins after Robinhood spread and fees on forward quotes.',
    requiredEvidence: ['Fresh genuine BBO quotes', 'Holdout closes (20)', 'Volatility gate cleared', 'Lab champion with verified provenance'],
    resources: { cpuSlots: 32, providerCallsPerHour: 0 }, rows: any(ids('robinhood-strategy', 'robinhood-exploration', 'robinhood-daily', 'robinhood-daily-shadow'), prefix('robinhood-external-')) },
  { id: 'robinhood-equities', title: 'Robinhood stocks & ETFs', basePriority: 55, freshnessMs: 2 * DAY, labModule: 'robinhood-equities', champion: 'lab-robinhood-equities', dependencies: ['edgar'],
    objective: 'Beat buy-and-hold SPY on next-open execution with provider-backed daily bars.',
    requiredEvidence: ['1,134 sessions of authentic history after warm-up', 'Walk-forward folds and an untouched holdout', 'At least 20 paper sessions'],
    resources: { cpuSlots: 32, providerCallsPerHour: 0 }, rows: ids('robinhood-equities', 'equity-disclosure-paper', 'platform-stocks-paper') },
  { id: 'kalshi-weather', title: 'Kalshi weather', basePriority: 70, freshnessMs: 30 * MIN, labModule: 'kalshi', champion: null, dependencies: ['weather-feed', 'market-identity'], proposalModule: 'kalshi-weather',
    objective: 'Price temperature contracts better than the market after fees using calibrated forecasts bound to the settlement station.',
    requiredEvidence: ['Fresh forecasts and contract quotes', 'Settled outcomes on independent days', 'Frozen exploratory proposal admitted by the trader', 'At least 20 settled exploratory bets'],
    resources: { cpuSlots: 4, providerCallsPerHour: 60 }, rows: any(ids('kalshi-bot-weather', 'kalshi-bot-weather-nws'), farmKind('weather')) },
  { id: 'kalshi-btc', title: 'Kalshi BTC ranges', basePriority: 60, freshnessMs: 10 * MIN, labModule: 'kalshi', champion: null, dependencies: ['market-identity'], proposalModule: 'kalshi-btc',
    objective: 'Price BTC range contracts after fees; needs settled outcomes on independent validation dates.',
    requiredEvidence: ['Fresh contract quotes', 'Settled outcomes on independent days', 'Compatible settlement records', 'At least 20 settled bets'],
    resources: { cpuSlots: 4, providerCallsPerHour: 60 }, rows: any(ids('kalshi-bot-btc'), farmKind('btc')) },
  { id: 'polymarket-clob', title: 'Polymarket global CLOB', basePriority: 45, freshnessMs: DAY, labModule: 'polymarket', champion: 'lab-polymarket', dependencies: ['market-identity'],
    objective: 'Find CLOB strategies positive after depth-walked costs on completed tape days.',
    requiredEvidence: ['Completed depth tape days', 'Executable quotes', 'Lab champion with verified provenance'],
    resources: { cpuSlots: 1, providerCallsPerHour: 0 }, rows: ids('platform-polymarket') },
  { id: 'polymarket-copy', title: 'Polymarket copy', basePriority: 50, freshnessMs: 30 * MIN, labModule: null, champion: null, dependencies: [],
    objective: 'Rank leaders on achievable follower outcomes after latency, depth and fees against no-trade and random controls.',
    requiredEvidence: ['Fresh leader observations', 'Settled copied positions per cohort (20)', 'Control cohorts running'],
    resources: { cpuSlots: 1, providerCallsPerHour: 120 }, rows: prefix('polymarket-copy') },
  { id: 'polymarket-us', title: 'Polymarket US singles/combos', basePriority: 45, freshnessMs: 2 * HOUR, labModule: 'polymarket-combo', champion: 'lab-polymarket-combo', dependencies: [],
    objective: 'Find US single/combo policies positive after observed markup on settled outcomes.',
    requiredEvidence: ['Settled US outcomes', 'Observed (not assumed) markup', 'Positive holdout ROI', 'Lab champion with verified provenance'],
    resources: { cpuSlots: 1, providerCallsPerHour: 0 }, rows: prefix('polymarket-us-', 'polymarket-shadow-') },
  { id: 'kalshi-mirror', title: 'Kalshi mirror', basePriority: 40, freshnessMs: 30 * MIN, labModule: null, champion: null, dependencies: ['market-identity'],
    objective: 'Mirror identified Polymarket leader game-winner buys onto the exactly matching Kalshi market.',
    requiredEvidence: ['Exact market identity matches', 'Settled mirrored positions (20)'],
    resources: { cpuSlots: 1, providerCallsPerHour: 60 }, rows: ids('kalshi-mirror') },
]);

// Input feeds. Freshness is the newest stored observation of that kind; on-demand feeds keep no history.
export const FEEDS = Object.freeze([
  { id: 'weather-feed', title: 'NWS weather alerts', kind: 'WeatherAlert', providers: ['nws'], freshnessMs: 6 * HOUR },
  { id: 'market-identity', title: 'Contract identity (Kalshi/Polymarket)', kind: 'Contract', providers: ['kalshi', 'polymarket'], freshnessMs: 30 * MIN },
  { id: 'sports', title: 'Sports schedule', kind: 'SportsEvent', providers: ['mpos'], freshnessMs: 2 * HOUR },
  { id: 'wire', title: 'Wire (BEA/Fed/CFTC releases)', kind: 'NewsEvent', providers: null, freshnessMs: 2 * DAY },
  { id: 'edgar', title: 'SEC EDGAR filings', kind: 'Filing', providers: ['sec'], freshnessMs: 7 * DAY },
  { id: 'macro', title: 'FRED macro series', kind: null, freshnessMs: null, note: 'Fetched on request and cached in memory; no stored history to age.' },
  { id: 'wallet-flows', title: 'Solana wallet flows', kind: null, freshnessMs: null, note: 'Measured by the Pump copy books themselves; no separate stored feed.' },
]);

// Cross-module relationships are hypotheses, never edges. Each declares its mapping, timestamp rule,
// expiry and a prospective ablation against a simpler baseline. countsAsEdge is always false here.
export const HYPOTHESES = Object.freeze([
  { id: 'weather-calibration->kalshi-weather', source: 'weather-feed', target: 'kalshi-weather',
    mapping: 'Kalshi KXHIGH* city contracts -> settlement station forecast for the contract date (station, timezone, units from the rules text)',
    timestampRule: 'Forecast first-receipt time must precede the paper entry', expiresAfterMs: 2 * DAY,
    baseline: 'NWS-only control bot on the same markets', treatment: 'kalshi-bot-weather', control: 'kalshi-bot-weather-nws' },
  { id: 'external-sol-flow->robinhood-crypto', source: 'wallet-flows', target: 'robinhood-crypto',
    mapping: 'External Solana native flow windows -> SOL-USD Robinhood quote at the next observation (not Robinhood customer trades)',
    timestampRule: 'Flow window closes before the decision quote', expiresAfterMs: DAY,
    baseline: 'Momentum-only $25 cohort', treatment: 'robinhood-external-momentum_plus_external_native_flow', control: 'robinhood-external-momentum_only' },
  { id: 'filings->robinhood-equities', source: 'edgar', target: 'robinhood-equities',
    mapping: 'Form 4 issuer CIK -> listed ticker on the filing acceptance date',
    timestampRule: 'Acceptance time precedes the next-open entry', expiresAfterMs: 7 * DAY,
    baseline: 'SPY buy-and-hold over the same sessions', treatment: 'equity-disclosure-paper', control: null },
  { id: 'market-identity->kalshi-mirror', source: 'market-identity', target: 'kalshi-mirror',
    mapping: 'Polymarket game-winner market -> Kalshi game market with the same teams, date and settlement rule',
    timestampRule: 'Mirror entry after the leader trade is observed', expiresAfterMs: DAY,
    baseline: 'The source copy book on polymarket.com', treatment: 'kalshi-mirror', control: 'polymarket-copy' },
  { id: 'wire->robinhood-equities', source: 'wire', target: 'robinhood-equities',
    mapping: 'Not declared: no instrument mapping or ablation book exists yet', timestampRule: 'First receipt of each release revision', expiresAfterMs: 2 * DAY,
    baseline: null, treatment: null, control: null },
]);

// JSON round trip first: undefined fields are dropped exactly as they are when stored.
const fingerprint = v => strictFingerprint(JSON.parse(JSON.stringify(v ?? null)));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, dp = 4) => (num(v) === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const freshOf = row => row?.freshness?.status || 'NO_DATA';
function readJsonBounded(file) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > LIMITS.maxFileBytes) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Pure: retain / revise / reject recommendation for one prospective paper book.
export function decideExperiment(row, { now = Date.now() } = {}) {
  if (!row) return { decision: 'CONTINUE', reason: 'No paper book yet' };
  if (row.recoveryRequired) return { decision: 'HOLD', reason: 'Book recovery required; its file was kept' };
  const n = row.closes || 0, min = row.minCloses || 20, net = num(row.netPnl), without = num(row.netWithoutBest);
  const ends = num(row.experiment?.evaluationEndsAt), ended = ends !== null && now >= ends;
  const predicted = num(row.forwardScorecard?.predicted?.meanPerBet), realized = num(row.forwardScorecard?.forward?.meanPerBet);
  const vsPrediction = predicted === null || realized === null ? null : { predictedPerBet: round(predicted), realizedPerBet: round(realized) };
  if (n < min) return ended ? { decision: 'REVISE', reason: `Evaluation window ended with ${n}/${min} settled outcomes; collect a new frozen window`, vsPrediction }
    : { decision: 'CONTINUE', reason: `${n}/${min} settled outcomes`, vsPrediction };
  if (row.beatsBaseline === 'YES') return { decision: 'RETAIN', reason: `Net ${round(net, 2)} ${row.unit || ''} is above its baseline, also without the best trade`, vsPrediction };
  if (net !== null && net < 0 && (without ?? net) < 0) return { decision: 'REJECT', reason: `Net ${round(net, 2)} ${row.unit || ''} after costs over ${n} settled outcomes`, vsPrediction };
  return { decision: 'REVISE', reason: row.reason || 'Not above its baseline, or depends on a single trade', vsPrediction };
}

// Pure: hypothesis status from declared ablation books. SUPPORTED_PROSPECTIVELY never means an edge.
export function evaluateHypothesis(h, rowsById, { now = Date.now() } = {}) {
  const t = h.treatment ? rowsById.get(h.treatment) : null, c = h.control ? rowsById.get(h.control) : null;
  const base = { id: h.id, source: h.source, target: h.target, mapping: h.mapping, timestampRule: h.timestampRule, baseline: h.baseline, expiresAfterMs: h.expiresAfterMs, countsAsEdge: false };
  if (!h.treatment || !h.baseline) return { ...base, status: 'NO_ABLATION_DECLARED', reason: 'No instrument mapping and ablation book; cannot count as evidence' };
  if (!t) return { ...base, status: 'DECLARED', reason: `Treatment book ${h.treatment} is not running` };
  const last = Math.max(num(t.freshness?.at) ?? 0, num(t.lastCloseAt) ?? 0);
  if (last && now - last > h.expiresAfterMs) return { ...base, status: 'EXPIRED', reason: 'Treatment observations are older than the declared expiry' };
  const min = t.minCloses || 20, tn = t.closes || 0, cn = c ? c.closes || 0 : null;
  const evidence = { treatment: { id: t.id, closes: tn, net: num(t.netPnl) }, control: c ? { id: c.id, closes: cn, net: num(c.netPnl) } : null };
  if (tn < min || (h.control && (cn ?? 0) < min)) return { ...base, status: 'COLLECTING', evidence, reason: `Needs ${min} settled outcomes in each arm (treatment ${tn}${h.control ? `, control ${cn ?? 0}` : ''})` };
  if (h.control) {
    const start = num(t.experiment?.startAfter), end = num(t.experiment?.evaluationEndsAt);
    if (!c || !t.unit || t.unit !== c.unit || num(t.startUsd) === null || t.startUsd !== c.startUsd || start === null || end === null
      || start !== num(c.experiment?.startAfter) || end !== num(c.experiment?.evaluationEndsAt)) {
      return { ...base, status: 'COMPARABILITY_UNVERIFIED', evidence, reason: 'Treatment and control need the same declared prospective window, currency and funding before outcome differences support this hypothesis' };
    }
  }
  const beats = h.control ? num(t.netPnl) !== null && num(c.netPnl) !== null && t.netPnl > c.netPnl && t.beatsBaseline === 'YES' : t.beatsBaseline === 'YES';
  return { ...base, status: beats ? 'SUPPORTED_PROSPECTIVELY' : 'NOT_SUPPORTED', evidence,
    reason: beats ? 'Treatment beat the simpler baseline prospectively; still not an established edge' : 'Treatment did not beat the simpler baseline' };
}

export class Coordinator {
  constructor(store, bus = null, { dataDir = null, publish = true, now = Date.now } = {}) {
    this.store = store; this.bus = bus; this.dataDir = dataDir; this.publish = publish && !!dataDir; this.now = now;
    this.lastError = null; this.lastTickAt = null; this.lastRequestsHash = null; this.view = null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS intelligence_memory(identity TEXT PRIMARY KEY, input_hash TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intelligence_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator_requests(id TEXT PRIMARY KEY, identity TEXT NOT NULL, input_hash TEXT NOT NULL, attempt INTEGER NOT NULL,
        module TEXT NOT NULL, lab_module TEXT, kind TEXT NOT NULL, priority REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL, receipt TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS coordinator_requests_identity ON coordinator_requests(identity,input_hash,attempt);
      CREATE INDEX IF NOT EXISTS coordinator_requests_status ON coordinator_requests(status,created_at);`);
  }
  memory(key) { const r = this.store.db.prepare('SELECT result FROM intelligence_memory WHERE identity=?').get(key); try { return r ? JSON.parse(r.result) : null; } catch { return null; } }
  remember(key, value, now) {
    const text = JSON.stringify(value), hash = fingerprint(value);
    this.store.db.prepare('INSERT INTO intelligence_memory VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET input_hash=excluded.input_hash,at=excluded.at,result=excluded.result').run(key, hash, now, text);
  }
  run(identity, value, now) {
    this.store.db.prepare('INSERT INTO intelligence_runs(identity,at,result) VALUES(?,?,?)').run(identity, now, JSON.stringify(value));
    this.store.db.exec('DELETE FROM intelligence_runs WHERE seq <= (SELECT COALESCE(MAX(seq),0)-2000 FROM intelligence_runs)');
  }

  // ------------------------------------------------------------- observe
  gather(rows, now) {
    const lab = {}, champions = {}, feeds = {};
    const dir = this.dataDir, link = dir && path.join(dir, 'lab-link');
    for (const m of MODULES) if (m.labModule && link && !(m.labModule in lab)) {
      const s = readJsonBounded(path.join(link, 'modules', `${m.labModule}.json`));
      lab[m.labModule] = s && s.module === m.labModule ? { status: s.status || null, phase: s.phase || null, updatedAt: num(s.updatedAt), lastRunAt: num(s.lastRunAt),
        blockers: Array.isArray(s.blockers) ? s.blockers.slice(0, 5).map(b => String(b).slice(0, 240)) : [], note: s.note ? String(s.note).slice(0, 300) : null,
        evaluatorVersion: s.evaluatorVersion || null, inputFingerprint: s.inputFingerprint || s.lastInputFingerprint || s.datasetFingerprint || null } : null;
    }
    let registry = new Map();
    try { registry = new Map(this.store.db.prepare("SELECT id,state,version FROM strategies WHERE id LIKE 'lab-%'").all().map(r => [r.id, r])); } catch {}
    for (const src of LAB_CHAMPION_SOURCES) {
      const doc = link ? readLabChampion(link, src) : null, reg = registry.get(src.id) || null;
      if (!doc) { champions[src.id] = { present: false, registryState: reg?.state ?? null }; continue; }
      const v = verifyLabProvenance(doc, { dataDir: dir });
      champions[src.id] = { present: true, candidateId: doc.champion?.id ?? doc.candidate?.id ?? null, stage: doc.qualificationStage || null,
        paperPromotionAllowed: doc.paperPromotionAllowed === true, provenance: v.status, provenanceBlockers: v.blockers.slice(0, 4),
        registryState: reg?.state ?? null, publishedAt: num(doc.publishedAt) };
    }
    for (const f of FEEDS) {
      if (!f.kind) { feeds[f.id] = { id: f.id, title: f.title, status: 'ON_DEMAND', last: null, count: null, freshnessMs: null, note: f.note }; continue; }
      let r = null;
      try {
        r = f.providers ? this.store.db.prepare(`SELECT MAX(available_at) last, COUNT(*) n FROM entities WHERE kind=? AND provider IN (${f.providers.map(() => '?').join(',')})`).get(f.kind, ...f.providers)
          : this.store.db.prepare('SELECT MAX(available_at) last, COUNT(*) n FROM entities WHERE kind=?').get(f.kind);
      } catch {}
      const last = num(r?.last), age = last === null ? null : now - last;
      feeds[f.id] = { id: f.id, title: f.title, status: last === null ? 'NO_DATA' : age <= f.freshnessMs ? 'FRESH' : 'STALE', last, ageMs: age, count: r?.n ?? 0, freshnessMs: f.freshnessMs,
        consumers: MODULES.filter(m => m.dependencies.includes(f.id)).map(m => m.id) };
    }
    for (const f of FEEDS) feeds[f.id].consumers ||= MODULES.filter(m => m.dependencies.includes(f.id)).map(m => m.id);
    const proposals = link ? readJsonBounded(path.join(link, 'exploratory-proposals.json')) : null;
    const acks = link ? readJsonBounded(path.join(link, 'coordinator-acks.json')) : null;
    return { lab, champions, feeds, proposals, acks };
  }

  // Pure for a given input: one module's stage, bottleneck, readiness, next action and plan inputs.
  assess(m, rows, g, now) {
    const books = rows.filter(r => r.kind !== 'lab' && m.rows(r)), fresh = books.filter(r => freshOf(r) === 'FRESH');
    const lab = m.labModule ? g.lab[m.labModule] : null, champ = m.champion ? g.champions[m.champion] : null;
    const deps = m.dependencies.map(d => g.feeds[d]).filter(Boolean), badDeps = deps.filter(d => ['STALE', 'NO_DATA'].includes(d.status));
    const recovery = books.filter(r => r.recoveryRequired);
    const frozen = books.filter(r => r.experiment && r.exploratory);
    const activeFrozen = frozen.filter(r => !r.withdrawn || (r.open || 0) > 0);
    let eligible = [], lifetime = frozen.length;
    if (m.proposalModule && g.proposals) {
      try { eligible = exploratoryVariants(g.proposals, now).filter(v => v.experiment.module === m.proposalModule); } catch { eligible = []; }
    }
    const admittedIds = new Set(frozen.map(r => r.experiment?.identity || r.experiment?.id));
    const waiting = eligible.filter(v => !admittedIds.has(v.experiment.identity));
    const decided = books.filter(r => (r.closes || 0) >= (r.minCloses || 20));
    const outcomes = books.reduce((s, r) => s + (r.closes || 0), 0), open = books.reduce((s, r) => s + (num(r.open) || 0), 0);
    const labStale = lab && lab.updatedAt !== null && now - lab.updatedAt > Math.max(m.freshnessMs, 30 * MIN);
    const requirements = [
      { key: 'fresh-paper-data', label: 'Fresh paper observations', met: books.length ? fresh.length > 0 : null, detail: `${fresh.length}/${books.length} books fresh` },
      { key: 'inputs', label: 'Input feeds fresh', met: deps.length ? badDeps.length === 0 : null, detail: deps.map(d => `${d.id} ${d.status}`).join(', ') || 'no declared feeds' },
      { key: 'lab-research', label: 'Lab research lane current', met: m.labModule ? !!lab && !labStale : null, detail: lab ? `${lab.status || '?'} / ${lab.phase || '?'}` : m.labModule ? 'no Lab status mirrored' : 'no Lab lane' },
      { key: 'provenance', label: 'Lab champion provenance verified', met: champ ? champ.present ? champ.provenance === 'VERIFIED' : false : null, detail: champ ? champ.present ? `${champ.provenance}${champ.provenanceBlockers?.length ? ': ' + champ.provenanceBlockers.join(', ') : ''}` : 'no champion published' : 'not applicable' },
      { key: 'outcomes', label: 'Settled outcomes for a decision', met: books.length ? decided.length > 0 : null, detail: `${outcomes} settled/closed across ${books.length} books` },
    ];
    const scored = requirements.filter(r => r.met !== null), readiness = scored.length ? scored.filter(r => r.met).length / scored.length : 0;
    let stage, bottleneck, next, dispatchKind = null, decisions = [];
    if (recovery.length) { stage = 'REPAIR'; bottleneck = `Book recovery required: ${recovery.map(r => r.id).join(', ')}`; next = 'Operator restores the preserved book file; nothing is reset automatically'; }
    else if (books.length && !fresh.length && (!lab || lab.phase === 'WAITING_FOR_DATA')) {
      stage = 'COLLECT'; bottleneck = badDeps.length ? `Input feed ${badDeps.map(d => `${d.id} is ${d.status}`).join(', ')}` : `No fresh observations (${books.map(r => `${r.id} ${freshOf(r)}`).slice(0, 4).join(', ')})`;
      next = 'Collect fresh observations; wake research when new evidence arrives'; dispatchKind = m.labModule ? 'WAKE_ON_NEW_EVIDENCE' : null;
    } else if (activeFrozen.length) {
      decisions = activeFrozen.map(r => ({ book: r.id, experiment: r.experiment?.identity || r.experiment?.id || null, ...decideExperiment(r, { now }) }));
      const final = decisions.filter(d => d.decision !== 'CONTINUE');
      stage = final.length ? 'DECIDE' : 'EVALUATE';
      bottleneck = final.length ? `${final.length} frozen experiment(s) reached a decision point` : `Frozen exploratory books awaiting settled outcomes: ${decisions.map(d => `${d.book} ${d.reason}`).join('; ')}`;
      next = final.length ? final.map(d => `${d.decision} ${d.book}: ${d.reason}`).join('; ') : 'Keep collecting prospective settled outcomes; the evaluation window is fixed';
      if (waiting.length) bottleneck += lifetime >= 2 ? `; ${waiting.length} more frozen proposal(s) wait: lifetime exploratory budget reached (2 books, $50)` : `; ${waiting.length} more frozen proposal(s) eligible for admission`;
      if (final.some(d => d.decision === 'REVISE') && m.labModule) dispatchKind = 'REVISE_CANDIDATE';
    } else if (waiting.length) {
      stage = 'ADMISSION';
      bottleneck = lifetime >= 2 ? 'Lifetime exploratory budget reached (2 books, $50); a new cohort needs an explicit operator allocation' : `${waiting.length} frozen proposal(s) eligible; admission runs on the next farm cycle`;
      next = lifetime >= 2 ? 'Wait for the admitted cohort to finish; previous losses are never reset' : 'Trader admits the frozen proposal into a separately funded $25 book';
    } else if (champ?.present && champ.provenance !== 'VERIFIED' && m.labModule) {
      stage = 'FREEZE'; bottleneck = `Lab champion ${champ.candidateId} is not admissible: provenance ${champ.provenance}${champ.provenanceBlockers?.length ? ' (' + champ.provenanceBlockers.slice(0, 2).join(', ') + ')' : ''}; stage ${champ.stage || 'unknown'}`;
      next = 'Lab freezes a candidate with verified provenance (evaluator, dataset and output hashes) before any trader admission'; dispatchKind = 'FREEZE_EXPLORATORY_CANDIDATE';
    } else if (decided.length && !m.labModule) {
      decisions = decided.map(r => ({ book: r.id, ...decideExperiment(r, { now }) }));
      stage = 'DECIDE'; bottleneck = `${decided.length} paper book(s) have enough outcomes for a recommendation`;
      next = decisions.map(d => `${d.decision} ${d.book}`).join('; ') + ' (recommendation only; books and pauses are unchanged)';
    } else if (m.labModule) {
      stage = 'RESEARCH'; bottleneck = lab ? (lab.blockers[0] || lab.note || `Lab phase ${lab.phase}`) : 'No Lab status mirrored yet';
      next = labStale ? 'Wake the Lab lane: its status is older than the freshness limit' : 'Lab evaluates new evidence when its input fingerprint changes'; dispatchKind = 'RESEARCH';
    } else {
      stage = 'EVALUATE'; bottleneck = books.length ? `Collecting outcomes: ${outcomes} closed across ${books.length} books (needs ${books[0]?.minCloses || 20} per book)` : 'No paper book is running for this module';
      next = books.length ? 'Continue forward observation' : 'Start or restore the module paper book';
    }
    // Priority: base + evidence gain + after-cost improvement + readiness. Aging is added at dispatch.
    const gain = Math.min(1, (open + fresh.length * 5 + (lab && lab.phase !== 'WAITING_FOR_DATA' ? 5 : 0)) / 20);
    const losers = books.filter(r => num(r.netPnl) !== null && r.netPnl < 0 && num(r.startUsd)), improvement = Math.min(1, losers.reduce((s, r) => s + Math.abs(r.netPnl) / r.startUsd, 0));
    const components = { base: m.basePriority, evidenceGain: round(25 * gain, 2), outcomeImprovement: round(20 * improvement, 2), readiness: round(15 * readiness, 2) };
    const metrics = { labPhase: lab?.phase ?? null, labBlockers: lab?.blockers?.length ?? null, champion: champ?.present ? `${champ.candidateId}:${champ.provenance}` : null,
      books: Object.fromEntries(books.map(r => [r.id, { closes: r.closes || 0, net: round(num(r.netPnl), 4), fresh: freshOf(r) }])) };
    // Work identity follows evidence, not scheduler phases/notes or moving unrealized marks.
    // A phase changing from queued to running must never supersede its own outstanding request.
    const inputHash = fingerprint({ labInput: lab?.inputFingerprint ?? null, champion: metrics.champion,
      books: books.map(r => [r.id, r.closes || 0, r.lastCloseAt ?? null, freshOf(r), r.recoveryRequired === true]),
      feeds: deps.map(d => [d.id, d.last, d.count, d.status]), waiting: waiting.map(v => v.experiment.identity) });
    return { m, stage, bottleneck, next, dispatchKind, decisions, readiness: round(readiness, 3), requirements, components, metrics, inputHash,
      deps: deps.map(d => ({ id: d.id, status: d.status, ageMs: d.ageMs })), lab, champion: champ, books: books.length, freshBooks: fresh.length, outcomes, open,
      exploratory: { admitted: frozen.map(r => ({ book: r.id, experiment: r.experiment?.identity || null, closes: r.closes || 0, open: r.open ?? null, evaluationEndsAt: r.experiment?.evaluationEndsAt ?? null })), eligibleWaiting: waiting.map(v => v.experiment.identity), lifetime } };
  }

  // ------------------------------------------------------------- receipts from the Lab
  applyAcks(doc, now) {
    if (!doc || doc.schema !== ACKS_SCHEMA || !Array.isArray(doc.acks)) return 0;
    let n = 0;
    const get = this.store.db.prepare('SELECT * FROM coordinator_requests WHERE id=?'), set = this.store.db.prepare('UPDATE coordinator_requests SET status=?,updated_at=?,receipt=?,expires_at=? WHERE id=?');
    for (const a of doc.acks.slice(0, 500)) {
      const r = get.get(String(a?.requestId || '')); if (!r || ['COMPLETED', 'DECLINED', 'SUPERSEDED', 'EXPIRED'].includes(r.status)) continue;
      if ((a.module != null && a.module !== r.lab_module) || (a.inputHash != null && a.inputHash !== r.input_hash)) continue;
      if (num(a.at) === null || a.at < r.created_at || a.at > now || (num(a.finishedAt) !== null && (a.finishedAt > now || (a.status !== 'DEDUPED_UNCHANGED_EVIDENCE' && a.finishedAt < r.created_at)))) continue;
      if (a.status === 'COMPLETED' && (typeof a.jobId !== 'string' || !a.jobId.trim() || num(a.finishedAt) === null || a.finishedAt > a.at)) continue;
      const receipt = { status: String(a.status || '').slice(0, 40), jobId: a.jobId ? String(a.jobId).slice(0, 200) : null, at: num(a.at), finishedAt: num(a.finishedAt), reason: a.reason ? String(a.reason).slice(0, 300) : null, jobState: a.jobState ? String(a.jobState).slice(0, 20) : null };
      const status = ['COMPLETED', 'DEDUPED_UNCHANGED_EVIDENCE'].includes(receipt.status) ? 'COMPLETED' : ['FAILED', 'BACKOFF', 'UNSUPPORTED_MODULE', 'INVALID', 'EXPIRED'].includes(receipt.status) ? 'DECLINED'
        : ['ENQUEUED', 'RUNNING', 'ALREADY_RUNNING', 'WAITING_COOLDOWN'].includes(receipt.status) ? 'ACKNOWLEDGED' : null;
      if (!status || (status === r.status && r.receipt === JSON.stringify(receipt))) continue;
      // Fresh actual scheduler receipts keep an acknowledged job alive, bounded by six
      // hours from creation. Without new receipts it still expires and backs off.
      const expiresAt = status === 'ACKNOWLEDGED' ? Math.max(r.expires_at, Math.min(r.created_at + LIMITS.maxBackoffMs, now + 10 * MIN)) : r.expires_at;
      set.run(status, now, JSON.stringify(receipt), expiresAt, r.id); n++;
      if (status === 'COMPLETED' || status === 'DECLINED') {
        const key = `coord:module:${r.module}`, st = this.memory(key) || {};
        const payload = JSON.parse(r.payload);
        if (status === 'COMPLETED') { st.attempts = 0; st.nextAttemptAt = null; st.retryReason = null; st.lastCompletedInputHash = r.input_hash; if (receipt.status === 'COMPLETED') st.lastExperiment = { requestId: r.id, kind: r.kind, completedAt: receipt.finishedAt ?? now, jobId: receipt.jobId, before: payload.metricsAtDispatch || null, after: null }; }
        else { st.attempts = (st.attempts || 0) + 1; st.nextAttemptAt = now + Math.min(LIMITS.maxBackoffMs, LIMITS.minBackoffMs * 2 ** Math.min(12, st.attempts - 1)); st.retryReason = `Lab ${receipt.status}${receipt.reason ? ': ' + receipt.reason : ''}`; }
        st.receipts = [{ requestId: r.id, kind: r.kind, status, ...receipt }, ...(st.receipts || [])].slice(0, 5);
        this.remember(key, st, now);
      }
    }
    return n;
  }

  // ------------------------------------------------------------- tick
  tick({ rows = [], now = this.now() } = {}) {
    const g = this.gather(rows, now), out = { at: now, dispatched: [], changed: [] };
    this.store.transaction(() => {
      this.applyAcks(g.acks, now);
      // Expire stale requests; their module retries after backoff.
      for (const r of this.store.db.prepare("SELECT * FROM coordinator_requests WHERE status IN ('PENDING','ACKNOWLEDGED') AND expires_at<=?").all(now)) {
        this.store.db.prepare("UPDATE coordinator_requests SET status='EXPIRED',updated_at=? WHERE id=?").run(now, r.id);
        const key = `coord:module:${r.module}`, st = this.memory(key) || {};
        st.attempts = (st.attempts || 0) + 1; st.nextAttemptAt = now + Math.min(LIMITS.maxBackoffMs, LIMITS.minBackoffMs * 2 ** Math.min(12, st.attempts - 1)); st.retryReason = `Request ${r.id.slice(0, 8)} expired without a Lab receipt`;
        this.remember(key, st, now);
      }
      const assessed = MODULES.map(m => this.assess(m, rows, g, now)), wanting = [];
      for (const a of assessed) {
        const key = `coord:module:${a.m.id}`, prev = this.memory(key) || {};
        const st = { ...prev };
        if (prev.stage !== a.stage || prev.bottleneck !== a.bottleneck) { st.stageSince = prev.stage === a.stage ? prev.stageSince ?? now : now; }
        if (prev.inputHash && prev.inputHash !== a.inputHash) { st.attempts = 0; st.nextAttemptAt = null; st.retryReason = null; } // new evidence resets retry backoff
        if (st.lastExperiment && !st.lastExperiment.after) st.lastExperiment = { ...st.lastExperiment, after: a.metrics };
        const decisionSig = fingerprint(a.decisions.map(d => [d.book, d.decision]));
        const changed = prev.stage !== a.stage || prev.decisionSig !== decisionSig || prev.bottleneck !== a.bottleneck;
        Object.assign(st, { stage: a.stage, bottleneck: a.bottleneck, nextAction: a.next, inputHash: a.inputHash, decisionSig, decisions: a.decisions, readiness: a.readiness, metrics: a.metrics, at: now });
        st.stageSince ??= now;
        this.remember(key, st, now);
        if (changed) {
          const record = { module: a.m.id, stage: a.stage, from: prev.stage || null, bottleneck: a.bottleneck, next: a.next, decisions: a.decisions, inputHash: a.inputHash, executionAuthority: false };
          this.run(`coord:${a.m.id}`, record, now); out.changed.push(a.m.id);
          this.bus?.publish('RESEARCH_COMPLETED', { kind: 'COORDINATOR_STAGE', ...record, priority: a.m.basePriority, cost: { modelCalls: 0, tokens: 0 } }, { id: `coord:${a.m.id}:${a.inputHash}`, source: 'coordinator' });
        }
        a.state = st;
        if (a.dispatchKind && a.m.labModule) wanting.push(a);
      }
      // Dispatch: dedupe by identity+input hash, one open request per identity, bounded per tick, aging
      // priority so a low-priority module that keeps waiting is eventually served.
      const pendingCount = () => this.store.db.prepare("SELECT COUNT(*) n FROM coordinator_requests WHERE status IN ('PENDING','ACKNOWLEDGED')").get().n;
      for (const a of wanting) {
        const waitingMs = now - (a.state.lastServedAt ?? a.state.stageSince ?? now);
        // Aging must eventually outweigh every base/readiness bonus, otherwise low priority
        // lanes can starve forever while high priority lanes keep receiving fresh evidence.
        a.components.aging = round(Math.max(0, waitingMs) / (5 * MIN), 2);
        a.score = round(Object.values(a.components).reduce((s, v) => s + (v || 0), 0), 2);
      }
      wanting.sort((x, y) => y.score - x.score || x.m.id.localeCompare(y.m.id));
      let budget = LIMITS.dispatchPerTick;
      for (const a of wanting) {
        const identity = `${a.m.id}:${a.dispatchKind}`;
        const open = this.store.db.prepare("SELECT * FROM coordinator_requests WHERE module=? AND status IN ('PENDING','ACKNOWLEDGED')").all(a.m.id);
        if (open.length) { a.dispatch = { status: 'OPEN', requestId: open[0].id, newerEvidenceWaiting: open[0].input_hash !== a.inputHash }; continue; }
        if (Number(a.state.nextAttemptAt) > now) { a.dispatch = { status: 'BACKOFF', retryAt: a.state.nextAttemptAt, reason: a.state.retryReason }; continue; }
        const attempt = this.store.db.prepare('SELECT COUNT(*) n FROM coordinator_requests WHERE identity=? AND input_hash=?').get(identity, a.inputHash).n;
        const done = this.store.db.prepare("SELECT 1 FROM coordinator_requests WHERE identity=? AND input_hash=? AND status IN ('COMPLETED')").get(identity, a.inputHash);
        if (done || a.state.lastCompletedInputHash === a.inputHash) { a.dispatch = { status: 'DONE_FOR_THIS_EVIDENCE' }; continue; }
        if (budget <= 0 || pendingCount() - open.length >= LIMITS.maxPending) { a.dispatch = { status: 'QUEUED_BEHIND_HIGHER_PRIORITY', score: a.score }; continue; }
        for (const r of open) this.store.db.prepare("UPDATE coordinator_requests SET status='SUPERSEDED',updated_at=? WHERE id=?").run(now, r.id);
        const id = fingerprint([identity, a.inputHash, attempt]).slice(0, 32), ttl = Math.min(LIMITS.maxBackoffMs, Math.max(10 * MIN, a.m.freshnessMs));
        const payload = { reason: a.bottleneck, next: a.next, resources: a.m.resources, score: a.score, components: a.components, metricsAtDispatch: a.metrics };
        this.store.db.prepare('INSERT INTO coordinator_requests(id,identity,input_hash,attempt,module,lab_module,kind,priority,status,created_at,updated_at,expires_at,payload,receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
          .run(id, identity, a.inputHash, attempt, a.m.id, a.m.labModule, a.dispatchKind, a.score, 'PENDING', now, now, now + ttl, JSON.stringify(payload));
        a.state.lastServedAt = now; a.state.lastRequestId = id; this.remember(`coord:module:${a.m.id}`, a.state, now);
        a.dispatch = { status: 'DISPATCHED', requestId: id }; out.dispatched.push(id); budget--;
      }
      // Bounded request history.
      this.store.db.exec(`DELETE FROM coordinator_requests WHERE status NOT IN ('PENDING','ACKNOWLEDGED') AND id NOT IN
        (SELECT id FROM coordinator_requests ORDER BY updated_at DESC LIMIT ${LIMITS.requestHistory})`);
      const rowsById = new Map(rows.map(r => [r.id, r]));
      const hypotheses = HYPOTHESES.map(h => evaluateHypothesis(h, rowsById, { now }));
      for (const h of hypotheses) { const key = `coord:hyp:${h.id}`, prev = this.memory(key); if (prev?.status !== h.status) { this.remember(key, { ...h, since: now }, now); this.run(`coord:hyp:${h.id}`, h, now); } }
      this.view = this.buildView(assessed, g, hypotheses, now);
      this.remember('coord:view', this.view, now);
    });
    this.lastTickAt = now;
    if (this.publish) this.publishRequests(now);
    return out;
  }

  pendingRequests(now = this.now()) {
    return this.store.db.prepare("SELECT * FROM coordinator_requests WHERE status IN ('PENDING','ACKNOWLEDGED') AND expires_at>? ORDER BY priority DESC, created_at").all(now).map(r => {
      const p = JSON.parse(r.payload);
      return { id: r.id, identity: r.identity, inputHash: r.input_hash, attempt: r.attempt, module: r.module, labModule: r.lab_module, kind: r.kind, priority: r.priority,
        status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, reason: p.reason, next: p.next, resources: p.resources };
    });
  }
  requestsDocument(now = this.now()) {
    return { schema: REQUESTS_SCHEMA, at: now, advisory: true, executionAuthority: false, liveAuthority: false,
      note: 'Wake/priority hints for the Lab module scheduler. They never bypass evidence dedupe, backoff, capacity or any gate, and never touch trader books.',
      requests: this.pendingRequests(now) };
  }
  publishRequests(now) {
    const doc = this.requestsDocument(now), hash = fingerprint(doc.requests.map(r => [r.id, r.status]));
    if (hash === this.lastRequestsHash) return false;
    try { const file = path.join(this.dataDir, 'lab-link', 'coordinator-requests.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); writeFileAtomicSync(file, JSON.stringify(doc)); this.lastRequestsHash = hash; this.lastError = null; return true; }
    catch (e) { this.lastError = `request file: ${String(e?.code || e?.message).slice(0, 120)}`; return false; }
  }

  // ------------------------------------------------------------- explanation
  buildView(assessed, g, hypotheses, now) {
    const modules = assessed.map(a => {
      const st = a.state || {}, le = st.lastExperiment;
      const changed = !le ? 'No research request has completed for this module yet.' : describeChange(le.before, le.after || a.metrics, le);
      const need = a.requirements.filter(r => r.met === false).map(r => `${r.label} (${r.detail})`);
      return { id: a.m.id, title: a.m.title, stage: a.stage, objective: a.m.objective, requiredEvidence: a.m.requiredEvidence, requirements: a.requirements,
        readiness: a.readiness, dependencies: a.deps, freshnessLimitMs: a.m.freshnessMs, resources: a.m.resources, priority: { score: a.score ?? round(Object.values(a.components).reduce((s, v) => s + (v || 0), 0), 2), components: a.components },
        bottleneck: a.bottleneck, nextAction: a.next, decisions: a.decisions, labModule: a.m.labModule, lab: a.lab, champion: a.champion, exploratory: a.exploratory,
        dispatch: a.dispatch || (a.m.labModule ? { status: 'NOT_NEEDED' } : { status: 'TRADER_SIDE_ONLY' }),
        retry: { attempts: st.attempts || 0, nextAttemptAt: st.nextAttemptAt ?? null, reason: st.retryReason ?? null }, receipts: st.receipts || [], stageSince: st.stageSince ?? null,
        lastExperiment: le || null, executionAuthority: false,
        plain: { doing: doingText(a), why: a.bottleneck, needs: need.length ? need.join('; ') : 'Nothing missing for the current stage', next: a.next, changed } };
    }).sort((x, y) => y.priority.score - x.priority.score || x.id.localeCompare(y.id));
    const top = modules[0];
    return { schema: COORDINATOR_SCHEMA, at: now, scope: 'Deterministic paper-research coordinator; recommendations and Lab hints only', executionAuthority: false, liveAuthority: false, modelCalls: 0,
      summary: top ? { doing: `Highest priority: ${top.title} (${top.stage}). ${top.plain.doing}`, why: top.plain.why, next: top.plain.next,
        stages: Object.fromEntries(STAGES.map(s => [s, modules.filter(m => m.stage === s).length])) } : null,
      modules, feeds: Object.values(g.feeds), hypotheses, champions: g.champions,
      requests: { pending: this.pendingRequests(now), recent: this.store.db.prepare('SELECT id,module,kind,status,created_at createdAt,updated_at updatedAt,receipt FROM coordinator_requests ORDER BY updated_at DESC LIMIT 20').all().map(r => ({ ...r, receipt: r.receipt ? JSON.parse(r.receipt) : null })) },
      channel: { requestsFile: 'lab-link/coordinator-requests.json', acksFile: 'lab-link/coordinator-acks.json', lastAckAt: num(g.acks?.at), endpoint: '/api/coordinator' } };
  }
  snapshot() { return this.view || this.memory('coord:view') || { schema: COORDINATOR_SCHEMA, at: null, modules: [], executionAuthority: false, note: 'Coordinator has not run yet' }; }
}

function doingText(a) {
  if (a.stage === 'RESEARCH') return a.lab?.phase === 'RUNNING' || a.lab?.status === 'RUNNING' ? 'The Lab is running research for this module.'
    : a.dispatch?.status === 'BACKOFF' ? 'Waiting for the retry cooldown before requesting research.'
    : a.dispatch?.status === 'DONE_FOR_THIS_EVIDENCE' ? 'Current evidence was processed; waiting for new independent observations.'
    : 'Research is requested or waiting for eligible evidence and Lab capacity.';
  return { REPAIR: 'Holding this module until its book is restored.', COLLECT: 'Waiting for fresh observations before any research.', RESEARCH: 'The Lab is researching this module on its current evidence.',
    FREEZE: 'Waiting for the Lab to freeze an admissible candidate with verified provenance.', ADMISSION: 'A frozen exploratory proposal is waiting for trader admission.',
    EVALUATE: 'Collecting prospective paper outcomes.', DECIDE: 'Paper outcomes are sufficient for a retain/revise/reject recommendation.' }[a.stage];
}
export function describeChange(before, after, le) {
  if (!before || !after) return 'The last research request completed; no comparable measurements were recorded.';
  const parts = [];
  if (before.labPhase !== after.labPhase) parts.push(`Lab phase ${before.labPhase ?? 'none'} -> ${after.labPhase ?? 'none'}`);
  if (before.labBlockers !== after.labBlockers) parts.push(`Lab blockers ${before.labBlockers ?? 0} -> ${after.labBlockers ?? 0}`);
  if (before.champion !== after.champion) parts.push(`champion ${before.champion ?? 'none'} -> ${after.champion ?? 'none'}`);
  for (const [id, b] of Object.entries(after.books || {})) {
    const p = before.books?.[id];
    if (!p) parts.push(`${id} started`);
    else if (p.closes !== b.closes || p.net !== b.net) parts.push(`${id} closes ${p.closes} -> ${b.closes}, net ${p.net ?? '?'} -> ${b.net ?? '?'}`);
  }
  return parts.length ? `After request ${String(le.requestId).slice(0, 8)} (${le.kind}): ${parts.join('; ')}.` : `Request ${String(le.requestId).slice(0, 8)} (${le.kind}) completed with no measurable change.`;
}

// GET /api/coordinator (src/hudRoutes.js). Live: the running coordinator. Preview: the last view the
// running app stored (read-only SQLite), else a files-only plan computed in memory without writes.
export async function handleCoordinatorRequest(req, res, url, ctx) {
  if (url.pathname !== '/api/coordinator') return false;
  const live = ctx.live?.marketPlatform?.();
  if (live?.intelligence?.coordinator) { ctx.json(res, { ok: true, source: 'live', ...live.intelligence.coordinator.snapshot(), lastError: live.intelligence.coordinatorError || null }); return true; }
  const file = path.join(ctx.dataDir, 'mpos-core.sqlite');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { const r = db.prepare("SELECT result FROM intelligence_memory WHERE identity='coord:view'").get(); if (r) { ctx.json(res, { ok: true, source: 'stored', ...JSON.parse(r.result) }); return true; } }
    finally { db.close(); }
  } catch {}
  const { CoreDatabase } = await import('./database.js');
  const mem = new CoreDatabase(':memory:');
  try { const c = new Coordinator(mem, null, { dataDir: ctx.dataDir, publish: false }); c.tick({ rows: [] }); ctx.json(res, { ok: true, source: 'files-only', note: 'Computed from lab-link files without the paper scoreboard', ...c.snapshot() }); }
  finally { mem.close?.(); }
  return true;
}
