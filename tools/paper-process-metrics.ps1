param([string]$Tag='current', [string]$Out='reports/paper-potential-2026-10-03')
$ErrorActionPreference='Stop'
$names=@('Money Printer OS','Money Printer Evolution Lab')
function Sample {
  $processes=@(Get-Process | Where-Object {$_.ProcessName -in $names} | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64)
  $roots=@((Join-Path $env:APPDATA 'Money Printer OS\data'),(Join-Path $env:APPDATA 'Money Printer Evolution Lab\data'))
  $disk=@($roots | ForEach-Object {$root=$_;$files=@(Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue);[ordered]@{root=$root;files=$files.Count;bytes=($files|Measure-Object Length -Sum).Sum}})
  return [ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');processes=$processes;disk=$disk}
}
$a=Sample
Start-Sleep -Seconds 20
$b=Sample
$seconds=([DateTime]::Parse($b.at)-[DateTime]::Parse($a.at)).TotalSeconds
$logical=[Environment]::ProcessorCount
$rows=@($names | ForEach-Object {$name=$_;$before=@($a.processes|Where-Object {$_.ProcessName -eq $name});$after=@($b.processes|Where-Object {$_.ProcessName -eq $name});$cpu=0;foreach($p in $after){$old=$before|Where-Object {$_.Id -eq $p.Id};if($old){$cpu+=$p.CPU-$old.CPU}};[ordered]@{app=$name;processes=$after.Count;cpuMachinePct=[math]::Round(100*$cpu/$seconds/$logical,2);workingSetBytes=($after|Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($after|Measure-Object PrivateMemorySize64 -Sum).Sum}})
$report=[ordered]@{schema='mpo.paper-process-metrics.v1';tag=$Tag;sampleSeconds=$seconds;logicalProcessors=$logical;startedAt=$a.at;endedAt=$b.at;apps=$rows;diskBefore=$a.disk;diskAfter=$b.disk;limitations=@('Process CPU is measured over this short window, not long-run utilization','Build/test processes are excluded; other machine work still affects latency','Working sets can contain shared pages')}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Out "$Tag-process-metrics.json") -Encoding utf8
$rows | Format-Table | Out-String | Write-Output
