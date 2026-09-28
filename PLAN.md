# Money Printer OS: phased truth-first plan

## Phase gate
Only Phase 0 is authorized. STOP after its report. Phases 1-5, including each
5a-5d sub-phase, require separate explicit user approval. No automatic promotion.

| Phase | Status | Gate |
|---|---|---|
| 0 Truth and instrumentation | NEEDS DECISION | Read-only journal metrics and fixed-window replay |
| 1 Parallel aggressive paper | NOT AUTHORIZED | Separate approval after Phase 0 |
| 2 Shadow-live, zero orders | NOT AUTHORIZED | Separate approval after Phase 1 |
| 3 Second execution estimate | NOT AUTHORIZED | Separate approval after Phase 2 |
| 4 Read-only qualification | NOT AUTHORIZED | Separate approval after Phase 3 |
| 5a Polymarket singles | NOT AUTHORIZED | Separate approval |
| 5b Kalshi demo | NOT AUTHORIZED | Separate approval |
| 5c Robinhood equities paper | NOT AUTHORIZED | Reconcile existing implementation first |
| 5d Cross-platform routing | NOT AUTHORIZED | Separate approval |

## Frozen baseline
- Source: `68757cd5020df5f312f21bb40e791b6d640a290d`, alpha.73.
- Isolated branch: `audit/phase0-truth-20260928`; original worktree preserved.
- Paired Evolution Lab: `529cc71`, alpha.14. No Lab changes in Phase 0.
- Installed runtime provenance matches source; mode PAPER, execution manual,
  automatic promotion false. FAIR / aggression 72 / LAB_AUTO / effective cap 25.
- Champion `GLOBAL-G101757-821` overrides exits; FAIR name is not its exit policy.
- Existing untracked `src/pumpProfitPolicy.js` is unrelated and is not included.
- Immutable input copies: `W:/mpo-phase0-evidence-20260928`; no credentials copied.
- Existing simulator, live gates, sizing, thresholds, routes and tests stay intact.
- Initial discovery: retained journal has five paper resets; report separate eras.

## Phase 0 result: NEEDS DECISION (no next-phase authorization)
Instrumentation, CLI JSON/Markdown output and an existing-model fixed-window reference
replay are implemented. Exact installed FAIR/LAB_AUTO replay parity is NOT established.
The retained journal lacks micro.p10, priceAccel, pool binding and full historical
policy/config inputs. The reference replay must not be presented as current-policy evidence.

Snapshot cutoff: 2026-09-28 10:40:44.479 UTC (06:40:44.479 America/New_York).
Fixed window: 2026-09-27 03:51:21.323 UTC through that cutoff, end exclusive.

| Book/reference | Closes | Win rate | Net P&L | Expectancy | Closed-PnL max DD | Hourly proxy Sharpe |
|---|---:|---:|---:|---:|---:|---:|
| Current Pump.fun UNIFIED_EDGE | 128 | 41.40625% | +0.854479 SOL | +0.006676 SOL | 0.066583 SOL | 0.931545 |
| Polymarket US combos | 112 | 77.67857% | -17.06 USD | -0.152321 USD | 24.63 USD | -0.083146 |
| Robinhood crypto | 1 | 0% | -0.178389 USD | -0.178389 USD | 0.178389 USD | N/A |
| Robinhood practice | 15 | 0% | -8.68 USD | -0.578667 USD | 8.68 USD | -0.661366 |
| Legacy FAST reference replay | 149 | 30.87248% | -0.150229 SOL | -0.001008 SOL | 0.151927 SOL | -0.316021 |

Most important number: only **4.6843 hours** in the current reset era.
Current rolling Sharpe has only four complete hourly samples; it is unannualized,
realized-only, and not a marked-portfolio Sharpe or readiness qualification.
The captured marked-equity curve separately shows a 30.5637% maximum drawdown.
One winner contributed 0.428989 SOL; only 48/128 closes have complete cash receipts.
Momentum contributed 0.502059 SOL and pullback 0.277456 SOL; attribution is not causal.
All 862 closes before the common cutoff remain visible across five reset boundaries.
This Phase 0 work made no resets, removed no losses, changed no open-position policy, relaxed no model and placed no orders.

## Reproduce and inspect
From `W:/mpo-phase0-truth-20260928`:

```powershell
node src/analytics/journalReport.js journal --data-dir W:/mpo-phase0-evidence-20260928 --out W:/mpo-phase0-results-20260928/journal-new
node src/analytics/journalReport.js replay --data-dir W:/mpo-phase0-evidence-20260928 --from 2026-09-27T03:51:21.323Z --to 2026-09-28T10:40:44.479Z --start-sol 1 --sol-usd 200 --preset FAST --out W:/mpo-phase0-results-20260928/replay-new
node --test --test-concurrency=1 tests/phase0-analytics.test.mjs tests/phase0-report-io.test.mjs tests/phase0-replay.test.mjs tests/replay-lab.test.mjs tests/pump-paper-shared.test.mjs tests/accounting-integrity.test.mjs tests/solana-fair.test.mjs tests/runtime-controls.test.mjs tests/robinhood-safety.test.mjs tests/robinhood-auto-trader.test.mjs
```

Use a new output basename each time: the CLI refuses overwrites and refuses to write inside its input directory.
Evidence outputs: `W:/mpo-phase0-results-20260928/{journal-final,replay-final}.{json,md}`,
`receipt.json`, `tests-final.log`, and `live-gates.txt` (the exact requested recursive greps).
Test result: **94 passed, 0 failed**: 20 new Phase 0 cases plus 74 existing cases.
Existing test files are unchanged. Six protected source files are byte-identical to baseline.
Repeated real-data replay JSON is byte-identical:
`c2d68608511a52fb89729b643eefe7456e7c9a854a6e477a4f678b41135852ea` (case-insensitive hex).
Normalized fixed-window input SHA-256:
`9f7396f7a30f0e7c2d022ad6bc455eb5f7de91988aea56447f90549c3693a8f2`.

## Concurrent work and next decision
The original `W:/money-printer-os` checkout acquired unrelated concurrent changes during
this pass, including `executionSim.js` and an existing test. They were neither modified
nor staged by this Phase 0 work. This isolated branch has not been merged, pushed or installed.
The running applications still reported Trader alpha.73 / Lab alpha.14 at the final check,
with paper mode, manual execution and automatic promotion false.
Recommendation: reconcile the concurrent work into a reviewed baseline, then establish
runtime-faithful FAIR/champion replay and richer historical input coverage before approving
Phase 1. STOP here; no aggressive profile, shadow mode or platform expansion is authorized.
