# One-click local update: build Money Printer OS and the Evolution Lab from their repos, boot-test the
# MPO build, back up the installed app.asar of each, swap the new ones in, and relaunch both.
# Run by double-clicking "Update Money Printer.cmd" on the Desktop. Unsigned local builds, as before.
# Rollback: each resources folder keeps app.asar.backup-<timestamp>; copy it back over app.asar.
$ErrorActionPreference = 'Stop'
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$mpoRepo = 'W:\money-printer-os'
$labRepo = 'W:\money-printer-evolution-lab'
$mpoApp = Join-Path $env:LOCALAPPDATA 'Programs\money-printer-os'
$labApp = Join-Path $env:LOCALAPPDATA 'Programs\money-printer-evolution-lab'
$work   = Join-Path $env:USERPROFILE "Desktop\Money Printer OS\update-$stamp"
New-Item -ItemType Directory -Force $work | Out-Null
$log = Join-Path $work 'update.log'
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c; Add-Content $log $m }
function Fail($m) { Say "FAILED: $m" Red; Say "Nothing installed was changed unless noted above. Log: $log" Yellow; Read-Host 'Press Enter to close'; exit 1 }
function Run($what, [scriptblock]$cmd) {
  Say "`n== $what" Cyan
  & $cmd 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "$what (exit $LASTEXITCODE)" }
}

Say "Money Printer local update  $stamp" Green
Say "Build folder: $work"

# 1. Build both archives while the apps keep running.
$mpoAsarDir = Join-Path $work 'mpo'
Push-Location $mpoRepo
Run 'Building Money Printer OS' { npm run -s release:windows-asar -- --out "$mpoAsarDir" }
$mpoAsar = Join-Path $mpoAsarDir 'app.asar'
if (-not (Test-Path $mpoAsar)) { Fail "no app.asar in $mpoAsarDir" }
# Port 18792 so the test never collides with the running app on 8792.
Run 'Boot-testing the new Money Printer OS build' { npm run -s smoke:windows -- --asar "$mpoAsar" --port 18792 }
Pop-Location

$labAsar = Join-Path $work 'lab\app.asar'
New-Item -ItemType Directory -Force (Split-Path $labAsar) | Out-Null
Push-Location $labRepo
Run 'Building Evolution Lab' { node scripts/package-windows.mjs --asar-only "$labAsar" }
Pop-Location
if (-not (Test-Path $labAsar)) { Fail "no Lab app.asar at $labAsar" }

# 2. Stop both apps: ask politely, then force whatever is left (children included).
function Stop-App($name) {
  $p = Get-Process -Name $name -ErrorAction SilentlyContinue
  if (-not $p) { return }
  Say "Stopping $name..."
  $p | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
  for ($i = 0; $i -lt 20 -and (Get-Process -Name $name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20 -and (Get-Process -Name $name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Name $name -ErrorAction SilentlyContinue) { Fail "$name would not stop" }
}
Say "`n== Stopping the running apps" Cyan
Stop-App 'Money Printer OS'
Stop-App 'Money Printer Evolution Lab'

# 3. Back up and swap, verifying the copied file's hash.
function Swap($appDir, $newAsar, $label) {
  $res = Join-Path $appDir 'resources'; $cur = Join-Path $res 'app.asar'
  if (-not (Test-Path $cur)) { Fail "$label is not installed at $appDir" }
  $bak = Join-Path $res "app.asar.backup-$stamp"
  Copy-Item $cur $bak
  Copy-Item $newAsar $cur -Force
  $want = (Get-FileHash $newAsar -Algorithm SHA256).Hash; $got = (Get-FileHash $cur -Algorithm SHA256).Hash
  if ($want -ne $got) { Copy-Item $bak $cur -Force; Fail "$label copy did not verify; restored the backup" }
  Say "$label installed (sha256 $($got.Substring(0,12))...). Backup: $bak" Green
}
Say "`n== Installing" Cyan
Swap $mpoApp $mpoAsar 'Money Printer OS'
Swap $labApp $labAsar 'Evolution Lab'

# 4. Relaunch.
Say "`n== Starting both apps" Cyan
Start-Process (Join-Path $labApp 'Money Printer Evolution Lab.exe')
Start-Process (Join-Path $mpoApp 'Money Printer OS.exe')
Say "`nDone. Both apps are starting with the new builds." Green
Say "To undo: quit both, then copy each resources\app.asar.backup-$stamp back over app.asar." Yellow
Read-Host 'Press Enter to close'
