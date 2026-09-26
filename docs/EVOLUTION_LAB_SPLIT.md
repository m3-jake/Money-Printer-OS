# alpha.53 — the Evolution Lab becomes its own app

## Why

Every Money Printer OS install (the Mac laptop included) ran the full strategy furnace in
process: the evolution daemon, the BEAST/GPU scorer, the robustness audit and the research
cluster. On the Windows workhorse in BEAST mode the daemon completed a generation every ~400 ms
and pushed a ~290 KB `evolution-sync` snapshot into the trader's `actions.ndjson` several times a
second. On 2026-09-18 that queue reached 23 GB, `drainActions()` could no longer read it into
memory, four orphaned `.drain` files added another 77 GB, the disk filled (`ENOSPC`), and every
child process crash-looped. The laptop paid the same CPU/RAM cost for research it cannot use.

## What changed

**Moved to `money-printer-evolution-lab`** (separate repo/app, Windows only):
`src/evolutionEngine.js`, `evolutionLoop.js`, `evolutionPool.js`, `evolutionScoring.js`,
`evolutionSearch.js`, `evolutionWorker.js`, `evolutionGpu.js`, `gpuFurnaceContract.js`,
`evolutionEvidence.js`, `evolutionBench.js`, `evolution.js`, `clusterHub/Client/Worker/Store.js`,
`researchAudit.js`, `research/gpu-furnace/`, `scripts/beast-*.mjs`, `artifacts/beast-*`, and
their tests. The scorer, promotion gates and champion contract are unchanged and their tests
run verbatim in the lab repo.

**Kept in the trader**: engine, network mesh, evidence collector, the read-only research
control plane / evidence store the HUD reads, `learner.evolutionChampionPolicy` (the gates).

**New: the lab link** (`src/labLink.js`, schema `mpo.lab-*.v1`):

| Direction | File | Cadence |
| --- | --- | --- |
| lab → trader | `<data>/lab-link/status.json` (compact loop view, ≤ 64 KB) | ≤ 1/s |
| lab → trader | `<data>/lab-link/champion.json` | only when the champion changes |
| lab → traders elsewhere | `<bridge>/lab-link/status.json`, `champion.json` (HMAC-signed) | status ≤ 1/min, champion on change |
| trader → lab | `<data>/lab-link/dataset.json` (5m labeled outcomes with features) | on change, ≤ 1/min |
| trader → lab | `<data>/lab-link/trader-status.json` | ≤ 1/min |
| trader → lab elsewhere | `<bridge>/lab-feed/<node>.dataset.json`, `<node>.trader-status.json` (signed) | ≤ 1/5 min |

`cycle()` calls `syncLabLink(s)` right after draining dashboard actions and before resolving the
champion policy, so `s.evolutionLoop` is the lab's view and `evolutionChampionPolicy` re-checks
every gate exactly as before. After the learner settles outcomes, `publishLabFeed(s)` exports the
dataset. The bridge is the existing `MONEY_PRINTER_BRIDGE_DIR` / `MONEY_PRINTER_BRIDGE_KEY`.

**Action-queue rails** (`src/store.js`): an action above 512 KB is refused; a queue file above
64 MB is quarantined (renamed `actions.ndjson.quarantined-<ts>`, journalled, never read into
memory or deleted); `.drain` orphans older than 5 minutes are swept once a minute.

**Supervisor** (`desktop/main.cjs`): no `evolution`, `clusterHub`, `clusterWorker` or
`researchAudit` children. `research-supervision.cjs` reports a leftover `research-beast.json` or
`MPO_RESEARCH_BEAST` but never honours it.

**HUD**: the Evolution panel shows the link state (`NOT LINKED` / `STALE` / linked via this
machine or bridge, lab name/version, status age) above the usual metrics; `/api/state` carries
`labLink`; `/api/research-monitor` reports `source: 'evolution-lab'` when linked.

## Migrating a machine

1. Install alpha.53. The trader starts with `evolutionLoop` from its last state until the lab
   publishes; the HUD says `NOT LINKED` until then.
2. Windows workhorse: install/run the Evolution Lab. On first run copy the old loop into the lab
   data dir so research continues from the same generation and champion:
   `evolution-loop.json`, `research-furnace.json`, `research-beast.json`, `research-evidence/`
   from `%APPDATA%\Money Printer OS\data` → `%APPDATA%\Money Printer Evolution Lab\data`.
3. Delete the leftovers in the trader data dir once alpha.53 has quarantined them:
   `actions.ndjson.quarantined-*`, `actions.ndjson.*.drain` (≈ 100 GB on WITCHDOCTOR).
4. Laptop: nothing to configure. With the bridge set in `.env` it receives the champion within a
   minute of publication and its dataset reaches the lab within five.

## Verification (Windows, 2026-09-19)

Trader tests: every file passes except the four failures that already fail at alpha.52 on
Windows (`hypothesis-miner` 1, `replay-lab` 1 path case, `visual-assets` 2). New:
`tests/lab-link.test.mjs` (5), `tests/action-queue-rails.test.mjs` (3), updated
`research-supervision.test.cjs` (4). Lab tests: 18 files, all passing (parity, sync, pool,
furnace, evidence, feed, publish, server, supervision).

End to end on the real Windows data: the trader exported 1,089 rows (676 KB); the lab resumed
the migrated loop at generation 52,088, ran 52,089 in 189 ms on 8 CPU workers, published
`CROSS-G11019-575` (1.5 KB) plus a 19.6 KB status; the trader applied it through
`evolutionChampionPolicy` and the dashboard reported the link as connected.

## Verification (macOS, 2026-09-19)

`npm run test:lab-link` (`tests/lab-link.test.mjs` + `tests/action-queue-rails.test.mjs`) is
green on this Mac: **8/8**. No Evolution Lab is configured on this machine, so the HUD's
Evolution panel correctly shows `NOT LINKED` — that is the expected state here, not a fault.
This does not verify, and should not be read as verifying, Windows connectivity; the
cross-machine link (lab ↔ trader over the bridge) is exercised only on Windows, per the
section above.

## Lab tape and family champions (2026-09-26, batch 13)

The review `reports/SOLANA-ROBINHOOD-LAB-REVIEW-2026-09-26.md` §5 extends the link for venue tape. The first venue is
Robinhood.

| Direction | File | Bounds |
| --- | --- | --- |
| trader → lab | `<data>/lab-link/tape/<venue>/<SYMBOL>/<YYYY-MM-DD>.p<N>.ndjson` | sealed complete UTC days, immutable, ≤ 16 MB each, ≤ 8 sealed per call, 1 GB quota |
| trader → lab | `<data>/lab-link/tape/manifest.json` (`mpo.lab-tape-manifest.v1`) | ≤ 256 KB, rewritten ≤ 1 per 10 min |
| trader → remote lab | `<bridge>/lab-feed/<node>/tape/...` plus signed `<node>.tape-manifest.json` | 1 segment per call, ≤ 64 MB per UTC day, sha256 re-checked before copy |
| lab → trader | `<data>/lab-link/tape-ack.json` or signed `<bridge>/lab-link/ack/<node>.json` (`mpo.lab-ack.v1`, `ingested:[sha256]`) | acked segments are deleted a week later; everything goes at 45 days; oldest first over quota |
| lab → trader | `<data>/lab-link/champion-<family>.json` (or signed bridge copy), `mpo.lab-champion.v1` with `family`, `params`, `paramsHash`, `evidence` | ≤ 64 KB; accepted ≤ 1 per hour |

- **Code:** `src/labTape.js` (`publishTape`) and `readFamilyChampion` in `src/labLink.js`.
- **Robinhood hook:** the loop tick calls both at most every 5 min (`labSync` in `src/robinhoodAutoTrader.js`). `MPO_LAB_TAPE=false` stops the sealing.
- **Champion acceptance** (`offerLabChampion`):
  - It is accepted only with `evidence.quoteSource === 'robinhood'` and `evidence.testCloses >= 100`.
  - `paramsHash` must hash the Lab's own full set.
  - Only the 12 search keys are taken, and each must be within bounds.
  - It is then **proposed** (APPLY, or `ROBINHOOD_EVOLVE_AUTOPROMOTE=true`), paper only.
- **When the Lab is off:** the trader keeps its params and keeps sealing locally under the quota. Nothing is queued anywhere.
- **Lab side (not built yet):** it needs to read the manifest, verify each sha256, ingest, write the ack, and publish `champion-robinhood-breakout.json`. That is a Lab-repo session.
