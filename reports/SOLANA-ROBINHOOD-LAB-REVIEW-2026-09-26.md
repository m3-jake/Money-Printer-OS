# Solana, Robinhood and the trader/Lab split: strategy review (2026-09-26)

This is a read-only review. No code was changed, no signed calls were made, and the live data dir and the Lab repo were only read (the Lab tree was clean at `c41d331`). The numbers come from `%APPDATA%\Money Printer OS\data` as of 00:52 local on 09-26.

## 1. What each one is today

**Solana trader.** It paper-trades Solana memecoins, mostly `pump` mints, found through DexScreener and GeckoTerminal (`src/dexscreener.js:9-10`).
- `analyze()` (`src/strategy.js:5`) combines liquidity, momentum, flow, activity and attention into an edge score.
- In SPRINT mode, a trade also needs liquidity ≥ $15k, simulated slippage ≤ 250 bps and failure odds ≤ 40% (`src/index.js:160-170`).
- The active preset is `sprint` (`src/runtime.js:7`): take-profit 4% (sells 100%, `index.js:368`), stop 5%, trail 5%, max hold 25 min.
- Paper costs: 25 bps fee plus 80 bps of slippage plus a size/liquidity impact term, charged on both legs (`src/config.js:42-61`, `src/positionExecution.js:4-11`).
- Real swaps would go through Jupiter with 300 bps max slippage (`src/jupiter.js:18`). The code has no priority-fee or platform-fee parameter.

**Robinhood.** It paper-trades BTC, ETH and SOL against USD with a volatility-gated Donchian breakout: EMA 12/48, take 4×C, stop 1×C, trail, max hold 240 min (`src/robinhoodStrategy.js:9-14, 237-273`).
- C is the round-trip cost: C = 2×fee + spread + 2×slip (`robinhoodStrategy.js:79-83`). The fee falls back to 0.85% per side (`robinhoodAutoTrader.js:69`).
- Without credentials, paper quotes come from **Coinbase's public order book** (`src/robinhoodPaperFeed.js:4`), not from Robinhood's own quotes.
- Evolve runs mutation search (24 candidates, 12 keys, 70/30 walk-forward split) inside the engine. The loop tick triggers it every 6 h (`robinhoodAutoTrader.js:548`).

## 2. Profit reality

| Metric | Solana paper (SPRINT) | Robinhood paper |
| --- | --- | --- |
| Closed trades | 124 (full book; history isn't capped) | **0** |
| Window | 09-26 00:01Z to 04:51Z (4.8 h) | Tape: 21 rows per symbol, **about 5 min** |
| Hit rate | 44.4% (55 take-profit, 64 stop, 5 stale) | unknown, needs tape |
| Net P/L | **−0.0845 SOL** on 0.059 SOL average size, about **−1.15% per trade** | 0 |
| Profit factor | **0.85** | unknown |
| Max drawdown | −0.216 SOL | unknown |
| Modeled round-trip cost | 0.5% fee + about 2.0% slippage (84 bps entry, 115 bps exit) = **about 2.5%** | 1.70% fee + spread + 0.10% = **≥ 1.85%** |
| Costs not modeled | priority fees; pool/LP fee vs the DexScreener price (unknown, needs a Jupiter quote vs mid comparison) | Robinhood's real spread (the paper tape is Coinbase's) and the real `fee_ratio` tier |
| Break-even hit rate | take-profit +4% and stop −5% with 2.5% cost gives about **+1.5% / −7.5%**, so **about 83% needed** | 40% by design (§7) |

**Solana verdict: park it.** The SPRINT exits guarantee a loss: the take-profit is smaller than two round-trip costs. Even before the 25 bps fees, the book is −0.048 SOL after modeled slippage. This matches the 09-25 furnace verdict: 1.4 B variants, none admissible, and all six evidence-coverage flags false. A believable path would need wider targets (runner preset) *and* real Jupiter quotes to measure the unmodeled costs. That is research on a venue whose costs are about 2.5% per trade. It isn't worth an hour before Robinhood has data.

**Robinhood verdict: no evidence either way.** With 5 minutes of tape and zero trades, none of these numbers can be computed.

**Is 3 days of tape plus a 6-hour evolve enough? No, it's overfitting by construction:**
- With the defaults, a 4 h horizon and a 1.5×C ≥ 2.8% volatility gate, BTC enters rarely. The 30% test slice of a 3-day tape is about 0.9 days, which gives an expected 0 to 3 test closes. The score is scaled by closes/20, so the ranking is noise.
- The "test" slice is the newest 30%, and every generation sees it again. After generation 1 it is effectively in-sample.
- An incumbent that scores 0 is beaten by any positive score (§22.3), so the first lucky mutation gets promoted.
- 24 candidates per generation, compounding across generations, with no multiple-testing correction.
- The Coinbase spread understates Robinhood's, so every backtest is cost-optimistic.

**Missing before real money could ever be considered.** This is a list only; enabling real money is not proposed.
1. At least 45 days of tape across at least 2 volatility regimes, using Robinhood's own quotes (read-only).
2. A sealed final holdout that the search never sees, and at least 100 out-of-sample closes.
3. A score corrected for multiple testing (deflated Sharpe or White's reality check).
4. The measured `fee_ratio` tier and the spread distribution (p50/p90) from Robinhood itself.
5. Paper qualification on a fixed params hash (20 closes, profit factor ≥ 1.3 over 30 days) that is actually achieved.
6. The §17/§18 unknowns resolved: v2 field names, stop exposure during a 429 backoff, jurisdiction, the shared rate limit.
7. An explicit bing decision.

## 3. Could / should / can

Ranked by expected net-of-cost gain per hour of work.

| # | Idea | Expected net impact | Evidence | Effort | Where | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Stop** the Solana SPRINT paper run | Stops about −1.15% per trade of modeled bleed; frees CPU and 9.6 MB state writes | §2 | 5 min, bing | Trader | none |
| 2 | Collect Robinhood tape continuously, **with Robinhood's own quotes** | Makes every later answer possible | 5 min of tape today | 1 h plus bing | Trader | low |
| 3 | `rh-tape-stats`: spread p50/p90 and the share of time the expected move is ≥ 1.5×C | Tells us in about 1 week whether the strategy *can* trade at all | §7 gate math | 2 h | Lab (or CLI) | none |
| 4 | Fix the evolve statistics before it ever runs (sealed holdout, min 30 test closes, no promotion over a 0-scoring incumbent) | Prevents promoting noise | §2 bullets | 3 h | Lab | none |
| 5 | Enter with limit orders at the bid instead of market orders at the ask | Saves about half the spread per entry; the fee is the same for market and limit (§8) | doc §8 | 2 h paper model | Trader | fill risk |
| 6 | Fewer, better trades: raise `costMultiple` and the horizon instead of searching 12 keys | Cuts cost drag; each trade already pays at least 1.85% | §7 | param only | Lab | fewer samples |
| 7 | **Stop** in-process evolve on the loop tick | CPU and latency only | §4 | 30 min | Trader | none |
| 8 | Sizing and Kelly work | 0 until there is an edge | — | — | — | — |
| 9 | **Stop** mining Solana variants (BEAST) | Saves power and crashes | 09-25 report §2.6 | 0 | Lab | none |

## 4. Weight audit

The idle CPU/RSS measurement was **skipped**. Booting the engine loads `.env`, and with credentials present the Robinhood loop would make signed quote calls, which this review isn't allowed to do. That needs a run with `ROBINHOOD_AUTOSTART=false` and a credential-free env.

| Component | Lines | Runs | Cost | Verdict |
| --- | --- | --- | --- | --- |
| `robinhoodEvolve` + `robinhoodBacktest` | 153 + 62 | Runtime: tick `finally` (`robinhoodAutoTrader.js:548`), every 6 h | Up to 20 s of CPU on the engine event loop; each candidate replays synchronously (14 d × 3 symbols × 720-sample windows) | **Move to Lab** (the trader keeps only the strategy and the champion apply) |
| `hypothesisMiner` via `alphaWorkerManager` | 113 | Runtime: forked child (`index.js:655`, `alphaWorker.js:34`), at most every 120 s | One extra Node process (about 40-60 MB RSS) | **Move to Lab** |
| `research` blob in `state.json` | — | Runtime: rewritten on every save | **7.0 MB of the 9.6 MB** `state.json` | **Keep** the labels, cap them, and move them to their own file feeding lab-link |
| `tickHistory` in state | — | Runtime | 1.9 MB, bounded (`store.js:217-220`) | Keep |
| `replayLab` | 271 | CLI `replay` | n/a | **Move to Lab** |
| `polymarketResearchEval` | 916 | CLI | n/a | **Move to Lab** (the Lab already owns Polymarket research) |
| `executableReplayEvaluator` + `Adapter` | 842 | Tests only | n/a | **Move to Lab** |
| `alphaLab` | 126 | Only `selftest.js:4` | n/a | **Delete** (and edit the selftest) |
| `researchControlPlane` | 287 | Runtime: HUD reads (`dashboard.js:62, 184, 301`) | Small | Keep |
| `@solana/web3.js` | 15 MB | Runtime | Load time | Keep; lazy-load it once Solana is parked |
| `public/dashboard.html` | 129 KB | HUD | Trivial | Keep |

**Target trader footprint.** Three processes: engine, mesh and collector. No forked workers, no in-process search, `state.json` under 2 MB, and the Robinhood tick doing quotes, tape and paper pass only.

## 5. Lab-link proposal (smallest extension)

The design is pull, not push: the trader only writes **bounded, sealed files** and never touches `actions.ndjson`. Everything uses tmp, fsync and rename via `src/atomicRename.js`.

**Tape segments (trader → Lab).**
- Today's open file: `<data>/lab-link/tape/<venue>/<SYMBOL>/<YYYY-MM-DD>.ndjson`.
- It is sealed at 00:00Z by renaming it to `.sealed.ndjson`, and rolled into `-partN` above 16 MB.
- The existing Robinhood tape and the collector's Solana raw ticks are what gets sealed.

```json
{"schema":"mpo.lab-tape-manifest.v1","node":"witchdoctor","at":1790400000000,
 "quotaBytes":1073741824,"usedBytes":81234567,
 "segments":[{"venue":"robinhood","symbol":"BTC-USD","day":"2026-09-26","part":0,
   "rows":5760,"bytes":301234,"sha256":"…","quoteSource":"robinhood|coinbase-public","sealed":true}]}
```

- The manifest is at most 256 KB and lists 45 days. It is rewritten at most once a minute.
- The bridge copy is signed with HMAC and copies sealed segments only, at most 1 file per minute and at most 64 MB per day.

**Ack (Lab → trader).** The trader deletes a sealed segment only when the Lab has acked it, or after 45 days, or when the 1 GB quota is hit (oldest first, journalled).

```json
{"schema":"mpo.lab-ack.v1","lab":"evolution-lab","at":0,"ingested":["<sha256>","…"]}
```

**Champion (Lab → trader).** This reuses `champion.json` and adds a `family`. It is one file per family, capped at 64 KB, and the trader accepts at most one per hour.

```json
{"schema":"mpo.lab-champion.v1","family":"robinhood-breakout","paramsHash":"b32b46bc9e65",
 "params":{},"evidence":{"tapeFrom":"…","tapeTo":"…","holdoutSealedAt":"…","testCloses":112,
 "testPF":1.41,"deflatedScore":0.0,"quoteSource":"robinhood"},"sig":"hmac…"}
```

- The trader applies it only through `applyRobinhoodEvolution` (paper, propose-only unless `ROBINHOOD_EVOLVE_AUTOPROMOTE`).
- It refuses a champion with `quoteSource ≠ robinhood` or fewer than 100 test closes.

**When the Lab is off or on another machine.** The trader keeps its last applied params and the champion never expires into a revert. Tape keeps sealing under the quota. The HUD shows `NOT LINKED` or `STALE`. The Mac laptop is the same over `MONEY_PRINTER_BRIDGE_DIR`.

**Why the 23 GB failure can't repeat:**
- no queue;
- every file has a byte cap;
- total quota;
- write-rate limits;
- sealed files are immutable;
- the reader caps reads at 8 MB (`labLink.js:23`);
- the Lab ingests by sha256, so duplicates are idempotent.

## 6. Next three batches

**Batch 11: slim the trader (no strategy change)**
1. **bing:** switch the Solana profile off SPRINT and stop it, from the HUD. Done when no new `history` rows appear for 24 h.
2. Default `ROBINHOOD_EVOLVE_ENABLED` to `false`; "Run now" still works.
   - Files: `src/robinhoodEvolve.js`, docs §13/§22.
   - Tests: the Robinhood evolve and auto-trader tests.
   - Done when the tick never calls `runRobinhoodEvolveOnce` under the default env.
3. Put the `alphaWorkerManager` start (`index.js:655`) behind `MPO_ALPHA_WORKER` (default off).
   - Tests: selftest, plus a new supervision assert.
   - Done when a default boot shows 3 Node children.
4. Cap `state.research` (learner outcomes and experiments) and split it into `<data>/learner.json` with atomic writes.
   - Files: `src/learner.js`, `src/store.js`.
   - Tests: selftest and store tests.
   - Done when a copy of the live `state.json` round-trips to under 2 MB.
5. Measure idle CPU/RSS with an isolated data dir, `ROBINHOOD_AUTOSTART=false` and no `.env`. Done when the numbers are recorded in the ledger.

**Batch 12: Robinhood data before search**
1. **bing:** run the Robinhood paper loop continuously with read-only credentials, so the tape comes from Robinhood rather than Coinbase. Done when there are at least 7 days of `robinhood-tape/BTC-USD.ndjson`.
2. Tag every tape row with `src` (`rh` or `cb`) and show the source split in the HUD.
   - Files: `src/robinhoodTape.js`, `src/robinhoodAutoTrader.js`.
   - Tests: the Robinhood tape tests.
   - Done when the rows carry `src`.
3. `scripts/rh-tape-stats.mjs` (read-only CLI): coverage, spread p50/p90, how often the expected move is ≥ 1.5×C, and a projection of trades per day.
   - Tests: a new fixture test.
   - Done when it prints one line per symbol.
4. After 7 days, record in the ledger whether the strategy can trade at all at Robinhood's costs.

**Batch 13: lab-link tape v1 and moving the search out**
1. `src/labLink.js`: `publishTape()` with the manifest, sealing, quota and ack pruning.
   - Tests: new `tests/lab-link-tape.test.mjs` covering caps, atomicity, quota, Lab off and a torn tail.
   - Done when the tests are green and the directory stays at or under quota in the test.
2. Champion `family` routing into `applyRobinhoodEvolution`, with the `quoteSource`/closes refusals. Tests: lab-link and Robinhood HTTP tests.
3. **bing:** schedule a Lab-repo session (after Codex's branch lands) to ingest the tape and port the backtest and evolve with a sealed holdout and a deflated score.
4. Move `replayLab`, `polymarketResearchEval`, `executableReplay*` and the Robinhood evolve to the Lab, and delete `alphaLab`.
   - Tests: the `test:all` count drops by exactly the moved tests.
   - Done when the trader's `src/` has no search, replay or scoring modules.
