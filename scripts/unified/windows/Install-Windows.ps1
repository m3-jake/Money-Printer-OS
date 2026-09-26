[CmdletBinding()]
param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
$Payload = Join-Path $PSScriptRoot 'Money Printer OS'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Stage = $null
$Backup = $null
$Swapped = $false
$TargetWasMoved = $false
try {
    $Manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'PAYLOAD-SHA256.json') -Raw | ConvertFrom-Json
    Write-Host 'Verifying the shared release files...'
    foreach ($Entry in $Manifest.PSObject.Properties) {
        $File = [IO.Path]::GetFullPath((Join-Path $Payload $Entry.Name))
        if (-not $File.StartsWith(([IO.Path]::GetFullPath($Payload) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid payload path.' }
        if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing payload file: $($Entry.Name)" }
        if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.Value) { throw "Checksum mismatch: $($Entry.Name)" }
    }
    $Release = Get-Content -LiteralPath (Join-Path $Payload 'MPO-RELEASE.json') -Raw | ConvertFrom-Json
    $Wsh = New-Object -ComObject WScript.Shell
    $Desktop = [Environment]::GetFolderPath('Desktop')
    $Programs = [Environment]::GetFolderPath('Programs')
    $ExistingLinks = @()
    $Candidates = @()
    foreach ($Root in @($Desktop, $Programs)) {
        if (Test-Path -LiteralPath $Root) {
            foreach ($Link in @(Get-ChildItem -LiteralPath $Root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
                if ($Link.Name -notmatch 'Money.?Printer') { continue }
                $Shortcut = $Wsh.CreateShortcut($Link.FullName)
                $Exe = $Shortcut.TargetPath
                if ($Exe -and ([IO.Path]::GetFileName($Exe) -match '^Money[ -]?Printer[ -]?OS\.exe$')) {
                    $Dir = Split-Path -Parent $Exe
                    if (Test-Path -LiteralPath (Join-Path $Dir 'resources\app.asar')) {
                        $Candidates += $Dir
                        $ExistingLinks += $Link.FullName
                    }
                }
            }
        }
    }
    if (-not $InstallDir) {
        $Candidates = @($Candidates | Select-Object -Unique)
        if ($Candidates.Count -gt 1) { throw "Multiple Windows installs found. Run this script with -InstallDir and the intended app folder. No changes were made." }
        if ($Candidates.Count -eq 1) { $InstallDir = $Candidates[0] }
        else { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Money Printer OS' }
    }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    if ($InstallDir -eq [IO.Path]::GetFullPath($Payload)) { throw 'Extract this update outside the installed application folder.' }
    if ((Test-Path -LiteralPath $InstallDir) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\app.asar'))) { throw 'Target exists but is not a recognized Electron application. Refusing to replace it.' }
    $Running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match '^Money[ -]?Printer[ -]?OS' -or ($_.Path -and $_.Path.StartsWith(($InstallDir + '\'), [StringComparison]::OrdinalIgnoreCase))
    })
    if ($Running.Count) { throw 'Close Money Printer OS before updating. No processes have been forced to quit.' }
    foreach ($UserRoot in @((Join-Path $env:APPDATA 'Money Printer OS'), (Join-Path $env:APPDATA 'money-printer-os'))) {
        $EnvFile = Join-Path $UserRoot '.env'
        if ((Test-Path -LiteralPath $EnvFile) -and (Select-String -LiteralPath $EnvFile -Pattern '^\s*MODE\s*=\s*["'']?live\b' -Quiet)) { throw 'Live mode is configured. Disarm and switch to paper mode in the app before updating.' }
        foreach ($Name in @('combo-engine.json', 'polymarket-us-combos.json', 'robinhood-auto-trader.json')) {
            $StateFile = Join-Path $UserRoot "data\$Name"
            if (-not (Test-Path -LiteralPath $StateFile)) { continue }
            $State = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
            if ($Name -eq 'robinhood-auto-trader.json') {
                if ($null -eq $State -or $State.version -ne 1 -or $State.open -isnot [Array]) { throw 'Robinhood journal schema requires recovery. No update performed.' }
                if ($State.open.Count) { throw 'Open Robinhood crypto exposure blocks updating.' }
            }
            if ($State.recoveryRequired -or $State.sessionArmed) { throw "Trading state is armed or needs recovery: $Name. No update performed." }
            if ($Name -eq 'polymarket-us-combos.json' -and @($State.open | Where-Object { $null -ne $_ }).Count) { throw 'Open Polymarket orders/RFQs block updating.' }
            if ($Name -eq 'combo-engine.json') {
                $RealOpen = @($State.open | Where-Object { $_.mode -eq 'real' -and $_.status -notin @('WON','LOST','VOID','CANCELLED','FORGOTTEN','PARTIAL') })
                if ($RealOpen.Count) { throw 'Open real combo exposure blocks updating.' }
            }
        }
    }
    $Parent = Split-Path -Parent $InstallDir
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    $Stage = "$InstallDir.staging-$Stamp"
    if (Test-Path -LiteralPath $Stage) { throw 'Staging directory already exists.' }
    Copy-Item -LiteralPath $Payload -Destination $Stage -Recurse
    foreach ($Entry in $Manifest.PSObject.Properties) {
        if ((Get-FileHash -LiteralPath (Join-Path $Stage $Entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.Value) { throw 'Staged payload verification failed.' }
    }
    if (Test-Path -LiteralPath $InstallDir) {
        $Backup = "$InstallDir.backup-$Stamp"
        Move-Item -LiteralPath $InstallDir -Destination $Backup
        $TargetWasMoved = $true
    }
    Move-Item -LiteralPath $Stage -Destination $InstallDir
    $Swapped = $true
    $Exe = Join-Path $InstallDir 'Money Printer OS.exe'
    $Links = @($ExistingLinks) + @((Join-Path $Desktop 'Money Printer OS.lnk'), (Join-Path $Programs 'Money Printer OS.lnk'))
    foreach ($Path in @($Links | Select-Object -Unique)) {
        $Shortcut = $Wsh.CreateShortcut($Path)
        $Shortcut.TargetPath = $Exe
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.Description = "Money Printer OS $($Release.releaseId)"
        $Shortcut.Save()
    }
    $Record = [ordered]@{releaseId=$Release.releaseId; sourceCommit=$Release.sourceCommit; appAsarSha256=$Release.appAsar.sha256; installedAt=(Get-Date).ToString('o'); installDir=$InstallDir; rollbackDir=$Backup; launched=$false}
    $Record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallDir 'INSTALL-RECEIPT.json') -Encoding UTF8
    Write-Host "Installed $($Release.releaseId)" -ForegroundColor Green
    Write-Host "Location: $InstallDir"
    Write-Host "Rollback: $Backup"
    Write-Host 'Settings, keys, balances, trade history, and the separate Evolution Lab were not changed.'
    Write-Host 'Launch Money Printer OS from the desktop when ready. Trading is not started by this installer.'
} catch {
    if ($TargetWasMoved -and -not $Swapped -and $Backup -and (Test-Path -LiteralPath $Backup) -and -not (Test-Path -LiteralPath $InstallDir)) {
        Move-Item -LiteralPath $Backup -Destination $InstallDir
    }
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
