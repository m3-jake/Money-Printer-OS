# Money Printer OS: next steps and unattended-compute plan (2026-09-25 03:45 ET)

Written by a read-only Claude session. Nothing below was executed except the sandbox searches
noted in section 4 and read-only checks. Verified against code, logs, git and data on WITCHDOCTOR.

## 1. Where things actually stand

| Area | State (verified) |
| --- | --- |
| Trader (installed) | alpha.53, NOT running since 2026-09-25 00:30Z (clean quit). alpha.54 archive built + boot-tested at `W:\mpo-alpha54-build\app.asar` (sha f6d0d438…), not installed. |
| Trader repo | `integrate-alpha54` is a pure fast-forward of `origin/main` (+17 after Codex's 03:35 commit). Local `main` is the old asar lineage; nothing on it is missing from `integrate-alpha54`. No `v*` tag exists. PR #1 is already contained (merge a53a538). |
| Evolution Lab | NOT running since the 2026-09-22 16:44 power loss. Its `evolution-loop.json` and `lab-link\status.json` are 100% NUL bytes; `lab-journal.ndjson` has a 631 KB NUL tail. Newest parseable loop file: `W:\mpo-lab-loop-stale-20260921-100214.json` (gen 120,602). Installed Lab asar lacks `verifyLoopFile` (grep = 0 hits). |
| Lab repo | Codex committed the Polymarket work at 03:32 on `codex/lab-evidence-20260925` and is mid-edit on the fee model (2 of 28 tests red at 03:36). |
| Polymarket tape | Full days on disk: 09-17 (107 games) and 09-21 (99 games). Nothing usable since: 09-22 3 MB, 09-24 0.4 MB, 09-25 0.9 MB. The collector only runs as a child of the trader, so three days were lost. |
| Research verdict | 288-config long-only book-reversion family loses on 09-17 (-4.4%), 09-21 (-3.5%) and both combined (-7.9%). The 5% taker fee sits on 92% of records; fee-free records are exactly the NFL markets. Nothing to freeze; a sealed window would be refused. |
| Machine | Six Kernel-Power 41 events in two weeks, all BugcheckCode 0 (power loss / hard hang, no dump, no WHEA). Windows Update active hours 09:00-03:00. No AutoAdminLogon. No task or startup item restarts any MPO process. |
| Hourly replay task | `MoneyPrinterReplayWorkhorse` runs a Sep-15 copy of MPO with 28 workers every hour: 18 s wall, `qualified: 0`, top configs have n=13 trades. Harmless, useless, churns Dropbox. |
| Admin tools | BingAgentLab scripts (`mpo-status.ps1`, `poly-*.ps1`, `deploy-alpha44/45.ps1`) are alpha.44/45-era and know nothing about the Lab split, the tape collector, the evidence gate or alpha.54. `npm run health` (Sep 20) is the only current one. |

## 2. Ranked next steps

1. **Bank Polymarket tape every day, unattended.** This is the only thing that moves the evidence
   gate and it costs ~25 MB/h and a few percent of one core. Run the collector standalone with a
   restart loop and a logon task (section 3). Add `MPO_RESEARCH_COLLECTOR=false` to the trader's
   `.env` first so launching the app later never double-writes the same day file.
2. **Give the machine a restart path.** Set Windows Update active hours to cover the collection
   window, and decide whether to enable auto-logon (or a startup-trigger task with a stored
   password, which only you may enter). Until then, every power loss stops collection silently.
   Have the PSU/cabling/thermals looked at: six bugcheck-0 resets is hardware, not software.
3. **Let Codex finish, then re-run the three searches.** Its fee-model change alters every
   result. Do not run a second agent on either repo until its branch is merged or parked.
   Then: `node scripts/polymarket-research.mjs --mode search --train 2026-09-21 --data W:/mpo-polymarket-research`
   (8 s) and the 09-17 and combined variants.
4. **Install alpha.54 and push main** (section 5). Ten minutes by hand; the Mac update kit is
   stale (alpha.53) and the alpha.54 asar is platform-independent, so use that for the Mac too.
5. **Design a second strategy family** rather than re-running this grid: fee-free NFL-only
   markets, maker/limit posting instead of taker (needs a queue model in the evaluator), or
   short-via-complement. This is the real "money" work and it is design, not compute.
6. **Do not restart the Solana BEAST furnace.** Its tape can never satisfy the gate (all six
   coverage flags false), 1.4 billion variants produced nothing admissible, three of the six
   crashes happened while it ran, and Unity currently holds 10.4 of 12 GB VRAM. If you want the
   Lab up for the lab-link only, repackage it with `verifyLoopFile`, restore a loop file from the
   09-21 copy, and run it CPU-light.
7. **Disable or daily-ify the hourly replay task.** `Disable-ScheduledTask -TaskName MoneyPrinterReplayWorkhorse`.
8. **Refresh the admin tools** once alpha.54 is in: fold lab port 8793, the collector's
   `research-capture-status.json`, and the evidence monitor into `mpo-status.ps1`, and retire the
   alpha.44/45 deploy scripts.
9. **Stop hourly PR check-in routines** that find nothing; they burned your 5-hour window at 01:31Z.

## 3. Unattended schedule (next 72 h)

| When | Workload | Cost | Why |
| --- | --- | --- | --- |
| Tonight, once | Collector task (section 3 commands), verify `research-capture-status.json` updates | 1 core, ~0.7 GB/day | Starts the UTC day file for 09-25/09-26 |
| Tonight, once | Disable the hourly replay task | none | Stops pointless Dropbox churn |
| Daily, 20:05 ET | `node scripts/polymarket-tape-profile.mjs --data "C:/Users/jakem/AppData/Roaming/Money Printer OS/data" --day <UTC day just closed>` | 10 s | Confirms the day has ~100 games before anyone treats it as a phase |
| After Codex merges | The three sandbox searches | 30 s total | Tells you whether the new fee model changes the verdict |
| Never unattended | `--mode status/provisional/sealed` against the official data dirs, any Lab BEAST/GPU run, the asar swap, git pushes | | Writes outside the ledger, or needs you present |

Everything else on this box (Unity, FL Studio, Codex, BING PUMPO server, agentlab daemon) is
unaffected by the collector.

## 4. Collector runbook (you run these)

Create `W:\mpo-collector\run-collector.cmd`:

```bat
@echo off
set "MONEY_PRINTER_DATA_DIR=%APPDATA%\Money Printer OS\data"
set POLYMARKET_AUTOSTART=false
set MPO_SOLANA_CAPTURE_MS=5000
set MPO_POLY_CAPTURE_MS=5000
:loop
echo [%date% %time%] collector start>> "W:\mpo-collector\collector.log"
"C:\Program Files\nodejs\node.exe" "W:\money-printer-os\src\researchCollector.js" >> "W:\mpo-collector\collector.log" 2>&1
echo [%date% %time%] collector exit %errorlevel%>> "W:\mpo-collector\collector.log"
timeout /t 10 /nobreak >nul
goto loop
```

Guard against the app starting a second collector, then register the task (PowerShell 7):

```powershell
Add-Content -Path "$env:APPDATA\Money Printer OS\.env" -Value 'MPO_RESEARCH_COLLECTOR=false'
$action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "W:\mpo-collector\run-collector.cmd"' -WorkingDirectory 'W:\money-printer-os'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'witchdoctor\jakem'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'MPO Polymarket Collector' -Action $action -Trigger $trigger -Settings $settings -User 'witchdoctor\jakem' -RunLevel Limited
Start-ScheduledTask -TaskName 'MPO Polymarket Collector'
```

Liveness check (safe any time; `npm run health` cannot see a standalone collector):

```powershell
Get-Content "$env:APPDATA\Money Printer OS\data\research-capture-status.json" | ConvertFrom-Json | Select-Object pid,@{n='updatedAt';e={[DateTimeOffset]::FromUnixTimeMilliseconds($_.updatedAt).LocalDateTime}},@{n='polyLastBatch';e={$_.polymarket.lastBatch}},@{n='polyRows';e={$_.polymarket.rowsTotal}}
```

Notes: day files roll at 00:00 UTC (20:00 ET) and are never pruned; the collector reads
`W:\money-printer-os\src\researchCollector.js` live, so a branch switch changes what restarts
(use a `git worktree` copy if that bothers you). The file is byte-identical across alpha.53,
alpha.54 and the working tree, so output format does not change.

## 5. alpha.54 release and install (you run these; each step reversible as noted)

```powershell
cd W:\money-printer-os
git fetch origin --prune; git status -sb; git merge-base --is-ancestor origin/main integrate-alpha54; $LASTEXITCODE   # expect 0
git branch -m main windows-alpha53-lineage; git branch --unset-upstream windows-alpha53-lineage; git tag windows-alpha53-lineage-tip 608cc36
git branch -m integrate-alpha54 main; git branch -vv
git push origin main                      # fast-forward, no force; CI runs on ubuntu
# after CI is green:
git tag -a v0.5.0-alpha.54 -m "Money Printer OS 0.5.0-alpha.54"; git push origin v0.5.0-alpha.54   # release.yml on macos-15 bills 10x; or build on the Mac with npm run release:unified
```

Wait for Codex to finish and for `npm run test:all` to be green on the new HEAD before pushing.

Windows install (app must be closed; it is):

```powershell
$res = "$env:LOCALAPPDATA\Programs\money-printer-os\resources"; $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$res\app.asar" "$res\app.asar.pre-alpha54-$stamp"; Copy-Item "$res\app.asar" "$res\app.asar.previous" -Force
$bk = "$env:APPDATA\Money Printer OS\backups\pre-alpha54-$stamp"; New-Item -ItemType Directory $bk | Out-Null; Copy-Item "$env:APPDATA\Money Printer OS\data\*.json" $bk
(Get-FileHash W:\mpo-alpha54-build\app.asar -Algorithm SHA256).Hash          # F6D0D438…
Copy-Item W:\mpo-alpha54-build\app.asar "$res\app.asar" -Force
(Get-FileHash "$res\app.asar" -Algorithm SHA256).Hash; (Get-Item "$res\app.asar").Length   # F6D0D438…, 30073777
Start-Process "$env:LOCALAPPDATA\Programs\money-printer-os\Money Printer OS.exe"
```

Rollback: copy `app.asar.pre-alpha54-<stamp>` back over `app.asar`. Then add
`MONEY_PRINTER_UPDATE_TOKEN=<fine-grained read-only PAT>` to the installed `.env` by hand, sign
the manifest on the key-holding machine outside any agent session, and publish the draft release
(not pre-release). For the Mac, hand-swap the same alpha.54 asar; alpha.52's updater points at a
host that never existed, so it cannot self-update.

## 6. Do-not-do list

- Do not promote, arm, or size anything on proxy scores; real-money execution stays locked.
- Do not run `--mode status`, `provisional` or `sealed` against the official data dirs unattended.
- Do not restart the Lab until its loop file is restored and the packaged asar includes `verifyLoopFile`.
- Do not run the BEAST/GPU furnace while Unity holds the GPU or until the power-loss cause is found.
- Do not let two agents edit the same repo at once; check `git log -3` and recent mtimes first.
- Do not treat multi-day "independent games" (206 for 09-17+09-21) as gate groups; days double-count.
- Do not copy the sandbox ledger (867 trials) back over the official one without deciding which is canonical.

## 7. Open questions only you can answer

- What killed power on 09-12, 09-19, 09-20 and three times on 09-22? PSU, cable, outlet, thermal?
- Is the sandbox ledger or the trader-dir ledger the ledger of record for Polymarket?
- Are the `.sha256` sidecars the search writes into `W:\mpo-tape-archive-20260921` acceptable, given MANIFEST.json does not list them?
- Do you hold the Ed25519 release key, and on which machine?
- Which "admin tools suite" did you mean: BingAgentLab scripts, the MPO HUD, or FRATHOUSE ARCHON?
