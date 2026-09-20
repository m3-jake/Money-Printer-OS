# DATA DECISION MEMO — Money Printer OS alpha.42

**Role:** Architect, read-first evidence audit  
**Worktree:** `20260916-103902-e69ba` @ `4207a70` (`0.5.0-alpha.42`)  
**Inspected:** 2026-09-16 ~15:50 UTC  
**App-data:** `~/Library/Application Support/Money Printer OS/data/` (live, still appending)  
**Constraint honored:** no deployment, no orders, no risk loosening, no secrets, no paid APIs  

**Headline:** Do not promote, arm, or size up. Paper meme trading is a realized loser with a broken bankroll identity. Polymarket “42/42 WON” is early-exit selection, not settlement edge. Research “POSITIVE EVIDENCE” for COLD-regime liquidity is mostly “not a $1 placeholder.” Cluster/evolution scores are synthetic and contradict live paper. Production learning stays locked.

**Integrator note (20260916-104614-4bd03):** §2.5 “Proposal is the bottleneck” is **superseded**. Direct ready-to-proposal `wait_ms` instrumentation (`src/latencyStats.js`, `125126e`) shows `proposal_ms` is source-event-to-proposal (includes discovery); the ~500s mean is outlier-inflated end-to-end, not a proposal-stage queue. Settlement repairs landed from reviewed `ee8077a`/`125126e`, not the original 6h-timeout worker. Research `1d954bc` was not wholesale-merged; see `.agent-state/INTEGRATION_LEDGER.md`.

---

## 1. Claimed evidence vs what the files actually contain

Live files moved during the audit. Values below are the freeze at 2026-09-16 15:50 UTC unless noted.

| Claim | Verdict | Measured |
| --- | --- | --- |
| Meme paper lifetime ≈ −0.402 SOL | **Field matches; identity does not** | `realizedLifetimePnlSol` = **−0.404 SOL**. Marked equity = **0.052 SOL** on `paperStartSol=1`. Start + realized + unreal ≈ **0.596 SOL**. **~0.54 SOL hole.** |
| Latest 1500 closes median return ≈ −1.70% | **Confirmed, slightly better in this freeze** | n=1500 exactly (cap). median `returnPct` = **−1.55%**, mean **−1.22%**, win rate **47.3%**, profit factor **~0.67**, sum PnL of those 1500 = **−0.994 SOL**. |
| Edge proof INCONCLUSIVE | **Confirmed** | `edge-proof.json` status **INCONCLUSIVE**, proofScore **45**, `productionLearningUnlocked=false`. Four blockers still present. |
| Strongest measured lead = COLD liquidity top-quartile | **Lead exists; interpretation is wrong** | Only `POSITIVE EVIDENCE` hypothesis. Insights n=988, Δ≈79%, top median **+1.74%**. Proof `bestAlpha` n=**64**. SQLite COLD 30m: **4767/7348 rows have liquidity ≈ $1**. Q4 median still **−4.2%**. |
| Proposal latency ≈ 500s | **Confirmed as a mean, not a median** | Proof 24h mean `proposal_ms` ≈ **414–468s** (n≈16.2k). SQLite all-time median among finite values ≈ **112s**; mean is pulled by multi-hour/day outliers. Bottleneck label **PROPOSAL** is correct. |
| Polymarket paper 42/42 settled singles, 5 still open | **Confirmed, and biased** | 42/42 `WON`, **all** `settlementSource=early-exit`. `placedCount=47`. Open: **4 singles + 1 combo**, all `missingSince` 13:18 UTC, events dated 2026-09-14/15. Autopilot **off**. |

---

## 2. Trustworthy metrics (use these)

Treat **medians, counts, and cash/equity** as primary. Treat **means, learner “validated”, evolution walk-forward, and 42/42 win rate** as contaminated or censored.

### 2.1 Meme paper (live `state.json`)

| Metric | Value | Notes |
| --- | --- | --- |
| Mode / profile | paper, `SPRINT`, aggression 100, HEALTHY, not paused | Still deploying ~96% of remaining equity |
| Marked equity | **0.052 SOL** (~$5) | `cash + marked positions` |
| Open exposure | 4 positions, ~0.042 SOL remaining, unrealized **−0.0004 SOL** | Ages 0–12 min, `priceStatus=FRESH` in this freeze |
| `realizedLifetimePnlSol` / ledger | **−0.404 SOL**, ledger n=622, ~11h | Ledger is the field the UI calls “lifetime” |
| Last-1500 closes | median **−1.55%**, mean **−1.22%**, 709W / 791L | History is **hard-capped at 1500** (`store.pruneState`) |
| Last-1500 sum PnL | **−0.994 SOL** | **Does not equal** lifetime field |
| Exit mix (1500) | TP1 680 / stop 589 / **stale-purge 215** / BE 16 | 14.3% of recorded exits are stale-purge; those lose (median **−2.18%**) |
| Hold time | median **104s**, mean **505s**, max **11.7h** | SPRINT is not holding for 30m research horizons |
| Simulated friction | entry slip median **80 bps**, exit **81 bps**, sim latency median **180ms** | Execution calibration table is **empty** (n=0) — these are model assumptions, not observed fills |
| Equity path (series n=21600, ~33.8h) | **2.19 → 0.052 SOL** | Series `realizedSol` is **calendar-day PnL**, not lifetime |
| Pre-sprint snapshot (2026-09-14 19:47) | `paperStartSol=10`, cash 0.54, equity **11.38** with +2.91 unrealized | Different bankroll era |
| `state.bad-70sol-*` | equity **71 SOL** on start 10 | Historical impossible-balance artifact; do not use as performance |

**Accounting identity (broken):**

```
paperStartSol (1.000)
+ realizedLifetimePnlSol (−0.404)
+ unrealized (−0.000)
= 0.596  ≠  marked equity 0.052
```

Cash already reflects losses that `realizedLifetimePnlSol` no longer contains. `pnlLedger` begins ~11h ago; `history` is a 1500-row ring; `portfolioSeries` is a 21600-point ring starting at equity 2.19, not at 1.0. Tests in `tests/accounting-integrity.test.mjs` prove the *intended* contract (ledger survives prune). The **live file predates or bypassed** a clean 1 SOL reset: `paperStartSol` was relabeled to 1 without resetting cash/ledger together.

**Survivorship / censoring (meme):**

- Closed-trade stats are **right-truncated** at 1500. Older losses exist in cash but not in `history`.
- 215/1500 closes are `stale-purge` (forced exits, mostly losers).
- Open positions are small and fresh in this freeze; they are **not** the main drag.
- Research outcomes at 5/30/120m are a **different population** than SPRINT holds (median 104s). Comparing them to live paper is a horizon mismatch.

### 2.2 Polymarket paper (`polymarket-paper.json`)

| Metric | Value |
| --- | --- |
| Bankroll | start **$25.23**, cash **$21.28**, Δ cash **−$3.94** |
| Settled | **42 singles, 42 WON, +$2.56 realized**, mean +$0.061, median +$0.047 |
| Settlement source | **42/42 `early-exit`** — not gamma resolution |
| Open | **$6.50** at cost (4×$1 singles + 1×$2.50 combo), all `missingSince` 2026-09-16 13:18 UTC |
| Autopilot | **disabled**; `placedCount=47` = 42 settled + 5 open |
| Void timer | `MISSING_VOID_MS = 48h` — these will not auto-void until ~2026-09-18 13:18 UTC |

Mark-to-cost identity holds: `cash (21.28) + open stake (6.50) ≈ start (25.23) + realized (2.56)`.

**If the five missing positions lose in full:** net vs start ≈ **−$3.94** (cash already).  
**If they void at stake:** net vs start ≈ **+$2.56**.  
**If they win:** slightly above +$2.56.

The 100% settled win rate is **selection**: `tryEarlyExit` books `WON` when bid ≥ 0.99, or game-ended and bid ≥ 0.985, or recycle (bid ≥ 0.975 and ≥1.5% gain). Losers and unresolved games remain `OPEN`. That is classic **censoring of the right tail of losses**. Parallel task `20260916-103902-02a6c` owns the settlement-bias repair.

Stale open legs are 2026-09-14/15 tennis, MLB, and Argentine soccer. They are almost certainly finished; Gamma lookup is returning “missing,” not a resolution. Do not count them as live exposure with current timing (`etaMinutes` 11–15, scores frozen).

### 2.3 Edge proof / alpha-lab.sqlite (read-only)

| Metric | Value | Trust |
| --- | --- | --- |
| Independent 30m mints | 17,951 (proof) / outcomes 30m n=32,128 | Count is real |
| Proof 5/30/120m top median adj | **−15.8% / −40% / −40%** | Trust medians |
| Proof 30m top **mean** adj | −3.7% winsorized; **raw mean +18%** | Raw mean is contaminated |
| Holdout 30m contaminated | **true** (NORMAL); COLD 30m uncontaminated in proof regimes | |
| COLD 30m only positive regime at 30m | delta 76.6, medianDelta 47.8, `positive=true` | See §3 — mostly vs $1 liquidity |
| Outcomes cluster_id | **92,679 / 92,699 NULL** | “Clusters” in proof fall back to **mint** |
| Execution calibration | **0 rows** | Uncalibrated |
| Wallet funding graph | **0 rows** | Cluster-of-wallets unused |
| Learner flag | `MULTI-HORIZON VALIDATED`, 5m avgReturn **+6.3%** | **Do not trust** — uses means vs median 30m **−39%** |

Daily reports contradict each other because robustness landed mid-stream:

- **2026-09-14:** INCONCLUSIVE (93%), delayed-entry averages **+35,000%** (outliers).
- **2026-09-15:** **PROVEN (100%)**, “edge top quartile” lower CI **+3,255%**, recent delta **+94,548%**. This is the pre-winsor / mean-dominated false proof. **Reject.**
- **2026-09-16:** INCONCLUSIVE (45%), next action shadow-test. **This is the current honest gate.**

`src/edgeProof.js` now clamps adj to [−100, +500], winsorizes cluster medians, and requires top **median > 0** plus uncontaminated CI. That correctly killed the 09-15 PROVEN print. It has **not** produced a tradable edge.

### 2.4 COLD liquidity “alpha” — what it actually measures

SQLite `outcomes` 30m COLD (n=7,348):

| Liquidity slice | n | median adj | mean adj | pct positive |
| --- | --- | --- | --- | --- |
| Q1 $1.00–$1.00 | 1,837 | **−40%** | −38% | 2.7% |
| Q2 $1.00–$1.00 | 1,837 | **−40%** | −44% | 2.9% |
| Q3 $1–$21.7k | 1,837 | **−40%** | −24% | 11.1% |
| Q4 $21.7k–$94M | 1,837 | **−4.2%** | +5,209% (outliers) | 20.8% |

**4,767 / 7,348 COLD 30m rows have liquidity ≤ $1.01.** “Top quartile vs rest” is largely **tokens with real pools vs $1 placeholders**. Q4 still has a **negative median**. Insights `topMedianPct=+1.74%` is a small, fragile holdout slice (n_top depends on the hypothesis query; proof lists n=64). This is a **filter against junk**, not an entry signal, and it is not positive after costs on the paper book.

### 2.5 Latency

| Stage | Proof 24h mean | SQLite note |
| --- | --- | --- |
| discovery | ~121–137s | median ~102s |
| analysis | ~2ms | fine |
| ready | ~6–15s mean; median **3ms** | mean ruined by rare huge ready_ms (max 55e6) |
| **proposal** | **~414–468s mean** | median ~112s if <1h; 69 events >1h; 8 events >1 day |

**Superseded bottleneck label:** `proposal_ms` mean is end-to-end (includes discovery) and outlier-inflated. Direct ready-to-proposal wait is the proposal-stage KPI; discovery remains slow versus SPRINT holds of ~100s. The research loop can still be late relative to a ~100s hold, but that is a **discovery/feed** problem, not a proposal-queue problem.

`actions.ndjson` is **not missing data**. `store.drainActions` atomically renames the file; empty directory means no pending dashboard actions.

### 2.6 Experiment lane (Witchdoctor `latest.json`)

- Dataset hash `73afc71cc805…`, version `a4be7b9` (older than deployed `4207a70`).
- **Stable FAST:** n=145, realized **+0.0026 SOL**, median **−2.12%**, PF **1.016**, censored **12**, top-3 concentration **2,482%**, **1/3 splits positive**, final equity 0.979.
- **24 challengers, 0 eligible** (16 no-positive-edge, 5 drawdown, 3 sample-too-small).
- Every **SPRINT*** challenger failed on **drawdown** (PF ~0.34–0.46, DD 29–34%).
- This is a **replay/backtest**, not live paper. FAST “wins” by one whale-shaped concentration, not a median edge.

### 2.7 Cluster evolution (synthetic)

- `cluster/results.ndjson`: 310 jobs, all `ok`.
- Champion `MPO-Gmu49afya-e77a` stage **SHADOW**: walkAvg **+44%**, compounded **1,068×**, n=**73**, maxHold **2 min**, freshness weight **0.80**, stop 1.5% / take 100%.
- `state.shadow.trades` = **[]**. “SHADOW” is a label, not a filled shadow book.
- Datasets (~1,506 files, ~0.99 GB) are **5-minute observation outcomes** (`horizonMin: 5`, `isValidation`, predicted score). They are not execution-sim paper trades and not 30m holdout proof rows.
- Live strategy remains `UNIFIED_EDGE`. Evolution has **not** been promoted to execution. Keep it that way.

---

## 3. Root causes (dependency order)

1. **Bankroll identity is not a closed ledger.** `paperStartSol=1` is a label from `paperSprintMigrationV13` / a later relabel. Cash path never matched that start. History cap 1500 + ledger starting 11h ago makes `realizedLifetimePnlSol` **not reconcilable** with equity. Cancelled task `20260915-213157-46628` named this; the *code* now has a compact ledger, but the *live file* is still inconsistent.
2. **SPRINT on a shrinking paper book is generating the 1500-close sample.** Median −1.55%, PF 0.67, 215 stale-purges. Aggression 100 with 96% capital deployed on ~0.05 SOL is not research; it is recycling a wrecked account.
3. **Research means were (and partly still are) outlier-dominated.** 09-15 “PROVEN 100%” came from raw averages (max raw 30m return 2.8e7%). Winsorization in `bf14fd2` / `e8d5dbe` corrected the gate to INCONCLUSIVE. Learner still advertises MULTI-HORIZON VALIDATED from those means.
4. **Liquidity feature is a placeholder detector in COLD.** $1 liquidity is the mass of the distribution. Quartile splits vs that mass will always look “positive” on delta-vs-rest while remaining unprofitable.
5. **Proposal latency (~minutes) vs SPRINT hold (~seconds).** Even a real 30m alpha cannot be acted on by the current proposal path.
6. **Polymarket paper books winners at early-exit and parks the rest as missing for 48h.** 42/42 is not a sports edge. Open $6.50 is unresolved/stale, not working inventory.
7. **Zero execution calibration and near-zero cluster_id fill** (20/92k). Proof “clusters” are mints. Wallet-funding graph empty. No observed slippage vs model.
8. **Cluster GA optimizes 5m observation returns with 100% take-profit / 1.5% stop / freshness-heavy weights.** That overfits a different objective than live SPRINT paper with 80 bps+ fees/slip.

---

## 4. Kill / continue criteria

### KILL now (do not do)

- **Do not arm real wallets, real Polymarket, or any live size.**
- **Do not unlock production learning** (`productionLearningUnlocked` must stay false until §4 continue-to-promote is met).
- **Do not promote** the evolution champion, FAST experiment “stable”, or 09-15 PROVEN report.
- **Do not treat 42/42 WON as sports-edge evidence.**
- **Do not loosen** stops, liquidity floors, stake caps, or `MISSING_VOID_MS`.
- **Do not cherry-pick** alpha40 `comboEngine.js` (`20260915-204632-1110f`) onto alpha42.
- **Do not reset the live paper bankroll** just to make the chart pretty, unless the reset is an explicit, tested `resetPaper(start)` that also zeros ledger/history/series and is snapshotted first.
- **Do not change** the currently running app from this worktree.

### CONTINUE (research / paper only)

Shadow-test and measurement work is allowed. Trading logic changes that **tighten** filters or **stop** SPRINT recycling are allowed in isolated worktrees. Anything that increases size, frequency, or live risk is not.

**Continue-to-keep-researching (must all hold):**

1. Edge proof remains INCONCLUSIVE or better **after** winsorized medians, not means.
2. COLD liquidity is recoded as `liquidityUsd >= minLiquidityUsd` (config 1500) vs rest, **not** empirical quartiles that include $1 rows. Re-run holdout. Require top **median > 0** and 2 regimes.
3. Proposal latency p50 **< 15s** on a 24h window with outliers >1h excluded from the KPI but counted as faults.
4. Polymarket paper reports **settled-resolution** win rate separately from early-exit; missing markets >2h are flagged stale (not still “eta 12 min”).
5. Meme paper accounting identity `|equity − (resetStart + lifetimeLedger + unreal)| < 0.001 SOL` after the next *intentional* reset, or a reconstructed lifetime from an append-only ledger that already matches cash.
6. Execution calibration n ≥ 50 paper exits with predicted vs observed slip.

**Continue-to-promote-to-shadow-execution (paper, not live):**

- Independent 30m holdout still ≥150, 2h ≥100 (already true).
- Recoded liquidity (or a new feature) has top median > 0, lower 95% CI > 0, uncontaminated, stable old vs recent, **and** a paper shadow book with n≥100, median return > 0 **after** modeled 80 bps+ fees.
- Horizon of the shadow book matches the proof horizon (do not shadow 30m alpha with 100s SPRINT exits).
- Experiment lane: ≥2/3 time splits positive **and** top-3 concentration < 50% of gross wins.

**Kill-the-line (stop even paper SPRINT research on this book):**

- Marked equity < 0.03 SOL while still opening SPRINT size (already near).
- Another “PROVEN” print that uses raw means / un-winsorized max jumps.
- Any attempt to set `MODE=live` or US real session arm without the promote bar.

---

## 5. Ranked implementation / experiment plan

Dependency order. Each step is a separate isolated worktree unless noted. No deploy.

| # | Work | Owner / existing task | Why first | Acceptance |
| --- | --- | --- | --- | --- |
| 0 | **Freeze this memo as the evidence baseline.** Do not let 09-15 PROVEN or cluster 1068× overwrite it. | this task | Shared numbers | Memo committed; integrator `20260916-104614-4bd03` reads it |
| 1 | **Polymarket settlement-bias + stale missing.** Split metrics: early-exit vs gamma-resolved vs void. Resolve or mark the 5 missing (4 singles + 1 combo). Do **not** shorten void to recycle losers faster. | `20260916-103902-02a6c` (review) | $6.50 censored; 42/42 is false edge | Tests: a 42-win book with 5 missing is **not** 100% WR; early-exit labeled; missing >2h surfaced |
| 2 | **Stop using this SPRINT paper book as alpha.** Pause new meme entries **or** switch profile off SPRINT in paper only after a recorded snapshot. Keep history. | ops / runtime, not a merge | 96% deployed on 0.05 SOL pollutes the 1500-close window | No new SPRINT opens until identity repair; snapshot `state.json` |
| 3 | **Accounting identity on the live file.** Reconstruct lifetime from cash path **or** snapshot + explicit `resetPaper`. Do not rebuild lifetime from truncated `history`. Revive the *intent* of cancelled `20260915-213157-46628` against current `accounting.js` (ledger already exists). | new backend after 0 | −0.404 vs equity 0.052 is the highest-severity data bug | Identity test against a copy of live state (read-only fixture, no overwrite of app-data) |
| 4 | **Liquidity feature hygiene.** Treat `liquidity <= 1.01` (and below `minLiquidityUsd`) as missing, not as the bottom quartiles. Recompute hypotheses. | `20260916-103902-e8029` | Only “positive” lead is a placeholder split | New COLD lead either dies or survives with median>0 excluding $1 rows |
| 5 | **Proposal latency.** Measure p50/p90 on `latency_events` excluding `proposal_ms > 1h` as faults. Fix the proposal path (queue, not scoring). Do not retune entries to wait 8 minutes. | `20260916-103902-e8029` | 500s mean vs 104s holds | p50 proposal <15s; fault rate for >1h reported |
| 6 | **Replay remaining evidence gaps** (app-data discovery, held-position DD sampling, exit failures, censoring). | `20260915-213649-357f8` review notes; duplicate `20260916-001841-8fe5a` already cancelled as integrated at `2274cf2` | Needed before trusting experiment-lane / cluster | Replay tests still green; reports mark censored vs realized |
| 7 | **Shadow book for any surviving filter** (likely “liq ≥ $15k AND execution ≥ X”, not quartile). Horizon 30m, paper, no live. | after 4–6 | Proof nextAction says shadow; current `shadow.trades=[]` | n, median, PF, censor count written to `state.shadow` |
| 8 | **Experiment lane re-run on `4207a70` + current dataset**, not `a4be7b9`. Keep FAST immutable. SPRINT challengers remain ineligible unless DD gate is met **without** loosening. | `20260915-213158-190bb` (review) | latest.json is stale vs deployed | 0 eligible remains OK; do not promote FAST on 2482% concentration |
| 9 | **Visual overhaul / canary** only after 1–3 and the tester baseline. Visual must not touch trading. | `20260916-000321-*`, canary `20260916-104846-0a178` | Product polish is independent of edge, but must not ship over a lying PnL rail | Existing visual commits already in `4207a70`; further visual is optional |

---

## 6. Review branches: integrate vs reject

Base for all judgments: deployed/canonical **`4207a70`**.

### Already in alpha.42 — do not re-merge

| Task / commit | Status |
| --- | --- |
| Robust edge stats `bf14fd2` / `e8d5dbe` (`20260915-213157-16165`) | **Keep.** This is why 09-16 is INCONCLUSIVE instead of fake-PROVEN. |
| Accounting helpers + 1500-cap ledger tests | **Keep code.** Live file still fails the identity; that is data, not a revert. |
| Replay chronological + censored marks `ebad40b` + `2274cf2` | **Keep.** Duplicate `20260916-001841-8fe5a` stays cancelled. |
| Combo post-ETA cadence `9df7fe1` / `1b5894c` | **Keep.** |
| Visual/motion `89ba958` + `4207a70` | **Keep** as the visual baseline. |

### Integrate after review (isolated, no deploy)

| Branch / task | Action |
| --- | --- |
| `20260916-103902-02a6c` settlement-bias | **Integrate if** it only splits metrics, settles/marks stale missing, and adds tests. **Reject** any change that books more WON or shortens void. |
| `20260916-103902-e8029` meme alpha + latency | **Integrate if** it is measurement/filter/latency in replay/shadow/paper research paths. **Reject** entry/size/aggression changes. |
| `20260915-213649-357f8` remaining replay notes | **Port leftover test gaps only**; core already in `4207a70`. |
| `20260915-213158-190bb` experiment lane | **Review then integrate** only if it cannot promote on concentrated FAST / empty shadow. Latest.json already correctly has 0 eligible. |
| `20260916-103902-a131d` tester baseline | **Run**, do not change source. Gate for integrator `20260916-104614-4bd03`. |
| Visual ready queue `20260916-000321-c83ea/82e99/3254a` | **After** data integrator, and only style. Architect spec `9b48135` is spec-only. |

### Reject / do not merge as-is

| Branch / artifact | Why |
| --- | --- |
| `20260915-204632-1110f` (`99ad510`, alpha40 `comboEngine.js`) | Architecture moved to `polymarketUSCombos.js`. Review note already says do not cherry-pick. |
| `20260915-205422-bb88d` original lane | **Superseded** by `16165` / `e8d5dbe`. Leave in review or close as superseded. |
| `20260915-213157-46628` cancelled accounting lane | Do not revive that worktree blindly; re-implement against live identity using current `accounting.js`. |
| `20260915-210244-0ae89` full-OS audit still `review` with empty result | Treat as stale vs this memo + deployed alpha42. Close or rewrite; do not merge a half-finished audit branch. |
| 2026-09-15 daily alpha **PROVEN 100%** | Outlier contamination. Historical document only. |
| Cluster champion 1,068× / walk +44% | Synthetic 5m GA. Not a candidate. |
| Experiment FAST as a production profile | Median −2.12%, concentration 2,482%, 1/3 splits. |
| Any SPRINT* challenger | Drawdown gate already failed. |
| `combo-engine.json` in app-data | Stale alpha40 sidecar (`lastRunAt` ~10h before this freeze, last action $48 combo). Not the live sports path (`polymarket-paper.json` is). Do not re-enable. |

### Close / ignore as completed historical reviews

Grok feed-resilience `20260910-185737-56c7d`, alpha41 visual integrator `20260915-173137-4af00`, Polymarket correctness `20260915-183341-e9a48`, throughput audit `20260915-203703-3039b` — already consumed into alpha40/41/42. No further merge.

---

## 7. Files inspected (no secrets)

App-data: `state.json` (+ `state.backup.json`, `state.pre-1sol-sprint-*`, `state.bad-70sol-*`, `state.pre-price-repair-*`), `market.ndjson` + `.1` + `.2`, `alpha-insights.json`, `edge-proof.json`, `polymarket-paper.json`, `combo-engine.json`, `latest-alpha-report.json`, `reports/2026-09-1{4,5,6}-alpha.{md,json}`, `alpha-lab.sqlite` (read-only; tables `token_observations`, `outcomes`, `hypothesis_results`, `latency_events`, `execution_calibration`, `wallet_funding`, `tx_events`, `wallet_token_positions`, `capital_migrations`, `alpha_meta`), `alpha-queue.ndjson` (existence only).

Cluster: `cluster/results.ndjson`, `cluster/datasets/*` (schema sample + count; experiment hash `73afc71cc805…` **not present** as a named dataset file).

Agent Lab: `state/experiments/money-printer-os/latest.json`, `tasks/20260915-*` and `20260916-*` Money Printer records, grok-results for `20260910-185737-56c7d`.

Source (behavior, not performance): `src/store.js` (1500 cap, action drain), `src/accounting.js`, `src/edgeProof.js`, `src/alphaInsights.js`, `src/polymarket.js` (early-exit + 48h missing void), `src/config.js`.

**Not found / not a hole:** `actions.ndjson` — drain-on-read.  
**Not read:** `.env`, keys, `state/secrets/`.

---

## 8. Decision

**Continue measurement. Kill promotion. Kill live. Kill SPRINT-as-alpha on this book.**

The only number that looks like a lead (COLD liquidity quartile) is a missing-data artifact plus a less-bad median that is still negative. The only number that looks like a sports win rate (42/42) is an early-exit filter with five stale opens. The only number that looks like a strategy winner (cluster 1,068× / FAST +0.0026) is synthetic or concentrated. The number that actually moved the paper meme account is equity **2.19 → 0.052 SOL** over ~34 hours of retained series, with a **−1.55% median** on the last 1500 closes.

Next workers: settlement-bias (`02a6c`) and evidence-driven research (`e8029`) may proceed inside paper/replay/shadow. Integrator `104614-4bd03` should refuse any diff that loosens risk or promotes a strategy. Canary `104846-0a178` waits.

---

*End of memo. No orders placed. No app restarted. No credentials touched.*
