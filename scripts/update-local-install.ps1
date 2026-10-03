# One-click local update: build Money Printer OS and the Evolution Lab from their repos, boot-test the
# MPO build, back up the installed app.asar of each, swap the new ones in, and relaunch both.
# Run by double-clicking "Update Money Printer.cmd" on the Desktop. Unsigned local builds, as before.
# Rollback: each resources folder keeps app.asar.backup-<timestamp>; copy it back over app.asar.
#   -BuildOnly   build and boot-test only; never stops, swaps or starts anything (for testing this script).
param([switch]$BuildOnly, [switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
# One run at a time: a second double-click while this one is working just says so and exits.
$mutex = New-Object System.Threading.Mutex($false, 'Local\MoneyPrinterLocalUpdate')
if (-not $mutex.WaitOne(0)) { Write-Host 'An update is already running in another window. Let that one finish.' -ForegroundColor Yellow; if (-not $NonInteractive) { Read-Host 'Press Enter to close' }; exit 1 }
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$mpoRepo = 'W:\money-printer-os'
$labRepo = 'W:\money-printer-evolution-lab'
$mpoApp = Join-Path $env:LOCALAPPDATA 'Programs\money-printer-os'
$labApp = Join-Path $env:LOCALAPPDATA 'Programs\money-printer-evolution-lab'
# Space-aware work folder: the build, boot tests and the verified paper-data backup need roughly the
# size of the backed-up data plus both archives. The system drive once filled mid-install, so the
# folder moves to the first candidate drive with that much free plus headroom (MPO_UPDATE_ROOT first).
# Past-day raw evidence files (research-evidence/raw/*-YYYY-MM-DD.ndjson older than a day) no longer change.
# They are kept once in <root>/evidence-store and verified by hash, instead of being re-copied every update.
function Get-SealedEvidence {
  $raw = Join-Path $env:APPDATA 'Money Printer OS\data\research-evidence\raw'
  if (-not (Test-Path -LiteralPath $raw)) { return @() }
  $cutoff = (Get-Date).AddDays(-1)
  return @(Get-ChildItem -LiteralPath $raw -File | Where-Object { $_.LastWriteTime -lt $cutoff -and $_.Name -match '-\d{4}-\d{2}-\d{2}\.ndjson$' })
}
# A sealed file is already stored when the store copy has the same length and write time.
function Test-Stored($file, $storeRoot) {
  $copy = Join-Path $storeRoot $file.Name
  if (-not (Test-Path -LiteralPath $copy)) { return $false }
  $c = Get-Item -LiteralPath $copy
  return ($c.Length -eq $file.Length -and $c.LastWriteTimeUtc -eq $file.LastWriteTimeUtc)
}
function Get-BackupEstimate($storeRoot) {
  $bytes = [int64]0
  foreach ($label in @('Money Printer OS', 'Money Printer Evolution Lab')) {
    $source = Join-Path $env:APPDATA "$label\data"
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $bytes += (Get-ChildItem -LiteralPath $source -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.json','.sqlite') -or $_.Name -match '\.sqlite-(wal|shm)$' -or $_.Name -in @('journal.ndjson','project-journal.ndjson') } | Measure-Object Length -Sum).Sum
    foreach ($folder in @('experiments','daily-shadow','robinhood-equities','robinhood-daily','lab-link','workbench','module-research','research-evidence','pump-profit-evidence')) {
      $p = Join-Path $source $folder
      if (Test-Path -LiteralPath $p) { $bytes += (Get-ChildItem -LiteralPath $p -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum }
    }
  }
  # Sealed evidence already in this root's store costs nothing; the rest is copied there once.
  foreach ($f in Get-SealedEvidence) { if (Test-Stored $f $storeRoot) { $bytes -= $f.Length } }
  return $bytes
}
$headroom = 5GB   # never leave a drive nearly full for the running apps
$candidates = @()
if ($env:MPO_UPDATE_ROOT) { $candidates += $env:MPO_UPDATE_ROOT }
$candidates += (Join-Path $env:USERPROFILE 'Desktop\Money Printer OS'), 'W:\money-printer-backups'
$work = $null; $evidenceStore = $null
foreach ($root in $candidates) {
  $qualifier = Split-Path $root -Qualifier -ErrorAction SilentlyContinue
  if (-not $qualifier) { continue }
  $drive = Get-PSDrive -Name $qualifier.TrimEnd(':') -ErrorAction SilentlyContinue
  if (-not $drive) { continue }
  $store = Join-Path $root 'evidence-store'
  $needBytes = (Get-BackupEstimate $store) + 1GB   # plus archives, boot-test scratch and logs
  if ($drive.Free -ge $needBytes + $headroom) { $work = Join-Path $root "update-$stamp"; $evidenceStore = $store; break }
  Write-Host ("Skipping {0}: {1:N1} GB free, need {2:N1} GB plus {3:N0} GB headroom." -f $root, ($drive.Free/1GB), ($needBytes/1GB), ($headroom/1GB)) -ForegroundColor Yellow
}
if (-not $work) { Write-Host 'No drive has room for the build and the verified paper-data backup. Nothing was changed. Free space or set MPO_UPDATE_ROOT.' -ForegroundColor Red; if (-not $NonInteractive) { Read-Host 'Press Enter to close' }; exit 1 }
New-Item -ItemType Directory -Force $work | Out-Null
# The archive swap writes into the install folder; its drive needs room for one more archive per app.
$installDrive = Get-PSDrive -Name ((Split-Path $env:LOCALAPPDATA -Qualifier).TrimEnd(':'))
if ($installDrive.Free -lt 1GB) { Write-Host ("Install drive has only {0:N2} GB free; refusing to swap archives." -f ($installDrive.Free/1GB)) -ForegroundColor Red; if (-not $NonInteractive) { Read-Host 'Press Enter to close' }; exit 1 }
$log = Join-Path $work 'update.log'
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c; Add-Content $log $m -Encoding UTF8 }
function Fail($m) { Say "FAILED: $m" Red; Say "Nothing installed was changed unless noted above. Log: $log" Yellow; if (-not $NonInteractive) { Read-Host 'Press Enter to close' }; exit 1 }
# Node/npm print warnings (e.g. DEP0190) on stderr. Windows PowerShell 5.1 turns redirected stderr
# into error records, which 'Stop' made fatal and silently killed the first version of this script.
# Here stderr is just output; only the exit code decides success.
function Run($what, [scriptblock]$cmd) {
  Say "`n== $what" Cyan
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $cmd 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable out | Out-Host; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  Add-Content $log ($out -join "`r`n") -Encoding UTF8
  if ($code -ne 0) { Fail "$what (exit $code)" }
}
trap { Say "FAILED: unexpected error: $($_.Exception.Message)" Red; Say "Log: $log" Yellow; if (-not $NonInteractive) { Read-Host 'Press Enter to close' }; exit 1 }

Say "Money Printer local update  $stamp" Green
Say "Build folder: $work"

# 0. A release comes only from clean source. If a repo has an origin, fast-forward it first;
# local commits may be ahead, but a diverged history is never merged by an unattended updater.
function Assert-CleanRepo($repo, $label) {
  if (-not (Test-Path (Join-Path $repo '.git'))) { Fail "$label repo missing at $repo" }
  $dirty = @(git -C $repo status --porcelain)
  if ($dirty.Count) { Fail "$label source has uncommitted changes. Finish/commit them before updating." }
}
function Update-Repo($repo, $label) {
  Assert-CleanRepo $repo $label
  $branch = (git -C $repo branch --show-current).Trim()
  $remotes = @(git -C $repo remote)
  if ($remotes -notcontains 'origin') { Say "$label has no origin remote; using the clean local commit on $branch." Yellow; return }
  $origin = (git -C $repo remote get-url origin).Trim()
  Run "Fetching latest $label source" { git -C $repo fetch origin $branch --prune }
  $behind = [int](git -C $repo rev-list --count "HEAD..origin/$branch")
  $ahead  = [int](git -C $repo rev-list --count "origin/$branch..HEAD")
  if ($behind -gt 0 -and $ahead -gt 0) { Fail "$label local branch diverged from origin/$branch; refusing an automatic merge." }
  if ($behind -gt 0) { Run "Fast-forwarding $label to origin/$branch" { git -C $repo merge --ff-only "origin/$branch" } }
  Assert-CleanRepo $repo $label
}
Update-Repo $mpoRepo 'Money Printer OS'
Update-Repo $labRepo 'Evolution Lab'

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

Run 'Boot-testing the new Evolution Lab archive' {
  node (Join-Path $mpoRepo 'scripts\run-lab-archive-smoke.mjs') --asar $labAsar --exe (Join-Path $labApp 'Money Printer Evolution Lab.exe')
}

$mpoBuildInfo = Join-Path $mpoAsarDir 'BUILD-INFO.json'
$labBuildInfo = "$labAsar.build.json"
if (-not (Test-Path $mpoBuildInfo)) { Fail "Money Printer build provenance missing: $mpoBuildInfo" }
if (-not (Test-Path $labBuildInfo)) { Fail "Evolution Lab build provenance missing: $labBuildInfo" }
$mpoBuild = Get-Content $mpoBuildInfo -Raw | ConvertFrom-Json
$labBuild = Get-Content $labBuildInfo -Raw | ConvertFrom-Json
$mpoCommit = if ($mpoBuild.sourceCommit) { $mpoBuild.sourceCommit } else { $mpoBuild.commit }
$labCommit = $labBuild.commit
Say "Release pair: MPO $($mpoBuild.packageVersion) @ $($mpoCommit.Substring(0,7)) + Lab $($labBuild.packageVersion) @ $($labCommit.Substring(0,7))" Green
if ($BuildOnly) { Say "`nBuild-only run: both archives built and both archived engines boot-tested. Nothing installed was touched." Green; exit 0 }

# 2. Stop both apps: ask politely, then force whatever is left (children included).
function Stop-App($name) {
  $p = Get-Process -Name $name -ErrorAction SilentlyContinue
  if (-not $p) { return }
  Say "Stopping $name..."
  if ($name -eq 'Money Printer Evolution Lab') {
    # Closing the Lab window intentionally leaves its furnace running. New Lab builds accept this
    # second-instance flag and run the normal before-quit/will-quit path, which records a clean boot.
    try { Start-Process (Join-Path $labApp 'Money Printer Evolution Lab.exe') -ArgumentList '--quit-for-update' -WindowStyle Hidden } catch {}
  } else {
    $p | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
  }
  for ($i = 0; $i -lt 30 -and (Get-Process -Name $name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  $left = Get-Process -Name $name -ErrorAction SilentlyContinue
  if ($left) { Say "$name did not exit cleanly; forcing the remaining process tree." Yellow; $left | Stop-Process -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20 -and (Get-Process -Name $name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  if (Get-Process -Name $name -ErrorAction SilentlyContinue) { Fail "$name would not stop" }
}
Say "`n== Stopping the running apps" Cyan
Stop-App 'Money Printer OS'
Stop-App 'Money Printer Evolution Lab'

# Preserve paper accounting and journals after writers have stopped. Copy-only backups;
# market tapes and caches are left in place and never deleted or reset by the installer.
$dataBackup = Join-Path $work 'paper-data-backup'
New-Item -ItemType Directory -Force $dataBackup | Out-Null
$dataBackupManifest = @()
foreach ($label in @('Money Printer OS', 'Money Printer Evolution Lab')) {
  $source = Join-Path $env:APPDATA "$label\data"
  if (-not (Test-Path -LiteralPath $source)) { continue }
  $destination = Join-Path $dataBackup $label
  New-Item -ItemType Directory -Force $destination | Out-Null
  $rootFiles = @(Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Extension -in @('.json','.sqlite') -or $_.Name -match '\.sqlite-(wal|shm)$' -or $_.Name -in @('journal.ndjson','project-journal.ndjson') })
  foreach ($item in $rootFiles) {
    $target = Join-Path $destination $item.Name
    Copy-Item -LiteralPath $item.FullName -Destination $target
    $sourceHash=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLower()
    $backupHash=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    if ($sourceHash -ne $backupHash) { throw "Paper data backup did not verify: $($item.Name)" }
    $dataBackupManifest += [ordered]@{ source=$item.FullName; backup=$target; bytes=$item.Length; sha256=$backupHash; verified=$true }
  }
  foreach ($folder in @('experiments','daily-shadow','robinhood-equities','robinhood-daily','lab-link','workbench','module-research','research-evidence','pump-profit-evidence')) {
    $targetSource = Join-Path $source $folder
    if (-not (Test-Path -LiteralPath $targetSource)) { continue }
    if ($label -eq 'Money Printer OS' -and $folder -eq 'research-evidence') {
      # Everything except sealed past-day raw files is copied into this update's backup as before.
      $sealedNames = @(Get-SealedEvidence | ForEach-Object { $_.Name })
      $folderTarget = Join-Path $destination $folder
      foreach ($f in Get-ChildItem -LiteralPath $targetSource -File -Recurse) {
        if ($f.DirectoryName -eq (Join-Path $targetSource 'raw') -and $sealedNames -contains $f.Name) { continue }
        $rel = $f.FullName.Substring($targetSource.Length).TrimStart('\')
        $to = Join-Path $folderTarget $rel
        New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
        Copy-Item -LiteralPath $f.FullName -Destination $to
      }
      continue
    }
    Copy-Item -LiteralPath $targetSource -Destination (Join-Path $destination $folder) -Recurse
  }
}
# Sealed evidence: copied to the persistent store once, hash-verified, and listed in every manifest.
# STORE-INDEX.json remembers verified hashes so unchanged sealed files are not re-hashed every update.
New-Item -ItemType Directory -Force $evidenceStore | Out-Null
$indexFile = Join-Path $evidenceStore 'STORE-INDEX.json'
$index = @{}
if (Test-Path -LiteralPath $indexFile) { (Get-Content -LiteralPath $indexFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $index[$_.Name] = $_.Value } }
foreach ($f in Get-SealedEvidence) {
  $copy = Join-Path $evidenceStore $f.Name
  $known = $index[$f.Name]
  if ((Test-Stored $f $evidenceStore) -and $known -and [int64]$known.bytes -eq $f.Length -and $known.writeUtc -eq $f.LastWriteTimeUtc.ToString('o')) { $storeHash = $known.sha256 }
  else {
    $sourceHash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    if (-not (Test-Stored $f $evidenceStore)) { Copy-Item -LiteralPath $f.FullName -Destination $copy -Force }
    $storeHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLower()
    if ($sourceHash -ne $storeHash) { throw "Sealed evidence did not verify in the store: $($f.Name)" }
    $index[$f.Name] = [ordered]@{ bytes=$f.Length; writeUtc=$f.LastWriteTimeUtc.ToString('o'); sha256=$storeHash; verifiedAt=(Get-Date).ToString('o') }
  }
  $dataBackupManifest += [ordered]@{ source=$f.FullName; backup=$copy; bytes=$f.Length; sha256=$storeHash; verified=$true; sealedStore=$true }
}
$index | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $indexFile -Encoding UTF8
Say "Sealed evidence store: $evidenceStore" Green
$dataBackupManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $dataBackup 'MANIFEST.json') -Encoding UTF8
Say "Paper data backup: $dataBackup" Green

# 3. Back up and swap as one transaction. If either copy fails, restore both old archives.
function Swap($appDir, $newAsar, $label, $bak) {
  $res = Join-Path $appDir 'resources'; $cur = Join-Path $res 'app.asar'
  if (-not (Test-Path $cur)) { throw "$label is not installed at $appDir" }
  Copy-Item $cur $bak
  Copy-Item $newAsar $cur -Force
  $want = (Get-FileHash $newAsar -Algorithm SHA256).Hash; $got = (Get-FileHash $cur -Algorithm SHA256).Hash
  if ($want -ne $got) { throw "$label copy did not verify" }
  Say "$label installed (sha256 $($got.Substring(0,12))...). Backup: $bak" Green
}
function Restore-Pair($why) {
  Say "Rolling back the pair: $why" Yellow
  foreach ($x in @(@($mpoApp, $mpoBak), @($labApp, $labBak))) {
    $cur = Join-Path $x[0] 'resources\app.asar'
    if (Test-Path $x[1]) { Copy-Item $x[1] $cur -Force }
  }
}
$mpoBak = Join-Path $mpoApp "resources\app.asar.backup-$stamp"
$labBak = Join-Path $labApp "resources\app.asar.backup-$stamp"
Say "`n== Installing paired release" Cyan
try {
  Swap $mpoApp $mpoAsar 'Money Printer OS' $mpoBak
  Swap $labApp $labAsar 'Evolution Lab' $labBak
} catch {
  Restore-Pair $_.Exception.Message
  Fail "paired install failed; previous Money Printer OS + Evolution Lab archives were restored"
}

# 4. Relaunch and prove both halves of the pair are healthy before declaring success.
function Wait-Health($url, $seconds = 35) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $lastStatus = 'no response'
  while ((Get-Date) -lt $deadline) {
    try {
      $h = Invoke-RestMethod -Uri $url -TimeoutSec 2
      $lastStatus = "ok=$($h.ok), health=$($h.health)"
      # CAUTION is a successful application health response with ordinary WARN diagnostics.
      # DEGRADED and STALLED must still fail, even if a malformed response claims ok=true.
      if ($h.ok -eq $true -and ((-not $h.PSObject.Properties['health']) -or $h.health -in @('HEALTHY','CAUTION'))) { return $h }
    } catch { $lastStatus = $_.Exception.Message }
    Start-Sleep -Milliseconds 500
  }
  Say "Health probe failed for ${url}: $lastStatus" Yellow
  return $null
}
function Wait-Json($url, $seconds = 35) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { return Invoke-RestMethod -Uri $url -TimeoutSec 2 } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $null
}
Say "`n== Starting and verifying paired release" Cyan
Start-Process (Join-Path $labApp 'Money Printer Evolution Lab.exe') -WindowStyle Hidden
Start-Process (Join-Path $mpoApp 'Money Printer OS.exe') -WindowStyle Hidden
$mpoHealth = Wait-Health 'http://127.0.0.1:8792/api/health'
$mpoState = Wait-Json 'http://127.0.0.1:8792/api/state'
$labHealth = Wait-Health 'http://127.0.0.1:8793/api/health'
$researchState = Wait-Json 'http://127.0.0.1:8792/api/platform/intelligence'
$healthError = $null
if (-not $mpoHealth) { $healthError = 'Money Printer OS health endpoint did not recover' }
elseif (-not $mpoState) { $healthError = 'Money Printer OS state endpoint did not recover' }
elseif ($mpoHealth.switches.paperOnlyBuild -ne $true -or $mpoHealth.switches.realEnabled -eq $true -or $mpoHealth.switches.sessionArmed -eq $true -or $mpoHealth.switches.liveActivationAllowed -eq $true -or $mpoHealth.switches.automaticLivePromotionAllowed -eq $true) { $healthError = 'Money Printer OS did not come back in the expected paper-only safety state' }
elseif ($mpoState.build.version -ne $mpoBuild.packageVersion) { $healthError = "Money Printer OS version mismatch: expected $($mpoBuild.packageVersion), got $($mpoState.build.version)" }
elseif ($mpoState.build.provenance.sourceCommit -ne $mpoCommit) { $healthError = "Money Printer OS commit mismatch: expected $mpoCommit, got $($mpoState.build.provenance.sourceCommit)" }
elseif ($mpoState.build.provenance.sourceDirty -eq $true) { $healthError = 'Money Printer OS reports a dirty packaged source' }
elseif (-not $researchState -or $researchState.budget.paidModelsEnabled -ne $false -or $researchState.cache.paidModelsEnabled -ne $false) { $healthError = 'Money Printer OS zero-credit research safety check failed' }
elseif (-not $labHealth) { $healthError = 'Evolution Lab health endpoint did not recover' }
elseif ($labHealth.service -ne 'money-printer-evolution-lab') { $healthError = 'port 8793 answered, but it was not Evolution Lab' }
elseif ($labHealth.version -ne $labBuild.packageVersion) { $healthError = "Evolution Lab version mismatch: expected $($labBuild.packageVersion), got $($labHealth.version)" }
elseif ($labHealth.build.commit -ne $labCommit) { $healthError = "Evolution Lab commit mismatch: expected $labCommit, got $($labHealth.build.commit)" }
elseif ($labHealth.build.sourceDirty -eq $true) { $healthError = 'Evolution Lab reports a dirty packaged source' }
elseif ($labHealth.switches.liveActivationAllowed -eq $true -or $labHealth.switches.automaticLivePromotionAllowed -eq $true) { $healthError = 'Evolution Lab came back with forbidden live authority enabled' }

if ($healthError) {
  Say $healthError Red
  Stop-App 'Money Printer OS'
  Stop-App 'Money Printer Evolution Lab'
  Restore-Pair $healthError
  Start-Process (Join-Path $labApp 'Money Printer Evolution Lab.exe') -WindowStyle Hidden
  Start-Process (Join-Path $mpoApp 'Money Printer OS.exe') -WindowStyle Hidden
  Fail 'new pair failed post-install verification; previous pair restored and relaunched'
}

# The installed bytes were already hash-verified. Record one authoritative receipt in BOTH app roots
# so future audits never have to reconcile stale single-app sidecars again.
$mpoHash = (Get-FileHash (Join-Path $mpoApp 'resources\app.asar') -Algorithm SHA256).Hash.ToLower()
$labHash = (Get-FileHash (Join-Path $labApp 'resources\app.asar') -Algorithm SHA256).Hash.ToLower()
$pair = [ordered]@{
  schema = 'mpo.paired-release.v1'
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
  machine = [Environment]::MachineName
  moneyPrinterOS = [ordered]@{ version = $mpoBuild.packageVersion; commit = $mpoCommit; sha256 = $mpoHash }
  evolutionLab = [ordered]@{ version = $labBuild.packageVersion; commit = $labCommit; sha256 = $labHash }
  safety = [ordered]@{ paperOnlyBuild = $true; realEnabled = $false; liveActivationAllowed = $false; paidModelsEnabled = $false }
}
$pairJson = $pair | ConvertTo-Json -Depth 6
Set-Content (Join-Path $mpoApp 'PAIRED-RELEASE.json') $pairJson -Encoding UTF8
Set-Content (Join-Path $labApp 'PAIRED-RELEASE.json') $pairJson -Encoding UTF8
Copy-Item $mpoBuildInfo (Join-Path $mpoApp 'BUILD-INFO.json') -Force
Copy-Item $labBuildInfo (Join-Path $labApp 'BUILD-INFO.json') -Force

Say "`nDone. Verified pair: MPO $($mpoBuild.packageVersion) + Lab $($labBuild.packageVersion)." Green
Say "Both live health endpoints passed; paired receipt written to both installs." Green
Say "To undo: quit both, then restore BOTH resources\app.asar.backup-$stamp files as a pair." Yellow
if (-not $NonInteractive) { Read-Host 'Press Enter to close' }
