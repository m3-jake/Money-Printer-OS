# Structure audit: Money Printer OS and Evolution Lab (2026-10-03)

The question bing asked: are both apps structured in the way that best serves their goals?

| App | Its goal |
| --- | --- |
| Money Printer OS | A personal paper desk: Robinhood and Kalshi autopilot bots plus copy trading, always on and always visible, with a lightweight web demo for showing people. Not a product. |
| Evolution Lab | Use this PC's power to improve the trading modules, and hand the improvements back to the trader. |

All measurements below were taken on WITCHDOCTOR against trader `0.5.0-alpha.85` (c1202de) and the Lab at
`2c083f4`. This report is structural only. It changes no trading behaviour.

## Verdict

**Neither app is structured optimally. Both are carrying the shape of earlier goals.**

- **Money Printer OS** still has the shape of a Pump.fun bot that grew other venues.
  - One process runs every venue's loop and also serves the HUD. One stuck await in Pump.fun froze everything for
    100+ minutes (fixed in alpha.85 by a watchdog, but the coupling is still there).
  - Pump.fun, whose verdict is PARK, is still the largest code path and the largest CPU cost.
- **Evolution Lab** still has the shape of the retired furnace.
  - 171 KB of furnace-era code ships beside 83 KB of the Workbench, which is what actually does the job.
  - Two schedulers run side by side, plus a process (`labLoop`) whose only job is to publish a heartbeat.
  - It uses under 4% of the CPU on a 16-core machine. Its goal is to use the PC.
- **Shared problem: the two repos disagree about the strategies they share.** The Lab evaluates a Robinhood
  strategy whose fill model and cost floor differ from the ones the trader actually runs. A Lab result for that
  module therefore does not describe the trader's bot.

## Measurements

| What | Money Printer OS | Evolution Lab |
| --- | --- | --- |
| Long-running processes | engine + HUD (one process), research collector, network mesh, Electron | `labServer`, `labLoop` (heartbeat only), workbench daemon, `moduleScheduler`, `moduleResearch`, Electron (8 processes, ~970 MB) |
| CPU while running | engine cycle 0.25–3.6 s every 45 s; collector ~20% of a core | under 4% of the machine |
| Unreachable source (not imported by any entry point) | 25 files, 167 KB (mostly offline CLI tools inside runtime `src/`) | `evolutionBench`, `researchBench`, `laneRegistry`, orphan `weatherReplayWorker.js` |
| Code for a retired or parked goal | Pump.fun engine path (the largest) | 171 KB furnace-era code (evolution engine, GPU, BEAST, cluster, learner) vs 83 KB Workbench |
| Largest single UI file | `public/dashboard.html` 328 KB, mostly one inline script | — |
| Agent docs read before work | `MONEY_PRINTER_STATUS.md` 187 KB (~47k tokens), `PROGRESS.md` 99 KB, `.agent-state/`, 8.1 MB `reports/` | 12 docs |
| HUD API latency | fine (measured) | fine |

### Copies shared by both repos that have drifted

Ten files have the same name in both repos but different contents. The two that matter:

| File | Trader | Lab | Consequence |
| --- | --- | --- | --- |
| `robinhoodStrategy.js` | trader fill model, `costMultiple` floor 0.1 | different fill model, floor 0.5 | the Lab ranks a strategy that the trader does not run |
| `robinhoodEvolve.js` | `maxHoldMin` up to 720 | up to 4320 | the Lab can propose holds the trader clamps away |

`computeLease.js` had also drifted; alpha.85 copied the Lab version back into the trader.

## Recommendations, by priority

### S1. One shared strategy core, enforced by a parity test (both apps)

- **Why first:** this is the only finding that makes the Lab's output *wrong* rather than slow. The Lab exists to
  improve the modules, so it must score the code the trader runs.
- **Change:**
  - make the trader the single owner of each strategy, fill and fee model: `robinhoodStrategy`, `robinhoodEvolve`,
    the Kalshi bot params, the weather model and `computeLease`;
  - the Lab imports these files from the trader checkout, or from a vendored copy stamped with the trader's
    commit;
  - a parity test in each repo fails when the hashes differ;
  - the Lab's wider search ranges (for example 1–3 day holds) become the trader's parameter bounds, so a Lab
    proposal can never be clamped away.
- **Size:** medium. It is mechanical once the owner is chosen.

### S2. Isolate the HUD from the trading loops (Money Printer OS)

- **Why:** the desk's job is to stay on and to stay visible. Today the HUD server shares one event loop with every
  venue's cycle. A slow Solana RPC call in Pump.fun's risk step (~11 s) delays both the Kalshi bots and the
  dashboard.
- **Change, in steps:**
  1. Run each venue loop on its own timer with its own budget and stall watchdog: Pump.fun, Kalshi bots and farm,
     Robinhood, the copy books. A stall in one venue is then that venue's problem only.
  2. Move the Pump.fun engine into a worker thread (or a child process under the existing supervisor). The
     HUD reads its state from the books on disk, as it already does for the other venues.
  3. Move the risk lookups off the cycle. This is already listed as an open item in PF-7.
- **Size:** step 1 is small to medium; step 2 is medium.

### S3. Shrink Pump.fun to match its PARK verdict (Money Printer OS)

- **Why:** the desk's focus is Robinhood, Kalshi and copy trading. The parked venue should not be the biggest CPU
  and maintenance cost.
- **Change:**
  - keep the Pump.fun paper engine running on a slower cadence;
  - keep the wallet-copy book, which is part of copy trading;
  - stop the raw research captures that only the retired furnace consumed (the collector's remaining ~20% of a
    core);
  - cap `research-evidence`.
- **Size:** small (configuration plus the collector schedule).

### S4. Make the Lab one pipeline that uses the machine (Evolution Lab)

- **Why:** its goal is to use the PC's power. Today it idles, and its structure still describes the furnace.
- **Change:**
  - **One scheduler.** Fold `moduleScheduler` into the workbench daemon, which already owns the leases, the CPU pool
    and the job queue.
  - **No heartbeat-only process.** The workbench publishes `lab-link/status`, and `labLoop` is removed from the
    supervisor.
  - **Archive the furnace.** Move the evolution engine, the GPU furnace, BEAST, the cluster hub/worker and the
    learner to `archive/` (or a git tag), along with their 29 test files. Delete the unreachable bench files and
    the orphan worker.
  - **Fill the machine.** When the lease budget is idle, the daemon keeps a standing queue of replay searches (weather
    re-priced against Kalshi settlements, Robinhood multi-day crypto, Kalshi bot-param replay, copy-leader replay
    once 14 snapshots exist). It stays inside the existing desktop and RAM headroom, and the search counts feed
    the multiple-testing correction. This matches the earlier Lab audit: the bottleneck is evidence, and spare cores
    should become more replays of the recorded tape, not bigger searches over the same ~2k samples.
- **Size:** medium. The scheduler merge and the archive are mechanical. The standing queue is new code.

### S5. Move tools out of the runtime (Money Printer OS)

- **Change:** move the 25 unreachable `src/` files to `tools/` (offline CLIs) or delete them (dead). Then
  `src/` is exactly what ships and runs, and the reachability script can become a test.
- **Size:** small.

### S6. Split the HUD script (Money Printer OS)

- **Change:** break `dashboard.html`'s inline script into ES modules: one per window plus shared glass and chart
  helpers. The web demo build already bundles `public/`, so the demo keeps working.
- **Payoff:** cheaper edits for agents. It also avoids the `$$` replace trap and file-wide merge conflicts between
  Claude and Codex.
- **Size:** medium. Do it window by window, never in one pass.

### S7. Trim what agents must read (both apps)

- **Change:**
  - `MONEY_PRINTER_STATUS.md` keeps the current state and the last ~5 batches, at most ~20 KB;
  - older batches move to `docs/history/`;
  - `PROGRESS.md` and the dated audit docs fold into that history;
  - `reports/` (8.1 MB) moves out of the repo or into `.gitignore` except for the latest of each kind.
- **Why:** with two agents working in parallel, every session pays ~47k tokens before doing anything. Stale
  sections also contradict the current code.
- **Size:** small.

## Suggested order

1. **S1, the parity core.** It changes what the Lab measures, so do it before any more Lab results are used.
2. **S5 and S7, the cleanup.** Low risk; they make every later batch cheaper.
3. **S4, the Lab pipeline and standing replay queue.** This is where the PC's power starts going to its goal.
4. **S2 step 1 and S3: per-venue loops, a slower Pump.fun cadence and a lighter collector.**
5. **S2 step 2 and S6: the engine worker and the HUD modules.**

Each step is its own bounded batch with its own ledger entry, tests and paired release, following the status
ledger workflow. Nothing here touches the paper-only guarantees, the $25 wallets, or the graphs.
