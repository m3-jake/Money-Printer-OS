# Release status — alpha.53 (packaged, NOT installed by an agent)

Version `0.5.0-alpha.53` (`package.json`, unchanged this pass). Packaging implemented and run
by the `packaging` work package (ledger M7, M8 release/integration half), per
`.workflow/scratch/PACKAGING.md` §6 and `.workflow/scratch/PLAN.md` §6, on top of this tree's
HEAD at packaging time.

**Folded forward from the undotted `agent-state/RELEASE_STATUS.md` (now deleted — see
`.agent-state/INTEGRATION_LEDGER.md` for the duplicate-directory decision), night finish-up
notes prior to packaging:**
- Tests: `npm run test:all` exit 0 after paper-identity + equity-jump guards (replay-lab
  24/24; accounting integrity includes new identity/jump cases).
- Selftest / doctor: PASS / OK (paper mode, live gate false, production learning LOCKED).
- Accounting: live RO `state.json` identity hole = 0; historical `state.bad-70sol-*`
  documented; save refuses single-save equity teleport; load flags absurd open realized.
- Rollback: prior app.asar backups under Application Support remain untouched.

## Packaging results (this pass)

- **HEAD packaged:** `2420d77c3e8b770375239f03f879a3e89f61851d` ("mpo: product") — the commit
  on `main` at the moment `packaging` ran, **before** this packaging commit itself lands.
  `scripts/release-alpha53.mjs pack` records its own `commit = git rev-parse HEAD` at pack
  time into `release-record.json`; see below for the actual packaged commit, which is the
  packaging commit itself (pack runs after this file is committed, per the script's own
  git-clean precondition).
- **Integration state at packaging time (IMPORTANT — read before treating this artifact as a
  final ship candidate):** merge order per `PLAN.md` §7 is ship-fixes → accounting → product →
  visual → packaging. At the time packaging ran, only **product** (`2420d77`) was merged onto
  `main`; **ship-fixes** was committed on its own branch (`wf/ship-fixes` @ `971a168`) but not
  yet merged; **accounting** and **visual** had uncommitted work-in-progress in their own
  worktrees, not yet committed or merged. **This means the `.asar` packaged and recorded below
  reflects `main` HEAD as of `product`, not the fully-integrated alpha53 tree** — it does not
  yet contain ship-fixes' `test:visual` wiring/doctor `--offline` flag/doc fixes, accounting's
  `REALIZED_WITHOUT_BASIS` guard and the other F1–F8 fixes, or visual's CSS/markup
  consolidation. Per `PLAN.md` §7's own warning ("any merge after it invalidates the recorded
  hash"), **this SHA-256 must be treated as a mechanism proof, not a final release artifact.**
  Once ship-fixes/accounting/visual land on `main`, re-run `node scripts/release-alpha53.mjs
  pack` to produce the real ship candidate and replace this record.
- **Version:** `0.5.0-alpha.53` (asserted by `pack`; matches `package.json`).
- **Tests re-run for this record:** `npm run test:release-gate` → 6/6 pass. `npm run selftest`
  → `SELFTEST PASS`. `npm run test:all` → exit 0 (full chain, on the pre-packaging-commit
  `main` HEAD described above). `node --test tests/renderer-alpha52.test.mjs
  tests/visual-assets.test.mjs tests/visual-contract.test.mjs` → 25/25 (run by explicit path;
  `test:visual` npm alias does not exist on `main` yet — ship-fixes owns adding it, contract
  C2). `node src/doctor.js --offline` **was not run**: `main` does not yet have ship-fixes'
  `--offline` flag (`src/doctor.js` still unconditionally calls `benchmarkRpcs()`), and running
  it without that flag would make live RPC network calls, which the workflow's hard
  constraints forbid. This is an honest gap, not a skipped requirement — re-run once
  ship-fixes merges.
- **Asar artifact:** `<FILLED BELOW BY PACK — see release-record.json>`
- **Archive contents verified:** see `asar-manifest.txt` / the grep proof in `PACKAGING-RUN.md`
  under `.workflow/scratch/packaging/` — zero `.env`, zero `.agent-state`/`agent-state`/
  `research`/`artifacts`/`.workflow`/`.git`, zero non-empty `data/*`, exactly one
  `build/icon.icns`; `.env.example`, `desktop/main.cjs`, `src/index.js`,
  `public/dashboard.html`, `public/css/mpo-shell.css`, `package.json` all present.
- **Rollback path:** app-level — `Contents/Resources/app.asar.previous`, written by both a
  manual install and the app's own auto-updater on every asar swap
  (`desktop/main.cjs:206-209,229`). Data-level — a timestamped
  `~/Library/Application Support/Money Printer OS/backups/<label>-<ts>/` directory holding the
  state/journal files from immediately before the swap. Neither was created or touched by this
  packaging pass — no agent installs, and none of `~/Applications` or
  `~/Library/Application Support/Money Printer OS` was written to.
- **Install / restart — for bing, not an agent:**
  ```
  node "/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release-src/scripts/release-alpha53.mjs" install
  node "/Users/bing/Desktop/Money Printer OS/Current/MPO-alpha53-release-src/scripts/release-alpha53.mjs" restart
  ```
  Both verbs hard-refuse under an agent session and print this same guidance; only bing, from
  his own terminal, after confirming no real Solana/Polymarket-US session is armed, should run
  them. (And, per the integration-state note above, only after re-packing the fully-merged
  tree.)
- **Honest status: packaged, NOT installed by an agent.** No promotion past `candidate` is
  possible or attempted — see `docs/WINDOWS-RELEASE.md` for why (`tests.windowsBoot` and
  `artifacts.windows.sha256` do not exist in this repo).
- **`.build-version` / `.build-commit`:** restamped to `0.5.0-alpha.53` /
  `2420d77c3e8b770375239f03f879a3e89f61851d`. **These two files are cosmetic** — read by no
  code in this repository (`grep -r "build-version\|build-commit\|BUILD_VERSION\|BUILD_COMMIT"`
  across the tree returns nothing outside the files themselves and this note). The
  authoritative packaged commit is whatever `release-record.json.commit` says, not these files.

---

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
