# Integration ledger — 20260916-104614-4bd03

Base: deployed alpha.42 `4207a70`. This worktree fast-forwarded reviewed settlement/latency, then selectively ported research tools. **No deploy, no app restart, no live orders, no credential/risk-gate changes.**

## Accepted

| Source | Commit / files | Why |
| --- | --- | --- |
| `integration/alpha42-settlement-reviewed` | `ef316c8` → `ee8077a` → `125126e` | Reviewed paper settlement: closed-Gamma recovery, lost-leg combo booking, conservative/censoring metrics, unknown outcomes stay OPEN. Reviewer **rejected** 6h timeout refunds. Isolated `wait_ms` / ready-to-proposal instrumentation. Tests 117/117 + SELFTEST on that candidate. |
| Architect memo `20260916-103902-e69ba` | `b216d5b` + integrator notes | Evidence baseline. Kill promotion / live / SPRINT-as-alpha. Integrator note: §2.5 proposal-bottleneck **superseded** by `latencyStats.js`. |
| Research `1d954bc` **selective** | replay/experiment/hypothesis/validate/forensics/report + worker wiring | Measurement and evidence hygiene only. COLD lead stays **FAIL** after sentinel/economic filters. Challengers `promotable:false`. Top-quartile lead requires **positive top median**, not “less negative than rest.” |
| Cluster-identity integrator fix | `src/hypothesisMiner.js` `obs_cluster_id` | Reviewer blocker: mining must keep observation/funding cluster identity instead of mint fallback when `x.cluster_id` exists. |

## Rejected / left unmerged

| Source | Why |
| --- | --- |
| Original `02a6c` `b8b2b66` | 6h auto-void/refund. Superseded by `ee8077a`. |
| Wholesale research `6413227` / `1d954bc` | Reviewer: do not cherry-pick whole branch. Quarantining proof rows would change `productionLearningUnlocked` population. Historical `reports/research/*.json|md` were **not** regenerated after reviewer fixes — not treated as current proof. |
| `computeEdgeProof` outcome quarantine from `1d954bc` | Explicitly omitted. Production-learning gate still scores the same independent-outcome population as `4207a70` (winsor/median already in robust edge stats). |
| Visual `1fd80cf` / `visual-current-20260916` | Style-only, but `public/dashboard.html` overlaps settlement audit UI. Dedicated visual integrator `20260916-000321-3254a` owns that merge. Motion/fire/profit FX already in `4207a70`. |
| Hive experiment `20260915-213158-190bb` | Stale vs alpha42 (`comboEngine.js` era). Promotion gates already in `c0dd59e`; `promotable:false` taken from research instead. |
| Replay leftover `20260915-213649-357f8` | Core already in `ebad40b` / `2274cf2`. |
| alpha40 `comboEngine.js` `20260915-204632-1110f` | Architecture moved to `polymarketUSCombos.js`. |
| 2026-09-15 daily alpha PROVEN 100%, cluster 1068×, FAST-as-production, any SPRINT* challenger | Outlier / synthetic / drawdown / concentration. Memo kill list. |
| Strategy aggression / live eligibility / sizing / credentials | Forbidden. High-turnover sports `keep=false`. |

## Already in alpha.42 — not re-merged

Robust edge stats (`bf14fd2` / `e8d5dbe`), replay chronological + censored marks (`ebad40b`, `2274cf2`), combo post-ETA cadence (`9df7fe1`), visual/motion baseline (`89ba958`, `4207a70`), Hive stable-config immutability (`c0dd59e`), release gate tests.

## Research JSON/MD

`reports/research/*` from `e8029` are historical worker outputs. COLD lead **FAIL**. They are **not** copied here as regenerated evidence.

## Real-money / risk gates preserved

- Real Polymarket execution remains locked; paper journal in tests is a fixture, live app-data untouched.
- `productionLearningUnlocked` still equals `proven` on the un-quarantined independent-outcome set.
- Experiment/replay challengers cannot become live; `promotable:false` cannot become shadow.
- No MODE/live, wallet, credential, stake-cap, or `MISSING_VOID_MS` shortening.

## BEAST furnace (`20260916-180029-34473`) — 2026-09-16

Base: alpha45 + CPU fast path `fc0d8bb` + global/sealed `f59aa69` + GPU research package `419ab0b`. **No deploy, no app restart, no live orders, no credential/risk-gate changes.**

### Accepted
| Source | Why |
| --- | --- |
| CPU/RAM packed scorer + persistent pool | Same-corpus rankingFingerprint/order/promotion match locked alpha45 (`82a330a8…`, winner `BEAST-0070`, RETAIN). 1-worker packed **1.32×–1.47×** vs seeded baseline. |
| Global Halton + sealed tail | Already merged; sealed mutation cannot change ranking rows. Duplicate rate 0 on the frozen set. |
| Opt-in BEAST profile | `MPO_RESEARCH_BEAST=1` / `research-beast.json`. Resource-capped workers (1 on ≤6-thread hosts), batch 4096, CPU fallback forced. Promotion constants exported and locked. |
| GPU sidecar contract | Research-only; CUDA probe required; CPU rescores anyone within 10 deterministic robust-score points of the leader. |

### Rejected / not default
| Source | Why |
| --- | --- |
| GPU as default BEAST scorer | This host: `torch-unavailable`. No PyTorch/CUDA. GPU remains opt-in (`MPO_RESEARCH_GPU=1`) with CPU fallback. WITCHDOCTOR RTX 5070 4097×3000 90-round: 6227.7 v/s, 1188 MB VRAM, max abs 4.26e-14. |
| 4-worker default on MacBook Neo | Measured slower than 1 packed worker on the locked corpus. |
| Live promotion / execution / wallet / Polymarket | Forbidden. Champions stay SHADOW/RESEARCH. |

### Recommended knobs
workers **1** (this 6-thread Mac), batchSize **4096**, ramTargetGB **0.8–1.6**, GPU batch **4096**, GPU VRAM **2048 MB**. Evidence: `artifacts/beast-compare/REPORT.md`.

## Verification (this worktree)

- `npm run selftest` — SELFTEST PASS
- `npm run test:all` — 156/156 across recovery, turnover, execution, settlement, polymarket-us, combos, edge-robustness, accounting, replay, experiments, research, release-gate, latency.
- Live journals, running apps, credentials, and real-money state were not modified.

### Final BEAST addendum — 2026-09-16 19:xx ET

The earlier "GPU default rejected" note remains correct for non-CUDA hosts, but WITCHDOCTOR was subsequently verified with the exact fixed 2048×3000 corpus. Persistent CUDA sidecar is accepted only as explicit BEAST screening acceleration: 0 deterministic mismatches, full ranking exact, max abs error 1.455e-11, ~1,028 MB peak VRAM. After one-time initialization, the second end-to-end persistent request was ~918 ms (raw compute ~115 ms) versus 1,655.96 ms for packed JS on the frozen corpus. GPU-only scores are nulled before authoritative ranking; any candidate still able to win after the maximum +10 Monte-Carlo contribution is CPU-rescored, as is the incumbent. Any sidecar/parity/protocol failure falls back to CPU.

Final `npm run test:all` after the persistent-sidecar correction exited 0, including 41 evolution tests and 7 BEAST-specific tests. No deploy/restart/live-state mutation.

## alpha.53 — ship + polish + accounting-fix workflow — 2026-09-19/20

Base: `93c8022` ("alpha53 source as received"), planner-integration base `cb71d4c` ("fix:
alpha53 paper identity + equity jump guards"). Plan: `.workflow/scratch/PLAN.md`. Ledger:
`LEDGER-mpo.md` items M1–M8. Five work packages, each in its own worktree under
`/Users/bing/Desktop/Money Printer OS/Current/MPO-wt-<name>`, file ownership disjoint by
`PLAN.md` §1.

### Planned merge order (`PLAN.md` §7)

| # | package | status at the time `packaging` ran |
| --- | --- | --- |
| 1 | ship-fixes | committed on `wf/ship-fixes` @ `971a168` ("mpo: ship-fixes") — **not yet merged to `main`** |
| 2 | accounting | uncommitted work-in-progress in `MPO-wt-accounting` (`src/accounting.js`, `src/store.js`, `src/index.js`, `src/positionExecution.js` modified, not committed) — **not yet merged to `main`** |
| 3 | product | merged directly to `main` @ `2420d77` ("mpo: product") |
| 4 | visual | uncommitted work-in-progress in `MPO-wt-visual` (`public/css/mpo-shell.css`, `public/css/mpo-workstation.css`, `public/dashboard.html` modified, not committed) — **not yet merged to `main`** |
| 5 | packaging | this section — implemented `scripts/release-alpha53.mjs` and packed whatever was on `main` HEAD (`2420d77`) at the time, per its own scope |

**Accepted onto `main` this pass:** `product` (`2420d77`) — re-verification only, no source
change (see its own commit message; `src/polymarket.js` diff vs `93c8022` confirmed empty).
`packaging` (this commit) — new `scripts/release-alpha53.mjs`, `docs/WINDOWS-RELEASE.md`,
`docs/UPDATER-MANIFEST.md`, `.gitignore` `__pycache__/` addition + untracking two committed
`.pyc` files, `.build-version`/`.build-commit` restamp, this ledger entry, and the
`RELEASE_STATUS.md` fold-forward.

**Not yet merged / rejected — flagged for bing, not resolved by `packaging`:** ship-fixes,
accounting, and visual are real, separately-scoped packages per `PLAN.md` — they were not
rejected, they simply had not landed on `main` at the moment `packaging`'s turn came up in
this workflow run. `packaging` does not own merging them (its file ownership is exclusive and
does not include their files), and per its own hard constraint it touches only its assigned
paths. **The `.asar` this pass produced therefore does not contain ship-fixes' test-harness
wiring, accounting's F1–F8 fixes (including the `REALIZED_WITHOUT_BASIS` guard for the
70-SOL-class incident), or visual's CSS/markup consolidation.** Re-run `node
scripts/release-alpha53.mjs pack` once those three land on `main`; the recorded SHA-256 in
this pass's `release-record.json` / `.agent-state/RELEASE_STATUS.md` is only a proof that the
packaging mechanism works, not a final ship candidate.

### The "3.0.0 vs 0.5.0-alpha.NN" question (unresolved, flagged for bing)

Recurring across this project's history (see the alpha.52 entry above: "task text said
'3.0.0-alpha.52'... kept the established 0.5.0-alpha.NN line pending confirmation"). Same
question resurfaces for alpha53 and remains **unresolved** here too. Per the workflow ledger's
own Clarified block, this pass **kept `package.json.version` on the `0.5.0-alpha.NN` line**
(`0.5.0-alpha.53`) rather than jumping to `3.0.0`. `packaging`'s `pack` verb asserts the
version equals `0.5.0-alpha.53` exactly and would refuse to pack a `3.0.0`-stamped
`package.json` — if bing decides to make the major-version jump, that assertion (and this
ledger note) need updating alongside it, not silently.

### Real-money / risk gates re-proven at packaging time

`git grep` re-run against `main` HEAD before packaging (see `.workflow/scratch/packaging/PACKAGING-RUN.md`
for the full transcript): `liveExecution:'manual'`, `automaticLivePromotionAllowed:false`,
`liveActivationAllowed:false` all present unchanged at `src/index.js:426-428`;
`productionLearningUnlocked` gate logic in `src/edgeProof.js` unchanged; `git diff
93c8022..HEAD -- src/polymarket.js` empty; `git diff 93c8022..HEAD -- desktop/` empty; no
unauthorized `package.json` script additions outside `"test:"`/`"release:"` prefixes (none
added by `packaging` at all — it does not touch `package.json`). No live gate loosened, no
Windows/signature/`signed:true` fabricated, no key material read beyond the public
`desktop/update-public-key.pem`, no write under `~/Applications` or `~/Library/Application
Support/Money Printer OS`.
## alpha.53 — INTEGRATION PASS (integrator, 2026-09-20)

Supersedes the "status at the time `packaging` ran" table above. All five work packages are now
on `main`. Integration was done in a dedicated worktree
(`/Users/bing/Desktop/Money Printer OS/Current/MPO-wt-integrate`, branch `wf/integrate`, based on
`e611a75`), verified there, then fast-forwarded onto `main`.

### Merges (plan order, `PLAN.md` §7)

| # | package | branch @ sha | merge commit | conflicts |
| --- | --- | --- | --- | --- |
| 1 | ship-fixes | `wf/ship-fixes` @ `971a168` | `5ccf437` | **none** |
| 2 | accounting | `wf/accounting` @ `52a6e74` | `2543c9a` | **none** |
| 3 | product | already on `main` @ `2420d77` | — (landed before this pass) | — |
| 4 | visual | `wf/visual` @ `11d676a` | `9054d10` | **none** |
| 5 | packaging | already on `main` @ `eaee265` → `1813445` → `e611a75` | — (landed before this pass) | — |

**Zero conflicts. The plan's exclusive-file-ownership model held exactly** — no path was touched
by two packages. `product` and `packaging` had committed straight to `main` out of order rather
than to package branches; because their files (`.agent-state/KNOWN_BUGS.md`;
`scripts/release-alpha53.mjs`, `docs/WINDOWS-RELEASE.md`, `docs/UPDATER-MANIFEST.md`,
`.gitignore`, `.build-*`, `.agent-state/RELEASE_STATUS.md`, this file) are disjoint from the three
package branches', the three merges were clean anyway. Nothing had to be hand-resolved and no
package's work was overridden.

### Out-of-order packaging — corrected

`packaging` ran and packed `main` when only `product` had landed, and said so honestly in its own
`RELEASE_STATUS.md` ("mechanism proof, not a final release artifact", SHA-256 `be8f1f8a…` from
commit `1813445`). That warning is now discharged: the integrator **re-ran
`node scripts/release-alpha53.mjs pack` against the fully-merged tree**, and the artifact +
SHA-256 recorded in `.agent-state/RELEASE_STATUS.md` are from the integrated HEAD. The earlier
`be8f1f8a…` hash is superseded and must not be shipped.

### Verification at integrated HEAD

Logs: `.workflow/scratch/integration/`. Run in the integration worktree after `npm ci`, then
re-run in full on `main` after the fast-forward.

| check | result |
| --- | --- |
| `npm ci` | exit 0 (lockfile unchanged; no new dependencies anywhere in this workflow) |
| `npm run test:all` | **302 tests, 302 pass, 0 fail, 0 skipped** (`final-test-all.log`) |
| `npm run test:visual` | **26/26** (`final-test-visual.log`) |
| `node --test tests/release-gate.test.cjs` | **6/6** (`final-release-gate.log`) |
| `node src/selftest.js` | `SELFTEST PASS` (`final-selftest.log`) |
| `node src/doctor.js --offline` | exit 0, `PAPER IDENTITY … holeExact 0 okExact true` (`final-doctor-offline.log`) |
| M3 — identity through `loadState()` on all 5 read-only snapshots | **PASS**, `holeExact = 0.000000000`, `okExact = true` on every one (`recon-loadstate.log`) |
| M4 — real PEG rewrite replayed against `saveState()` | **REFUSED** `REALIZED_WITHOUT_BASIS`; `state.json` byte-unchanged; `guardEquityJump` alone would have allowed it (`guards-proof.log`) |
| raw-file reconciliation on every snapshot | `IDENTITY(hist)` hole `0.000000000` (`recon-all.log`) |
| legacy pre-ledger merge repro | ledger reconstructed, `okExact true` (`merge-repro.log`) |

`npm run doctor` was **only ever run as `node src/doctor.js --offline`**, with a throwaway
`MONEY_PRINTER_DATA_DIR`. Running it without `--offline` would call `benchmarkRpcs()` against
live RPC providers, which the workflow's hard constraints forbid. This is stated as a deliberate
substitution, not a silently skipped step.

### Integration breakage fixed

**None.** No test, suite or script failed at any point after any of the three merges; no
integration fix-up commit was needed and no feature was added. The only non-merge change in this
pass is the truthful restatement of `.agent-state/PROJECT_STATE.md`, `CURRENT_TASKS.md`,
`KNOWN_BUGS.md`, `RELEASE_STATUS.md` and this file, plus the repacked artifact.

### Real-money / risk gates re-proven at integrated HEAD

`liveExecution:'manual'` (`src/index.js:433-435`, `src/dashboard.js:316`),
`automaticLivePromotionAllowed:false` (`src/index.js:433-435`, `src/experimentRegistry.js:47,66,86`,
`src/researchControlPlane.js:9,75,141`, `src/dashboard.js:135,315`, `src/researchLifecycle.js:55`),
`liveActivationAllowed:false` (`src/researchControlPlane.js:10,74,140`, `src/index.js:433-435`,
`src/dashboard.js:314`) — all present, all unchanged. `productionLearningUnlocked` still derives
from `proven` in `src/edgeProof.js` (no forcing). `MISSING_VOID_MS` unchanged
(`src/polymarket.js:48`). The diff of `src/polymarket.js` against `93c8022` is **empty**; the diff
of `desktop/` against `93c8022` is **empty**; the entire `package.json` diff vs `93c8022` is
`test:visual`, its insertion into `test:all`, and the three `release:*` aliases — nothing else.
`~/Library/Application Support/Money Printer OS` was never written to; the read-only copies under
`.workflow/scratch/data-ro/` are byte-identical before and after every run
(`state.pre-price-repair-*` sha256 `1288a8f6ae84c51baa35d4ec64f2555989b76f61472301bb3a6cc739aa493998`).

### Still open after integration — needs bing, not an agent

1. **Install / restart.** `scripts/release-alpha53.mjs install` and `restart` hard-refuse under an
   agent by design. Exact commands in `.agent-state/RELEASE_STATUS.md`.
2. **Updater manifest signing.** `docs/UPDATER-MANIFEST.md` carries the Ed25519 recipe with the
   private-key path left as a placeholder. No agent read, named or looked for key material.
3. **Windows.** No Windows build, signing or CI exists in this repo (`docs/WINDOWS-RELEASE.md`), so
   `tests.windowsBoot` and `artifacts.windows.sha256` cannot be produced here. `promote tested`
   refuses accordingly; the release stays at stage `main`. Needs a Windows machine.
4. **Polymarket US API key** regeneration at polymarket.us/developer (`keyNotFound`), and the
   Combos/RFQ beta allow-list (`betaNotEnabled`) which is polymarket.us's decision.
5. **First real trade** to confirm the `/v1/order/{id}` and settlement payload shapes — deliberately
   not simulated.
6. **`3.0.0` vs `0.5.0-alpha.NN`** still unresolved; this pass kept `0.5.0-alpha.53`, and `pack`
   asserts that exact string.
