# Final paired installation — October 3, 2026

Completed the interrupted release, including the final request deadline, durable operating control and Lab startup summary fixes. Both full suites passed before packaging. Installed at 2:30 PM America/New_York; runtime verification is recorded in `after-report.json`.

| App | Version | Packaged and running commit | Installed archive SHA-256 |
|---|---|---|---|
| Money Printer OS | 0.5.0-alpha.89 | 3fa7d3b0eb1a69b90f9ef9790783c1a7aefbe6dd | cf0bb5dc0a1e0e592235ef8a5be2df14dc2ca4dcaa5b1f57a5b7e12ffaf0ece3 |
| Evolution Lab | 0.1.0-alpha.25 | 258286ff589a2d1e7e8e06511918ef3a637a8fcb | a4d592d7e6736340ee9cb89699429f46d28a95e7ad08b9c13d660b0dd6e35afa |

The receipts in both install roots are identical. Fresh archive hashes match them; both running builds report the expected clean packaged commits. `PAIRED-RELEASE.json` is the copied final receipt. Documentation edits following this verification do not change the packaged release identity.

## Validation and operating state

- Trader `test:all`: 1,357 executions, 1,337 passed, 20 intentional live-order skips, zero failures/cancellations. Log: `completion-trader-tests.log`.
- Lab `test:all`: 349 passed, zero failures/skips/cancellations. Log: `completion-lab-tests.log`.
- Shared-core parity passed in both suites. Both archive smoke checks passed, including hashes, exact versions/commits and paper-only checks.
- Trader health HEALTHY; Lab health successful. Both persisted operating profiles are FAST_PAPER_STEADY. Recurring paid models and live activation remain disabled.
- Ten final health requests: p50 20 ms, p95 22 ms. This is a small startup HTTP measurement, not source-to-fill latency, execution throughput or a long observation window.
- Startup scoreboard: 89 rows, zero beating baseline, seven not beating and 82 with insufficient data; five outlier-driven and 13 stale. Seven separate copy cohorts are present. No empirical profitability is claimed.

## Preservation, backup and rollback

Every retained pre-swap close in the incumbent copy and US combo histories remains byte-for-byte present in the post-install history records. Copy: 71 closes, $500 initial capital, $200.988483 cash, 16 opens, drawdown pause active. US combo: 355 closes, $100 initial capital, $1.24 cash, no opens. Comparison is to the immediate pre-swap backup; changes since the original baseline are ordinary retained trading/settlement results. Existing losses are preserved.

Backup/build folder: `C:/Users/jakem/Desktop/Money Printer OS/update-20261003-142927/`. `paper-data-backup/MANIFEST.json` records hash-verified root JSON, SQLite, WAL/SHM and journal backups; experiment and research directories were also copied after writers stopped.

To roll back, quit both apps and restore **both** installed `resources/app.asar.backup-20261003-142927` files to their corresponding `resources/app.asar`. The install roots are `C:/Users/jakem/AppData/Local/Programs/money-printer-os/` and `C:/Users/jakem/AppData/Local/Programs/money-printer-evolution-lab/`. Preserve current paper data; do not replace it to erase outcomes.

The first completion attempt aborted during backup, before archive swaps, because a relaunched process held SQLite SHM open. Remaining app processes were stopped and the full paired installer retried successfully. `completion-installer.log` records the successful retry; the first attempt log remains in `W:/money-printer-release-2026-10-03/completion-installer.log`.

Pre-existing trader launch configuration, status-ledger content, upload ZIP and Lab `.workflow/` were restored. Applied safety stashes remain available: trader `2d63c29` (release artifacts) and the named pre-existing-work stash; Lab named pre-existing-workflow stash. No source reset, public push, signed updater publication or real-money dispatch occurred.

## Remaining boundaries

Authentic forward quotes, elapsed outcomes, independent-wallet provenance, supported equity history, SEC identification/credentials and operator choices remain required where listed in BUILD-RECORD.md. The separate remaining HUD script extraction (D2), Mac verification, signed updater publication and literal 24-hour observation are not completed by this Windows release. These are recorded waits or separate work, not profitability inferred from fixture tests.
