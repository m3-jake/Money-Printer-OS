# Running Money Printer OS unattended

How to leave the trader and the Evolution Lab running for weeks, what to check, and how to stop or
roll back. Everything here is paper only; live execution stays manual and is locked by the Risk
Governor until accounts are reconciled.

## The one file to read

`<trader data>/reports/self/<date>.md` (also `GET http://127.0.0.1:8792/api/self-report/latest`).
It is rewritten hourly. The first run on a new day finalizes yesterday's and adds a "Daily report"
line to the Journal. It lists each module's verdict (`KEEP_RESEARCHING`, `BLOCKED`, `PARK`), closes
and net P/L, the change since yesterday, blockers, trial decisions, and resource use.

Trader data is `%APPDATA%\Money Printer OS\data` on Windows and
`~/Library/Application Support/Money Printer OS/data` on macOS.

## Read-only APIs

| URL | What |
| --- | --- |
| `http://127.0.0.1:8792/api/health` | trader health and kill switches |
| `http://127.0.0.1:8792/api/fitness` | fitness ledger: verdict and blockers per module (`docs/FITNESS-LEDGER.md`) |
| `http://127.0.0.1:8792/api/self-report/latest` | today's self-report |
| `http://127.0.0.1:8792/api/state`, `/api/robinhood`, `/api/polymarket-us/evidence` | full module state |
| `http://127.0.0.1:8792/api/telemetry` | live readings only: CPU/RAM, resource lane, RPC health, wallet scorecard (`/api/state` is persisted state, ETag-cacheable, and carries none of these) |
| `http://127.0.0.1:8792/api/data-coverage` | tape coverage per source |
| `http://127.0.0.1:8792/api/project-journal` | the Journal's project history |
| `http://127.0.0.1:8793/api/state`, `/api/health` | Evolution Lab |

## Scheduled checks

- `npm run health -- --json` exits 1 when anything is RED. It covers:
  - trader up, paper mode, kill switches, Robinhood order POSTs (RED above 0), fitness verdicts;
  - Lab up, generation advancing (RED if frozen 30 min while RUNNING), modules, loop persistence;
  - disk free (RED under 2 GB), data dir size, tape collector heartbeat, raw tape retention.
  It remembers the Lab generation in `<trader data>/health-check-state.json`.
- The tape collector prunes `research-evidence/raw` hourly: day files older than 45 days go first,
  then the oldest while over 20 GB (`MPO_RAW_KEEP_DAYS`, `MPO_RAW_BUDGET_MB`). Today's and yesterday's
  files are never touched, and the Polymarket US evidence is kept until every strategy window has
  20 settled shadow combos.

To run the health check at logon on Windows (owner, once):

```
schtasks /Create /TN "MPO health" /SC ONLOGON /TR "cmd /c cd /d W:\money-printer-os && npm run health -- --json > \"%APPDATA%\Money Printer OS\health-last.json\""
```

## For agent sessions

1. Run `node scripts/agent-preflight.mjs` first. Exit 2 means this process sees a stale copy of the
   data dirs (the MSIX overlay): read state only through the APIs above and write nothing under them.
2. Never start the Lab, `npm run dev`, `lab:once`, the collector or the trader from an agent session.
3. Builds, installs, signing, keys and anything on the MacBook belong to the owner.

## Kill switches

| Switch | Where | Effect |
| --- | --- | --- |
| STOP ALL LIVE TRADING | Command Center window, or `POST /api/platform/risk/halt` | persistent halt; blocks every live transport and core paper fills |
| Pump.fun pause / kill switch | Pump.fun window Controls | stops Solana entries |
| `ROBINHOOD_AUTOSTART=false` | `.env` | Robinhood loops do not start |
| `ROBINHOOD_LAB_AUTO_APPLY_PAPER` | `.env`, default `false` | when `true`, cleared Lab proposals run as 20-close paper trials with automatic revert |
| `MPO_LAB_LINK=false` | `.env` | isolates the trader from the Lab |
| Lab pause | Lab window, or `lab-control.json` `paused: true` | the Lab stops searching and publishes PAUSED |

## Rollback

Each install keeps the previous app archive next to it (`resources\app.asar.<label>-backup-<date>`).
Quit the app, copy the backup over `resources\app.asar`, and start it again. User data is never part of
an install and needs no rollback. A reverted Robinhood trial restores the previous paper params by
itself; the trial record is `<trader data>/robinhood-lab-trial.json`.
