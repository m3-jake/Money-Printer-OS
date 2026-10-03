# Current tasks — 2026-10-03

Read `MONEY_PRINTER_STATUS.md` first: it is the ledger of record (current entry point, the latest batches, the
architecture and the open issues). Older history is in `docs/history/`.

- The coordinated desktop build and verified paired installation are complete: trader alpha.93 / Lab alpha.28, both MAX_RESEARCH. Read `reports/coordinated-desktop-2026-10-03/README.md` and `docs/LLM_REVIEW.md` before making release claims.
- The earlier improvement run has D2 (remaining shared HUD script extraction) open; two windows are already
  extracted. Evidence/credential waits in BUILD-RECORD.md and operator choices in the ledger remain open.
- Codex and Claude both work in this tree and the Lab's. Check `git log` and the ledger before starting; never
  revert the other agent's commits.
- **Profitability P0:** the current Pump.fun MAX paper policy has materially negative completed outcomes, while the existing Pump profit study is pinned to an older immutable baseline and reports `ACTIVE_POLICY_CHANGED_NO_NEW_BASELINE_OPPORTUNITIES`. Implement the versioned, policy-keyed PAPER-only prospective study in `W:\money-printer-audit-artifacts\profit-lab\pump-policy-study\TASK.md`. The reproducible nomination evidence is in `W:\money-printer-audit-artifacts\profit-lab\pump-max-current-analysis.json` and `pump-max-filter-nomination.json`; never promote from those historical outcomes. Preserve the legacy study, active profile, trade history and all paper/live safety.

The queued Pump study task and nomination artifacts are also available to GitHub reviewers under `reports/queued-pump-policy-study/`. This is a separate future implementation, not a completed strategy or prospective qualification.
