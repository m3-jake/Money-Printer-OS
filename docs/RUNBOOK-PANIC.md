# Panic path — stop, verify, recover

Paper-only. This runbook is about *stopping*, *verifying* and *recovering*; nothing in it enables
live trading, and the execution boundary stays closed regardless of what you do here.

Every claim below names the code that implements it, and `tests/panic-runbook.test.mjs` fails if any
of those names disappears — a runbook that has drifted from the code is worse than none.

## 1. Stop now

**The kill switch is not a stop button.** `toggle-kill` blocks new entries only (`src/index.js`
adds `kill-switch` to the entry-side `blockStatus` reasons), and position management, exits and
marking keep running. That is deliberate: you can stop adding risk without abandoning open paper
positions. To stop the engine completely, stop the process.

| Where | What to do | What happens |
|---|---|---|
| Desktop app | Quit the app | The supervisor holds the engine's stdin; when it dies the pipe closes and the engine exits instead of surviving as an orphan on the port (`MONEY_PRINTER_SUPERVISED` stdin listeners) |
| CLI / service | `SIGINT` or `SIGTERM` | `shutdown()` closes the program stream, the alpha worker and the dashboard, aborts the in-flight cycle budget (so a fetch cannot hold the process open) and exits **0** |
| HUD | `POST /api/kill`, `POST /api/pause` | Queues `toggle-kill` (`killSwitch` ⇒ `paused`) / `toggle-pause`; applied at the top of the next cycle |

```bash
curl -sS -X POST http://127.0.0.1:8792/api/kill  -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8792/api/pause -H 'content-type: application/json' -d '{}'
```

Mutations are local-only: anything that is not a same-origin JSON request from this machine gets
`403 Local same-origin JSON request required`, and a HUD request without its JSON body is refused
rather than silently queued.

## 2. Verify it stopped

`GET /api/health` is the one endpoint to read during an incident:

| Field | Meaning |
|---|---|
| `ok` | `false` whenever `health === 'DEGRADED'` — this is the field to alert on |
| `health` | `HEALTHY` / `CAUTION` / `DEGRADED`, derived by `supervisorTick` from `diagnostics` (ERROR ⇒ DEGRADED, WARN ⇒ CAUTION) |
| `lastCycle` | Wall-clock of the last completed cycle; `STALE_CYCLE` appears once it is older than 60 s |
| `diagnostics` | Codes worth knowing: `CYCLE_ERROR_STREAK`, `CYCLE_BUDGET_EXCEEDED`, `MARKET_BUDGET_REJECTED`, `MARKET_RATE_LIMIT`, `HELD_PRICE_UNVERIFIED`, `STALE_CYCLE`, `FEED_STALE`, `RPC_DOWN` |
| `cycleRecovery` | `saveFailed`, `lastSaveFailure`, `pendingErrorRows`, `consecutive`, `degradeAfter`, `aborts`, `abortStreak`, `lastError` |
| `marketRequests` | Request budget: `requests`, `budgetRejects`, `timeouts`, `rateLimits`, `retryAt`, `hosts[].windowCalls` |
| `marketBudget` | What the last discovery fan-out was allowed (`fanoutBatches`, `fanoutAddresses`, `rejectsDelta`) |

A stopped engine looks like: `state.json` shows `system.paused: true`, `system.killSwitch: true`, and
`lastCycle` stops advancing while `/api/health` still answers (the dashboard runs in the same
process, so if the port is dead the process is gone too). `GET /api/state` returns the same
state the engine is working from, if you would rather not read the file. `/api/state` is persisted
state only and may answer `304 Not Modified` while state.json is unchanged; the machine's live
CPU/RAM and RPC readings are `/api/telemetry`.


## 3. When the state file is the problem

`saveState()` deliberately refuses to publish a state that violates accounting: a realized-basis
violation or an equity jump (`EQUITY_JUMP`) is rejected and **state.json is left untouched**.

- The cycle that hit it keeps the loop alive; the refusal is journaled as `error-persist-failed`
  (`stage: 'save'`), surfaces in `/api/health` as `cycleRecovery.saveFailed`, and the error counter
  lives in the journal rather than in the state that could not be written. A restart shows the
  journal rows, not a lie.
- If `state.json` cannot be read at all, `loadState()` falls back to `state.backup.json` and forces
  `paused: true`, `killSwitch: true`, `recovery.status: BACKUP_RECOVERED` with `reviewRequired`.
- If **both** files are unusable the engine throws `STATE_RECOVERY_REQUIRED` and exits **1**
  (`main().catch`), preserving both files.

Do not delete `state.json` to "fix" it. Keep the trio — `state.json`, `state.backup.json`,
`market.ndjson` — copy them somewhere else before touching anything, and compare them: the journal
tells you what the last cycle tried to do, the state file tells you what was last published.

## 4. Reset (paper only)

| Action | How | Note |
|---|---|---|
| Reset the paper book | `POST /api/reset` with `{"amountSol": 1}` | Queues `reset-paper`; bounds-checked; applied at the top of the next cycle |
| Clear the error banner | `POST /api/clear-error` | Clears `system.lastError` only — it does not clear `cycleRecovery` evidence |
| Recover from a refused save | Fix the accounting cause, then restart | The refusal clears itself on the first successful save (`markCleanCycle`), and a `DEGRADED` flag from a streak clears on the first cycle that does not throw |

## 5. Switches an incident usually touches

| Variable | Default | Why you would change it |
|---|---|---|
| `MODE`, `ENABLE_LIVE_TRADING` | `paper`, `false` | Keep both as they are during an incident |
| `MONEY_PRINTER_DATA_DIR` | `data` | Point at a copy to inspect a suspect book without touching the live one |
| `MARKET_REQUESTS_PER_MINUTE` | `120` | The discovery fan-out is sized from this; raising it widens the universe, lowering it narrows the fan-out |
| `CYCLE_BUDGET_MS` | `45000` | A cycle past its budget is abandoned (and recorded as `cycle-budget`), never left hanging |
| `CYCLE_ERROR_DEGRADE_AFTER` | `3` | Consecutive failed or abandoned cycles before `DEGRADED` |
| `SCAN_INTERVAL_SEC` | `8` | The per-cycle budget share is `interval × budget ÷ 60`; a slower loop buys a wider fan-out |

## 6. Exit codes

- `0` — clean stop (`shutdown()`), including a one-shot run (`--once`).
- `1` — a fatal error escaped `main()` (for example `STATE_RECOVERY_REQUIRED`); the message is on
  stderr and `process.exitCode = 1`.

The append-only truth is `data/market.ndjson` (`GET /api/journal` reads its tail). Row types that
matter here: `error`, `error-persist-failed`, `cycle-budget`.
