# Upgrade implementation ledger

Authority: `MASTER-UPGRADE-PROMPT-2026-09-26.md`, explicitly requested by the owner. Earlier retirement notes, stop-after-batch instructions and historical build prohibitions are superseded. No live orders, installation, publishing, or installed-data mutation are authorized here.

## Verified starting point

- Trader: `feature/hud-declutter`, `4a80e902042682d4fc94515c0a10255639d6642b`, package alpha.60. Pre-existing changes: `.claude/launch.json` and the untracked master brief; preserve both. Checkout build markers incorrectly say alpha.53 / `9054d10`.
- Lab: `codex/lab-evidence-20260925`, `386bb13`, alpha.6, initially clean. Work proceeds in the explicitly named checkouts, with exclusive agent file ownership.
- Installed APIs: trader alpha.60; Lab alpha.6, generation 101182, RUNNING, THROTTLED, one worker, GPU off, exits FROZEN. Trader has lab link enabled, paper only, live disabled. Package version alone does not establish source identity: installed platform coverage still reports read-only legacy books while checkout implements mirrors.
- Real data directories: `%APPDATA%/Money Printer OS/data` and `%APPDATA%/Money Printer Evolution Lab/data`; fresh September 26 files agree with running APIs. A separate stale Claude MSIX Lab overlay exists under `%LOCALAPPDATA%/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/`, last updated September 21. Tests and development must explicitly use disposable directories.
- Hardware: Ryzen 9 5900XT, 16 cores / 32 logical processors, 63.9 GiB usable RAM (37.4 GiB free at sample). RTX 5070, 12227 MiB VRAM, driver 610.74; initial telemetry 3056 MiB used, 6% utilization, 43 C, 38.82 W. CUDA evaluator availability remains a separate check.
- Running installed app processes: trader root PID 29604; Lab root PID 6548. Neither was restarted. Runtime Node for source tests: 24.16.0; npm 11.13.0. Historical worktrees were inventoried with `git worktree list`; none was modified or retired.

## Ownership and delivered milestones

| Milestone | Owner | State / acceptance |
| --- | --- | --- |
| A replay and registry | replay agent | Implemented and verified: close availability, next-quote fills, both fees, marked DD, charged fold exits, effective closed samples, stored-run identity and startup invalidation |
| A portfolio / accounting | primary + independent Lab review | Implemented: marked USD equity, durable unitized HWM, cash-flow handling including complete withdrawal/redeposit, visible unknown valuations and exclusions |
| B Lab loop and contracts | Lab agent + primary + HUD review | Implemented: actual incumbent handoff, immutable experiment/holdout receipts, frozen future evaluation, actual producer-consumer compatibility, common manual/automatic bounded paper trial and verified rollback |
| C compute | Lab agent + replay agent | Implemented: persistent bounded scheduler, dedup/fairness/retry, shared CPU leases, bounded worker lifecycle. Benchmarked; GPU and unwired temperature/foreground sensors explicitly remain unavailable |
| D modules / cross venue | primary | Implemented:16-module capability/decision matrix, Kalshi handoff/evaluator integration, rule invalidation, synchronized books and failed-leg scenarios. No new chain meets evidence bar; ranked ready adapter design delivered |
| E HUD / operations | HUD agent + primary | Implemented: resilient preferences, tile restore, bounded polling, stale/readiness truth, full renderer measurement, native/browser tests, build provenance, legacy HTTP/Electron boundaries and current operator docs |
| F integration / release | primary integration reviewer | Full source suites and cross-app fixtures passed, bounded soaks observed, native Electron under CPU load passed. Committed-source Windows archives and isolated engine smoke recorded below; installation and 24h observation remain owner/future work |

## Prioritized issue ledger

| ID | Classification | Evidence / impact | Fix and acceptance | Status |
| --- | --- | --- | --- | --- |
| A1 | fixed | Core candle rows expose past open at close | Close-only nonexecutable candle research; regression | verified |
| A2 | fixed | Core close returns omit entry fee | Cash/trade/MC reconciliation | verified |
| A3 | fixed | Terminal mark omitted from DD; fold silently discarded inventory | Predeclared next-quote boundary liquidation, fees/slip; incomplete folds cannot qualify | verified |
| A4 | fixed | WF counts legs | Closed/effective observations | verified |
| A5 | fixed | Registry accepts numeric assertions, retains evidence across revisions | Stored evaluator/dataset/policy identity, fixed-policy matching, startup invalidation and append-only lineage | verified |
| A6 | fixed | `RiskGovernor.lossMetrics` uses realized-loss/deposit ratio | Marked equity, cash-flow-neutral HWM, unknown marks block additions; zero-unit reset regression | verified |
| B1 | fixed | Lab equities compares default, reuses sealed history and omits sell fees | Applied incumbent, consumed holdout, boundary costs, future frozen evaluation | verified |
| C1 | fixed | Core pool unbounded queue and incomplete timeout/shutdown | Admission, cancellation, timeout, crash, release-I/O outcomes; lease retained until worker exit | verified |
| E1 | fixed | Desktop preference JSON can prevent startup | Field-level recovery, quota/denied storage, native/browser checks | verified |
| E2 | fixed | Retired-Lab docs contradict code/runtime/owner | Current architecture, source/runtime provenance and state entry points | documented |
| B2 | historical fixed | Runtime has fitness ledger, Robinhood venue rows, frozen Solana exits, throttle | Preserve and verify tests; no reimplementation | verified current runtime |
| B3 | data blocked | RH 0.557 days / 63% venue rows / 1 close; Solana sampled marks; US combo RFQ unavailable | Collect first; no manufactured champion | qualification pending |
| B4 | fixed in independent review | Manual Lab apply bypassed safety/freshness/trial, malformed rollback state could keep old closes or report false restoration | Common admission, epoch/hash/equity checks, persisted PREPARING/ROLLBACK_PENDING, verified restore, keep only when flat | verified |
| B5 | fixed in independent review | Equities consumer trusted a pass flag; proposal withdrawal silently reset applied params | Independent126-session/grouped interval/gate validation; persisted accepted-policy receipt; actual sibling producer test | verified |
| D1 | fixed | Matching described unresolved multi-leg return as locked | Conditional payout and one-leg loss/unwind scenarios; fee/rule changes invalidate | verified |
| D2 | fixed | Repeated wire polls could claim source publication as availability | First local receipt of each revision retained | verified |
| E3 | fixed in independent review | Legacy POSTs lacked same-origin JSON guards; Electron opened arbitrary external schemes | Local Host/Origin/JSON checks and exact-origin navigation/protocol allowlist | verified offline before side effects |

## Verification log

Read-only API samples: `/api/state`, `/api/health`, `/api/fitness`, `/api/platform/status` on 8792; `/api/health` on 8793. These endpoints prove only reported current state. No external authenticated order probe was made. Windows source checks are not a Mac installation test.

### Source integration

Starting HUD branch lacked code already installed from main; merge `3eef954` restored fitness/trials,
quote sampling and unattended reliability without discarding HUD work. Owned commits:
`b95f40f` and `1f15352` replay/registry/pool/soak; `996c8ff` HUD and bounded trial; `c511661`
equities consumer/sticky applied policy. Lab `abc16cec35bb8957d7fb6f7b8a4791c0bad0fbdb` includes
Robinhood parity `36fae5f`. The parent commit packages valuation, contracts, provenance, Kalshi bridge,
security boundaries, native verification and documentation. The final source/build commit is below.

### Tests and actual environments

* Final trader `npm run test:all`: **865 passed, zero failures, zero skips** on Windows Node24.16.0.
  Raw log `upgrade-trader-final-test-all-2026-09-26.log`. The prior integration run passed849;
  final gates include later reproduced bugs and real sibling repository compatibility.
* Lab `npm run test:all`: **254 passed**; subsequent scheduler11/11 passed after additional recovery
  and actual `--once` process-exit regressions. Lab result details/logs are linked below.
* Trader selftest and offline doctor passed using disposable data; paper identity exact, no live gate.
  Installed read-only preflight reports both actual data directories consistent with running APIs.
* Cross-app tests assert byte parity for three shared implementations, competing shared leases,
  stored Kalshi contract/book/outcome → atomic handoff → actual Lab evaluator → immutable experiment
  and trader status mirror, plus refusal of incompatible schemas/provisional fee overrides.
* Equities integration uses the sibling Lab's actual freeze/evaluate/publish functions and126 future
  synthetic sessions solely as a deterministic test fixture. No real elapsed qualification is claimed.
* The existing full suites retain signed-job rejection, CPU/reference and mocked GPU/fallback checks,
  collector/recovery, ledger, credentials, local HTTP, real-order locks and updater-signature tests.
  No authenticated provider order, GPU performance validation, Mac install or live update was exercised.

### Measured responsiveness and resources

| Measurement | Observed result | Interpretation |
|---|---|---|
| Worker real copied BTC corpus,4jobs/2workers | 174→255ms wall;563→734ms CPU;131→137MiB; maximum event-loop lag15.8→14.5ms; same output hash | Lease/lifecycle correctness adds overhead; no throughput speedup claimed |
| Lab copied ETF dataset,3-run median | 753→665ms;RSS159→175MB | Corrected accounting/window workload, not numerical parity or pure acceleration |
| Scheduler duplicate admission | 1000submissions→1job | Avoided999 redundant evaluations |
| Browser HUD before/after | Render p955.2→1ms;long tasks15→1; interaction p959.2→27.7ms | Different durations/sample counts; no apples-to-apples speedup claim |
| Native Electron38.8.6,150%DPI,4CPUworkers | Corrupt/quota/disconnect phases:72clicks, p95feedback75.3/22.1/6.2ms; frame p956.4/6.4/6.3ms;0errors | All feedback samples meet100ms target. Actual native renderer, synthetic feeds; human/multi-monitor transition latency unverified |
| Native render/working set | Full render p9525.4/20.8/6ms; working set about193→208,256→263,279→281MiB by phase | Short reload-based sample cannot establish absence of a memory leak; raw process/GPU metadata retained |
| Lab local API under research load | 475responses;p955.36ms,max38.6ms;0errors | Meets cached-local200ms target in this fixture |

Native hidden-window control was throttled near1Hz and failed the feedback target; it is retained
as `upgrade-electron-hidden-hud-2026-09-26.json` and excluded from active-window performance claims.
The repeated visible native test passed and closed its copied runtime. Screenshots and metrics:
`upgrade-electron-hud-2026-09-26.json`, `upgrade-electron-*.png`, and the HUD workstream report.
GPU enumeration is diagnostic only; no acceleration/thermal/energy efficiency result is asserted.

### Observed soak and continuation

Trader core soak accumulated **98.429seconds**,567complete paper cycles,1,135ledger rows,
567worker completions,56cancellations,11restarts, maxqueue1, maximum observed RSS110MiB;
cash remained exactly$1,000, zero positions, failures or network attempts. Lab soak observed
**30.004seconds**,20real-corpus jobs,0failures and475API samples. These are short isolated checks.

Resume trader in bounded invocations (checkpoint includes target/accumulated time and pass criteria):

```powershell
node scripts/upgrade-soak.mjs --dir C:\Users\jakem\AppData\Local\Temp\mpo-upgrade-soak-tuZBzj --max-seconds 120
```

Lab continuation from its repository:

```powershell
node scripts/upgrade-soak.mjs --seconds 86400 --resume C:\Users\jakem\AppData\Local\Temp\mpo-lab-soak-fkwCKx
```

The24-hour observation has **not** completed. No background monitoring job or automation was created.

### Current limitations and deliberately deferred work

Qualification awaits authentic executable histories/costs and future data. Generic Market Lab's current
sources cannot certify historical fee/slippage/depth lineage, so its qualification gate stays closed;
an API caller cannot turn it on with a boolean. Kalshi's new path remains exploratory. Equities needs
126future sessions after freeze and verified costs; Robinhood requires authentic elapsed coverage and
independent closes. Solana executable/rug/priority-fee evidence and actual US joint RFQ access remain
missing. No strategy is newly certified profitable. Daily-crypto untouched-window machinery was not
generalized to every evaluator; information-desk predictive ablations remain unproven.

USD marked accounting explicitly excludes unconverted currencies and unreconciled legacy books.
New high-water history begins at the first upgraded valuation; prior market marks are not reconstructed.
All event families beyond existing explicit supported mappings remain related, not exact. Full-network
sleep/reconnect/disk-exhaustion scenarios and physical multi-monitor transitions need extended operations
testing. GPU scheduling/thermal feedback and speculative Base/Arbitrum/Ethereum adapters are deferred
because validated evaluator/data/cost advantages were not established; a ranked integration contract is
in the operator document. Existing signed release and live authorization gates remain intact.

### Detailed deliverables

* `docs/UPGRADE-OPERATIONS.md`: ownership, capabilities, configuration, expansion decision,
  official API references, accounting scope, exact build/install/rollback procedure.
* `reports/UPGRADE-REPLAY-RESULTS-2026-09-26.md`: correctness, workers, benchmark and resumable soak.
* `reports/UPGRADE-LAB-RESULTS-2026-09-26.md`: experiments/scheduler, Lab artifact and integration review.
* `reports/UPGRADE-HUD-RESULTS-2026-09-26.md`: controls, trial safeguards, screenshots and measurements.

## Packaged release verification

| Artifact | Version | Packaged source | SHA256 |
|---|---|---|---|
| `W:/upgrade-release-20260926/trader/app.asar` | 0.5.0-alpha.61 | `b7ad48a5c0aa50d28f6f97d6f18bebd70da4034d` | `2da92602748fa47e99d3161dea575fa535c01bf6061680242a120fce41f4d2dc` |
| `W:/upgrade-release-20260926/lab/app.asar` | 0.1.0-alpha.7 | `abc16cec35bb8957d7fb6f7b8a4791c0bad0fbdb` | `59f1fc61a2922bfb4a2079be5453f7ed9b267cabbdd4b55f4a873e7faa9b83de` |

Trader archive is 44,522,133 bytes, 5,002 entries, zero native modules. Both archives were built twice
from the same committed source/toolchain and reproduced their exact SHA256. Trader's203 packaged
source-file hashes were reread through Electron's archive filesystem and matched BUILD.json; Lab's95
files were extraction-verified. No tests, portfolios, `.env` secrets or private keys were packaged.
The public updater verification key is intentionally included. Build logs retain the existing npm
shell invocation deprecation warning; fixed local paths and pinned tooling were used.

Both archives passed a separate isolated API/dashboard boot using the installed Electron38.8.6 runtime
**as Node22.22.0**. Each returned dashboard200 and health200/ok:true with exact version/commit and
sourceDirty:false. Trader health STARTING and Lab UNKNOWN are expected for these collector-disabled
disposable boots; they are not claims of full research readiness. The native renderer test is the separate
visible source fixture described above. Manifest and smoke evidence live beside each archive;
trader additionally has `PAYLOAD-VERIFICATION.json`, `BUILD-INFO.json` and `SHA256SUMS.txt`.

Final read-only installed check: trader still alpha.60, Lab still alpha.6 (generation101188), original
root PIDs29604 and6548 with unchanged5:35PM startup times. No installed process was restarted or
replaced. Trader pre-existing `.claude/launch.json` and the untracked owner master brief are preserved;
Lab checkout is clean. Subsequent commit(s) only add release verification/docs and the Lab smoke helper;
the packaged runtime source remains pinned to the commits above. These local unsigned payloads are ready
for owner review, with installation/signing/publication and the unobserved24-hour gate still outstanding.

## Desktop artwork and selection follow-up

The owner's subsequent desktop request is implemented in source commit
`328ce70d64a373949ce3eb24e5d0127406eaf127`. Desktop artwork grows from 38 to 56 CSS pixels,
with wider cells and 13px labels. The upper-right logo grows from 160 to 240px (120 to 180px
on narrow windows). The desktop suppresses native selection and decorative image dragging;
app windows and dialogs retain selectable text. Custom money pointer handlers are unchanged.

Verification: all 55 existing visual tests and both money-physics tests passed. An isolated
Electron 38.8.6 source fixture at 1536x1024 and 960x720, both DPR 1.5, passed actual pointer
drag checks: background/icon/logo selection stayed empty; app text and input selection worked;
each bill drag recorded one grab, twelve moves while grabbed, and one release, with zero native
image drags or renderer errors. All sixteen icons and the logo fit both viewports. The fixture
used synthetic positive profit and a fixture-only burst to provide a large draggable bill.

The updated trader payload is `W:/upgrade-release-20260926/trader-desktop/app.asar`, alpha.61,
SHA256 `21ec40db10c36829a1a2e6c650eefd5d3de03d125fb4ab2470608ec25120bfbd`.
It contains the committed CSS change and supersedes the earlier trader payload for this request;
the Lab payload above is unchanged. This follow-up archive was built once and passed an isolated
Electron-as-Node boot with dashboard/health HTTP 200, health ok:true, and exact clean source provenance.
Its directory includes the build manifest, hash, smoke result, `desktop-interaction-verification.json`,
and screenshots `desktop-icons-1536.png` and `desktop-icons-960.png`. Neither app was installed or restarted.
