# Resumed recovery - September 28, 2026

Source pair: Money Printer OS 0.5.0-alpha.73 with unchanged Evolution Lab 0.1.0-alpha.14 at 529cc718eae2c4c743345ddf2af05b1f5c25e4c2. Work resumed through Desktop Commander on WITCHDOCTOR after the alpha.72 interruption.
The authoritative installed state is PAIRED-RELEASE.json at both installation roots, written only after build, isolated engine smoke and exact runtime identity/safety checks. This source report is not an installation receipt.

## Recovered checkpoint
The prior alpha.72 trader and alpha.14 Lab were installed and running, the trader source was pushed, and both worktrees were clean. The trading engine was healthy but Command Center risk correctly remained RED / UNKNOWN_LOSS_STATE because mirrored Robinhood practice positions had no liquidation marks. The historical Solana mirror failure was separately visible.

## Repairs
The existing unauthenticated public quote adapter now preserves observed L1 bid/ask size, venue time, receipt time, indicative-auction status and explicit provenance. Future or missing timestamps are no longer quietly relabelled as fresh venue observations.
The practice book preserves those fields. The shared risk governor consumes only fresh observed depth for reconciled practice positions, with conservative configured practice slippage/fee assumptions. It neither calls another provider nor changes cash, trades, positions or history. Depth is shared across positions in the same asset rather than counted twice. Mark writes are deduplicated.
Stale, future, shallow, indicative, unknown-source, changed-book and unreadable-book cases invalidate the affected marks and keep new-risk checks fail-closed. Neither LIVE permission nor ledger safeguards were loosened. The source is explicitly Coinbase public data for a paper simulator, not Robinhood execution evidence.
Real-time practice cycles and manual simulator actions check freshness after the request completes. Explicit clocks remain injectable for deterministic tests, and timestamp-free quotes cannot create simulated fills.
Command Center shows practice-mark readiness and source/cost limitations. Paired release receipts now obtain the machine name from the operating system instead of an environment variable that was absent under Desktop Commander.

## Verification actually performed before packaging
Money Printer OS npm run test:all: 923 passing test executions across 28 commands, zero failures, cancellations, skips or TODOs.
Evolution Lab npm run test:all: 262 passing executions across 3 commands, zero failures, cancellations, skips or TODOs.
Focused mark/feed/practice/risk suite: 23 passed. These overlap the full suites and are not extra unique tests.
A separate isolated reconstruction used a read-only copy of the actual practice book plus unauthenticated public quote GETs. The mirror reconciled exactly, two observed-depth marks were admitted, after-cost valuation became available, and risk was GREEN. The production book and production database were not altered by that check.
Both Git diffs passed whitespace checks; edited JavaScript passed syntax checks; the PowerShell installer passed parser validation.
Evidence directory: W:/mpo-repair-backups/resume-20260928-0440/. Includes full test logs, the isolated mark check, a pre-change paper-state copy, a practice-book copy and a consistent SQLite backup.

## Remaining evidence / external boundaries
The old Solana book lacks a complete sequence of successful partial-exit postings. Current source cash arithmetic balances, but the historical unified mirror cannot be reconciled safely from those incomplete records. Its warning remains; no events were guessed and no balancing deposit was fabricated. New cash-posting receipts introduced in alpha.72 retain evidence prospectively, without pretending old positions have complete coverage.
No paid model calls or real orders were used. Signed updater publication, a full 24-hour observation window and Mac installation are not established by passing source tests. The Lab has no configured Git remote, and a connected GitHub search found no matching evolution repository under m3-jake; no replacement repository was created. Its local committed source and Git backup remain preserved.

## Installed follow-up and final source regression pass
The installed check found a real clock edge case: a public quote carried a venue timestamp 476 milliseconds ahead of local receipt. The raw future-at-receipt label had remained a permanent veto even after real time caught up. Eligibility now requires both the unmodified venue timestamp and receipt timestamp to be reached and independently within the existing freshness limit. Old receipts cannot be rejuvenated by a future venue timestamp. Symbol identity is also explicitly bound. The stale-data allowance was not increased.
Browser inspection confirmed Market Lab lives inside Command Center, but found its initial Working indicator never cleared after the response because the final busy-state change did not redraw. The redraw is repaired, offline initial-load retries have a 30-second cooldown, and HTTP requests have bounded deadlines. Tests cover initial success, offline recovery, no render-driven retry storm and the clock edge cases.
The final full Money Printer OS source suite passed 927 executions across 28 commands, with zero failures, cancellations, skips or TODOs. Lab source is unchanged from its passing 262-execution run. Final MPO log: W:/mpo-repair-backups/resume-20260928-0440/mpo-final.log. Earlier source counts in this report are checkpoints rather than additive unique tests.
The installed alpha.73 Command Center retained the lazy detail layout at approximately 471 DOM elements and 22 rows by default, compared with 1,644 elements and 104 rows before consolidation. Opening ledger detail rendered its 31 rows on demand and displayed SOL units correctly. These are DOM-size observations, not a claimed frame-rate benchmark.
A subsequent paired build must use the follow-up commit, not the earlier 4a84c62 checkpoint. Both receipt files and archived-engine checks remain the runtime acceptance authority.
