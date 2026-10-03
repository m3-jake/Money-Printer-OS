# Project state — 2026-10-03

Ledger of record: `MONEY_PRINTER_STATUS.md` (entry point, latest batches, architecture, open issues).

- **Apps:** Money Printer OS (trader, `W:/money-printer-os`, branch `main` → GitHub) and the Evolution Lab
  (`W:/money-printer-evolution-lab`, branch `master`, no remote). Paper only; real execution is not installed.
- **Shared strategy core:** `shared-core.json` lists the files the Lab runs from the trader. Edit them only in the
  trader, then `node scripts/sync-shared-core.mjs`; parity tests in both repos fail on drift.
- **Install:** `scripts/update-local-install.ps1` builds, boot-tests and swaps both apps as a pair; receipts in each
  install's `PAIRED-RELEASE.json`. The install record is `.agent-state/RELEASE_STATUS.md`.
- **History:** `docs/history/` (the earlier status ledger, the remediation PROGRESS ledger and the older agent-state
  files, verbatim).
