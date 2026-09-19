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