# Platform Research Systems Inventory and Boundary Design

**Date:** 2026-09-26  
**Scope:** Money Printer OS (MPO) checkout at `W:\money-printer-os` and the separately described Money Printer Evolution Lab.

## Gate before implementation

This document is the required inventory and boundary definition for the platform expansion request. No implementation work for the new general Polymarket registry, new Robinhood asset lanes, or Lab comparison UI should begin until this document is reviewed and accepted. Existing code and tests remain unchanged by this inventory pass.

The checkout contains MPO only. A second Evolution Lab repository or installed Lab source tree was not found under the workspace root, and the Lab repository path named in historical state documents is not mounted here. Therefore, Lab capabilities below are based on the existing MPO link contract, checked-in documentation, and tests; they are not a source audit of the separate Lab application.

## Repository and runtime inventory

| Area | Current evidence | Status / boundary |
|---|---|---|
| MPO source | `src/`, `desktop/`, `public/`, `tests/` | Present; Node `>=22`; Electron desktop entry is `desktop/main.cjs`. |
| MPO version | `package.json` reports `0.5.0-alpha.60`; README still says alpha.53 | Version documentation is inconsistent and must be reconciled during implementation. |
| Latest commits | `da12894` Polymarket US evidence; `1d146c4` Robinhood equities paper lane; `5ada6b9` HUD bounds | Current checkout includes recent Polymarket evidence and Robinhood equities work. |
| Working tree | Existing uncommitted and untracked visual assets under `artifacts/sky-refs/` | User changes; preserve and do not include in unrelated edits. |
| MPO data | `data/` plus runtime user data outside the checkout | Do not mutate installed/user data during development or tests. Use fixtures and temporary directories. |
| Environment | `.env.example` exists; no checkout `.env` was found | Credentials are not available and must not be requested or embedded in tests/builds. |
| Installed app versions | No installed app inspection was performed in this workspace pass | Must be verified by an operator on each target OS before packaging claims. |
| Evolution Lab source | Not present in this checkout | Lab implementation inventory is provisional until its repository/commit is supplied. |

## Existing MPO capabilities

### Polymarket

Implemented or partially implemented modules include:

- `src/polymarket.js`: global Polymarket paper market/sports path, including timing and settlement behavior.
- `src/polymarketUS.js`: Polymarket US account/session and single-market API boundary; current dashboard comments say its scanner/order routes are parked.
- `src/polymarketUSCombos.js`: US combo/RFQ lane with paper and guarded real-path code.
- `src/polymarketUSEvidence.js`, `src/polymarketResearchEval.js`, `src/polymarketCrossVenue.js`: evidence, research evaluation, and cross-venue evidence surfaces.
- `tests/polymarket-settlement.test.mjs`, `tests/polymarket-us-*.test.mjs`, and `tests/polymarket-research-eval.test.mjs`: existing safety, evidence, combo, settlement, and evaluation coverage.

Current limitation: Polymarket is not yet represented by a general stable module registry with independently persisted lane state. The visible product is still primarily the global/sports path plus Polymarket US combos and evidence. Existing claims about API schemas and fee behavior must remain tagged as observed, documented, or unverified until fixture and source provenance are attached.

### Robinhood

Implemented or partially implemented modules include:

- Official Crypto Trading API boundary: `robinhoodSigner.js`, `robinhoodTransport.js`, `robinhoodHttp.js`, `robinhoodPaperFeed.js`, `robinhoodJournal.js`, `robinhoodAutoTrader.js`.
- Crypto tape/replay/evolution: `robinhoodBacktest.js`, `robinhoodEvolve.js`, tape statistics, paper qualification, and recovery tests.
- Stocks/ETF paper lane: `robinhoodEquities.js`, `robinhoodEquitiesData.js`, `robinhoodEquitiesStrategy.js`, `robinhoodEquitiesBook.js`, `robinhoodEquitiesHttp.js`, `robinhoodEquitiesCalendar.js`, and corresponding tests.
- Evidence and HUD: `robinhoodEvidence.js`, `public/assets/robinhood-panel.js`, dashboard integration, readiness and safety tests.

Current limitation: crypto and equities are separate in substantial areas but are not yet unified behind a first-class venue/asset-class registry and common lane contract. Options are not an implemented executable or complete paper lane. The repository documentation states that Robinhood has no public equities REST API and that Agentic Trading/MCP requires a dedicated account and OAuth; those are readiness boundaries, not available capabilities in this checkout.

### Research and Lab link

Existing research surfaces include `researchControlPlane.js`, `researchEvidenceStore.js`, `researchEvidenceGate.js`, replay/evaluation modules, `championState.js`, `labLink.js`, and action-queue rails in `store.js`. The existing link uses signed status/champion/dataset records and local revalidation. Real execution remains guarded by `liveExecution: 'manual'`, `automaticLivePromotionAllowed: false`, and `liveActivationAllowed: false` (or equivalent checks) across the application.

The current Lab link is a transport and champion-status boundary, not a complete venue-aware Lab registry. The separate Lab's CPU/worker/BEAST/GPU implementation and current commit cannot be verified from this checkout.

## Capability classification

### 1. Implemented and testable now

- MPO paper mode and existing release/exposure gates.
- Deterministic local paper books, atomic persistence, recovery refusal, audit journals, and replay primitives.
- Existing Polymarket global/sports, Polymarket US evidence/combo, settlement, and cross-venue evidence modules within their documented scope.
- Robinhood crypto official signing/transport boundary and crypto paper tape/book/evaluation.
- Robinhood regular-hours stocks/ETF paper research lane using qualified fixture/public data boundaries.
- Lab-link signature validation, stale-link handling, local champion revalidation, and promotion vetoes.

### 2. Paper-only lanes implementable now

Subject to documented source contracts and durable fixtures, these can be added without live credentials:

- Polymarket single binary, multi-outcome, politics, macro/financial, crypto range/price, weather/event, market-making simulation, cross-market relationships, and combos as one lane.
- Polymarket fee/settlement/capital-lock/partial-fill replay where rules and source timestamps are available.
- Robinhood crypto, stocks, ETFs, fractional-share accounting, event-driven research, dividends/splits/earnings/corporate-action replay, session calendar behavior, and cash/long-only benchmarks.
- A Robinhood options read-only/research lane only when all prerequisite data contracts are present; otherwise it must remain `UNAVAILABLE`.
- Shared registry discovery, per-lane tapes/holdouts/incumbents, bounded search requests to the Lab, reports, and side-by-side Lab comparison views.

### 3. Read-only evidence lanes

- Public Polymarket metadata/order-book/trade/market-resolution evidence when obtained from documented endpoints or durable supplied tapes.
- Public or documented Robinhood crypto market-data evidence.
- Public market/calendar/corporate-action data used for Robinhood equities research, explicitly tagged as non-Robinhood executable data.
- Agentic Trading/MCP readiness discovery and schema/readiness reporting, without account actions.
- Cross-venue price-gap evidence, never treated as executable parity or guaranteed arbitrage.

### 4. Requires user credentials or a dedicated account

- Robinhood Crypto Trading API authenticated account for official Robinhood quotes, account data, and any separately authorized real-order path.
- Polymarket US account/key scopes and any beta allow-list for authenticated account, RFQ, or order routes.
- Official Robinhood Agentic Trading/MCP OAuth and dedicated Agentic account, if the user chooses to configure it.
- Any bridge/shared-folder key used for signed Lab exchange.

Credentials must stay out of renderer code, localStorage, URLs, logs, tests, fixtures, and public builds.

### 5. Unavailable through an official supported API in this project

- Robinhood public equities REST trading API for ordinary accounts, based on the repository's current documented boundary.
- Robinhood sandbox/paper API; local paper mode is not an exchange sandbox.
- Unofficial Robinhood mobile endpoints, `robin_stocks`, scraping, credential impersonation, or undocumented APIs.
- Any claim that an external public quote is a Robinhood executable quote or fill.

### 6. Permanently out of scope for automatic promotion

- Automatic promotion from research, Lab, shadow, or paper state to real execution.
- Live execution without explicit separate authorization, platform-approved credentials, current permissions, and existing release gates.
- Synthetic or invented fills, fees, market status, resolution, greeks, corporate actions, or performance.
- Options simulation with missing chain/contract/quote/valuation/assignment/buying-power/ledger prerequisites.
- Treating combo legs as independent observations; event-grouped validation is mandatory.

## Proposed stable contracts before implementation

Every venue/asset lane must expose a registry record with `name`, `version`, `venue`, `assetClass`, `dataRequirements`, parameter bounds, paper-book model, risk/exposure limits, evidence outputs, promotion status, and rejection/insufficient-data reasons. Every observation must retain source, source kind, `asOf`, freshness, coverage, missingness, and confidence. Every tape must be replayable deterministically and must reject look-ahead.

The shared research result must include candidate/incumbent/cash comparisons, event-group counts, dataset/source/code hashes, cost and fee assumptions, stress settings, walk-forward/holdout boundaries, calibration, drawdown, coverage, and multiplicity-aware statistics. Lab publications remain advisory; each trader revalidates locally. The only allowed automatic state transition is within paper/shadow research states, never into live execution.

## Required implementation phases after approval

1. Resolve the second-repository inventory: provide or mount the Evolution Lab checkout and record its commit, tests, runtime, packaging target, and current registry/search/link contract.
2. Add shared lane schemas/registry and durable storage contracts without changing live gates.
3. Add Polymarket lane adapters and deterministic fixtures, then settlement/cost/replay/evidence gates.
4. Add Robinhood multi-asset registry and equities/corporate-action/benchmark boundaries; add options refusal/readiness behavior and Agentic MCP adapter readiness only.
5. Extend Lab discovery, bounded lane searches, signed advisory publication, local revalidation, and rejection reporting.
6. Add HUD overview/summary/Advanced diagnostics while preserving Simple/Advanced behavior and existing graphs.
7. Add tests, offline doctor/self-test, browser smoke, and platform packaging verification. Report unavailable capabilities explicitly.

## Acceptance boundary

No lane may be called complete merely because a panel, stub, mock, or registry row exists. Completion requires a real documented data contract, durable state, deterministic tests, replay/no-lookahead coverage, honest readiness status, and preserved release/promotion vetoes. Until the separate Lab repository is audited, Lab-specific completion claims remain blocked at the inventory boundary.

