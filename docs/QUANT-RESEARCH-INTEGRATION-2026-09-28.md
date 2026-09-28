# Quant research integration — September 28, 2026

Money Printer OS now contains a searchable, read-only index of both Brainbrick repositories, ten prioritized research mappings, and a structured evidence checklist derived from the supplied image. Open **Quant research library** from the Research Monitor. No upstream trading code was copied or activated. Trading parameters, admission gates, account state and installed applications were not changed. The catalog is not an executable strategy registry.

## Scope and provenance

All 5,907 strategy documents were read by the indexer for metadata, content hashes, code-block hashes and heuristic review flags. Selected relevant specifications and snippets were inspected in detail. This is a full inventory and automated content screen, not a manual audit of 5,907 algorithms or a profitability backtest.

| Source | Pinned revision | Documents | What it contributes |
| --- | --- | ---: | --- |
| [Quant-Trading-Strategies](https://github.com/brainbrick-trades/Quant-Trading-Strategies) | `a76cc4413f3c73ddaff2be9c1ca26461a94126a2` | 101 | Structured hypotheses, mathematical definitions, data and testing requirements |
| [The-Quant-Trading-Vault](https://github.com/brainbrick-trades/The-Quant-Trading-Vault) | `c9d6fa49486855899a92fea65004f440533049aa` | 5,806 | Indicator and strategy snippets, many tied to TradingView or FMZ |
| User image | supplied September 28 | 1 | Research process, realistic friction, benchmarks, robustness, reporting and invalidation |

Vault language counts from actual source headers: Pine Script 5,283; JavaScript 362; Python 131; MyLanguage 27; C++ 3. These differ slightly from the approximate README table. Most Vault documents do not declare a structured asset class; the catalog leaves that unknown instead of inferring tradability from a title. Family tags use titles and are discovery aids, not audited classifications.

The documents' installation commands, agent contracts and role prompts were treated as source material. No AgenKit package was installed, no embedded code was executed, and no suggested exchange integration was activated. The image's claims about available data/tools are not evidence that those feeds exist here.

## Source quality findings

The text screen found 72 documents with lookahead-on settings, 766 with multi-timeframe/security or repainting references, 313 with inventory-escalation patterns, and 341 with FMZ runtime dependencies. Counts overlap. These are review flags, not confirmed defects: a higher-timeframe call can be valid when properly lagged, and lookahead-on can be valid with explicit offsets. Conversely, absence of a flag does not establish correctness. Five groups share identical whitespace-normalized fenced code; many more economically correlated variants likely remain. Hash equality does not measure independent alpha.

The Vault multi-asset momentum tutorial adjusts trades around a stored base price with per-asset thresholds. It is not a cross-sectional monthly ranking allocator. Its original exchange objects and account calls require FMZ; they cannot be pasted into this Node trading service.

The Vault ATR example uses an EMA of typical price plus an EMA of true range. ATR smoothing conventions must be preserved or an altered version labeled explicitly. Its short futures positions, funding, margin and liquidation assumptions cannot transfer to a cash-only crypto book.

The Vault dynamic-spread market-making file describes an SMA-centered quote model with inventory limits. The README presents it under an Avellaneda–Stoikov heading, but the inspected snippet does not implement that model. Price touching a simulated quote is insufficient evidence of a real maker fill.

The Donchian specification defaults to **fade**, with breakout as an explicit alternate mode. Its bands exclude today's signal bar. Silent translation to a breakout strategy or an including-today channel changes the strategy. The IBS specification is a dollar-neutral cross-sectional long/short fade; a long-only ETF dip strategy must be evaluated as a distinct adaptation.

The Vault README claims MIT licensing, but neither pinned checkout contains a top-level LICENSE/COPYING file. The first repository has no explicit license grant in its checkout. This integration stores discovery metadata, hashes and source links plus original integration notes; it does not vendor source blocks or the full specification text. Resolve grants and upstream author attribution before redistributing implementations copied from these sources.

## Fit with the existing workstation

| Priority | Research idea | Existing fit | Required next work |
| --- | --- | --- | --- |
| 1 | Dual momentum and moving-average trend | `robinhoodEquitiesStrategy.js` already combines SPY trend with ETF 12-1 rotation | Compare distinct gates and cash alternatives; avoid duplicate strategy claims |
| 2 | Volatility targeting | ETF risk overlay candidate | Unlevered, capped shadow version; lagged estimator; crash-lag and turnover stress |
| 3 | Explicit Donchian breakout | Crypto spot challenger | Qualified OHLC aggregation; exclude signal bar; existing friction core; long-only adaptation |
| 4 | ATR envelope trend | Crypto spot challenger | Translate signal math into pure shadow functions; no futures assumptions |
| 5 | IBS mean reversion | ETF diversification hypothesis | Consistent adjusted OHLC, zero-range rejection, long-only redesign, next-session fills, settlement |
| 6 | Equity cross-sectional momentum | Stock lane described in registry | Point-in-time universe, delistings and corporate actions; ETF tape alone is insufficient |
| Deferred | Market making and grids | Simulator research only | Queue, partial fills, cancel latency, adverse selection, inventory and tail losses |
| Deferred | Options, FX carry, futures basis, fixed income | Missing venue/data/model prerequisites | Contract histories, Greeks/assignment, borrow, funding, curves or derivatives infrastructure as applicable |

These priorities measure implementation fit, not Sharpe or expected profits. The existing tactical ETF book is documented as drawdown control and has previously trailed SPY on out-of-sample return. Adding related momentum specs does not change that evidence. Crypto mean reversion must compete against fees and spread; a high win rate alone does not establish positive expectancy. Grid inventory can hide losses until a trend break; measure full marked equity rather than closed-trade gains.

Polymarket and Kalshi need probability and settlement models, not blind ports of price indicators. A probability contract has bounded payoffs, resolution rules and outcome dependence. Cross-market combinations need joint-outcome risk and executable prices; ordinary equity pairs/correlation assumptions are not sufficient.

## Research process adopted from the image

1. Describe market, regime, coverage and economic thesis before selecting parameters.
2. Freeze the candidate, data window, benchmark and parameter search budget; log all trials.
3. Replay with qualified executable prices, delayed fills, spread, fees, slippage, depth, latency and buying-power constraints.
4. Preserve chronological holdout; tune within training data, then test walk-forward and nearby parameter values without using holdout to pick the winner.
5. Evaluate multiple regimes, tail events, cost stress and concentration. Track correlated families and effective trial count.
6. Compare after-cost results with cash, asset buy-and-hold, current incumbent and appropriate broad/sector benchmarks.
7. Report return, CAGR, Sharpe, Sortino, drawdown, win rate, profit factor and turnover where supported. Missing metrics stay null with reasons; use correct units and annualization for each market.
8. State invalidation triggers, data limitations and deployment prerequisites. Existing evidence lifecycle and trader gates decide admission.

The image's suggested Sharpe >1 and drawdown <30% are preferences, not universal guarantees or replacements for lane policy. There is no newly validated winner, no synthetic performance report, and no automatic paper or live promotion. Producing 3–10 actual validated strategies requires authentic historical data and executable replay evidence that this source review does not supply.

## Implementation and usage

- `src/quant-catalog.json`: bundled metadata snapshot with pinned source links and file SHA-256 values.
- `scripts/index-quant-research.mjs`: offline read-only indexer over two local checkouts; no runtime downloads.
- `src/quantResearchCatalog.js`: bounded search, shortlisted lane mappings and research/report contract.
- `GET /api/quant-research?q=momentum&source=specs&limit=25`: searchable metadata; supports source, family, language, offset and limit (maximum 100).
- `GET /quant-research`: browser library with search, pagination, shortlist and checklist; linked from the Research Monitor.
- `GET /api/research-monitor`: now includes catalog counts and provenance under `quantResearch`.

Rebuild with `node scripts/index-quant-research.mjs <Quant-Trading-Strategies checkout> <The-Quant-Trading-Vault checkout>`. Review changed commits, counts and links before adopting a new snapshot. The catalog lives under `src` and the viewer under `public`, both covered by the existing release allowlists.

Strategy-search execution remains owned by the separate Evolution Lab. This change supplies a research input and review surface; it does not register these documents as executable Lab adapters. The next implementation should be a small shadow challenger package with authentic replay data, starting with volatility targeting or explicit Donchian/ATR spot adaptations, then tested through existing evidence gates before paper admission.

## Verification

`npm run test:all` completed successfully: 954 passing tests across the invoked suites, zero failures. This includes four new inventory/search/safety and HTTP checks. `npm run selftest` passed, both pages' inline scripts parsed successfully, and `git diff --check` passed. The HTTP test uses isolated temporary data and stubs external requests. Native desktop layout and click behavior were not visually exercised; the local library link uses same-window navigation to comply with the existing Electron navigation policy. No package was built or installed, and no new trading profitability result is claimed.
