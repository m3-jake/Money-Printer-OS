# Robinhood Social feasibility and current lane diagnosis

Checked October 3, 2026. The user confirms Social access. No trader profile/post links have been supplied, so no actual Social candidates or copied signals have been identified or admitted.

## Confirmed official capabilities

[Robinhood Social](https://robinhood.com/us/en/social/) advertises profiles, shared portfolios, verified P&L and discussion across asset classes. [The support article](https://robinhood.com/us/en/support/articles/robinhood-social/) explains that eligible trades are manually shared after confirmation; trading statistics are optional. Quick trade initiates a trade from a post. Shared posts therefore do not establish a complete, timely entry/exit ledger or copyable profit.

The [Social agreement](https://cdn.robinhood.com/assets/robinhood/legal/robinhood_social_user_agreement.pdf), page 4, prohibits automated access/collection. No documented Social profile/trade-feed API was found in the official materials checked. Do not invent a private endpoint, repurpose Crypto API credentials as Social access, or call a marketing example a real leader.

[Robinhood's official agent interface](https://robinhood.com/us/en/support/articles/agentic-trading-overview/) can read the user's own accounts, positions and transaction history; its [documented tools](https://robinhood.com/us/en/support/articles/trading-with-your-agent/) include market data and watchlists. Those capabilities do not demonstrate access to other users' Social trades. Account integration and Social leader discovery are separate prerequisites. Existing paper-only order boundaries remain unchanged.

## Live app diagnosis

The installed API returned 200 with authenticated v2 quotes for eight crypto pairs, valid configured feed keys and a running 15-second loop. This is not a dead quote connection.

- Strict book: no open positions or closes; BTC and ETH currently reject `lowVol`.
- Current account fee model: 0.95% per side. Including spread and modeled slippage, round-trip cost is about 2.0%; the existing 1.5× gate requires about 3.0% expected movement.
- Observed expected movement at this snapshot: BTC about 0.254%, ETH about 0.267%, both below that gate.
- Separate exploratory book: enabled, three open positions and three completed positions. Completed net P&L about -$0.117. These exploratory observations do not count toward strict qualification.
- Practice sandbox: one open position, explicitly excluded from strategy evidence.

These are snapshot observations, not forecasts or recommendations. Fee routing and assumptions should remain source-labelled; the current [official fee schedule](https://cdn.robinhood.com/assets/robinhood/legal/rhc-fee-schedule.pdf) documents the entry Smart Exchange Routing tier at 0.95%. Do not lower costs or gates merely to create activity.

## Next step requiring actual Social activity

Obtain user-provided profile/post links or manually supplied screenshots/exported observations from their legitimate Social access. Review real entries and exits, posting delays, sample completeness, drawdowns, concentration, after-cost follower outcomes and instrument support. Record first receipt times; late shared posts cannot become earlier signals. Keep stocks/options/crypto separated. Candidate discovery can use shared performance, while prospective paper copying needs attributable, fresh trade observations and an explicit exit policy.

Until an approved feed or sufficient user-provided observations exists, Social is a candidate discovery source rather than an operational automated copy lane. No leaders were fabricated, no order was sent, no book reset, no live scope enabled and no trading policy changed during this feasibility check. The raw runtime snapshot stays local because it can contain account information.

## Prior review publication

The completed desktop work was pushed and remote heads verified: trader `03a8c03` on `main`, Lab `4564b30` on `master`. The Lab repository is private. Review starts at `docs/LLM_REVIEW.md` in the trader repository.
