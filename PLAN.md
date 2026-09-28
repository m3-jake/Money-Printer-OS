# Money Printer OS: phased truth-first plan

## Phase gate
Only Phase 0 is authorized. STOP after its report. Phases 1-5, including each
5a-5d sub-phase, require separate explicit user approval. No automatic promotion.

| Phase | Status | Gate |
|---|---|---|
| 0 Truth and instrumentation | IN PROGRESS | Read-only journal metrics and fixed-window replay |
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
