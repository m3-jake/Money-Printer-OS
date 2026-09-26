# Prompt: point Money Printer OS at profit and make the Evolution Lab improve it unattended

Paste everything below the line into a fresh Claude Code session opened in `W:\money-printer-os`.
It is written to run as bounded batches. Say CONTINUE between batches.

---

You are working on two sibling repos on this Windows machine:

- **Trader:** `W:\money-printer-os` (Money Printer OS, installed as 0.5.0-alpha.58, running on port 8792).
- **Lab:** `W:\money-printer-evolution-lab` (Evolution Lab 0.1.0-alpha.5, running on port 8793, branch `codex/lab-evidence-20260925`).

## Goal

Get to a state where the owner can leave both apps running for weeks and the trader's **paper** books get measurably better by themselves, with no human in the loop for paper, while anything involving real money stays manual forever.

"Better" means these numbers, per module, move the right way and are visible in one place:

| Module | Optimise | Must never degrade |
| --- | --- | --- |
| Robinhood | paper profit factor and net P/L after fees at the running params hash (30 d); closes per day | Robinhood-sourced quote share of the tape (floor 90 %); order POSTs (ceiling 0); max paper drawdown |
| Solana | FAIR expectancy after measured cost; hit rate vs the 50.5 % break-even with a 95 % interval | cost-gate refusals stay on; engine stays on BASE unless an honest champion exists |
| Polymarket US | settled shadow combos per window; calibration rows | no combo features are built (parked); public data only |
| Lab | deflated held-out t-stat of any published champion; sealed lift vs what the trader actually runs | trials per sealed window (ceiling); Lab CPU while nothing is promotable (ceiling) |
| System | test pass count, health checks green, disk free, self-report age | — |

Be honest in every report. A self-improving loop can only find an edge that exists. If the numbers say a module has no edge after costs, the correct output is **PARK**, and the loop must be able to reach that verdict on its own.

## Session rules (read before touching anything)

1. Read `MONEY_PRINTER_STATUS.md` first. Batches 1-26 are there. Do not re-inventory the repos.
2. Work in batches of 3-5 related items. After each batch: run `npm run test:all` in every repo you touched, commit, append a batch entry to `MONEY_PRINTER_STATUS.md`, then **STOP** until the owner says CONTINUE.
3. Baselines: trader **609 pass / 0 fail**, Lab **163 / 163**. Counts may only go up.
4. Both repos are LF. Edit with node or the Edit tool, never Python (it rewrites LF as CRLF on this box).
5. **Never** start the Lab, `npm run dev`, `lab:once`, the collector, or the trader from this session. Claude-desktop processes see a stale Sep-20 MSIX copy of the Lab data dir and would write into it. Read live state only with `curl http://127.0.0.1:8792/api/...` and `curl http://127.0.0.1:8793/api/...`. Never write into `%APPDATA%`.
6. Builds, installs, signing, keys, and anything on the MacBook are **owner-only** ("bing"). Code reaches the running apps only after the owner installs.

## Permanent invariants (every batch must keep these true)

- Paper only. `liveExecution:'manual'`, `liveActivationAllowed:false`, `automaticLivePromotionAllowed:false` in every record on both sides. No real-money execution, no Robinhood real autopilot, `ROBINHOOD_REAL_ENABLED` untouched.
- The Robinhood key signs GET quote and account reads only.
- Gates are only ever tightened: `learner.js` `evolutionChampionPolicy`, `edgeGate` `productionLearningUnlocked:false`, Lab `PROMOTION_GATES`, `holdoutGate`, `qualificationThresholds`, the Solana cost gate, the Robinhood vol gate.
- The Lab never writes trader parameters. It publishes proposals under `lab-link/`; the trader decides and records the decision.
- Every Solana champion the Lab publishes carries stage `RESEARCH_ONLY` and `paperPromotionAllowed:false` until an executable-price replay exists. This is also what keeps the MacBook alpha.53 trader on BASE.
- Polymarket combo features stay parked (403 `betaNotEnabled`). `polymarket-combo` stays out of `MPO_LAB_MODULES`. The public evidence tick keeps running.
- The research evidence gate stays unwired from the live app.
- Every state write is tmp + fsync + rename; every NDJSON reader tolerates torn or NUL tails. Every file has a byte cap.
- No observed payload is fabricated. Reports cite the file:line or API field.

## Where things stand (2026-09-26, verified)

- **Robinhood tape is stale and 0 % Robinhood-sourced.** The key works since today, but live v2 quotes cross by about 1.5 bps and stamp about 1.1 s ahead of this PC, so `fresh()` rejects them and the tick halts. The fix landed in commit 9ef08a9 and ships in alpha.59 (216d000); confirm it is installed before Batch B. Tape per symbol: ~750 `coinbase-candles` (synthetic, zero spread), ~710 `coinbase-public-paper`, 0 `robinhood`, span 0.26 days. The Lab's Robinhood lane scores every candidate 0.
- **Robinhood vol gate is binding.** BTC expected move 0.45 % vs required 2.7 % (cost C = 2 × 0.85 % fee + spread + 2 × slip, times `costMultiple` 1.5).
- **Solana is still on SPRINT** because the owner never clicked FAIR. The cost gate has refused 92,132 entries, so there are no new paper fills, which are the only executable-cost evidence. The learner still samples outcomes, so the Lab's feed is intact but mark-only.
- **The Lab's Solana search fits phantom marks.** `evolutionScoring.js` applies a flat 0.35 % friction and clamps returns to [-stop, +take] as if stops filled perfectly. The champion sits at the search edges (stop 1.5, take 100, hold 2) with "1006×" on heldOutN 34 after 1.27 billion trials. The Lab reports a Bonferroni alpha of 3.9e-11 and ignores it. Challengers are compared to the Lab's own BASE, not what the trader runs. Champion metrics are never re-scored. BEAST runs 24 workers at 95 % CPU plus GPU on a box with six power-loss resets.
- **Polymarket:** CLOB sandbox lane is NO_EDGE. US evidence has 99 legs tracked and 0 settled shadow combos per window.
- **Nothing closes the loop.** No Lab output changes any paper trade. Nothing tells the Lab whether a proposal held up in paper.

## Work plan, in order

Each item lists where to change and how to prove it. Adjust file details after reading the code; keep the acceptance criteria.

### Batch A: stop the bleeding and make evidence flow

1. **Confirm the Robinhood quote fix is live.** It is committed (9ef08a9, alpha.59). Add the two missing tests if absent: a 6 bps cross stays crossed so `fresh()` still rejects it, and a v2 quote reaches `bufferTape` with `src:'robinhood'`. Done when, after the owner installs alpha.59, `/api/robinhood` shows `readiness.paperQuoteSource === 'robinhood'` and tape age under 60 s.
2. **Paper-only SPRINT auto-demote.** In `src/index.js`, at cycle start in paper mode, if the active profile's tp1 fails the cost gate at the baseline round trip, switch to FAIR through the same path as the `profile` action and journal it. Never promote back to SPRINT automatically. Test in `tests/solana-fair.test.mjs`. After install, `runtime.profile === 'FAIR'` and `costGate` skips stop climbing.
3. **Outbound audit for Robinhood.** Per-process counters in `rhGet`/`rhPost`, exported as `rhCallStats()` and shown in the snapshot. `rhPost` refuses any path outside the orders endpoints. Test that a paper tick makes zero POSTs.
4. **Pin the champion gates with tests** in `tests/lab-link.test.mjs`: a PAPER_CANARY champion with `paperPromotionAllowed:false` gives a null policy; a missing field gives null; mismatched `labNodeId` gives null; a stale bridge status is disconnected.
5. **Surface the kill switches** read-only: `switches` in trader `/api/health` (labLink, robinhoodAutostart, paperOnlyBuild, realEnabled, sessionArmed) and Lab `/api/health` (paused, beast, gpu, workers, modulesActive, bridge).

### Batch B: measure before searching

1. **Robinhood vol-gate ratio.** Over the last 7 days of `src==='robinhood'` rows per symbol: p50/p95 expected move, median spread, C, required move, and `ratio = p95 expected / required`. Serve it at `/api/robinhood` `evolve.volGate` and mirror it into the Lab's Robinhood blockers.
2. **Synthetic rows can't make money.** In the trader's and the Lab's `robinhoodEvolve.js` / `robinhoodBacktest.js`, give non-Robinhood rows the trailing median Robinhood spread (floor: `maxSpreadBps`) or drop candle rows. Report `rowsSynthetic`/`syntheticShare`. Test: the same mid path tagged `coinbase-candles` never beats it tagged `robinhood` with real spread.
3. **FAIR expectancy.** Extend `solanaBookView()` in `src/solanaEconomics.js` with closes, hit rate, Wilson 95 % interval, realised round trip from fills, and expectancy = p·tp1 − (1−p)·stop − C. Publish in `/api/state` and in `trader-status.json`.
4. **Polymarket shadow summary.** `polymarketFitness()` in `src/polymarketUSEvidence.js`: settled and open per window, hit rate, P/L, calibration rows.
5. **Stop the Polymarket CLOB worker.** Default Lab `MPO_LAB_MODULES` to `robinhood`. Keep the code.

### Batch C: one fitness ledger both apps read

1. **`src/fitnessLedger.js`** in the trader, written atomically at the trader-status cadence to `<data>/lab-link/fitness/<module>.json` (schema `mpo.fitness-ledger.v1`) and served at `GET /api/fitness`. Per module: `running` (params hash or champion id, params, since, source BASE/operator/lab-auto), `paperRecord` (closes, hit rate, PF, net P/L after cost, max drawdown, window), `evidence` (span days, quote-source shares, synthetic share, executable prices yes/no), `proposal` (id, stage, basis, published at), `trial` (status, closes so far), `lastDecision` (applied/reverted/adopted/refused + reason + at), `verdict` (KEEP_RESEARCHING / BLOCKED / PARK) and `blockers`.
2. **Evidence flags gate.** One `laneMayPropose(evidence, thresholds)` in the Lab's new `src/evidenceFlags.js`, copied verbatim to the trader. Defaults: executable prices required, ≥ 7 days, ≥ 20 closes, ≥ 90 % venue-sourced quotes. `publishModuleChampion` refuses `paperPromotionAllowed:true` without it, and the trader re-checks it before any apply.
3. **The Lab reads the ledger.** `labFeed.js` and `moduleResearch.js` read `fitness/*.json` and show its blockers in module status.

### Batch D: make the Lab honest before it gets any authority

1. **Freeze Solana exits.** While `evidence.executablePrices !== true`, `mutate()`, `globalVariant` and `crossoverVariant` keep `stopPct`/`takePct`/`maxHoldMin` at the trader's running FAIR preset (8 / 12 / 90). Feed friction from the trader's baseline round trip (about 2.2 %) instead of 0.35 %. Status shows `exitSearch:'FROZEN'`.
2. **The incumbent is what the trader runs.** Add `runningPolicy` to `traderStatusRecord`. The Lab scores an `MPO-RUNNING` variant every generation, and `promotionImproves` must beat it too. Re-score the champion every generation and demote it when its re-scored held-out result falls below the incumbent's.
3. **Multiple-testing discipline.** `promotionImproves` requires a held-out t-stat above the normal quantile for alpha = 0.05 / trials, and `minHeldOutN ≥ 200` for Solana. Add a trial budget per sealed window (`maxTrialsPerSealedWindow`); when spent, status reads `BUDGET_SPENT` until new sealed rows arrive. Expose `requiredT` and `deflatedSharpe`.
4. **Throttle compute when nothing is promotable.** If no lane has executable-price evidence, drop BEAST/GPU to a single CPU worker with a 5 min rest and cap CPU at 50 %. After two unclean boots in 7 days (record `lab-run.json` with `cleanExitAt`), cap CPU at 50 % and disable GPU. An explicit env override restores BEAST.
5. **Pause means pause.** `moduleResearch.js` honours `lab-control.json` `paused` and publishes `PAUSED` without retracting a sticky proposal.

### Batch E: close the Robinhood loop (paper only)

1. **Sticky, versioned proposals.** `publishModuleChampion` adds `proposalVersion`, `supersedes` and `basis` (incumbent hash, trader-since, holdout-through, trials). It replaces a proposal only when the basis changed, the standing proposal's trial concluded, or a new candidate beats it on fresh sealed data. Apply the same to Solana `champion.json` so it stops flipping on every promotion.
2. **Bounded auto-apply to paper.** `labProposalPass()` in `src/robinhoodAutoTrader.js`, run from `tick()`, gated by `ROBINHOOD_LAB_AUTO_APPLY_PAPER` (**default false**; the owner flips it to true once, after reading the first proposal). It applies only when the proposal is PAPER_REVIEW, passes `laneMayPropose`, is within `EVOLVE_BOUNDS`, its basis hash equals the current paper hash, and the hash was never reverted. It goes through `setRobinhoodPaperAutopilot({params})` only. It snapshots the incumbent's params and record, and starts a trial. One trial at a time.
3. **No-regression revert.** After 20 new paper closes at the candidate hash, keep it only if PF ≥ the incumbent's PF and drawdown stays within 3 % of the paper start. Otherwise revert to the incumbent params and mark the hash rejected. Revert as well if the trial produces no close in 14 days. Record every decision in the fitness ledger and the evolve ledger (`applied.by:'lab-auto'`).
4. **Feed the outcome back.** The Lab reads the trial result from the fitness ledger. While a trial runs, it publishes nothing and shows `PAPER_TRIAL n/20`. A new proposal must beat the **applied** incumbent's paper record on data sealed after the last decision.
5. **Solana stays research-only** through all of this. Its path to paper opens only after a collector-side Jupiter quote tape exists (Batch F item 5) and a separate owner decision.

### Batch F: run for weeks unattended

1. **Raw tape retention.** `pruneRawTapes()` in `src/researchCollector.js`, hourly: drop day files older than 45 days, then oldest first over a byte budget. Never touch today's or yesterday's file. Exempt `polymarket-us-*` until the shadow has 20 settled combos per window. Report sizes in `research-capture-status.json`.
2. **fsync everywhere.** `writeFileAtomicSync()` in `src/atomicRename.js`, then switch `labLink.writeJsonAtomic`, the Robinhood tape compaction, journal and evolve writers, and the Polymarket writers to it. Tests for a NUL tmp never replacing a target.
3. **Health for an empty room.** `npm run health -- --json` gains `lab.health`, `lab.generation` (RED if it stops advancing while RUNNING), `lab.modules`, `disk`, `research raw`, `switches`, and `robinhood.orderPosts` (RED if above 0). Exit 1 on any RED.
4. **Daily self-report.** `src/selfReport.js` writes `<data>/reports/self/<date>.json` and `.md`: fitness delta per module vs yesterday, decisions taken, verdicts, blockers, resource use, health. Serve the latest at `/api/self-report/latest`. This is the file the owner reads instead of opening either app.
5. **Solana executable prices.** A rate-limited Jupiter quote sampler in the collector for pending learner mints and open positions (fixed notional both directions), writing `raw/jupiter-quotes-<date>.ndjson`. This is the only way the Solana lane can ever leave research-only.
6. **Agent preflight and runbook.** `scripts/agent-preflight.mjs` detects the MSIX overlay (on-disk status older than the live API) and refuses to proceed. `docs/RUNBOOK-UNATTENDED.md` lists the read-only APIs, the never-start list, the kill switches, and rollback.

## Park rules the loop applies by itself

- **Robinhood Donchian family:** after 7 full days of ≥ 90 % Robinhood rows, if the vol-gate ratio is below 1 on every symbol, verdict PARK. Keep collecting tape; stop searching that family.
- **Robinhood candidate:** reverted twice in a row on the same basis → the Lab stops proposing until 7 new days of tape.
- **Solana FAIR:** after 100 FAIR closes, if the upper 95 % bound of the hit rate is below the measured break-even, verdict PARK and the Lab's Solana lane stays throttled.
- **Polymarket:** no search of any kind until every strategy window has ≥ 20 settled shadow combos.
- **Lab compute:** while every lane is PARK or BLOCKED, the Lab runs throttled.

## Owner-only actions (list them in each batch report when relevant)

1. Install each new build of the trader and the Lab.
2. Click FAIR now, or wait for the Batch A auto-demote to arrive with the next install.
3. MacBook: install alpha.58 or later there, or remove its bridge key. It still shows PAPER_CANARY from before Lab alpha.5.
4. Flip `ROBINHOOD_LAB_AUTO_APPLY_PAPER=true` after reading the first Lab proposal.
5. Schedule `npm run health -- --json` and the collector at logon. Look into the six power-loss resets.

## Definition of done for the whole plan

- `/api/fitness` shows all three modules with a verdict and blockers, and matches `/api/robinhood`, `/api/state` and `/api/polymarket-us/evidence`.
- The Robinhood tape is ≥ 90 % Robinhood-sourced and at least 7 days long.
- At least one Lab proposal has gone through apply → trial → keep or revert with no human action, and the Lab's next proposal was measured against the result.
- The Lab runs throttled while nothing is promotable, and its published Solana champion is RESEARCH_ONLY with frozen exits and a deflated t-stat.
- A self-report exists for each of the last 7 days, and `npm run health -- --json` has been green for 7 days.
- Trader and Lab test counts are above their baselines, and every invariant above still holds.

Start with Batch A.
