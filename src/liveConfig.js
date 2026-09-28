// P4.2 (audit exec #4: "the Solana live lane is env-gated, not code-locked"). Measured at HEAD,
// the *dispatch* half of that claim is false, and the *loudness* half is true.
//
//   Dispatch: every real order path consults core/executionBoundary.js before it writes anything.
//   A process that booted a runtime (index.js main() -> marketPlatform() -> activateExecutionBoundary)
//   is refused with LIVE_ACCOUNT_NOT_RECONCILED, and so is a standalone process pointed at a data dir
//   a runtime has used, no matter what MODE / ENABLE_LIVE_TRADING / BS58_PRIVATE_KEY say. The three
//   env vars the finding names are not enough. (tests/live-gate.test.mjs measures this.)
//
//   Loudness: nothing validated MODE against ENABLE_LIVE_TRADING, so a live-looking config that can
//   never execute (no signer) or can never be reached (an unrecognised MODE) booted silently, and
//   `doctor` printed a WARN and still exited 0 for it.
//
// This module is the single verdict the engine and doctor consult. It is a pure function over plain
// values (it does not import cfg, so callers stay one line and tests can call it with literals) and
// it can only ever *refuse* a configuration: it never arms a lane and it does not touch the
// execution boundary that locks dispatch. Defaults are untouched -- paper with the gate off is ok
// with no output.
const MODES = Object.freeze(['paper', 'live']);

export function liveConfigVerdict(config = {}) {
  const mode = String(config.mode ?? 'paper').trim().toLowerCase();
  const armed = config.enableLiveTrading === true;
  const signer = Boolean(config.privateKey);
  const jupiterKey = Boolean(config.jupiterApiKey);
  const fatal = [];
  const warnings = [];

  // index.js branches on `mode === 'paper'` and `mode === 'live'`, and gates updatePositions on
  // ['paper','live'].includes(mode). An unrecognised MODE therefore runs a loop that counts signals,
  // enters nothing and manages no held position, without saying so -- refuse instead.
  if (!MODES.includes(mode)) fatal.push({ code: 'MODE_UNKNOWN', message: `MODE=${mode} is not a mode the cycle loop implements (${MODES.join(', ')}): entries and position management would both be skipped silently` });

  // jupiter.js wallet() throws 'Missing BS58_PRIVATE_KEY', index.js:673 skips the wallet balance
  // refresh without it, and every live dispatch would fail at the moment it is attempted. A live
  // lane with no signer cannot work, so it must not start.
  if (mode === 'live' && !signer) fatal.push({ code: 'LIVE_WITHOUT_SIGNER', message: 'MODE=live without BS58_PRIVATE_KEY: the Jupiter path cannot sign, so every dispatch would fail at the moment it is attempted' });

  // The gate is read only inside the live branch (index.js:245), so arming it in paper mode arms
  // nothing at all. Kept non-fatal on purpose: a .env that pre-arms the lane while running paper is
  // a coherent (inert) configuration, and refusing it would break a boot that trades nothing.
  if (armed && mode !== 'live') warnings.push({ code: 'LIVE_GATE_OUTSIDE_LIVE_MODE', message: `ENABLE_LIVE_TRADING=true while MODE=${mode}: the gate is only read inside the live branch, so it arms nothing` });

  if (mode === 'live' && signer && !armed) warnings.push({ code: 'LIVE_PROPOSALS_ONLY', message: 'live mode with the live gate off: automatic picks are proposals, and a manual order would be refused by the gate' });
  if (mode === 'live' && !jupiterKey) warnings.push({ code: 'LIVE_WITHOUT_JUPITER_KEY', message: 'live mode selected without JUPITER_API_KEY' });
  if (mode === 'live' && armed && signer) warnings.push({ code: 'LIVE_DISPATCH_STILL_LOCKED', message: 'live lane armed: dispatch is still refused by the execution boundary until live accounts are reconciled into the common ledger' });

  return { ok: fatal.length === 0, mode, armed, signer, fatal, warnings };
}

export function assertLiveConfig(config = {}) {
  const verdict = liveConfigVerdict(config);
  if (!verdict.ok) {
    // The reason codes go in the message as well as on the error object: main()'s catch reports the
    // message alone (compactError), so a code that only lived on the object would never be printed.
    const error = new Error(`live config refused (${verdict.fatal.map(r => r.code).join(', ')}): ${verdict.fatal.map(r => r.message).join('; ')}`);
    error.code = 'LIVE_CONFIG_REFUSED';
    error.reasons = verdict.fatal;
    throw error;
  }
  return verdict;
}
