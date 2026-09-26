# Money Printer OS + Evolution Lab extension inventory and design

Date: 2026-09-26  
Repositories inspected: `W:\money-printer-os` (`feature/hud-declutter`, HEAD `da12894`) and `W:\money-printer-evolution-lab` (`codex/lab-evidence-20260925`, HEAD `d97003c`).

## Inventory evidence

The OS is Node 22+, version `0.5.0-alpha.60`, with a broad existing test matrix (`npm run test:all`). The Lab is Node 22+, version `0.1.0-alpha.6`, with dedicated lab, evolution, and evidence test commands. The OS worktree already contains unrelated uncommitted visual/assets work; this extension must not overwrite it.

Existing contracts inspected include `src/labLink.js`, `src/polymarketResearchEval.js`, `src/polymarketUS.js`, `src/polymarketUSCombos.js`, `src/robinhood*.js`, `desktop/release-gate.cjs`, `public/dashboard.html`, `docs/POLYMARKET-RESEARCH-EVAL.md`, `docs/POLYMARKET-COMBOS.md`, `docs/ROBINHOOD-AUTO-TRADER.md`, `docs/EVOLUTION_LAB_SPLIT.md`, and the venue tests.

## Capability classification

### Implemented and testable

- Paper-first OS and Lab lifecycle, signed/HMAC Lab-link records, local revalidation, atomic JSON writes, recovery flags, release-gate exposure checks, and fail-closed promotion policy.
- Polymarket research tape parsing with as-of clocks, no-lookahead checks, depth walking, partial fills, fee metadata requirements, sports signals, settlement/resolution fixtures, calibration/evidence records, cross-venue gap logging, and a separately gated US combo surface.
- Robinhood crypto paper feed/book/journal/tape/replay/evolution, source tags, freshness and coverage, authenticated-feed fallback classification, and isolated stocks/ETF daily-bar paper lane with sessions, next-open fills, T+1-oriented ledger behavior, fees/slippage, cash, and benchmarks.
- Evolution Lab bounded search, worker/BEAST/GPU configuration surfaces already present, walk-forward/stress/shadow/deflated-Sharpe gates, module status/publication, and paper-only champion application.
- Windows 98-inspired HUD with Simple/Advanced rendering, explicit paper/stale/unavailable states in several panels, and profit-gated money effects with existing bill assets.

### Paper-only capabilities implementable now

- A versioned, venue-neutral lane registry and lane status/readiness schema that reports actual data prerequisites without granting execution authority.
- Separate Polymarket research lanes for singles, multi-outcome, sports, politics, macro/financial, crypto range/price, weather/events, market-making simulation, relationships, combos, and settlement, provided each lane refuses missing metadata/depth/fees/resolution inputs.
- Separate Robinhood paper lanes for crypto, stocks, ETFs, fractional-share research where the qualified source supports it, event-driven research, corporate-action/session research, long-only cash behavior, cash/buy-and-hold/sector/broad-market/asset benchmarks, and options prerequisite/readiness reporting.
- Deterministic seeded desktop money physics in a bounded canvas/DOM layer, including drag/throw and reduced-motion simplification.
- Lab discovery, per-lane datasets/tapes/holdouts/incumbents, lane-specific reports, comparison/rejection diagnostics, and signed paper/shadow publications using the existing link contract.

### Read-only evidence capabilities

- Public Polymarket metadata/order-book/trade/resolution evidence when obtained from documented official endpoints and captured with source, as-of, freshness, coverage, and missingness.
- Robinhood-authenticated read-only market data only when the official credential flow succeeds; public Alpaca/Coinbase or other qualified sources remain explicitly non-Robinhood evidence.
- Official documentation and readiness evidence for Robinhood Agentic Trading/MCP, without wiring account actions into this application.

### Credentialed or dedicated-account capabilities

- Polymarket US authenticated requests and any account-scoped features require the user’s official developer credential and platform-side enablement; current repository evidence records combo beta as account-disabled even after signed access succeeded.
- Robinhood authenticated crypto quotes require the official Crypto Trading API key/private-key setup. Any future sanctioned trading adapter would require the user’s own official OAuth/account setup, separate authorization, and dedicated account controls.
- Agentic Trading/MCP is an adapter/readiness boundary only; secrets must never enter renderer code, localStorage, URLs, logs, tests, or public builds.

### Unavailable through official supported APIs in this application

- Robinhood mobile/private APIs, robin_stocks, scraping, credential impersonation, undocumented endpoints, and fabricated executable Robinhood quotes are unavailable and permanently rejected.
- Robinhood real equity/options/crypto execution is not wired into MPO. The supported Agentic Trading/MCP route is not an MPO execution implementation.
- Historical Robinhood-native quotes, chains, greeks, assignment/exercise, buying-power, and settlement data are unavailable unless all official prerequisites are actually supplied and qualified.
- Polymarket US combo/RFQ access is unavailable while the platform returns `403 betaNotEnabled`; international CLOB research is not evidence of US combo access.

### Permanently out of scope

- Automatic promotion to real execution, unattended live trading, bypassing release gates, weakening `liveExecution:'manual'`, `automaticLivePromotionAllowed:false`, or `liveActivationAllowed:false`, or treating a Lab champion as live authority.
- Invented quotes, fills, fees, depth, market status, resolutions, greeks, corporate actions, performance, or “complete” claims based only on a registry row, mock, or HUD panel.
- Combining correlated event legs as independent observations, look-ahead/future leakage, cross-venue state contamination, or using synthetic/public data as if it were venue-native executable data.

## Design decisions

1. Add a versioned lane contract with `id`, `version`, `venue`, `assetClass`, `requirements`, bounded parameters, paper-book model, limits, outputs, promotion state, readiness, and explicit `NO_DATA`, `STALE`, `NOT_CONFIGURED`, `UNAVAILABLE`, or rejection reasons.
2. Keep lane state physically namespaced by venue and asset class. A reset or recovery in one namespace cannot mutate another.
3. Make evidence provenance first-class on every observation and replay row. Unknown provenance is not silently upgraded.
4. Reuse existing atomic writes, lab-link signatures, local champion revalidation, and release gates. New surfaces consume these contracts; they do not create parallel authority.
5. Use deterministic seeds and bounded body counts for money physics. Profit events remain the sole spawn trigger; reduced motion disables dynamics and keeps only an accessible, minimal indication.
6. Treat options as readiness/read-only until every listed prerequisite is verified. Missing prerequisites produce honest refusal, not an estimated greeks or fill.
7. Build the registry and contract tests first, then adapters/replay, then Lab publication, then HUD integration, and finally packaging/smoke verification.

## Verification plan

Run existing OS and Lab suites before and after changes; add lane contract, provenance, replay/no-lookahead, settlement/corporate-action/options refusal, atomic recovery, isolation, Lab-link, HUD, and physics interaction/performance tests. Run self-test, offline doctor, browser/HUD and Lab smoke, and only claim packaged Windows/Mac smoke when those environments are reachable. Any unavailable external credential, account feature, or Mac host remains explicitly reported as unverified.

