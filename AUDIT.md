# Money-Printer-OS — full engineering audit

**Auditor:** Cline (read-only pass) · **Date:** 2026-09-28 · **Repo:** `money-printer-os-main`, `package.json` version `0.5.0-alpha.71`, HEAD `416ded8 "Release alpha.71 desktop consolidation"` · **Node measured:** v24.16.0 (engines: `>=22`).

**Ground rules of this pass:** no source file was modified. The only file written by this audit is `AUDIT.md` itself. Every numeric claim below is tagged:

- **[M]** = *measured* in this session (command + output captured, see Appendix).
- **[C]** = *read from the code* (constant/comment/expression quoted with file:line).
- **[R]** = *reasoned inference* from [M]/[C] — explicitly flagged so you can disagree with the reasoning without re-checking facts.

Where I could not verify something, it is listed under **Unverified** instead of being smoothed over.

---

## Executive summary — the five things worth doing first

| # | Finding | Impact | Effort | Evidence |
|---|---|---|---|---|
| 1 | **The repo cannot be verified as-is:** `node_modules/` is absent, so *every* test, `selftest`, and `doctor` fails at import time (`Cannot find package 'dotenv'`). | Blocker — nothing can be checked until installed | **S** (`npm ci`) | [M] §8 |
| 2 | **`/api/state` caching is defeated on purpose but not replaced:** the ETag includes `Math.floor(Date.now()/1000)`, so a 304 is essentially impossible while the HUD polls it every **1,500 ms**; each poll rebuilds `snapshot()` (state read + `researchPlane()` + live telemetry). | Real laptop CPU/RAM/battery on a terminal that is *already* the heaviest process | **S–M** (split the endpoint, don't "fix" the ETag) | [C] `dashboard.js:485-491`, `public/dashboard.html:1931` |
| 3 | **`system.diagnostics` is appended every cycle with no dedupe and no cap**, inside `state.json`, which is rewritten with `flush: true` (fsync) every cycle. | Unbounded growth in the file that is fsynced ~7,500×/day | **S** | [C] `index.js:673-675`, `store.js:336` |
| 4 | **The Solana live lane is env-gated, not code-locked:** `MODE=live` + `ENABLE_LIVE_TRADING=true` + `BS58_PRIVATE_KEY` is enough for the Jupiter path, and `doctor` only prints a `WARN` if live mode has no key. The Robinhood lane, by contrast, is hard-locked (`PAPER_ONLY_BUILD=true`). | Safety asymmetry across two venues in one product | **S** (hard-fail startup + non-zero `doctor`) | [C] `config.js:6,23,25`, `doctor.js:50`, `robinhoodAutoTrader.js:52`, `robinhoodTransport.js:102` |
| 5 | **The trade-path brain (`src/index.js`, ~50 KB: `cycle`/`enter`/`updatePositions`) is a top-level script that exports nothing**, so it cannot be imported by a test; only the extracted rails are testable. | The highest-risk code is outside the suite's reach | **L** (extract incrementally, never big-bang) | [C] `positionExecution.js:88-91`, `index.js:776-790` |

Everything else in this report is either a "keep doing this" note or a medium/low-priority item. Nothing I found is an active money-losing bug **in the default configuration** (`mode: 'paper'`), and the paper-only accounting guards are unusually strong (see §3 and §7).

---

## 0. System snapshot (facts, not opinions)

| Property | Value | Tag |
|---|---|---|
| Entry points | `desktop/main.cjs` (Electron supervisor) → spawns `src/index.js`, `src/networkMesh.js`, optional `src/researchCollector.js`; also directly `node src/index.js [--dashboard-only]` | [C] |
| Default operating mode | `mode: str('MODE','paper')` → paper | [C] `config.js:6` |
| Cycle interval | `SCAN_INTERVAL_SEC` default **8 s**; SPRINT paper loop `min(scanIntervalSec, 2)` with CPU back-off to 3 s / 4 s at ≥75 % / ≥90 % CPU | [C] `config.js:6`, `index.js:761-768` |
| State files | `state.json` (account + light research) + `research-state.json` (heavy research, ≤1 write/60 s) + `state.backup.json` (≤1 per 120 s, validated before publication) + `market.ndjson` (journal) + `actions.ndjson` | [C] `store.js:10-22,337-351,362-375` |
| Journal bounds | rotation at 128 MB, 3 generations → ~384 MB ceiling; `scan-candidate` rows ≈98 % of volume, ~1 GB/day claim in a code comment, opt-out `MPO_JOURNAL_SCAN_CANDIDATES=false` | [C] `store.js:22,388-394` |
| Retention caps | `UNIVERSE_KEEP`/`OUTCOME_KEEP` = 1500; wallets capped at 15000 | [C] `store.js:25-26,281,285-288` |
| Source size | `src/` = **142 files, 1.57 MB**; `public/` = **65 files, 7.18 MB**; `tests/` = **92 files, 1.06 MB** | [M] |
| Largest modules | `robinhoodAutoTrader.js` 104 KB · `polymarketUSCombos.js` 74 KB · `polymarket.js` 74 KB · `core/platform.js` 71 KB · `index.js` 50 KB · `dashboard.js` 47 KB | [M] |
| Runtime deps | 7 (`@anthropic-ai/sdk`, `@noble/ed25519`, `@solana/web3.js`, `bs58`, `dotenv`, `polymarket-us`, `ws`); **devDeps: none**; test runner = built-in `node --test` | [M] |
| Dependency advisories | `npm audit` on the installed tree: **4 moderate, 0 high, 0 critical**, all one chain — `@solana/web3.js@1.99.0` → `jayson@4.3.0` → `stream-json@1.9.1` + `uuid@8.3.2`; `@solana/web3.js` and `jayson` carry no advisory of their own (npm lists them only as `effects`). `stream-json` is never loaded — its only importer is `jayson/lib/utils.js:3-4`, and the only jayson entry point web3.js touches is `jayson/lib/client/browser`; jayson calls `uuid.v4` only, so the v3/v5/v6-`buf` advisory is off-path too. `fixAvailable` for all four is a **downgrade to `@solana/web3.js@0.0.3`**, so `npm audit fix` has no move | [M] `npm audit --omit=dev --json` (identical to `npm audit --json`: no devDeps), traced with a `Module._load` hook + `NODE_DEBUG=module` |
| Installed state | `package-lock.json` present (18,878 B); `node_modules/` was **absent** when §0 was written and is **installed** for the dependency measurement above | [M] |
| Test entry | no `npm test` script; suite = `npm run test:all` (28 chained `test:*` targets) | [M] |
| CI / release | `.github/workflows/ci.yml`, `release.yml` present; unified macOS arm64 + Windows x64 build, draft release, hand-signed manifest | [M] `README.md:41-53` |
| Electron pin | `38.8.6`, checksums from official `SHASUMS256.txt`; `@electron/asar@4.3.0` fetched at build time | [M] `scripts/build-unified.mjs` |

> **Status of this file:** sections 1–9 of the original outline are *not* written here. The
> remediation pass that followed replaced re-derivation with targeted verification of the eight
> claims the fixes depend on (below). Sections 1–9 remain un-synthesised on purpose: the fixes in
> `PROGRESS.md` were chosen from the executive summary, and re-writing the full narrative would
> have cost the same context that the fixes need. Every claim below carries a command or a
> `file:line` you can re-check.

## Verifications (VERIFY-FIRST pass, 2026-09-28)

Reproduce with the commands in the Appendix of `PROGRESS.md`; `[M]` = measured this session.

| # | Claim under test | Verdict | Evidence |
|---|---|---|---|
| V1 | `saveState` in the cycle catch can throw past `main()`; `stats.errors` is not persisted when the save fails | **CONFIRMED** | `index.js:751-757` catch calls `saveState(s)` unguarded; `store.js:310-318` throws on `realizedBasisViolations`, `store.js:319-325` throws `EQUITY_JUMP`; `index.js:787-792` `main().catch` sets `exitCode = 1`, so one bad mark ends the loop and the incremented counter is never written. |
| V2 | Discovery fan-out (~240 req/min at defaults) exceeds `MARKET_REQUESTS_PER_MINUTE` (120) → `budgetRejects` | **CONFIRMED**, refined: the budget is **per host**, 60 s rolling | `config.js:7` `MAX_CANDIDATES` 240, `config.js:8` `MARKET_REQUESTS_PER_MINUTE` 120; `index.js:512` `max = 240`; `dexscreener.js:151` `slice(0, Math.max(max*4, 240))` = 960 addresses → `dexscreener.js:153,155` = 32 batches/cycle, concurrency 3 → at the 8 s interval that is 32 × 7.5 = **240 req/min** on `api.dexscreener.com` alone; `marketRequests.js:17-18` keeps a per-host window and throws + `stats.budgetRejects++` once it is full. `collectSeeds` (+12 calls per 45 s TTL) shares the same host. |
| V3 | The Solana kill switch gates entries only; exits keep running | **CONFIRMED** | `index.js:456-457` inside `blockStatus`; the flag is consulted only at `index.js:694`; `index.js:507` runs `updatePositions` unconditionally and `index.js:427-443` fires stop/TP exits regardless. |
| V4 | No global per-cycle abort signal; individual fetches carry timeouts | **CONFIRMED** | Repo-wide grep: no cycle-level `AbortSignal`; `marketRequests.js:26-27` creates a per-request `AbortController` with `timeoutMs` (default 6500); peers use `AbortSignal.timeout(9000…30000)`. Nothing bounds the cycle as a whole. |
| V5 | Legacy float book and core BigInt ledger are not reconciled | **CONFIRMED**, refined | Core money is integer: `core/ledger.js:30` (`BigInt(r.gross_units)`), `core/model.js:37-42`, `core/platform.js:126`. Legacy float book: `accounting.js:41` (`equity = cashSol + markedPositionsValue`). `core/legacyBooks.js:1-3,56` reports the books *beside* the ledger and explicitly "never summed into it"; `core/accountReconcile.js:1-9` reconciles *venue* accounts against the LIVE ledger — a different check. Currencies differ (SOL vs USD) and `legacyBooks.js:4` forbids inventing FX, so any comparison must stay per-currency. |
| V6 | `/api/state` rebuilds the whole snapshot on every 1.5 s poll and the ETag is volatile by design | **CONFIRMED** | `dashboard.js:485-491`: tag = `` `${stateStamp()}-${Math.floor(Date.now()/1000)}` `` + `snapshot()`; HUD polls at 1500 ms (`public/dashboard.html:1931`). |
| V7 | Sizing is risk-based and `tradeSizeSol` is not binding | **DISPROVEN — inverted** | `positionExecution.js:114-122`: at defaults (`PAPER_START_SOL` 1, `RISK_PER_TRADE_PCT` 1, `TRADE_SIZE_SOL` 0.05, `MAX_POSITION_SOL` 0.15) `riskSized = 1 × 1% / 8% = 0.125` SOL while `targetSize = max(0.05 × sizeFactor, 1 × 0.012) = 0.05` SOL, `positionCap = 0.15`, headroom `0.45`. The **binding constraint is `tradeSizeSol`**, and `riskPerTradePct` only binds once equity falls below ≈0.4 SOL (or the stop is far tighter than 8%). Any comment claiming otherwise would have been wrong; P1.3 therefore ships the readout (`aggressionReadout()`) and a *derivation comment that states the measured truth*, not the audit's premise. |
| V8 | `tickBand` is one-sided against the median; `TICK_BAND_MAX_RATIO = 5` | **CONFIRMED** | `positionExecution.js:44` `TICK_BAND_MAX_RATIO = 5`; `:67-69` rejects only `price > median * 5` — an unbounded *downward* multiple of the median passes the band. |

### Baseline before the fixes (so "did I break it?" is answerable)

- `npm ci` was required first: `node_modules/` was absent, so every target failed at import
  (`Cannot find package 'dotenv'`) — audit finding #1, now cleared locally.
- `npm run test:all`: **one pre-existing failure**, `test:robinhood`, whose first step
  `node scripts/sync-robinhood-panel.mjs --check` throws `Error: Robinhood panel boundaries not
  found` (the script cannot find `// BEGIN ROBINHOOD PAPER PANEL` in `public/dashboard.html`).
  Because `test:all` chains with `&&`, `test:robinhood-equities`, `test:lane-contracts`,
  `test:fitness`, `test:unattended` and `test:upgrade` are **skipped** in a plain `test:all` run.
  Everything reached reports `fail 0`.
