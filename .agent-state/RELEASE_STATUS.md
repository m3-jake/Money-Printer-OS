# Release status — alpha.52 (integration candidate, NOT deployed)

Branch `agent/integrator/20260916-233900-fdce2-alpha52-release-integration---merge` @ `804b822`.
Merged frontend UI reconciliation (2583a) + backend research control-plane (2e4ef).
Resolved the sole conflict, `src/dashboard.js` (UI/API contract), by composing the frontend
leaderboard enrichment on top of the backend control-plane source:
`researchMonitorState -> decorateResearchMonitor(attachControlPlaneToMonitor(raw, plane), s)`;
adopted backend `systemView(s, policy)` and `evolutionLoopView(e,{now})`.
Tests: test:all 305/305, visual+renderer 25/25, release-gate 6/6, selftest PASS, doctor OK.
PAPER Solana starting balance default reset to exactly 1 SOL (`src/config.js`, `.env.example`);
research/journal/Polymarket stores untouched. Manual real-money gates intact
(liveExecution=manual, automaticLivePromotionAllowed=false, liveActivationAllowed=false).
Version bumped 0.5.0-alpha.51 -> 0.5.0-alpha.52. NOTE: task text said "3.0.0-alpha.52";
kept the established 0.5.0-alpha.NN line pending confirmation of any major-version jump.
Rollback tag `alpha52-integration-rollback` -> `f378eca`. Not merged to main; not deployed.

---

# Release status — alpha.41

Installed and running in /Users/bing/Applications/Money Printer OS.app on 2026-09-15. Archive: Current/MPO-alpha41-release.asar. SHA-256: a0a460636a1794525fe12797b9e7181814f44975891d0a25b8a434de7a6c6f2b.

55 regressions passed. Runtime build version verified; HEALTHY after initial provider backoff, 13 fresh held prices at inspection, no timeouts. Three stranded paper crash positions closed after confirmation.

Rollback: /Users/bing/Library/Application Support/Money Printer OS/backups/alpha40-before-alpha41-20260915-100119/app.asar (and app.asar.previous). Do not restore account snapshots merely to roll back code.

Packaging: python3 .workflow/scratch/release-alpha41.py pack|install|restart. Historical alpha40 scripts still target the old release and must not be used for alpha41.

Windows remains offline. Polymarket US credentials rejected; no session was armed or real order placed.
