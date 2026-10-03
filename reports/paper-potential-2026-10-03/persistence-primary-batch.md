# Missing-primary preservation guard

`assertPaperPrimaryAvailable(file)` refuses a missing primary when an initialization marker or verified checkpoint exists. `markPaperInitialized(file)` creates immutable once-only `.initialized.json` evidence using exclusive creation; it never restores a primary or refunds capital. Intact books are grandfathered only after successful validation. Generic paper store initialization, reads and existing verified-checkpoint behavior use this evidence.

BotFarm and Kalshi paper bots now guard custom reads and saves, validate finite nonnegative capital and real positive open quantities/costs/fees, and stop on malformed exposures or missing initialized primaries. Recovery snapshots do not advertise newly funded cash. Typed reset archives existing primary bytes before creating the explicitly requested new cohort; missing-primary recovery is not disguised as reset. Settled and observed journals no longer truncate new durable evidence. Prior records already trimmed cannot be reconstructed.

Tests: paper bots, lifecycle and scoreboard suites 46/46, including missing-file refusal, immutable marker, malformed exposure byte preservation and archived explicit reset. All fixtures in temporary directories. Parent/copy agent integrate helpers into the remaining custom loaders.
