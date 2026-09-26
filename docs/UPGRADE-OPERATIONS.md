# Research workstation upgrade — 2026-09-26

## Source, installed runtime, and authority

Trader source is alpha.61 on `codex/master-upgrade-20260926`; Lab source is alpha.7 in
`W:/money-printer-evolution-lab`. The installed processes remain trader alpha.60 and Lab alpha.6.
This session prepares archives; it does not install, restart, publish, sign, or enable real execution.
Exact packaged commits and SHA256 values live in `W:/upgrade-release-20260926/*/BUILD-INFO.json`
or the Lab archive sidecar and the final implementation report.

The trader owns cash, fills, positions, paper resets, applied parameters, risk and trial decisions.
Lab owns research experiments, candidate selection, consumed holdout receipts, scheduler state and
proposal publication. Proposals cannot grant real-money authority. HUD values are views of these
owners, never a second writable portfolio. The legacy Solana and USD books are not fully consolidated.

Canonical Windows data is `%APPDATA%/Money Printer OS/data` and
`%APPDATA%/Money Printer Evolution Lab/data`. The stale Claude MSIX LocalCache overlay is not current.
Run `node scripts/agent-preflight.mjs --json` before investigating a stopped/stale app. All development
must set explicit disposable trader/Lab data directories and a disposable `MPO_COMPUTE_BUDGET_FILE`.
Never start another writer against installed data. Do not copy `.env`, credentials or private keys into
test fixtures, reports, archives or another machine.

## Correctness and evidence contracts

* Market replay v2 uses information available at the decision, next observations for fills, both fees,
  final marked risk, and charged fold liquidation. Unfilled boundary liquidations invalidate the fold.
  Close-only candle data is synthetic research input; past OHLC prices cannot be executed at close.
* Registry qualification binds a stored run, dataset fingerprint, evaluator and immutable strategy
  identity. Editable metric flags are insufficient. A promotable fixed policy declares
  `params: {replayStrategy: 'momentum', parameters: {...}}`; its single grid and every fold must match.
  Adaptive sweeps remain research. Parameter/code/data/cost revisions invalidate prior qualification;
  old evidence remains in append-only history. Existing v1 active rows return to BACKTESTING.
* Robinhood replay uses next-quote entries/exits and every-quote marked drawdown in both repositories.
  Authentic Robinhood source coverage, fees and elapsed evidence gates are preserved. Paper apply
  uses the bounded trial admission path, candidate/incumbent identity and evaluator/dataset evidence.
  Corrupt rollback authority blocks further changes. A fresh proposal cannot bypass paper drawdown.
* Equities handoff names the actual applied incumbent and execution assumptions. Unknown actual costs
  remain unknown. Lab freezes a selected candidate before collecting 126 future sessions, compares it
  with the incumbent, SPY and cash, records one prospective access, and refuses overlapping final
  windows. Consumer checks evaluator/hash/freeze/cost/prospective identity before accepting it.
  Adjusted IEX bars are data input; they do not prove executable Robinhood or Alpaca prices.
* Kalshi's versioned handoff preserves historical rules, fees, timestamped exact-quantity offers and
  observed settlement. Its evaluator waits for an offer after latency, retains capital until settlement,
  groups repeated event outcomes, and labels simulated fills explicitly. It publishes research results
  only. No complete historical outcome corpus or prospective edge was invented.

Shared interfaces: `mpo.lab-status.v1`, `mpo.lab-module-champion.v1`, `mpo.fitness-ledger.v1`,
`mpo.prediction-episodes.v1` and `mpo.compute-budget.v1`. Evaluators: `market-replay.v2`,
`robinhood-backtest.v2`, `equities-close-next-open-v2`, `prediction-episodes.v1`. The portable prediction,
compute lease and Robinhood replay implementations must stay byte-identical across repositories.
`BUILD.json` supplies actual packaged commit/file hashes; historical checkout build markers are ignored
and no longer tracked. `/api/state` and `/api/platform/status` expose running build provenance.

## Module decisions and reactivation

The live capability matrix is `/api/platform/status.capabilities`. Collection readiness is separate
from validation and paper authority. Current source contracts are:

| Module | Decision | Evidence / reactivation condition |
|---|---|---|
| Solana/Pump.fun | Collect first | Preserve FAIR, frozen exit search, quote-only sampler and evidence gate. Require executable round trips, priority costs, failed transactions, rugs/stop gaps and sufficient independent exits. Sampled marks cannot qualify. |
| Robinhood crypto | Collect first | Preserve seven-day authentic quote requirement and fees; installed snapshot had about 0.56 day, 63% venue rows and one close. Longer-horizon/daily research remains separate. |
| Robinhood equities | Collect first | Actual incumbent now supplied. Verify execution/corporate-action/session assumptions and wait for the frozen future sample; no automatic historical winner. |
| Stocks / Market Lab | Consolidate shared identities; improve now | Share bar handoff, ledger, risk and verified registry; execution venue remains explicit. Fixed-policy evidence must match the registered policy. |
| Kalshi | Collect first | New complete collector-handoff/evaluator path; requires observed future settlement and rule/fee history. Paper orders remain explicit shared-governor proposals. |
| Polymarket international | Collect first / park search without edge | Preserve international CLOB identity and access checks. Require permissible executable history and independent after-cost edge. |
| Polymarket US | Park | Actual joint RFQ, expiry, fill/failure/void and settlement evidence plus product permission needed. Multiplied leg probabilities do not qualify US execution. |
| Cross-venue comparison | Improve now | Exact rule attestation, synchronized depth, costs and failed-leg scenarios implemented. Settlement/funding uncertainty prevents a locked-return claim. |
| Macro | Information only | Vintage/as-of FRED required for research; latest revised values are context. Predictive ablation remains unproven. |
| EDGAR | Information only | Acceptance-time facts and cited summaries; identify declared SEC contact. AI confidence is not a probability forecast. |
| Wire | Information only | First receipt and revision availability corrected; repeated polling cannot backdate the story. Measured incremental contribution remains pending. |
| Weather / Sports | Information only | Station/date/event/rule mappings supported as context; unsupported overtime/draw/postponement/threshold families stay related. |
| Whale Watch | Information only | Public wallet flow and uncertain labels retained. Require wash/transfer filtering, realistic copy delay and capacity before strategy use. |
| Infrastructure | Improve now | Marked equity, recovery, bounded queues, shared budget, provenance and trial controls. Exclusions and failures remain visible. |

## Accounting and cross-venue risk

Core USD valuation uses fresh bid/depth marks and modeled liquidation fees. Missing, stale, shallow or
unknown-cost marks make valuation incomplete and block added risk; reducing sells remain possible
subject to normal halt/order rules. High-water drawdown uses persisted unitized marked equity; flows
purchase/redeem units at observed pre-flow NAV and cannot erase percentage loss. Migration cannot
reconstruct prior marks; the starting timestamp and conservative first-day baseline are exposed.
After rollover the daily reference is the last complete prior observation, not an invented midnight mark.
Other currencies remain separate without timestamped verified FX; legacy positions are explicitly
excluded where no reconciled adapter exists. Never describe this as total consolidated net worth.

Cross-venue output is a **conditional matched payoff**. Rules fingerprints include thresholds, units,
time zones, resolution, void/dispute, overtime/tie, payout/currency and settlement timing. Stale books,
skew over one second and sequence/resync gaps block matching. Each leg includes depth/fees; output
shows outcome payouts, one-leg failure bounds and observed unwind assumptions. Capital duration and
funding can be unknown. Independent legs are non-atomic, and current snapshots cannot prove later fills.

Current official references were checked: Kalshi documents fixed-point complementary bid books and
authenticated streaming ([order books](https://docs.kalshi.com/getting_started/orderbook_responses),
[WebSockets](https://docs.kalshi.com/getting_started/quick_start_websockets)). Polymarket requires
market-specific fee/access handling ([fees](https://docs.polymarket.com/trading/fees),
[geographic restrictions](https://docs.polymarket.com/api-reference/geoblock)); the
[US data product](https://docs.polymarket.us/data-guide/overview) is a separate interface.
This upgrade uses permitted stored/read-only data; it adds no credential or regional bypass.

## Compute and resource policy

Lab defaults to the balanced profile with one module job, 50% CPU budget and two logical cores reserved;
research allows two jobs/70%, overnight three/80%. Actual memory pressure pauses new admissions.
Foreground latency/temperature inputs exist but their live sensors are not wired: do not advertise
automatic thermal or HUD feedback control. GPU stays disabled until an actual eligible evaluator wins
reference parity and end-to-end benchmarks including transfer/startup cost. No utilization target is used.

Trader pool has bounded queue32, deadlines, cancellation/crash outcomes and a shared lease per worker.
Lab queue16 deduplicates unchanged inputs, selects lanes fairly and records cost/history with bounded
retry. Both use `%APPDATA%/Money Printer Shared/compute-budget.json` unless the same explicit override
is supplied. The shared minimum ceiling prevents independent oversubscription. Live expired owners
retain slots conservatively; inspect owner PID and useful work before recovery. Do not delete active
leases or consumed holdout history. Detailed profiles/commands are in the Lab upgrade operator record.

## Expansion decision and ready adapter design

No additional chain passed the evidence bar. Existing Kalshi research integration was the highest-value
feasible extension. The table ranks future discovery effort, not profit or measured liquidity; unknowns
are deliberately unscored. Usable data/effort scores are provisional 0–5 judgments.

| Rank | Candidate | Usable local data | Capacity / edge / all-in cost | Integration effort | Access/reliability and decision |
|---|---|---|---|---|---|
| 1 | Base read-only EVM | 0/5 collected here | All unmeasured | 3/5 | Standard RPC possible, route/reorg/token risks remain; collect only after a declared hypothesis. |
| 2 | Arbitrum read-only EVM | 0/5 collected here | All unmeasured | 3/5 | Sequencer/L1 finality and fee assumptions required; no bridge fungibility assumption. |
| 3 | Ethereum mainnet | 0/5 collected here | All unmeasured | 3/5 | Native gas and finalized-vs-head state must be modeled; no low-capital edge established. |

Official shortlisted references: [Base chain identity](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId),
[Arbitrum protocol](https://docs.arbitrum.io/nitro-whitepaper.pdf),
[Ethereum transactions](https://ethereum.org/developers/docs/transactions/) and
[finality](https://ethereum.org/developers/docs/consensus-mechanisms/pos/gasper/).

Future adapters build on `JsonProvider`, `ProviderRegistry`, normalized entities and the existing broker
contract (`account`, `positions`, `instruments`, `quotes`, `preview`, `submit`, `orderStatus`, `cancel`,
`history`). A chain extension must return chain-qualified asset address+decimals, source/observed/available
times, block hash/number/finality, reorg invalidation, route/depth/expiry, native and token costs,
transfer-tax support, RPC health and retry/rate limits. Missing capabilities stay unavailable. Signing
is outside the research adapter. Complete admission requires replay fixtures/reference parity,
collector restart/deduplication, historical coverage, ledger account/currency mapping, risk valuation,
Lab registration and explicit HUD states. Cross-chain hypotheses additionally need funded balance,
bridge delay/cost/failure and nonfungible capital constraints. A price fetch alone is not an adapter.

## Release and rollback procedure (owner action, not executed)

1. Review `reports/UPGRADE-IMPLEMENTATION-2026-09-26.md`, the three workstream reports, build manifests,
   hashes, test logs and native/browser screenshots. A short soak does not certify 24 hours.
2. Close both apps and their supervisors once paper state has been saved; ensure no real open orders or
   live armed session. Existing release gates remain mandatory. Back up each current `resources/app.asar`,
   `.env` privately, and its complete canonical data directory including SQLite WAL/SHM while stopped.
3. Verify SHA256 of reviewed archives. Replace only the corresponding app.asar with the reviewed trader
   alpha.61 and Lab alpha.7 archives. These are local unsigned archive payloads for the installed runtime;
   use the existing signed manifest/update infrastructure before any public distribution.
4. Start one trader and one Lab. Confirm versions **and exact BUILD source commits**, canonical data paths,
   paper-only/live-disabled state, bridge schemas, actual incumbent and shared budget. Leave optional paper
   auto-apply off until the owner elects it. Old evidence invalidation and WAITING states are expected.
5. Monitor fresh useful collection, trial guards, marked-risk exclusions, crash-loop health and new experiment
   receipts. Run the documented resumable isolated 24-hour soak before asserting unattended stability.

Rollback: stop both writers, save post-upgrade data separately, restore the backed-up archives and, if
required for schema compatibility, the matching stopped data snapshot as an explicit rollback epoch.
Do not mix older executables with incompatible new data or delete research invalidations to restore a
champion. Keep new receipts/fills in the retained backup; never insert balancing ledger entries. Verify
runtime hashes and versions again. No Mac installation, Authenticode signing or public release was tested.

Build commands (after committing packaged source):

```powershell
npm run release:windows-asar -- --out W:\upgrade-release-20260926\trader
npm run smoke:windows -- --asar W:\upgrade-release-20260926\trader\app.asar --port 18772
# From W:\money-printer-evolution-lab; default packager installs, so retain --asar-only:
node scripts/package-windows.mjs --asar-only W:\upgrade-release-20260926\lab\app.asar
```

The engine smoke uses installed Electron **as Node** against disposable data. Native renderer verification
is separately reproducible with `node scripts/verify-electron-hud.mjs`; it opens a temporary synthetic
window, exercises controls under four CPU workers and closes it. It loads no installed portfolio or keys.
