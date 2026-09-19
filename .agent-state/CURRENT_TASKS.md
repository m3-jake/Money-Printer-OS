# Current tasks — 2026-09-16

| Task | Status |
| --- | --- |
| Data-first evidence audit (`20260916-103902-e69ba`) | Complete; `.agent-state/DATA_DECISION_MEMO.md`. No deploy/orders. |
| Polymarket settlement-bias (`20260916-103902-02a6c`) | Reviewed at `ee8077a` / `125126e`. Timeout refunds rejected. Strategy `keep=false`. Live journal not modified. |
| Isolated latency instrumentation | Integrated at `125126e` (`src/latencyStats.js` + `alphaDb` wait_ms). Ready-to-proposal timing supersedes memo mean-proposal bottleneck. |
| Meme alpha + latency (`20260916-103902-e8029` / `1d954bc`) | Not wholesale-merged. Selective research tools only; see `INTEGRATION_LEDGER.md`. |
| Data integrator gate (`20260916-104614-4bd03`) | Complete on this branch. Ledger: `.agent-state/INTEGRATION_LEDGER.md`. SELFTEST PASS; `test:all` 156/156. No deploy. |
| Alpha42 data/safety tester (`20260916-103902-a131d`) | Baseline 99/99 + SELFTEST PASS on `4207a70`. |
| Prove positive forward returns after costs | **Unproven.** Edge INCONCLUSIVE. Kill promotion until memo §4 bars met. |
| Regenerated Polymarket US key | Pending user; still keyNotFound historically |
| Real execution / risk loosening | **Forbidden** |
| Visual overhaul integrator (`20260916-000321-3254a`) | Left unmerged here; dashboard.html overlaps settlement audit UI. |
| Cross-platform canary (`20260916-104846-0a178`) | Waits on this gate + visual integrator. |
| BEAST furnace final benchmark (`20260916-180029-34473`) | Complete on this branch. CPU/RAM packed path accepted; persistent CUDA sidecar accepted **only when explicitly enabled on a CUDA host**, with CPU-authoritative finalist rescoring/fallback. Fixed 2048×3000 corpus had exact deterministic ranking parity and 0 mismatches; WITCHDOCTOR warm request ~918 ms. No deploy. |
