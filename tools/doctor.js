import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/config.js';
import { liveConfigVerdict } from '../src/liveConfig.js';
import { benchmarkRpcs } from '../src/rpc.js';
import { loadState } from '../src/store.js';
import { edgeProofSnapshot } from '../src/edgeProof.js';
import { paperIdentity } from '../src/accounting.js';

// Same data-dir resolution as src/store.js:9 (honours MONEY_PRINTER_DATA_DIR) instead of a
// hardcoded relative 'data/', so the "state present/fresh" line is correct for the packaged app.
const dataDir = path.resolve(process.env.MONEY_PRINTER_DATA_DIR || 'data');
const stateFile = path.join(dataDir, 'state.json');
const backupFile = path.join(dataDir, 'state.backup.json');
// P2.1: research-state.json now has the same pair of files, and its recovery marker is worth printing -- the
// account recovers loudly (paused + killSwitch), research recovers quietly by design.
const researchFile = path.join(dataDir, 'research-state.json');
const researchBackupFile = path.join(dataDir, 'research-state.backup.json');
const journalFile = path.join(dataDir, 'market.ndjson');

// --offline (or DOCTOR_OFFLINE=1) skips the live RPC benchmark so doctor can be run with
// network providers disabled/mocked, per the ground rules. Default (interactive) is unchanged.
const OFFLINE = process.argv.includes('--offline') || process.env.DOCTOR_OFFLINE === '1';

const s = loadState();
const nodeMajor = Number(process.versions.node.split('.')[0]);
console.log('MONEY PRINTER OS · EDGE PROVER DOCTOR');
console.log('Node', process.versions.node, nodeMajor >= 22 ? 'OK' : 'UPDATE REQUIRED (22+)');
console.log('mode', cfg.mode, 'live gate', cfg.enableLiveTrading, 'jito', cfg.jitoEnabled, 'direct stream', cfg.directStreamEnabled);
// P4.2: the same verdict the engine refuses on, read here so a config that could never dispatch cannot be
// reported as healthy to a script that only reads $?, and so doctor and the engine cannot disagree about
// what "live" means. It reports (REFUSED / WARN, each with a reason code) and exits non-zero on a refusal;
// it never arms anything, and the execution boundary still locks dispatch on top of it. The two ad-hoc
// live WARNs that used to live further down are subsumed by the reason codes, so they are gone.
const liveConfig = liveConfigVerdict(cfg);
for (const row of liveConfig.fatal) console.log('REFUSED:', row.code, '·', row.message);
for (const row of liveConfig.warnings) console.log('WARN:', row.code, '·', row.message);
if (liveConfig.fatal.length) process.exitCode = 1;
console.log('autonomy level', s.research?.autonomyLevel, 'system health', s.system?.health || 'UNKNOWN');
console.log('state', fs.existsSync(stateFile) ? 'present' : 'fresh', 'backup', fs.existsSync(backupFile) ? 'present' : 'none',
  'research', fs.existsSync(researchFile) ? 'present' : 'fresh', 'research backup', fs.existsSync(researchBackupFile) ? 'present' : 'none');
if (s.system?.researchRecovery) {
  const rr = s.system.researchRecovery;
  console.log('research state', rr.status, 'since', new Date(rr.observedAt).toISOString(), '·', rr.reason, '· review', rr.reviewRequired ? 'required' : 'not required');
}
console.log('journal', fs.existsSync(journalFile) ? `${(fs.statSync(journalFile).size / 1024 / 1024).toFixed(1)} MB` : 'fresh');
const id = paperIdentity(s);
console.log('PAPER IDENTITY', 'start', id.start, 'life', id.life, 'unreal', id.unreal, 'openRz', id.openRz, 'equity', id.equity, 'holeExact', id.holeExact, 'okExact', id.okExact);
// Robinhood Auto Trader readiness from env + files only (the venue module is never imported here; the loop state is
// reported by scripts/health-check.mjs from the running dashboard). Mirrors the Polymarket US style: keys / real / journal.
{
  const rhJournal = path.join(dataDir, 'robinhood-auto-trader.json');
  const rhPaper = path.join(dataDir, 'robinhood-paper.json');
  let rhOpen = 'n/a', rhQualified = 'unknown', rhEvolve = 'no ledger';
  try { const j = JSON.parse(fs.readFileSync(rhJournal, 'utf8')); rhOpen = j.recoveryRequired ? 'RECOVERY' : String((j.open || []).length); } catch (e) { rhOpen = e?.code === 'ENOENT' ? '0' : 'UNREADABLE'; }
  try { const p = JSON.parse(fs.readFileSync(rhPaper, 'utf8')); rhQualified = p.qualification?.qualified === true ? 'yes' : 'no'; } catch (e) { rhQualified = e?.code === 'ENOENT' ? 'no' : 'UNREADABLE'; }
  try { const l = JSON.parse(fs.readFileSync(path.join(dataDir, 'robinhood-evolve.json'), 'utf8')); rhEvolve = `gen ${l.generation || 0}${l.champion ? ' champion ' + l.champion.paramsHash : ''}`; } catch {}
  const keys = process.env.ROBINHOOD_API_KEY && process.env.ROBINHOOD_PRIVATE_KEY ? 'configured' : 'absent';
  console.log('robinhood', fs.existsSync(rhJournal) ? 'journal present' : 'no journal', 'keys', keys, 'real', process.env.ROBINHOOD_REAL_ENABLED === 'true' ? 'ENABLED' : 'disabled', 'open', rhOpen, 'qualified', rhQualified, 'evolve', rhEvolve, 'autopromote', process.env.ROBINHOOD_EVOLVE_AUTOPROMOTE === 'true' ? 'ON' : 'off');
  if (process.env.ROBINHOOD_REAL_ENABLED === 'true') console.log('WARN: ROBINHOOD_REAL_ENABLED=true; real crypto orders can be armed in the HUD');
}
console.log('Jupiter key', cfg.jupiterApiKey ? 'configured' : 'missing');
console.log('Alpha worker', cfg.alphaWorkerEnabled ? 'enabled' : 'disabled', 'tx min EDGE', cfg.alphaTxMinEdge);
console.log('Transaction feed', cfg.txFeedUrl ? 'custom configured' : cfg.heliusApiKey ? 'Helius configured' : 'public RPC fallback');
const proof=edgeProofSnapshot();console.log('EDGE proof', proof.status, `${proof.proofScore}%`, 'independent launches', proof.independentMints, 'production learning', proof.productionLearningUnlocked?'UNLOCKED':'LOCKED');console.log('EDGE next', proof.nextAction||'collect data');
console.log('Social feed', cfg.socialFeedUrl || 'not configured');
console.log('Program IDs', cfg.programLogIds.length ? cfg.programLogIds : 'not configured');
if (cfg.scanIntervalSec < 1) console.log('WARN: SCAN_INTERVAL_SEC below 1 is clamped by the runtime loop');
if (OFFLINE) {
  console.log('RPC benchmark skipped (--offline)');
} else {
  try {
    console.table(await benchmarkRpcs());
  } catch (error) {
    console.log('RPC benchmark failed:', error.message);
  }
}
for (const d of s.system?.diagnostics || []) console.log(d.level, d.code, d.message);
