import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { cfg } from './config.js';
import { strategyNames, defaults as runtimeDefaults } from './runtime.js';
import { ensureResearch } from './research.js';
import { ensurePnlLedger, paperIdentity, guardEquityJump } from './accounting.js';
import { renameSyncWithRetry } from './atomicRename.js';

const dir = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
const stateFile = path.join(dir, 'state.json');
const backupFile = path.join(dir, 'state.backup.json');
const journalFile = path.join(dir, 'market.ndjson');
const actionFile = path.join(dir, 'actions.ndjson');
const JOURNAL_MAX_BYTES = 128 * 1024 * 1024;
let lastSaveMs = 0;
let lastBackupAt = 0;
let readCache = { stamp: '', value: null };

export function stateStamp() {
  try { const st = fs.statSync(stateFile); return `${Math.trunc(st.mtimeMs)}:${st.size}`; } catch { return 'missing'; }
}

export function loadStateCached() {
  const stamp = stateStamp();
  if (readCache.value && readCache.stamp === stamp) return readCache.value;
  const value = loadState();
  readCache = { stamp, value };
  return value;
}

const strategyStats = () => Object.fromEntries(strategyNames.map(k => [k, {
  signals: 0, trades: 0, wins: 0, losses: 0, pnlSol: 0, avgReturnPct: 0, shadowScore: 0,
}]));

const fresh = (startSol = cfg.paperStartSol) => ({
  paperStartSol: Number.isFinite(Number(startSol)) && Number(startSol) > 0 ? Number(startSol) : cfg.paperStartSol,
  cashSol: Number.isFinite(Number(startSol)) && Number(startSol) > 0 ? Number(startSol) : cfg.paperStartSol,
  positions: [], history: [], pnlLedger: [], realizedLifetimePnlSol: 0, cooldowns: {}, watchlist: [], snapshots: {}, tickHistory: {}, candles: {},
  strategies: strategyStats(), pendingActions: [],
  market: { regime: 'UNKNOWN', score: 50, updatedAt: null }, rpcHealth: [],
  runtime: runtimeDefaults(),
  system: {
    paused: false, killSwitch: false, lastCycle: null, lastError: null, startedAt: Date.now(), streamEvents: 0,
    health: 'STARTING', diagnostics: [], metrics: { cycleMs: 0, discoveryMs: 0, riskMs: 0, analysisMs: 0, saveMs: 0 },
  },
  stats: { cycles: 0, signals: 0, skipped: 0, errors: 0, manualEntries: 0 },
});

function merge(s) {
  const f = fresh();
  const out = {
    ...f, ...s,
    system: { ...f.system, ...s?.system, metrics: { ...f.system.metrics, ...s?.system?.metrics } },
    stats: { ...f.stats, ...s?.stats },
    strategies: { ...f.strategies, ...s?.strategies },
    market: { ...f.market, ...s?.market },
    runtime: { ...f.runtime, ...s?.runtime, strategies: { ...f.runtime.strategies, ...s?.runtime?.strategies } },
  };
  // F1 (ACCOUNTING-AUDIT §3): `fresh()` seeds `pnlLedger: []` and `realizedLifetimePnlSol: 0`.
  // Spreading it UNDER a persisted state that predates those fields still leaves them present,
  // so ensurePnlLedger's reconstruction guards can never fire and the first load of a legacy
  // bankroll silently zeroes lifetime PnL while cashSol still carries the whole trading history.
  // Drop the seeded keys for exactly those inputs; states that already carry them are untouched.
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    if (!Array.isArray(s.pnlLedger)) delete out.pnlLedger;
    if (!Number.isFinite(Number(s.realizedLifetimePnlSol))) delete out.realizedLifetimePnlSol;
  }
  ensureResearch(out);
  ensurePnlLedger(out);
  out._accounting = paperIdentity(out);
  const jump = guardEquityJump({ nextEquity: out._accounting.equity, startSol: out.paperStartSol });
  const alerts = [];
  if (!jump.ok) alerts.push({ code: 'EQUITY_JUMP', reasons: jump.reasons });
  // F2: the old bar was max(0.5, start*0.25) against the INEXACT hole — on a 1 SOL bankroll the
  // observed 0.544 SOL hole cleared it by 0.044 and never raised anything.
  if (!out._accounting.ok && Math.abs(out._accounting.holeExact) > Math.max(1e-6, Number(out.paperStartSol || 0) * 1e-4)) {
    alerts.push({ code: 'PAPER_IDENTITY', hole: out._accounting.holeExact });
  }
  if (Number(out._accounting.openRz || 0) > Math.max(3, Number(out.paperStartSol || 0) * 3)) {
    alerts.push({ code: 'OPEN_REALIZED_ABSURD', openRz: out._accounting.openRz });
  }
  out.system = out.system || {};
  if (alerts.length) {
    out.system.accountingAlert = { code: alerts[0].code, alerts, at: Date.now(), identity: out._accounting };
    out.system.health = out.system.health === 'HEALTHY' ? 'CAUTION' : out.system.health;
  } else if (out.system.accountingAlert) {
    // F4: nothing ever cleared this, and merge's {...f, ...s} carried it forward every cycle,
    // pinning health at CAUTION forever after a single historic alert.
    delete out.system.accountingAlert;
  }
  publishedBasis = snapshotBasis(out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// F6 (ACCOUNTING-AUDIT §4 RC-A) — realized cash may only appear when basis leaves a position.
//
// On 2026-09-10 a priceIntegrityRepair pass rewrote one position's realizedSol from 27.556 to
// 34.916 (+7.359989876 SOL) while remainingSol did not move by a single lamport. The cash bridge
// closes to 0.000000000 around that write: it was money creation, and nothing in the tree refused
// it -- guardEquityJump allowed max(start*5, 5) = 50 SOL per save on a 10 SOL bankroll.
//
// The previous published state is snapshotted as COPIED PRIMITIVES rather than read back out of
// readCache: readCache holds the caller's own object, so any caller that mutates a cached state in
// place would compare it against itself and see no delta at all.
// ---------------------------------------------------------------------------------------------
const BASIS_EPS = 1e-12;
const REALIZED_EPS = 1e-9;
// Same window reviewPositionPrice admits a tick in (positionExecution.js): a mark outside it is
// not evidence of anything and may not authorise realized cash.
const MARK_RATIO_MIN = 0.05;
const MARK_RATIO_MAX = 20;
let publishedBasis = new Map();

function positionBasis(p) {
  return {
    rem: Number(p?.remainingSol ?? p?.sizeSol ?? 0) || 0,
    rz: Number(p?.realizedSol || 0) || 0,
  };
}

function snapshotBasis(s) {
  const m = new Map();
  for (const p of s?.positions || []) {
    if (!p || p.id == null) continue;
    m.set(String(p.id), positionBasis(p));
  }
  return m;
}

export function realizedBasisViolations(state, previous = publishedBasis) {
  const out = [];
  for (const p of state?.positions || []) {
    if (!p || p.id == null) continue;
    const next = positionBasis(p);
    const where = { id: p.id, mint: p.mint ?? null, symbol: p.symbol ?? null };
    const prev = previous.get(String(p.id));
    if (!prev) {
      // A position that did not exist in the last published state opens with an entry fee
      // (realizedSol = -fee, paper) or 0 (live). Positive realized cash on a brand-new position
      // is the same money creation arriving through a different door.
      if (next.rz > REALIZED_EPS) out.push({ code: 'REALIZED_WITHOUT_BASIS', ...where, soldBasis: 0, dRealized: next.rz, opened: true });
      continue;
    }
    const soldBasis = prev.rem - next.rem;
    const dRealized = next.rz - prev.rz;
    if (soldBasis <= BASIS_EPS) {
      if (Math.abs(dRealized) > REALIZED_EPS) out.push({ code: 'REALIZED_WITHOUT_BASIS', ...where, soldBasis, dRealized });
      continue;
    }
    const entry = Number(p.entryPrice || 0);
    const last = Number(p.lastPrice || entry || 0);
    let markRatio = entry > 0 && last > 0 ? last / entry : 1;
    if (!Number.isFinite(markRatio) || markRatio <= 0) markRatio = 1;
    const maxMarkRatio = Math.min(MARK_RATIO_MAX, Math.max(MARK_RATIO_MIN, markRatio));
    const limit = soldBasis * maxMarkRatio + REALIZED_EPS;
    if (dRealized > limit) out.push({ code: 'REALIZED_EXCEEDS_MARK', ...where, soldBasis, dRealized, markRatio, maxMarkRatio, limit });
  }
  return out;
}

function validateAccount(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)
      || typeof s.cashSol !== 'number' || !Number.isFinite(s.cashSol) || s.cashSol < 0
      || !Array.isArray(s.positions) || !Array.isArray(s.history)) {
    throw new Error('Invalid account state: expected finite nonnegative cash and position/history arrays');
  }
  if (s.paperStartSol !== undefined
      && (typeof s.paperStartSol !== 'number' || !Number.isFinite(s.paperStartSol) || s.paperStartSol <= 0)) {
    throw new Error('Invalid account state: starting balance must be finite and positive');
  }
  return s;
}

function parseState(file) {
  return merge(validateAccount(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

export function loadState() {
  try {
    return parseState(stateFile);
  } catch (primaryError) {
    try {
      const recovered = parseState(backupFile);
      recovered.system.lastError = `Recovered state from backup; entries paused for account review: ${primaryError.message}`;
      recovered.system.paused = true;
      recovered.system.killSwitch = true;
      recovered.system.recovery = { status: 'BACKUP_RECOVERED', observedAt: Date.now(), reviewRequired: true };
      return recovered;
    } catch (backupError) {
      // Only an actually new installation may initialize a bankroll.
      if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') return merge(fresh());
      const error = new Error(`Account state unavailable; existing files preserved. Primary: ${primaryError.message}; backup: ${backupError.message}`);
      error.code = 'STATE_RECOVERY_REQUIRED';
      throw error;
    }
  }
}

function pruneState(s) {
  delete s._accounting;
  const now = Date.now();
  s.history = (s.history || []).slice(-1500);
  s.pnlLedger = (s.pnlLedger || []).slice(-100000);
  s.watchlist = (s.watchlist || []).slice(0, 180);
  s.proposals = (s.proposals || []).slice(0, 100);
  s.pendingActions = (s.pendingActions || []).slice(-200);

  const active = new Set([
    ...(s.watchlist || []).map(x => x.mint),
    ...(s.positions || []).map(x => x.mint),
    ...(s.runtime?.pinned || []),
    ...(s.runtime?.favorites || []),
  ].filter(Boolean));

  for (const [mint, xs] of Object.entries(s.tickHistory || {})) {
    if (!active.has(mint) && (!xs.length || now - (xs.at(-1)?.ts || 0) > 30 * 60_000)) delete s.tickHistory[mint];
    else if (!active.has(mint) && xs.length > 60) s.tickHistory[mint] = xs.slice(-60);
    else if (xs.length > 240) s.tickHistory[mint] = xs.slice(-240);
  }
  for (const [mint, snap] of Object.entries(s.snapshots || {})) {
    if (!active.has(mint) && now - (snap?.ts || 0) > 30 * 60_000) delete s.snapshots[mint];
  }
  for (const [mint, until] of Object.entries(s.cooldowns || {})) if (until < now - 3600_000) delete s.cooldowns[mint];

  if (s.research) {
    if (s.research.feedStats?.unknown) delete s.research.feedStats.unknown;
    s.research.postmortems = (s.research.postmortems || []).slice(0, 500);
    s.research.lessons = (s.research.lessons || []).slice(0, 400);
    s.research.experiments = (s.research.experiments || []).slice(0, 400);
    s.research.daily = (s.research.daily || []).slice(0, 180);
    s.research.challengers = (s.research.challengers || []).slice(-128);
    if (s.research.learner) {
      s.research.learner.pending = (s.research.learner.pending || []).slice(-1800);
      s.research.learner.outcomes = (s.research.learner.outcomes || []).slice(0, 3000);
    }
    const walletEntries = Object.entries(s.research.walletProfiles || {});
    if (walletEntries.length > 10000) {
      walletEntries.sort((a,b)=>Number(b[1]?.lastSeen||0)-Number(a[1]?.lastSeen||0));
      s.research.walletProfiles = Object.fromEntries(walletEntries.slice(0,10000));
    }
    const deployerEntries = Object.entries(s.research.deployerProfiles || {});
    if (deployerEntries.length > 3000) {
      deployerEntries.sort((a,b)=>Number(b[1]?.lastSeen||0)-Number(a[1]?.lastSeen||0));
      s.research.deployerProfiles = Object.fromEntries(deployerEntries.slice(0,3000));
    }
    if (s.research.alpha) {
      const a=s.research.alpha;
      const tokenEntries=Object.entries(a.tokens||{}).sort((x,y)=>Number(y[1]?.lastSeen||0)-Number(x[1]?.lastSeen||0));
      if(tokenEntries.length>6000)a.tokens=Object.fromEntries(tokenEntries.slice(0,6000));
      const walletEntriesA=Object.entries(a.wallets||{}).sort((x,y)=>Number(y[1]?.lastSeen||0)-Number(x[1]?.lastSeen||0));
      if(walletEntriesA.length>15000)a.wallets=Object.fromEntries(walletEntriesA.slice(0,15000));
      a.counterfactuals=(a.counterfactuals||[]).slice(-500);a.evidence=(a.evidence||[]).slice(0,20);
    }
    const universeEntries = Object.entries(s.research.universe || {});
    if (universeEntries.length > 5000) {
      universeEntries.sort((a, b) => Number(b[1]?.lastSeen || 0) - Number(a[1]?.lastSeen || 0));
      s.research.universe = Object.fromEntries(universeEntries.slice(0, 5000));
    }
  }
  return s;
}

export function saveState(state) {
  const started = performance.now();
  fs.mkdirSync(dir, { recursive: true });
  const s = pruneState(validateAccount(state));
  ensurePnlLedger(s);
  const id = paperIdentity(s);
  const prevEq = readCache?.value ? paperIdentity(readCache.value).equity : null;
  // Block only discontinuous single-save leaps vs the last loaded mark.
  // Slow compounding past 20x start is allowed; load-time merge still flags multiples.
  const jump = guardEquityJump({
    prevEquity: prevEq,
    nextEquity: id.equity,
    startSol: s.paperStartSol,
    maxMultiple: 1e9,
    maxAbsJump: Math.max(Number(s.paperStartSol || 0) * 5, 5),
  });
  const violations = realizedBasisViolations(s);
  if (violations.length) {
    const first = violations[0];
    s.system = s.system || {};
    s.system.accountingAlert = { code: first.code, violations, at: Date.now(), identity: id };
    const err = new Error(`refusing to save: ${first.code} on position ${first.id}`
      + ` (basis sold ${first.soldBasis}, realized delta ${first.dRealized})`);
    err.code = first.code; err.violations = violations; err.identity = id;
    throw err;
  }
  if (!jump.ok) {
    s.system = s.system || {};
    s.system.accountingAlert = { code: 'EQUITY_JUMP', reasons: jump.reasons, at: Date.now(), identity: id, prevEquity: prevEq };
    const err = new Error(`refusing to save: ${jump.reasons.join(',')}`);
    err.code = 'EQUITY_JUMP'; err.jump = jump; err.identity = id;
    throw err;
  }
  if (!id.ok) {
    s.system = s.system || {};
    s.system.accountingAlert = { code: 'PAPER_IDENTITY', at: Date.now(), identity: id };
  }
  s.system ||= {};
  s.system.metrics ||= {};
  // Persist the previous measured save duration; the current duration is returned to the caller.
  s.system.metrics.saveMs = lastSaveMs;
  const temp = `${stateFile}.${process.pid}.tmp`;
  const json = JSON.stringify(s);
  fs.writeFileSync(temp, json, { flush: true });
  if (fs.existsSync(stateFile) && Date.now() - lastBackupAt > 120_000) {
    const backupTemp = `${backupFile}.${process.pid}.tmp`;
    try {
      // Validate the same bytes we publish, never copy a damaged primary over good recovery data.
      const previous = fs.readFileSync(stateFile, 'utf8');
      validateAccount(JSON.parse(previous));
      fs.writeFileSync(backupTemp, previous, { flush: true });
      renameSyncWithRetry(backupTemp, backupFile);
      lastBackupAt = Date.now();
    } catch {
      // The prior backup remains intact if validation or publication fails.
    } finally {
      try { fs.rmSync(backupTemp, { force: true }); } catch {}
    }
  }
  try { renameSyncWithRetry(temp, stateFile); }
  finally { try { fs.rmSync(temp, { force: true }); } catch {} }
  readCache = { stamp: stateStamp(), value: s };
  publishedBasis = snapshotBasis(s);
  lastSaveMs = Math.round(performance.now() - started);
  return lastSaveMs;
}

function rotateJournalIfNeeded() {
  try {
    if (!fs.existsSync(journalFile) || fs.statSync(journalFile).size < JOURNAL_MAX_BYTES) return;
    const old2 = `${journalFile}.2`;
    const old1 = `${journalFile}.1`;
    try { fs.rmSync(old2, { force: true }); } catch {}
    try { if (fs.existsSync(old1)) fs.renameSync(old1, old2); } catch {}
    fs.renameSync(journalFile, old1);
  } catch {}
}

// scan-candidate rows are ~98% of market.ndjson by volume - measured at ~1 GB a day on
// WITCHDOCTOR. They are the research dataset the Evolution Lab trains on, so the research
// machine must keep them. A laptop that only trades gains nothing from the writes and pays for
// them in SSD wear and battery, so it can opt out with MPO_JOURNAL_SCAN_CANDIDATES=false.
// Rotation already bounds the footprint (3 x JOURNAL_MAX_BYTES); this bounds the write rate.
export const JOURNAL_SCAN_CANDIDATES = String(process.env.MPO_JOURNAL_SCAN_CANDIDATES ?? '').trim().toLowerCase() !== 'false';
const journalKeeps = row => JOURNAL_SCAN_CANDIDATES || row?.type !== 'scan-candidate';

export function appendJournal(row) {
  if (!journalKeeps(row)) return;
  fs.mkdirSync(dir, { recursive: true });
  rotateJournalIfNeeded();
  fs.appendFileSync(journalFile, `${JSON.stringify({ ...row, ts: row.ts || Date.now() })}\n`);
}

export function appendJournalBatch(rows = []) {
  rows = rows.filter(journalKeeps);
  if (!rows.length) return;
  fs.mkdirSync(dir, { recursive: true });
  rotateJournalIfNeeded();
  const text = rows.map(row => JSON.stringify({ ...row, ts: row.ts || Date.now() })).join('\n') + '\n';
  fs.appendFileSync(journalFile, text);
}

export function readJournal(limit = 5000) {
  const readTail = file => {
    try {
      const stat = fs.statSync(file);
      const targetBytes = Math.min(stat.size, Math.max(1024 * 1024, Math.min(48 * 1024 * 1024, limit * 900)));
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(targetBytes);
      fs.readSync(fd, buf, 0, targetBytes, stat.size - targetBytes);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      if (stat.size > targetBytes) text = text.slice(text.indexOf('\n') + 1);
      return text.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  // Oldest → newest so rotated history remains usable by reports/backtests.
  const rows = [`${journalFile}.2`, `${journalFile}.1`, journalFile].flatMap(readTail);
  return rows.slice(-limit);
}

// Dashboard actions use their own append-only queue to avoid overwriting scanner state mid-cycle.
// The queue is for small dashboard actions. On 2026-09-18 an in-process evolution service pushed
// ~290 KB 'evolution-sync' snapshots into it several times a second, actions.ndjson reached 23 GB,
// drainActions() could no longer read it into memory, and the disk filled. Two rails now exist:
// no single action above ACTION_MAX_BYTES, and no queue file above QUEUE_MAX_BYTES (quarantined,
// never silently deleted). Evolution state arrives over the lab link (src/labLink.js) instead.
export const ACTION_MAX_BYTES = 512 * 1024;
export const QUEUE_MAX_BYTES = 64 * 1024 * 1024;
export const DRAIN_ORPHAN_MS = 5 * 60_000;
export function enqueueAction(action) {
  fs.mkdirSync(dir, { recursive: true });
  const queued = { id: action.id || randomUUID(), ...action, ts: action.ts || Date.now() };
  const line = `${JSON.stringify(queued)}\n`;
  if (Buffer.byteLength(line) > ACTION_MAX_BYTES) throw new Error(`action ${queued.type || '?'} is ${Buffer.byteLength(line)} bytes; the queue accepts at most ${ACTION_MAX_BYTES}`);
  if (queued.type === 'evolution-sync') throw new Error('Legacy evolution-sync is retired; use the validated Lab link.');
  fs.appendFileSync(actionFile, line);
  return queued;
}
export function quarantineActionQueue(reason = 'oversized') {
  const target = `${actionFile}.quarantined-${Date.now()}`;
  try { fs.renameSync(actionFile, target); } catch { return null; }
  try { appendJournal({ type: 'error', error: `actions.ndjson quarantined (${reason}) as ${path.basename(target)}; review or delete it` }); } catch {}
  return target;
}
// A .drain file lives for milliseconds; one older than DRAIN_ORPHAN_MS belongs to a process that
// died mid-drain (or hit ENOSPC) and would otherwise sit on disk forever.
export function cleanupActionDrains(now = Date.now()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('actions.ndjson.') || !name.endsWith('.drain') || name.startsWith(`actions.ndjson.${process.pid}.`)) continue;
      const file = path.join(dir, name);
      try { if (now - fs.statSync(file).mtimeMs > DRAIN_ORPHAN_MS) { fs.rmSync(file, { force: true }); removed++; } } catch {}
    }
  } catch {}
  return removed;
}

let lastDrainSweep = 0;
export function drainActions(limit = 1000) {
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  if (now - lastDrainSweep > 60_000) { lastDrainSweep = now; cleanupActionDrains(now); }
  if (!fs.existsSync(actionFile)) return [];
  try { const size = fs.statSync(actionFile).size; if (size > QUEUE_MAX_BYTES) { quarantineActionQueue(`${size} bytes`); return []; } } catch {}
  const drainFile = `${actionFile}.${process.pid}.${Date.now()}.drain`;
  try {
    // Atomic rename: dashboard appends after this point create/use a new actions.ndjson.
    fs.renameSync(actionFile, drainFile);
  } catch {
    return [];
  }
  // If anything below throws (e.g. ENOSPC while writing `remain` back), drainFile is left on
  // disk instead of deleted: it is the only copy of the batch, and cleanupActionDrains only
  // removes files older than DRAIN_ORPHAN_MS, leaving a window to recover it by hand.
  const lines = fs.readFileSync(drainFile, 'utf8').split('\n').filter(Boolean);
  const take = lines.slice(0, limit);
  const remain = lines.slice(limit);
  if (remain.length) fs.appendFileSync(actionFile, `${remain.join('\n')}\n`);
  fs.rmSync(drainFile, { force: true }); // only reached once `remain` is durably persisted
  return take.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean).filter(action => {
    if (action.type !== 'evolution-sync') return true;
    try { appendJournal({ type: 'action-rejected', actionType: action.type, actionId: action.id || null, reason: 'Legacy evolution-sync is retired.' }); } catch { /* Rejection diagnostics must not discard unrelated queued actions. */ }
    return false;
  });
}

export function resetPaper(startSol = cfg.paperStartSol, persist = true) {
  const amount = Number(startSol);
  const s = merge(fresh(Number.isFinite(amount) && amount > 0 ? amount : cfg.paperStartSol));
  if (persist) saveState(s);
  return s;
}

export function getPaperIdentity(s){ return paperIdentity(s); }
export function checkEquityJump(args){ return guardEquityJump(args); }
