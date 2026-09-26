# What to do next with the Evolution Lab data (2026-09-25, evening)

Written after reading the Lab's `evolution-loop.json`, `research-evidence-monitor.json`,
`experiment-registry.json`, the trader's `edge-proof.json`, `research-capture-status.json`
and the trade journal (`market.ndjson*`). Nothing here was executed against the data.

## 1. What the data actually says

| Store | Size / state | Honest reading |
|---|---|---|
| Solana research tape (`research-evidence/raw`, 1.07 M rows, 1.6 GB total raw) | coverage flags `bidAsk`, `depth`, `costs`, `executionLatency` are ALL false | The tape has marks but no executable prices. Every Solana "profit" the Lab scores is a mark-to-mark number, never a fill. `edge-proof.json` is `INCONCLUSIVE` and will stay that way on this tape. |
| Lab loop (`evolution-loop.json`, gen 53 653, 1.16 B variants; the stale 09-21 copy reached gen 120 602) | champion `CROSS-G53565-142`: threshold 65, stop 1.5 %, take 100 %, hold 2 min, "compounded x5484", +23 % per walk, held-out n = 64, 147 samples | Impossible numbers on a tiny sample = the scorer is fitting phantom marks. The whole champion family converged on `freshness` weight 0.3-0.5 with 2-minute holds, i.e. "buy the newest thing and mark it up" — exactly the 09-21 pattern (five +150-930 % two-minute "wins" carried the day). The loop file was also NUL-corrupted on 09-22 and restarted from an older copy, so 67 000 generations of history are gone. |
| Polymarket tape | coverage `depth` true, `costs` true; `latency`, `sharedCapital` false; full days only 09-17 and 09-21 | The only tape with real prices and fees. The 288-config book-reversion family loses on both days. That is a real result, not noise. |
| Experiment registry (113 experiments) / evidence monitor | `livePromotionAllowed: false` | The gates are doing their job. |
| Trade journal (09-17 → 09-25) | 1 147 closes, median trade negative every day, 447 of 985 closes on 09-21 were `stale-purge` | Confirms the above from the execution side. |

Conclusion: the Lab's compute has been spent optimising a scoring function against data
that cannot tell a fill from a mark. More generations will not change that. The data is
still valuable; it just answers different questions than "which weights win".

## 2. Best use, in order

1. **Stop the Solana furnace and keep it stopped** (it burned ~15 CPU-minutes in the ten
   minutes it was open tonight, and the machine has six power-loss resets). Set `paused` in
   `lab-control.json` or leave the Lab closed; the lab-link is not needed while nothing
   is promotable.
2. **Turn the Solana tape into a mark-integrity audit, not a strategy search.** Replay the
   09-21 journal through `executableReplayEvaluator` and classify every close by
   "would this price have been fillable" (spread, depth, tick-band). Publish the share of
   PnL that survives. That single number decides whether the meme lane deserves any more
   compute. (Today's guards — `TICK_BAND_MAX_RATIO`, `paperSizingEquity` — were written
   from suspicion; this makes it measured.)
3. **Fix the capture before any new Solana search:** the collector must record Jupiter
   quote bid/ask, route depth and quote latency so the four coverage flags can go true.
   Until they do, the evidence gate is correct to refuse, and the Lab should not run on Solana.
4. **Point the Lab at the tape that has real prices: Polymarket.** Bank a full day every
   day unattended (the standalone collector runbook in `NEXT-STEPS-2026-09-25.md`), then
   test NEW families rather than re-gridding the loser: fee-free NFL-only markets,
   maker/limit posting (needs a queue model), short-via-complement. This is design work
   with cheap evaluation (seconds per search), not GPU work.
5. **Give the Lab a second, honest customer: the Robinhood crypto lane.** Robinhood's
   API returns true bid/ask and the fee ratio on every quote, so the new durable
   `robinhood-tape/` store (45 days per symbol) is the first dataset in the house where a
   walk-forward search is evaluated on executable prices. The trader now runs its own
   paper-only evolution loop on it (`src/robinhoodEvolve.js`); when the Lab moves off
   Solana, this is the tape to feed its scorer, with the same promotion posture
   (paper first, qualification before real, never auto-live).
6. **Data hygiene that costs nothing:** write loop/state files atomically (`.tmp` + rename,
   as the trader already does), keep the 09-21 loop copy as the archive of record, run
   `polymarket-tape-profile` on each closed UTC day, and prune the 16 MB rotated lab
   journal with NUL tails.

## 3. What NOT to do

- Do not loosen `learner.js`'s `paperPromotionAllowed` gate or the tick-band guard to
  bring back the 09-21 numbers. They were not edge.
- Do not resume the hourly `MoneyPrinterReplayWorkhorse` task; it reproduces `qualified: 0`
  on n = 13 trades every hour.
- Do not read the Lab's `compoundedMultiple` / `walkAvgPct` as money until step 2 has run.
