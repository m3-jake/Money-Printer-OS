# Unified Mac + Windows build — 0.5.0-alpha.53+unified.3ba4959 (2026-09-24, **latest**)

Built by `npm run release:unified` (`scripts/build-unified.mjs`) from a clean `git archive` of
`3ba49595a59228c3d7f3db2da7df18dda5eabb7f`. Neither package was installed by an agent. Everything below
was observed in that run; nothing is carried over from older builds.

| field | value |
| --- | --- |
| output dir | `/Users/bing/Desktop/Money Printer OS/Current/Unified-3ba4959-20260924/` |
| app.asar (shared, byte-identical in both zips) | `2c928f526567dba01c081145f66cf2b53f5d6c49c9eda14f1b8701404d529079` (31387171 bytes, header `c08c53629a5e248d2eb14a65ef7fea812f13eb7b723b4e53949535f3cc7b2ae0`) |
| `Money-Printer-OS-Alpha53-3ba4959-macOS-arm64.zip` | `1f850b9eaae167d51c55a144cd2e5e0852595d21addbc71f0ee672589ab19189` (120645598 bytes) |
| `Money-Printer-OS-Alpha53-3ba4959-Windows-x64.zip` | `10ed57558f12ca36b5d8902267f034d49b4f1e89c807c6e2d6e910e8fb7056c5` (146683264 bytes) |
| Electron | 38.8.6. darwin-arm64 and win32-x64 zips matched the official SHASUMS256.txt (pinned in script) |
| tests (source tree, same commit) | `npm run test:all` **316/316 pass, 0 fail, 19 suites**; `node src/selftest.js` **SELFTEST PASS**; `tests/release-gate.test.cjs` **6/6** (tests are not in the asar allowlist, so they run from source) |
| mac engine smoke | packaged Electron binary, `ELECTRON_RUN_AS_NODE=1`, `app.asar/src/index.js --dashboard-only`, MODE=paper, throwaway data dir: dashboard **200**, /api/health **200**; process stopped afterwards |
| signing | macOS **local ad-hoc only** (`codesign --verify --deep --strict` OK). Not Developer-ID signed or notarized. Windows **not Authenticode-signed**. Updater manifest **not signed**. |
| Windows | x64 folder + Install-Windows.ps1/Install.cmd (refuses a running app, live mode, or open exposures; preserves AppData; keeps a rollback copy), PAYLOAD-SHA256.json. **Not boot-tested on Windows.** The exe keeps the stock Electron icon because rcedit needs Windows or wine. |

Fixed during this build: the `src/index.js` entry guard from bbc8f4d silently skipped `main()` when a
symlink was on the path (`/var` resolves to `/private/var`), so the packaged engine hung with no output.
Fixed in `3ba4959`: it now compares realpaths and always runs when `MONEY_PRINTER_SUPERVISED=1`.
Rebuild: `npm run release:unified -- --force` (runtimes are cached in `Current/runtime-downloads/`).

# Release status — alpha.53 (INTEGRATED + PACKAGED, **not installed** by an agent)

Version `0.5.0-alpha.53` (`package.json`, unchanged all workflow). This section **replaces** the
earlier packaging-package record, which packed `main` before three of the five work packages had
landed and correctly labelled itself "a mechanism proof, not a final release artifact". That
artifact (SHA-256 `be8f1f8a87b83b052cf8d53b827e4d81bf221e0ae6aaa8cc06842f88507c1f57`, commit
`1813445`) is **superseded — do not ship it**. Everything below is the repack from the fully
integrated tree.

## The artifact

| field | value |
| --- | --- |
| path | `/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release.asar` |
| bytes | **34,148,685** |
| SHA-256 | **`c4b937dc48388d47a3bd0f837ef3e9f885a39c667b8ee0c03192d16169810c3f`** |
| packed from commit | `da0b73901c2a8f6e7e957729a4a5f5cee939c228` ("mpo: alpha53 integrated — state docs") |
| packer | `node scripts/release-alpha53.mjs pack` → staged copy + `npx @electron/asar@4.3.0 pack --unpack '*.node'` |
| gate stage | `main` (unadvanced) |
| signed | **no** |

`shasum -a 256` on disk, `.workflow/scratch/packaging/release-record.json` and this table all
carry the same hash. **The commit named above is one commit behind this file's own commit** (which
adds only this section to `.agent-state/RELEASE_STATUS.md`): `.agent-state/` is in the packer's
`STAGE_EXCLUDES`, so that later doc commit cannot and does not change a single packed byte. The
authoritative record of what was packed is `release-record.json`, not `.build-commit` /
`.build-version` — those two files are cosmetic and read by no code in this repository.

## What is inside (verified, not assumed)

`.workflow/scratch/integration/asar-manifest.txt` — 2,721 entries. Zero `.env`, zero
`.agent-state` / `agent-state` / `research` / `artifacts` / `.workflow` / `.git` entries. `data/`
present but **empty** (the running app expects the directory; a user's app must never ship this
dev tree's state or journal). Exactly one `build/icon.icns`. Present and confirmed by name:
`package.json`, `.env.example`, `README.md`, `desktop/main.cjs`, `desktop/release-gate.cjs`,
`src/index.js`, `src/store.js`, `src/accounting.js`, `src/positionExecution.js`, `src/doctor.js`,
`public/dashboard.html`, `public/css/mpo-shell.css`, `public/css/mpo-workstation.css`,
`scripts/release-alpha53.mjs`, plus 2,569 `node_modules` entries.

## Verification — recorded only after actually running

Source tree at the packed commit (`.workflow/scratch/integration/`):

| check | result |
| --- | --- |
| `npm run test:all` | **302 tests / 302 pass / 0 fail / 0 skipped** |
| `npm run test:visual` | **26 / 26** |
| `node --test tests/release-gate.test.cjs` | **6 / 6** |
| `node src/selftest.js` | `SELFTEST PASS` |
| `node src/doctor.js --offline` | exit 0 — `PAPER IDENTITY … holeExact 0 okExact true` |
| `release-alpha53.mjs test-record --testAll --selftest --macBoot` | `{testAll: true, selftest: true, macBoot: true}` — each re-run for real in that invocation, no flag taken at face value |

**The packaged archive itself was then unpacked and exercised** (`asar extract` → a throwaway
directory; `asar-release-gate.log`, `asar-boot.log`, `asar-doctor.log`):

- `node --test tests/release-gate.test.cjs` **from inside the extracted archive** — 6/6 pass. This
  is what "the asar boots the release gate" can honestly mean without installing: the gate module
  that ships in the archive loads and satisfies its own suite.
- `node src/index.js --dashboard-only` from the extracted archive, `MODE=paper`,
  `ALPHA_WORKER_ENABLED=false`, `DIRECT_STREAM_ENABLED=false`, throwaway
  `MONEY_PRINTER_DATA_DIR`, port 8794 — printed `Dashboard: http://127.0.0.1:8794` and served
  until the 60 s alarm killed it (exit 142 = SIGALRM, i.e. a clean boot, not a crash).
- `node src/doctor.js --offline` from the extracted archive — exit 0, live gate `false`,
  production learning `LOCKED`, identity `okExact true`.

`npm run doctor` was never run without `--offline`: the plain verb calls `benchmarkRpcs()` against
live RPC providers, which this workflow's hard constraints forbid. Stated as a deliberate
substitution, not a skipped step.

## Promotion — refused, nothing forced

```
node scripts/release-alpha53.mjs promote tested
missing: ["stageOrder","windowsArtifactHash","signed","windowsBoot"]
```

Exit 1, stage left at `main`. `testAll` / `selftest` / `macBoot` have dropped off the missing list
because they were genuinely satisfied; what remains **cannot** be satisfied on this machine — see
`docs/WINDOWS-RELEASE.md`. No stage was forced, no signature or Windows artifact fabricated, and
`desktop/release-gate.cjs` was never modified (`git diff 93c8022..HEAD -- desktop/` is empty).

## Install — bing only. An agent must not run this.

> **Known defect in the hand-off, flagged rather than papered over:** `release-alpha53.mjs install`
> and `restart` refuse *unconditionally*, not just for agents — running them yourself prints the
> same refusal and the same command back at you. They are a design reference, not a working
> installer. Use the explicit commands below instead. Fixing those two verbs is a follow-up, not
> something this pass changed (the script is the packaging package's file and its refusal is
> load-bearing for agent safety).

Run these yourself, from your own terminal, **after confirming no real Solana or Polymarket-US
session is armed** (`mode === 'paper'`, `sessionArmed === false`):

```sh
# 0. quit the running app
osascript -e 'quit app "Money Printer OS"'

# 1. rollback copies of what is installed right now (timestamped + the .previous the app expects)
RES="$HOME/Applications/Money Printer OS.app/Contents/Resources"
cp "$RES/app.asar" "$RES/app.asar.pre-alpha53-$(date +%Y%m%d-%H%M%S)"
cp "$RES/app.asar" "$RES/app.asar.previous"

# 2. snapshot the live data dir (state + journals) BEFORE swapping code
SUP="$HOME/Library/Application Support/Money Printer OS"
BK="$SUP/backups/pre-alpha53-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK" && cp "$SUP/data/"*.json "$BK/" 2>/dev/null; cp "$SUP/data/market.ndjson" "$BK/" 2>/dev/null; true

# 3. install the archive
cp "/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release.asar" "$RES/app.asar"

# 3b. and its unpacked native sidecar (see the note below — harmless, and correct)
rm -rf "$RES/app.asar.unpacked"
cp -R "/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release.asar.unpacked" "$RES/app.asar.unpacked"

# 4. verify the installed bytes are the ones recorded above
shasum -a 256 "$RES/app.asar"
# expect: c4b937dc48388d47a3bd0f837ef3e9f885a39c667b8ee0c03192d16169810c3f

# 5. launch
open -a "Money Printer OS"
```

### About `app.asar.unpacked`

`pack` runs `@electron/asar ... --unpack '*.node'`, which writes a sibling
`MPO-alpha53-release.asar.unpacked/` holding the prebuilt native addons (`bufferutil`,
`utf-8-validate`). **The currently installed app has no `app.asar.unpacked` directory at all** —
previous installs copied only the archive. That has been survivable because both addons are
optional accelerators for `ws`, which falls back to pure JS when they are missing; it is not
evidence that the sidecar is unnecessary. Step 3b installs it, which is strictly more correct and
costs nothing. If you skip 3b, also delete any stale `$RES/app.asar.unpacked` so the app cannot
load addons from a different build than the archive it is running.

## Rollback

```sh
RES="$HOME/Applications/Money Printer OS.app/Contents/Resources"
osascript -e 'quit app "Money Printer OS"'
cp "$RES/app.asar.previous" "$RES/app.asar"
rm -rf "$RES/app.asar.unpacked"   # the alpha53 sidecar does not belong to the previous build
shasum -a 256 "$RES/app.asar"
open -a "Money Printer OS"
```

Code-level rollback only. `app.asar.previous` is also written automatically by the app's own
updater on every swap (`desktop/main.cjs:206-209,229`). Data-level rollback is the timestamped
`~/Library/Application Support/Money Printer OS/backups/<label>-<ts>/` directory from step 2 —
**restore account snapshots only if the data is actually damaged, never merely to roll code back.**
As of this pass the installed `app.asar` is 34,204,023 bytes (2026-09-19 09:25) with
`app.asar.previous` at 34,185,920 bytes (2026-09-19 08:25); neither was read for content, touched,
or replaced by any agent in this workflow, and nothing under
`~/Library/Application Support/Money Printer OS` was written to.

## Still needs bing (no agent can close these)

1. **The install/restart click above** — and, if the app is code-signed, re-signing or a Gatekeeper
   prompt after the asar swap. Prior alphas were installed this way successfully.
2. **Updater manifest signing.** `docs/UPDATER-MANIFEST.md` holds the Ed25519 recipe with the
   private-key path left as a placeholder. No agent read, named or searched for key material; only
   the public half (`desktop/update-public-key.pem`) was ever touched.
3. **A Windows machine.** No Windows build, signing or CI exists in this repo, so `windowsBoot` and
   `artifacts.windows.sha256` cannot be produced here and promotion caps below `tested`.
4. **Polymarket US API key** regeneration at polymarket.us/developer (every signed call still
   returns `401 API key not found`), and the Combos/RFQ **beta allow-list**, which is
   polymarket.us's decision, not this repo's.
5. **The first real trade**, to confirm the `/v1/order/{id}` and settlement payload shapes that were
   implemented from docs. Deliberately not simulated or mocked closed.
6. **`3.0.0` vs `0.5.0-alpha.NN`.** Unresolved since alpha.52. This pass kept `0.5.0-alpha.53`;
   `pack` asserts that exact string and would refuse a `3.0.0` stamp.

**Honest status: integrated, packaged, verified, NOT installed and NOT promoted.** Real-money
execution stayed locked throughout (`liveExecution:'manual'`, `automaticLivePromotionAllowed:false`,
`liveActivationAllowed:false`, `productionLearningUnlocked` still derived from `proven`).
---

# Release status — alpha.52 (integration candidate, NOT deployed)

Branch `agent/integrator/20260916-233900-fdce2-alpha52-release-integration---merge` @ `804b822`.
Merged frontend UI reconciliation (2583a) + backend research control-plane (2e4ef).
Resolved the sole conflict, `src/dashboard.js` (UI/API contract), by composing the frontend
leaderboard enrichment on top of the backend control-plane source:
`researchMonitorState -> decorateResearchMonitor(attachControlPlaneToMonitor(raw, plane), s)`;
adopted backend `systemView(s, policy)` and `evolutionLoopView(e,{now})`.
Tests: test:all 305/305, visual+renderer 25/25, release-gate 6/6, selftest PASS, doctor OK.
PAPER Solana starting balance default reset to exactly 1 SOL (`src/config.js`, `.env.example`);
research/journal/Polymarket stores untouched. Manual real-money gates intact
(liveExecution=manual, automaticLivePromotionAllowed=false, liveActivationAllowed=false).
Version bumped 0.5.0-alpha.51 -> 0.5.0-alpha.52. NOTE: task text said "3.0.0-alpha.52";
kept the established 0.5.0-alpha.NN line pending confirmation of any major-version jump.
Rollback tag `alpha52-integration-rollback` -> `f378eca`. Not merged to main; not deployed.

---

# Release status — alpha.41

Installed and running in /Users/bing/Applications/Money Printer OS.app on 2026-09-15. Archive: Current/MPO-alpha41-release.asar. SHA-256: a0a460636a1794525fe12797b9e7181814f44975891d0a25b8a434de7a6c6f2b.

55 regressions passed. Runtime build version verified; HEALTHY after initial provider backoff, 13 fresh held prices at inspection, no timeouts. Three stranded paper crash positions closed after confirmation.

Rollback: /Users/bing/Library/Application Support/Money Printer OS/backups/alpha40-before-alpha41-20260915-100119/app.asar (and app.asar.previous). Do not restore account snapshots merely to roll back code.

Packaging: python3 .workflow/scratch/release-alpha41.py pack|install|restart. Historical alpha40 scripts still target the old release and must not be used for alpha41.

Windows remains offline. Polymarket US credentials rejected; no session was armed or real order placed.
