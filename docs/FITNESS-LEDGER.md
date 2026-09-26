# Fitness ledger and trader ↔ Lab contract (v1)

This is the one record both apps read to answer "what is running, how is it doing, and may the
Lab propose anything?". The trader writes it; the Evolution Lab only reads it. Everything here
is paper only.

## Files

| File (under the trader data dir) | Writer | Reader |
| --- | --- | --- |
| `lab-link/fitness/<module>.json`, module `solana` / `robinhood` / `polymarket` | trader, atomically, at the trader-status cadence | Lab (`labFeed.js`, `moduleResearch.js`) |
| `lab-link/trader-status.json` (adds `runningPolicy`) | trader | Lab |
| `lab-link/robinhood-champion.json` (adds `proposalVersion`, `supersedes`, `basis`) | Lab | trader (`labProposalPass`) |

`GET /api/fitness` on the trader returns `{ schema, at, modules: { solana, robinhood, polymarket } }`
with the same per-module documents.

## `mpo.fitness-ledger.v1` (one per module)

```json
{
  "schema": "mpo.fitness-ledger.v1",
  "module": "robinhood",
  "updatedAt": 1790000000000,
  "liveExecution": "manual", "liveActivationAllowed": false, "automaticLivePromotionAllowed": false,
  "running": { "hash": "…", "params": {}, "since": 1790000000000, "source": "BASE | operator | lab-auto" },
  "paperRecord": { "closes": 0, "hitRate": null, "profitFactor": null, "netPnl": 0, "unit": "USD | SOL",
                   "maxDrawdown": 0, "maxDrawdownPct": null, "windowDays": null, "since": null },
  "evidence": { "executablePrices": false, "spanDays": 0, "closes": 0, "venueShare": null,
                "syntheticShare": null, "quoteSources": {} },
  "mayPropose": { "ok": false, "blockers": ["…"] },
  "proposal": null,
  "trial": null,
  "lastDecision": null,
  "verdict": "KEEP_RESEARCHING | BLOCKED | PARK",
  "blockers": ["…"]
}
```

- `mayPropose` is `laneMayPropose(evidence)` from `src/evidenceFlags.js`. That file is copied
  verbatim into the Lab; change both together. Thresholds can only be tightened.
- `proposal`: `{ id, stage, basis, proposalVersion, publishedAt }` copied from the Lab's
  champion file when one stands, else `null`.
- `trial` (Robinhood only for now): `{ status: "RUNNING | KEPT | REVERTED", hash, incumbentHash,
  startedAt, endedAt, closes, needed: 20, incumbent: { profitFactor, closes }, candidate:
  { profitFactor, closes, maxDrawdownPct } }`.
- `lastDecision`: `{ action: "applied | kept | reverted | abandoned", reason, hash, at, by }`. `abandoned` means the paper params were changed by hand during a trial.
- `paperRecord.profitFactor` is `null` with `profitFactorUnbounded: true` when there is no losing close yet. `maxDrawdown` is in `unit`; `maxDrawdownPct` is relative to the paper start and `null` when that is unknown.
- `verdict`: `BLOCKED` while `mayPropose.ok` is false; `PARK` when a park rule fired
  (see `reports/SELF-IMPROVING-LOOP-PROMPT-2026-09-26.md`); otherwise `KEEP_RESEARCHING`.

Unknown numbers are `null`, never 0 or invented.

## `runningPolicy` in `trader-status.json`

What the trader's Solana book actually runs, so the Lab can score it as the incumbent
(`MPO-RUNNING`) and freeze exits at it:

```json
"runningPolicy": { "module": "solana", "profile": "FAIR", "exitPreset": "fair",
  "stopPct": 8, "takePct": 12, "take2Pct": 30, "trailPct": 7, "maxHoldMin": 90,
  "roundTripPct": 2.1, "hash": "16 hex" }
```

Percent fields are percents (8 = 8 %). `roundTripPct` is the modelled baseline round trip from
the cost gate.

## Robinhood proposal fields the trader checks (`labProposalPass`)

`robinhood-champion.json` must carry `qualificationStage: "PAPER_REVIEW"`, `paperPromotionAllowed: true`,
state ≥ PAPER, `proposalVersion` (integer), `supersedes` (previous proposal id or null) and
`basis: { incumbentHash, traderSince, holdoutThrough, trials }`. The trader applies it to paper
only when `ROBINHOOD_LAB_AUTO_APPLY_PAPER=true`, `basis.incumbentHash` equals its current paper
hash, the evidence passes `laneMayPropose`, the params are inside `EVOLVE_BOUNDS`, the hash was
never reverted, and no trial is running.

Trial rule: after 20 new paper closes at the candidate hash, keep it only if its profit factor
is ≥ the incumbent's and its drawdown stays within 3 % of the paper start; otherwise revert and
mark the hash rejected. A trial with no close in 14 days reverts too.

While `trial.status` is `RUNNING` the Lab publishes nothing for that module and shows
`PAPER_TRIAL n/20`. A later proposal must beat the applied incumbent's `paperRecord` on data
sealed after `lastDecision.at`.
