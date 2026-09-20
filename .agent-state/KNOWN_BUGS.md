# Known bugs / findings (2026-09-16)

## Open — data/evidence (see `.agent-state/DATA_DECISION_MEMO.md`)
1. **Paper bankroll identity broken:** `paperStartSol=1` + `realizedLifetimePnlSol≈−0.404` does not equal marked equity `≈0.052 SOL` (hole ~0.54 SOL). History is capped at 1500; live ledger window is shorter than cash path. Do not promote or reset without an explicit snapshot.
2. **Meme paper is a median loser:** last 1500 closes median return ≈ −1.55%, PF ≈ 0.67, 215/1500 stale-purges. Runtime still SPRINT/100 on ~0.05 SOL.
3. **Edge proof INCONCLUSIVE (45).** 2026-09-15 “PROVEN 100%” was outlier-contaminated; reject. COLD liquidity “positive” lead is mostly $1 placeholder vs real pools; Q4 median still negative.
4. **Polymarket 42/42 WON is early-exit censoring**, not gamma settlement. Reviewed repair books closed Gamma markets and lost combo legs, keeps unknown outcomes OPEN, and reports conservative ROI. High-turnover strategy `keep=false`. Live journal was not rewritten by tests.
5. **Proposal-stage wait is short; discovery is the slow stage.** Memo mean `proposal_ms` ~7–8 min is end-to-end including discovery/outliers. Direct ready-to-proposal instrumentation supersedes that bottleneck label. Execution calibration n=0. Cluster champion 1068× is synthetic 5m GA with empty `shadow.trades`.
6. **Impossible historical SOL balance jumps** still unresolved (`state.bad-70sol-*` equity 71 on start 10).

## Open — product
1. **Visual leftovers after alpha42 art pass**: product mark remains the photoreal spiked-cash render (kept as the existing brand; Win98 desktop icons stay pixel/bevelled). Packaged macOS dock still has no `build/icon.icns` in this tree. Bliss watermark plate was cloned over with grass and the WallpapersWide JPEG comment was stripped; a faint clone seam is possible only at 100% 4K zoom. Motion FX still owns `#horizonFire` / `#bottomFire` (cartoon flame sprites stay hidden; CSS heat haze on losses; money rain is profit-only). Placeholder settings/sportsbook icons were reverted to the shaded originals; hill-foreground no longer double-loads the wallpaper.
2. **Polymarket US auth fails**: every signed call returns `401 API key not found` with the stored key. Signing verified against docs; clock skew 0. The key must be regenerated at polymarket.us/developer. The alpha40 UI shows `KEY REJECTED — regenerate at polymarket.us/developer`.
2. **Combos/RFQ beta gate**: `POST /v1/combos` and `/v1/rfqs*` are only enabled for allow-listed Retail API keys. alpha40 classifies a 403 as `betaNotEnabled`, disables the real autopilot, and offers "Copy legs" for manual placement.
3. **Unverified fills cannot be resolved automatically** if an RFQ fill never exposes `rfqCreatorOrderId` (cycle-3 MAJOR-1/2). They stay open, flagged "unverified fill", never book P/L, and can be dropped with the "Forget…" button (local journal only).
4. Settlement/order payload shapes (`/v1/order/{id}`, `/v1/markets/{slug}/settlement`) were implemented from docs, not observed live. First real trade should confirm them.

## Fixed in alpha40
- US live sports never surfaced in the scanner (stale `live:true` events intersected with the first 500 catalog rows) → date-windowed in-play scan; `liveSports` ≈ 145 now.
- Gateway BBO blocked by Cloudflare (no User-Agent) → UA header; opportunity rows show real bid/ask.
- `feed.ageMs` negative on healthy snapshots.
- Stake-cap bypass via RFQ notional, quote↔legs binding, placement re-entrancy, fabricated wins for unfilled orders, journal entries dropped on auth errors (verifier cycles 1–2).

## Fixed in alpha41
Repeated market polling/rate limits, frozen paper crash marks, fee-blind break-even, paper cash-out depth, fees outside US stake caps, expired cached legs, selecting already-open games, and missing order remainder treated as a fill. See EXECUTION_UPDATE.md for semantics and limits.
