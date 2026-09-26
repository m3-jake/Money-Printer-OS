# Evolution Lab audit: does it serve and improve all three modules? (2026-09-26)

Read-only audit of both repos, both installed builds and the live data, run on the morning of 2026-09-26. Eight agents took part: one tracer and one adversarial verifier per module, plus one pair for the stuck window.

- Installed MPO: `app.asar` 0.5.0-alpha.57, source = `a244ffb`. `BUILD-INFO.json` beside it is stale: it still says alpha.56.
- Installed Lab: 0.1.0-alpha.4, source = `290f4bc`.

## Verdict

**Serves: yes. Improves: no.** The Lab is wired to all three modules: it reads their data, runs a research lane for each, publishes files, and MPO shows three lanes. But on this Windows trader, no Lab output changes any paper trade today.

| Module | Feed in | Research | Publishes | MPO uses it | Improves today |
| --- | --- | --- | --- | --- | --- |
| Pump.fun / Solana | yes, fresh (default `MPO_LAB_LINK=true` since `99faef0`) | running (gen ~78k) but scorer can't judge exits | yes, fresh | display only | **PARTIAL** (display only) |
| Robinhood | yes, fresh | running every 5 min, every candidate scores 0 | yes, overwritten every pass | display + gated manual apply, never enabled | **NO** |
| Polymarket US | international CLOB tape, not the US combo venue | scalper grid, gates can't pass | loser champion (-4.3 %) | never read | **NO** |

## The stuck "Starting lab…" window (fixed in Lab `893b6b7`, not installed)

- **Cause.** The Lab keeps running after its window closes. On relaunch, `second-instance` created a new window on the splash, but the module-level `showing` flag was still `true` from the first window. So `monitorTick` never navigated it.
- **Evidence.** A capture of the live window showed the splash while `/api/health` answered 200.
- **Fix.** `showing` now resets on create and close. A reopened window checks health immediately. A renderer crash clears the flag, and `showLab` ignores overlapping loads. `tests/lab-window.test.cjs` fails without the fix.
- **Workaround until installed.** Press Alt, then Evolution Lab > Exit, and relaunch. Or open http://127.0.0.1:8793 in a browser.
  - "Restart lab services" only escapes about 25 % of the time.
  - Reload / Ctrl+R just reload the splash.
- **Not fixed:**
  - The Reload menu item still reloads the `data:` URL; it should `loadURL(BASE)`.
  - `health()` accepts any JSON; it should check `service`.
  - `labServer` has no `listen` error handler.

## Solana (PARTIAL: display only)

1. **High: no route to paper.**
   - The Lab hard-codes `paperPromotionAllowed:false` / `RESEARCH_ONLY` (`labPublish.js:51,101`).
   - MPO requires `true` (`learner.js:18-19`, added by `3d9090d`), so the engine stays on BASE/SPRINT.
   - There is no manual apply for Solana.
   - The evidence gate can't pass either: `evolutionEvidence.js:25` builds bundles with no evaluator and no coverage.
2. **High: the scorer doesn't simulate exits.**
   - Returns are 5-minute close-to-close, clamped to [-stop, +take] as if the stop filled perfectly.
   - `maxHoldMin` only feeds a ×30 "velocity" bonus (`evolutionScoring.js:47,63,97`).
   - So the champion is pinned at the range edges: stop 1.5 (min), take 100 (max), hold 2 (min), "compounded 21,122×".
   - Real MPO 5 % stops filled between -3.7 % and -59.6 %.
3. **High: the old MacBook trader applies champions to paper with no gate.**
   - The MacBook trader (alpha.53, bridge) predates `3d9090d`, so it applies any bridge champion to paper, entries and exits, as PAPER_CANARY.
   - It has been silent 23 h. If it restarts, it will paper-trade the degenerate champion.
4. **Medium: thin, stale data.**
   - MPO keeps 1,500 outcomes, about 600 five-minute rows, roughly 95 min. The Lab keeps no history of its own.
   - 71 % of rows are the MacBook's 23 h-old snapshot, which was selected by an older champion's own score, so the data feeds back into itself.
   - 1.26e9 variants are searched on about 1,800 rows, with no multiple-testing correction used.
5. **Medium: wrong comparison and unused checks.**
   - Challengers are compared against the Lab's own BASE (`evolutionEngine.js:402`), not against the SPRINT policy MPO actually runs.
   - The sealed audit is observational (0.00 pp lift) and gates nothing.
   - Champion metrics are frozen at promotion and never re-scored.

## Robinhood (NO)

1. **High: the holdout can never pass.** It needs ≥ 90 % `src=='robinhood'` rows, and the tape has 0 %. The Robinhood key returns 401 `keyNotFound`, so every live row comes from Coinbase. The module status never names this blocker.
2. **High: the champion never stays put.**
   - `robinhood-champion.json` is overwritten on every 5-minute pass (`moduleResearch.js:118-131`).
   - A PAPER_REVIEW candidate would be replaced by a PROVISIONAL one on the next pass (`holdoutReused`). Apply on the old hash then fails with `notFound`.
3. **Medium: nothing trades.**
   - No point in `EVOLVE_BOUNDS` trades on the current tape at the 0.0085 fallback fee, because `costMultiple` is floored at 1.
   - Every candidate scores 0, so the published "champion" is just the lowest `paramsHash` (a tie-break).
4. **Medium: replay is optimistic.** About 55 % of tape rows are synthetic warm-start candles with zero spread, and the replay can trade on them. `tapeDays` measures first-to-last span, so gaps count toward the 7-day minimum. That minimum is reached around 2026-10-02.
5. **Other points:**
   - Lab gate settings come from the Lab's own env, not MPO's `ROBINHOOD_EVOLVE_*`. Both are on defaults today.
   - The Lab never reads paper outcomes or the exploration book.
   - The "stand-down" of MPO's own evolve suppresses nothing, because `ROBINHOOD_EVOLVE_ENABLED` was already false.

## Polymarket (NO)

1. **High: wrong venue.**
   - The lane reads `research-evidence/raw/polymarket-depth-*.ndjson`. The collector writes it from international `clob.polymarket.com`: top 20 by liquidity, 34 % esports, fee rate 0.05.
   - The module trades Polymarket US RFQ combos.
2. **High: search space doesn't match.** It searches a single-token 60-180 s book-reversion scalper. None of its parameters map to priceMin, maxMinutesLeft, maxLegs, window or rankWeights.
3. **High: nothing reads `lab-link/polymarket-champion.json`.** Not in any MPO commit. The only use is a monitor card that labels the lane "Polymarket US".
4. **High: the gates can't pass by construction.**
   - `coverageFromRun` hard-codes `latency:false` (`polymarketEvaluator.js:441`, pinned by a test).
   - The worker never runs a post-freeze window, so AWAITING_PROSPECTIVE_HOLDOUT never resolves.
   - There is no settlement model, so `SEALED_UNRESOLVED` would also throw.
5. **Medium: publishes a loser.** The champion is published because it beats the -82 % baseline, not cash. It returns -4.3 % net, with 13 wins out of 141.
6. **Low:**
   - The Lab writes `.sha256` sidecars into the trader's raw directory.
   - It researches sliver days (under 10 MB) with no minimum-size check.
7. **In progress (committed during the audit, not installed):** Lab `c65b06a` adds a `polymarket-combo` lane, and MPO `a6c2813` adds a manual apply-lab route plus US legs/RFQ tapes. That lane has no data yet.

## Environment gotcha

Processes started from the Claude desktop app get an MSIX-virtualized **stale copy** of `%APPDATA%\Money Printer Evolution Lab\data`, frozen at generation 53549 from Sep 20. It lives at `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Money Printer Evolution Lab`.

- Read live Lab state through `http://127.0.0.1:8793/api/state` or the trader-side mirror `%APPDATA%\Money Printer OS\data\lab-link\`.
- Never start the Lab or `npm run dev` / `lab:once` from a Claude session: it would resume from Sep 20 state and write into the overlay.
- The trader data directory is not virtualized.

## Suggested order of work

1. Install the Lab window fix. Bump the version first: `893b6b7` shipped without one.
2. Solana:
   - Stop the old-trader hazard: the Lab refuses to publish to the bridge for traders older than `3d9090d`, or the MacBook gets upgraded.
   - Freeze stop/take/hold in the search until exits are simulated.
   - Score MPO's actual SPRINT policy as the incumbent.
3. Robinhood:
   - Make the champion sticky, and publish only when it is paper-ready.
   - Surface the "0 % Robinhood quotes" blocker in the module status.
   - The owner regenerates the Robinhood key.
4. Polymarket: retire or relabel the CLOB lane as "research sandbox" and stop it publishing a champion. Let `polymarket-combo` become the only proposal path once US tape exists.
