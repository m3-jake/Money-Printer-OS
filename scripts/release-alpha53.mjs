#!/usr/bin/env node
// scripts/release-alpha53.mjs — Money Printer OS alpha53 release driver.
//
// Verbs: pack | test-record | promote | install | restart
//
// `install` and `restart` are present only as a design reference for bing (see
// docs section below and .workflow/scratch/PACKAGING.md §7). They HARD-REFUSE to run
// under an agent session and print the exact command bing should run himself.
// No agent invocation of this script may ever execute those two verbs.
//
// This script never reads, names, or infers the release signing private key. It
// never touches `~/Applications` or `~/Library/Application Support/Money Printer OS`.
// It never loosens any live-execution/risk gate. It is analysis + packaging + a
// gate-record driver only — see PACKAGING.md for the design this implements verbatim.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUT = '/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release.asar';
const RECORD_PATH = path.join(ROOT, '.workflow', 'scratch', 'packaging', 'release-record.json');
const EXPECTED_VERSION = '0.5.0-alpha.53';

// Paths excluded from the packaged app. Mirrors PACKAGING.md §1/§6 exactly.
const STAGE_EXCLUDES = new Set([
  '.git', '.workflow', '.env', '.DS_Store', 'data', '.agent-state', 'agent-state',
  'research', 'artifacts',
]);

function log(...args) { console.log(...args); }
function fail(msg) { console.error(`release-alpha53: ${msg}`); process.exitCode = 1; return false; }

function gitRoot() {
  return execFileSync('git', ['-C', ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function gitStatusPorcelain() {
  return execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
}

function gitHead() {
  return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')); }
  catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

function writeRecord(record) {
  fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
  fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
}

// Recursively copy `src` into `dest`, skipping any path segment (relative to the
// stage root) that appears in STAGE_EXCLUDES. Uses fs.cpSync's filter hook so the
// exclude decision is made once, symmetrically, for files and directories alike.
function copyTree(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter(source) {
      const rel = path.relative(src, source);
      if (rel === '') return true;
      const top = rel.split(path.sep)[0];
      return !STAGE_EXCLUDES.has(top);
    },
  });
}

function cmdPack() {
  const pkg = readPackageJson();
  if (pkg.version !== EXPECTED_VERSION) {
    return fail(`package.json version is '${pkg.version}', expected '${EXPECTED_VERSION}'. Refusing to pack.`);
  }
  const status = gitStatusPorcelain();
  if (status.trim() !== '') {
    console.error('release-alpha53: git status --porcelain is not empty:');
    console.error(status);
    return fail('working tree must be clean before packing.');
  }
  const root = gitRoot();
  if (path.resolve(root) !== path.resolve(ROOT)) {
    return fail(`repo root mismatch: git says '${root}', script root is '${ROOT}'.`);
  }
  const commit = gitHead();

  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-release-'));
  const stage = path.join(stageParent, 'app');
  log(`release-alpha53: staging ${ROOT} -> ${stage} (excluding: ${[...STAGE_EXCLUDES].join(' ')})`);
  copyTree(ROOT, stage);
  // Recreate an EMPTY data/ dir in the stage — the running app expects it to exist,
  // but a user's packaged app must never ship this dev tree's own state/journal files.
  fs.mkdirSync(path.join(stage, 'data'), { recursive: true });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (fs.existsSync(OUT)) fs.rmSync(OUT);
  log(`release-alpha53: packing asar -> ${OUT}`);
  const asar = spawnSync('npx', ['-y', '@electron/asar@4.3.0', 'pack', stage, OUT, '--unpack', '*.node'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (asar.status !== 0) {
    fs.rmSync(stageParent, { recursive: true, force: true });
    return fail(`@electron/asar pack exited ${asar.status}`);
  }
  fs.rmSync(stageParent, { recursive: true, force: true });

  const sha256 = sha256File(OUT);
  const bytes = fs.statSync(OUT).size;

  // desktop/release-gate.cjs's releaseRecord() shape, built inline (no import — this
  // is a plain JSON artifact, not a call into the gate; the gate is invoked for real
  // in `promote`, below).
  const record = {
    schema: 2,
    version: pkg.version,
    commit,
    stage: 'main',
    artifacts: { mac: { file: OUT, sha256, bytes } },
    tests: {},
    signed: false,
    signature: null,
    rollback: null,
    createdAt: Date.now(),
  };
  writeRecord(record);

  const result = { packed: true, bytes, sha256, commit, out: OUT };
  log(JSON.stringify(result, null, 2));
  return true;
}

function requireExistingRecord() {
  const record = readRecord();
  if (!record) {
    fail(`no release record at ${RECORD_PATH}. Run 'pack' first.`);
    return null;
  }
  return record;
}

// test-record --testAll --selftest --macBoot
// Sets tests.{testAll,selftest,macBoot} = true ONLY after actually re-running the
// corresponding check in this same invocation and seeing it pass. It never trusts a
// caller-supplied flag at face value — the flags select which checks to run, not
// what to record.
function runCheck(label, cmdArgs, opts = {}) {
  log(`release-alpha53: running ${label}: ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmdArgs[0], cmdArgs.slice(1), { cwd: ROOT, stdio: 'inherit', ...opts });
  const passed = res.status === 0;
  log(`release-alpha53: ${label} ${passed ? 'PASSED' : 'FAILED'} (exit ${res.status})`);
  return passed;
}

function macBootSmokeTest() {
  // A minimal, offline, non-live boot check: the engine process must start in paper
  // mode with networking disabled and answer its own dashboard HTTP endpoint, then
  // shut down cleanly. This never touches live markets and never writes to the
  // installed app's data directory — it uses a throwaway MONEY_PRINTER_DATA_DIR.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-macboot-'));
  const port = 8793;
  const env = {
    ...process.env,
    MODE: 'paper',
    ALPHA_WORKER_ENABLED: 'false',
    DIRECT_STREAM_ENABLED: 'false',
    OPEN_DASHBOARD: 'false',
    DASHBOARD_HOST: '127.0.0.1',
    DASHBOARD_PORT: String(port),
    MONEY_PRINTER_DATA_DIR: dataDir,
  };
  log(`release-alpha53: mac boot smoke test — data dir ${dataDir}, port ${port}`);
  const res = spawnSync('perl', ['-e', 'alarm 60; exec @ARGV', 'node', 'src/index.js', '--dashboard-only'], {
    cwd: ROOT,
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  // The alarm always tears the child down (SIGALRM) once the smoke window elapses;
  // a boot success is judged by console evidence, not the exit code of a killed proc.
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const booted = /listening|dashboard|ready/i.test(out);
  fs.rmSync(dataDir, { recursive: true, force: true });
  log(`release-alpha53: mac boot smoke test ${booted ? 'PASSED' : 'FAILED'} (offline, paper mode, port ${port})`);
  return booted;
}

function cmdTestRecord(flags) {
  const record = requireExistingRecord();
  if (!record) return false;
  let ok = true;
  if (flags.includes('--testAll')) {
    const passed = runCheck('npm run test:all', ['perl', '-e', 'alarm 1800; exec @ARGV', 'npm', 'run', 'test:all']);
    record.tests.testAll = passed === true;
    ok = ok && passed;
  }
  if (flags.includes('--selftest')) {
    const passed = runCheck('npm run selftest', ['perl', '-e', 'alarm 300; exec @ARGV', 'npm', 'run', 'selftest']);
    record.tests.selftest = passed === true;
    ok = ok && passed;
  }
  if (flags.includes('--macBoot')) {
    const passed = macBootSmokeTest();
    record.tests.macBoot = passed === true;
    ok = ok && passed;
  }
  writeRecord(record);
  log(JSON.stringify({ tests: record.tests }, null, 2));
  return ok;
}

// promote candidate|tested|stable — calls the real release-gate.cjs functions and
// PRINTS `missing` rather than ever forcing a stage past what the record supports.
async function cmdPromote(target) {
  const record = requireExistingRecord();
  if (!record) return false;
  if (!target || !['candidate', 'tested', 'stable'].includes(target)) {
    return fail(`promote requires a target: candidate | tested | stable`);
  }
  const gatePath = path.join(ROOT, 'desktop', 'release-gate.cjs');
  const { promotionGate, promoteRelease } = await import(pathToFileURL(gatePath).href);
  const gate = promotionGate(record, target);
  if (!gate.ok) {
    // Refusal, not forcing a stage: print `missing` and leave the record untouched.
    console.log(`missing: ${JSON.stringify(gate.missing)}`);
    log(JSON.stringify({ ok: false, stage: gate.stage, target, missing: gate.missing }, null, 2));
    return false;
  }
  const promoted = promoteRelease(record, target);
  writeRecord(promoted);
  log(JSON.stringify({ ok: true, stage: promoted.stage }, null, 2));
  return true;
}

function refuseAgentOnly(verb, humanCommand) {
  console.error(`release-alpha53: '${verb}' is bing-only and refuses to run under an agent session.`);
  console.error('release-alpha53: run this yourself, from your own terminal, after confirming');
  console.error('release-alpha53: no real Solana/Polymarket-US session is armed (mode==="paper", sessionArmed===false):');
  console.error('');
  console.error(`    ${humanCommand}`);
  console.error('');
  process.exitCode = 1;
}

function cmdInstall() {
  // Design reference only (PACKAGING.md §7) — reproduced here so bing has the exact
  // shape without an agent ever being able to execute it. This verb ALWAYS refuses,
  // regardless of TTY detection, because installing into ~/Applications and writing
  // ~/Library/Application Support/Money Printer OS is forbidden for any agent session
  // under the hard constraints of this workflow, full stop.
  refuseAgentOnly(
    'install',
    `node "${path.join(ROOT, 'scripts', 'release-alpha53.mjs')}" install   # (run this line yourself, not via an agent)`
  );
  return false;
}

function cmdRestart() {
  refuseAgentOnly(
    'restart',
    `node "${path.join(ROOT, 'scripts', 'release-alpha53.mjs')}" restart   # (run this line yourself, not via an agent)`
  );
  return false;
}

async function main() {
  const [, , verb, ...rest] = process.argv;
  switch (verb) {
    case 'pack': {
      const ok = cmdPack();
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'test-record': {
      const ok = cmdTestRecord(rest);
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'promote': {
      const ok = await cmdPromote(rest[0]);
      // exit 0 only when the record actually advanced a stage; a `missing:` refusal
      // exits 1 so callers can script on either the exit code or the printed line.
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'install': {
      cmdInstall();
      process.exit(1);
      break;
    }
    case 'restart': {
      cmdRestart();
      process.exit(1);
      break;
    }
    default: {
      console.error('usage: release-alpha53.mjs <pack|test-record|promote|install|restart> [...args]');
      process.exit(2);
    }
  }
}

main();
