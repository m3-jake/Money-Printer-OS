# Profit Lab P0 — versioned Pump.fun paper study

Fresh paper outcomes show the active Pump.fun policy and the existing immutable Pump profit study no longer share the same policy hash. The runtime therefore refuses new baseline opportunities, which is correct for the old holdout but leaves the active policy without a clean prospective comparison.

Implement a new policy-keyed PAPER-only study generation. Preserve the legacy baseline/protocol/checkpoint/evidence unchanged. A new generation must start from a fresh timestamp, use only future opportunities, keep the active trading profile unchanged, and never copy historical outcomes into validation.

Use these read-only nomination artifacts as context only:
- W:\money-printer-audit-artifacts\profit-lab\pump-max-current-analysis.json
- W:\money-printer-audit-artifacts\profit-lab\pump-max-filter-nomination.json

Acceptance:
1. Existing Pump study files and trade history are never reset, rewritten, refunded or deleted.
2. Each policy hash gets an isolated experiment checkpoint and evidence stream.
3. Historical outcomes can nominate a hypothesis but cannot enter the new validation statistics.
4. Baseline and a small predeclared candidate family see the same future opportunity timestamps; guarded candidates fail closed when required evidence is missing.
5. Validation remains blinded until its declared end and uses the existing independent-outcome, drawdown, best-trade and multiple-testing gates.
6. No automatic promotion, live activation, order API, bankroll reset, open-position policy change or user-profile change.
7. Run test:pump-profit, test:paper-bots, test:wiring, git diff --check and the full test:all before a paired release.

Dependency: implement in current Money Printer OS main and keep Evolution Lab shared-core parity green. The current evidence artifacts are sufficient to start; no credential or market-history backfill is required.
