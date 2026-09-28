# Zero-credit recovery release - September 28, 2026

Source pair: Money Printer OS 0.5.0-alpha.72 and Money Printer Evolution Lab 0.1.0-alpha.14.
This record describes tested source changes. Installed versions and archive hashes are authoritative in the PAIRED-RELEASE.json receipt written to BOTH installation roots only after successful runtime verification.

## Recovered work
Preserved the existing uncommitted Command Center mission cards, paper scoreboard improvements, local evidence triage, research reservations, and Lab scheduler fixes. Baseline source backup: W:/mpo-repair-backups/zero-credit-20260928-0338/.

## Changes completed
Paid model execution is build-locked before SDK construction, regardless of credentials or injected clients. Optional provider adapter request/response logic remains independently testable; default reservations are zero.
SEC research now produces explicitly labelled local source excerpts with exact source ranges and hashes, or reuses previously cached AI results without relabelling them as local facts. The shared SQLite research cache persists reuse counts and refuses expired evidence.
The shared event bus adds normalized IDs, provenance, timestamps, optional freshness/confidence/relevance, bounded explicit-identity deduplication and isolated observer failures. Accounting remains in the existing authoritative books; partial fills are never collapsed by order ID.
Command Center retains embedded Market Lab and cross-module mission desks. Local evidence attention is bounded and deduplicated. Paper book counts exclude Lab backtests, unknown P/L stays unknown, and drawdown labels specify closed outcomes rather than unrealized exposure.
Lab exhausted retries now survive producer polling, history compaction, waiting states and restarts. Explicit cancellation remains resumable. No holdout threshold was weakened and no champion was fabricated.
The paired updater now boot-tests BOTH archives, validates current Lab provenance instead of a hard-coded obsolete version, waits for engine readiness, checks zero-credit policy, and supports noninteractive execution. Paired backup/rollback and real-execution locks remain intact.

## Tests actually run before release
Money Printer OS: npm run test:all - 906 passing test executions across 28 suite commands; zero failures, cancellations, skips or TODOs.
Evolution Lab: npm run test:all - 262 passing test executions across three suite commands; zero failures, cancellations, skips or TODOs.
Additional focused passes: 85 core/research/accounting tests and 17 paired-release/scheduler tests passed. These overlap the full suites and are not added to claim a unique test count.
Edited JavaScript passed syntax checks; the PowerShell paired updater passed parser validation; git diff --check passed in both repositories.
Raw logs: W:/mpo-repair-backups/zero-credit-20260928-0338/mpo-full.log and lab-full.log.

## Boundaries
No paid model calls or real-money orders were used for this repair. Live execution and automatic live promotion remain forbidden.
This is not proof of profitability, a completed long-duration soak, or verification of every external provider account. Missing credentials, provider approval and new forward observations remain real evidence requirements.
Mac installation is not verified while that computer is offline. The Lab has no configured Git remote; do not create a replacement project or claim it was pushed. Signed public updater publication is distinct from the local paired installer and is not claimed by this source record.
