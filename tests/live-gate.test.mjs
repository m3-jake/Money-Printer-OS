// P4.2 -- audit exec #4 ("the Solana live lane is env-gated, not code-locked: MODE=live +
// ENABLE_LIVE_TRADING=true + BS58_PRIVATE_KEY is enough for the Jupiter path, and doctor only prints
// a WARN if live mode has no key"). Measured at HEAD, one half is false and one half is true.
//
//   FALSE half -- dispatch is already code-locked, one module away from the env flags the finding
//   cites. core/executionBoundary.js refuses every dispatch while `active` (set by platform.js:594
//   marketPlatform(), which index.js calls as the first thing main() does) or while the data dir
//   holds mpos-core.sqlite, with code LIVE_ACCOUNT_NOT_RECONCILED and no environment flag anywhere
//   in the file. Probe on this machine (2026-09-28): MODE=live + ENABLE_LIVE_TRADING=true + a
//   well-formed BS58_PRIVATE_KEY + JITO_ENABLED=true, Jito pointed at a dead local port ->
//   providers.jitoSendTransaction() threw LIVE_ACCOUNT_NOT_RECONCILED before any network write, in
//   the booted process and in a standalone process pointed at that data dir. Three env vars are not
//   enough. (The first probe attempt used `node -e`; the eval module resolved a *second* instance of
//   executionBoundary.js, so its activate() was invisible to providers.js and the call went through
//   to Jito. The probe below imports real files by absolute URL, exactly as the engine does, and
//   asserts the shared instance explicitly -- that assertion is the guard against a split-brain
//   module graph.)
//
//   TRUE half -- nothing validated MODE against ENABLE_LIVE_TRADING, and doctor printed a WARN and
//   still exited 0 for a live config that could never dispatch (measured: exit 0 with both WARNs).
//
// So what is pinned here is: the boundary is consulted by every armable order path and no env flag
// bypasses it; a booted runtime refuses the dispatch the finding said was reachable; the engine
// refuses an unexecutable live config at startup before any provider work; and doctor exits non-zero
// on that same verdict. MODE defaults and every live gate are unchanged -- src/liveConfig.js can
// only refuse a configuration, never arm one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveConfigVerdict, assertLiveConfig } from '../src/liveConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = pathToFileURL(root + path.sep).href;
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const dirs = fs.mkdtempSync(path.join(os.tmpdir(), 'mpo-live-gate-'));
let sequence = 0;
const newDataDir = () => { const d = path.join(dirs, String(++sequence)); fs.mkdirSync(d, { recursive: true }); return d; };
test.after(() => fs.rmSync(dirs, { recursive: true, force: true }));

const run = (args, env, cwd = root) => spawnSync(process.execPath, args, {
  cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
});

test('the verdict refuses what cannot run and keeps every default bootable', () => {
  const codes = v => [...v.fatal, ...v.warnings].map(r => r.code);
  const ok = v => assert.equal(v.ok, true, `unexpected refusal: ${JSON.stringify(v.fatal)}`);

  ok(liveConfigVerdict());                                   // the shipped default (paper, gate off)
  ok(liveConfigVerdict({ mode: 'paper', enableLiveTrading: false, privateKey: '', jupiterApiKey: '' }));
  assert.deepEqual(codes(liveConfigVerdict({ mode: 'paper' })), [], 'the default config must stay silent');

  // The intended armed configuration is still allowed: hardening this lane must never make it
  // unusable, and the verdict must say out loud that dispatch is locked by the boundary anyway.
  const armed = liveConfigVerdict({ mode: 'live', privateKey: 'k', jupiterApiKey: 'j', enableLiveTrading: true });
  ok(armed);
  assert.deepEqual(codes(armed), ['LIVE_DISPATCH_STILL_LOCKED']);

  const proposals = liveConfigVerdict({ mode: 'live', privateKey: 'k', jupiterApiKey: 'j' });
  ok(proposals);
  assert.deepEqual(codes(proposals), ['LIVE_PROPOSALS_ONLY']);

  // A live lane with no signer cannot dispatch at all (jupiter.js wallet() throws), so it is refused
  // rather than booting and failing at the moment of the first order.
  const noSigner = liveConfigVerdict({ mode: 'live', jupiterApiKey: 'j', enableLiveTrading: true });
  assert.equal(noSigner.ok, false);
  assert.ok(codes(noSigner).includes('LIVE_WITHOUT_SIGNER'));

  // Both index.js entry branches and updatePositions are gated on 'paper'/'live': any other MODE
  // runs a loop that counts signals, enters nothing and manages nothing.
  for (const mode of ['real', 'LIVE_TRADING', 'prod', '']) {
    const v = liveConfigVerdict({ mode });
    assert.equal(v.ok, false, `MODE=${JSON.stringify(mode)} must be refused`);
    assert.ok(codes(v).includes('MODE_UNKNOWN'), `MODE=${JSON.stringify(mode)} must be reported as unknown`);
  }

  // Arming the gate in paper mode is inert (the gate is read only inside the live branch), but it is
  // a coherent configuration, so it warns loudly and still boots -- a .env that pre-arms the lane
  // must not stop the paper book from running.
  const inert = liveConfigVerdict({ mode: 'paper', enableLiveTrading: true });
  assert.equal(inert.ok, true, 'pre-arming the gate while running paper must not refuse the boot');
  assert.deepEqual(codes(inert), ['LIVE_GATE_OUTSIDE_LIVE_MODE']);

  assert.throws(() => assertLiveConfig({ mode: 'live' }), e => e.code === 'LIVE_CONFIG_REFUSED'
    && /BS58_PRIVATE_KEY/.test(e.message) && e.reasons.some(r => r.code === 'LIVE_WITHOUT_SIGNER'));
  assert.throws(() => assertLiveConfig({ mode: 'production' }), e => e.code === 'LIVE_CONFIG_REFUSED'
    && e.reasons.some(r => r.code === 'MODE_UNKNOWN'));
  assert.equal(assertLiveConfig({ mode: 'paper' }).ok, true);
});

test('every armable order path consults the shared execution boundary, and no env flag bypasses it', () => {
  const boundary = read('src/core/executionBoundary.js');
  assert.match(boundary, /if\(active\|\|fs\.existsSync\(file\)\)throw Object\.assign\(new Error\('Risk Governor: live accounts are not reconciled into the common ledger; live submission is locked'\),\{code:'LIVE_ACCOUNT_NOT_RECONCILED'\}\)/);
  // The lock reads no environment flag: only the data dir, and only as a path. A future bypass
  // (LIVE_OK=1, SKIP_BOUNDARY=1, ...) fails here, in the same spirit as the Robinhood
  // `const PAPER_ONLY_BUILD=true` pin in visual-contract.test.mjs.
  const envNames = [...boundary.matchAll(/process\.env\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(envNames)], ['MONEY_PRINTER_DATA_DIR'], `the boundary must not read a bypass flag, saw ${envNames.join(',')}`);

  // Each of these dispatches real money and must assert first. The assertions are the exact first
  // statements, so moving one behind a fetch is a test failure rather than a review catch.
  assert.match(read('src/jupiter.js'), /async function signExecute\(o\)\{assertLiveDispatchAllowed\(\);/);
  assert.match(read('src/providers.js'), /export async function jitoSendTransaction\(signedBase64\)\{assertLiveDispatchAllowed\(\);/);
  // Since 5d56f2f the paper-only lock has no test-destination exemption: every non-read request is refused
  // unless live trading is compiled in, and then it still asserts the boundary first.
  assert.match(read('src/robinhoodTransport.js'), /if\(mutation\)\{\s*\n\s*if\(!ROBINHOOD_LIVE_TRADING_ENABLED\)\{[^\n]*throw[\s\S]{0,400}?\n\s*assertLiveDispatchAllowed\(\);/);
  const us = read('src/polymarketUS.js');
  for (const fn of ['submitPolymarketUSOrder', 'closePolymarketUSPosition']) {
    const row = us.split('\n').find(line => line.startsWith(`export async function ${fn}(`));
    assert.ok(row, `${fn} must exist`);
    assert.match(row, /assertLiveDispatchAllowed\(\);\s*return /, `${fn} must assert immediately before the venue call`);
  }
  assert.match(read('src/polymarketUSCombos.js'), /if\(\(method==='POST'&&pathname==='\/v1\/orders'\)\|\|\(method==='PUT'&&\/\\\/\(accept\|confirm\)\$\/\.test\(pathname\)\)\)assertLiveDispatchAllowed\(\);/);

  // Deliberate asymmetry, in the boundary's own words ("cancellation and read-only reconciliation
  // remain possible"): cancels stay open to a locked account. Pinned so it stays a decision.
  const cancels = us.split('\n').filter(line => /^export async function cancel/.test(line));
  assert.equal(cancels.length, 2, 'the two Polymarket US cancel functions must exist');
  for (const row of cancels) assert.doesNotMatch(row, /assertLiveDispatchAllowed/, `${row.slice(0, 40)} must stay reachable while dispatch is locked`);
});

test('a booted runtime refuses the dispatch the finding said three env vars would reach', () => {
  const dir = newDataDir();
  // Every module is imported by absolute URL from a real file, so the harness, providers.js and the
  // platform share one executionBoundary instance -- the `identity` line asserts exactly that, and
  // without it a split module graph would silently turn this test into a no-op.
  const probe = `
const base = ${JSON.stringify(base)};
const platform = await import(new URL('src/core/platform.js', base).href);
const boundary = await import(new URL('src/core/executionBoundary.js', base).href);
platform.marketPlatform();
let identity = 'NO-THROW';
try { boundary.assertLiveDispatchAllowed(); } catch (e) { identity = e.code || 'NO-CODE'; }
const providers = await import(new URL('src/providers.js', base).href);
let dispatch = 'NO-THROW';
try { await providers.jitoSendTransaction('AAAA'); } catch (e) { dispatch = e.code || e.message; }
try { platform.closeMarketPlatform(); } catch {}
console.log(JSON.stringify({ identity, dispatch }));
`;
  const audited = {
    MONEY_PRINTER_DATA_DIR: dir, MODE: 'live', ENABLE_LIVE_TRADING: 'true', JITO_ENABLED: 'true',
    // A dead local port, so even a regression that reaches the submit call cannot leave the machine.
    // The signer/Jupiter keys are the finding's own third env var; the boundary refuses before either
    // is used to sign or authenticate, which is why a placeholder is enough here.
    JITO_BLOCK_ENGINE_URL: 'http://127.0.0.1:9/', JUPITER_API_KEY: 'probe-key', BS58_PRIVATE_KEY: 'probe-not-a-real-key',
  };
  const child = run(['--input-type=module', '-e', probe], audited);
  assert.equal(child.status, 0, `probe must exit cleanly: ${String(child.stderr).slice(-600)}`);
  const seen = JSON.parse(String(child.stdout).trim().split('\n').pop());
  assert.ok(fs.existsSync(path.join(dir, 'mpos-core.sqlite')), 'the probe must have really booted a platform (the boundary keys off this file)');
  assert.equal(seen.identity, 'LIVE_ACCOUNT_NOT_RECONCILED', 'the harness must share the boundary instance the engine graph uses');
  assert.equal(seen.dispatch, 'LIVE_ACCOUNT_NOT_RECONCILED', `MODE=live + ENABLE_LIVE_TRADING=true + a signer must still be refused, got ${seen.dispatch}`);

  // And the same call from a standalone process pointed at that data dir, with no activation: the
  // boundary's durable half (the core db exists) refuses it too. Both halves of the lock are pinned,
  // because either one alone would leave a way to dispatch.
  const standalone = `
const base = ${JSON.stringify(base)};
const providers = await import(new URL('src/providers.js', base).href);
try { await providers.jitoSendTransaction('AAAA'); console.log('NO-THROW'); }
catch (e) { console.log(e.code || e.message); }
`;
  const second = run(['--input-type=module', '-e', standalone], audited);
  assert.equal(String(second.stdout).trim().split('\n').pop(), 'LIVE_ACCOUNT_NOT_RECONCILED', 'a data dir a runtime has booted must lock dispatch for every process');
});

test('the engine refuses an unexecutable live config at startup, before any provider work', () => {
  const dir = newDataDir();
  const live = run(['src/index.js', '--once'], { MONEY_PRINTER_DATA_DIR: dir, MODE: 'live', BS58_PRIVATE_KEY: '', JUPITER_API_KEY: '', ENABLE_LIVE_TRADING: 'true' });
  assert.equal(live.status, 1, `a live config with no signer must exit 1, stdout: ${String(live.stdout).slice(-300)}`);
  assert.match(String(live.stderr), /live config refused/);
  assert.match(String(live.stderr), /LIVE_WITHOUT_SIGNER/);
  assert.match(String(live.stderr), /BS58_PRIVATE_KEY/);
  // Refused before marketPlatform(): no core db, no state, no journal, no provider work at all.
  assert.deepEqual(fs.readdirSync(dir), [], 'the refusal must precede every write');

  const unknown = run(['src/index.js', '--once'], { MONEY_PRINTER_DATA_DIR: newDataDir(), MODE: 'real' });
  assert.equal(unknown.status, 1, 'a MODE the cycle loop does not implement must exit 1');
  assert.match(String(unknown.stderr), /MODE_UNKNOWN/);

  // The guard has to precede the boot call, or a live config would still pay for the boot first.
  const engine = read('src/index.js');
  const guard = engine.indexOf('assertLiveConfig(cfg)');
  assert.ok(guard > 0, 'main() must consult the verdict');
  assert.ok(guard < engine.indexOf('marketPlatform();'), 'the verdict must be consulted before the platform boots');
  assert.ok(guard < engine.indexOf('for (const w of liveConfig.warnings)'), 'warnings are reported after the refusal check');
});

test('doctor exits non-zero on the refused verdict and zero on the shipped default', () => {
  const liveNoSigner = run(['tools/doctor.js', '--offline'], { MONEY_PRINTER_DATA_DIR: newDataDir(), MODE: 'live', BS58_PRIVATE_KEY: '', JUPITER_API_KEY: '', ENABLE_LIVE_TRADING: '' });
  assert.equal(liveNoSigner.status, 1, `doctor must fail a live config that could never dispatch: ${String(liveNoSigner.stdout).slice(-300)}`);
  assert.match(String(liveNoSigner.stdout), /REFUSED: LIVE_WITHOUT_SIGNER/);

  // The finding's exact configuration: doctor now says the lane is armed *and* still locked, instead
  // of two WARN lines and exit 0.
  const armed = run(['tools/doctor.js', '--offline'], { MONEY_PRINTER_DATA_DIR: newDataDir(), MODE: 'live', ENABLE_LIVE_TRADING: 'true', JUPITER_API_KEY: 'probe-key', BS58_PRIVATE_KEY: 'probe-not-a-real-key' });
  assert.equal(armed.status, 0, `an armed live lane is coherent and must keep exiting 0: ${String(armed.stdout).slice(-300)}`);
  assert.match(String(armed.stdout), /WARN: LIVE_DISPATCH_STILL_LOCKED/);

  const defaults = run(['tools/doctor.js', '--offline'], { MONEY_PRINTER_DATA_DIR: newDataDir(), MODE: 'paper', ENABLE_LIVE_TRADING: '', BS58_PRIVATE_KEY: '', JUPITER_API_KEY: '' });
  assert.equal(defaults.status, 0, `the shipped default must stay exit 0: ${String(defaults.stdout).slice(-300)}`);
  assert.doesNotMatch(String(defaults.stdout), /REFUSED:|WARN: LIVE_/, 'the default config must stay silent: paper with the gate off');
  assert.match(String(defaults.stdout), /^mode paper /m, 'doctor still reports its mode line');

  // A trap this verdict surfaces for the first time: `MODE=` (an empty env var, which config.js
  // turns into mode '' rather than into its default) used to run a loop that counted signals, entered
  // nothing and managed no held position, with nothing anywhere saying so. It is refused now.
  const empty = run(['tools/doctor.js', '--offline'], { MONEY_PRINTER_DATA_DIR: newDataDir(), MODE: '', ENABLE_LIVE_TRADING: '', BS58_PRIVATE_KEY: '', JUPITER_API_KEY: '' });
  assert.equal(empty.status, 1, 'an empty MODE must be refused, not silently run');
  assert.match(String(empty.stdout), /REFUSED: MODE_UNKNOWN/);
});
