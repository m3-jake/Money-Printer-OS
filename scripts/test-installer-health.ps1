$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'update-local-install.ps1') -Raw
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
$function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-Health'}, $true)
if (-not $function) { throw 'Installer health function missing' }
Invoke-Expression $function.Extent.Text
function Say($message, $color) {}
function Invoke-RestMethod { return $script:response }
function Start-Sleep {}
foreach ($case in @(
  @{ response = @{ok=$true;health='HEALTHY'}; accepted=$true },
  @{ response = @{ok=$true;health='CAUTION'}; accepted=$true },
  @{ response = @{ok=$true}; accepted=$true },
  @{ response = @{ok=$false;health='CAUTION'}; accepted=$false },
  @{ response = @{ok=$true;health='DEGRADED'}; accepted=$false },
  @{ response = @{ok=$true;health='STALLED'}; accepted=$false }
)) {
  $script:response = [pscustomobject]$case.response
  $actual = Wait-Health 'http://isolated-fixture/health' 0.02
  if (($null -ne $actual) -ne $case.accepted) { throw "Unexpected acceptance: $($script:response | ConvertTo-Json -Compress)" }
}
Write-Output 'Installer health contract: 6 cases passed'
