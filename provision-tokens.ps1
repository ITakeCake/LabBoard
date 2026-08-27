<#
  provision-tokens.ps1 — mint per-stick telemetry tokens, register their SHA-256
  hashes in the Cloudflare D1 'tokens' table, and write the raw tokens into
  LabDeploy's config\tokens.json (gitignored; ships to sticks like licences.json).

  Run on the MASTER (it has wrangler auth and the stick ledger). Idempotent: an
  existing real token for a drive is reused, its hash re-registered.

  -LabRoot is your LabDeploy folder (the one holding drive-id.txt and config\).
  Set it once as the LABDEPLOY_ROOT environment variable, or pass it every run.
  -ApiDir defaults to the api\ folder next to this script, so a clone needs no edit.

  Examples:
    .\provision-tokens.ps1 -LabRoot D:\LabDeploy      # master + every stick in the ledger, register in the CLOUD
    .\provision-tokens.ps1 -LocalOnly                 # same, but register in the LOCAL dev D1 (for testing)
    .\provision-tokens.ps1 -DriveId <guid> -Label 'LabDeploy-07'   # just one drive
#>
param(
  [string]$DriveId = '',
  [string]$Label = '',
  [switch]$LocalOnly,
  [string]$LabRoot    = $env:LABDEPLOY_ROOT,
  [string]$ApiDir     = (Join-Path $PSScriptRoot 'api'),
  [string]$LedgerPath = ''
)
$ErrorActionPreference = 'Stop'

if (-not $LabRoot) {
  throw "No LabDeploy folder given. Pass -LabRoot <path>, or set the LABDEPLOY_ROOT environment variable to the folder holding drive-id.txt and config\."
}
if (-not (Test-Path $LabRoot)) { throw "LabRoot not found: $LabRoot" }
if (-not (Test-Path $ApiDir))  { throw "Worker folder not found: $ApiDir (pass -ApiDir)" }
# The stick ledger lives under the master's own state root, beside the session logs.
if (-not $LedgerPath) {
  $masterRoot = if ($env:LABDEPLOY_MASTER_ROOT) { $env:LABDEPLOY_MASTER_ROOT } else { 'C:\LabDeployMaster' }
  $LedgerPath = Join-Path $masterRoot 'sticks.json'
}
$tokensPath = Join-Path $LabRoot 'config\tokens.json'

function New-Token {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').Replace('=','')
}
function Get-Sha256Hex([string]$s) {
  $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s))
  return (-join ($h | ForEach-Object { $_.ToString('x2') }))
}

# --- build the (driveId, label) work-list ---
$targets = @()
if ($DriveId) {
  $targets += @{ id = $DriveId; label = $Label }
} else {
  $masterId = (Get-Content (Join-Path $LabRoot 'drive-id.txt') -TotalCount 1 -ErrorAction Stop).Trim()
  if ($masterId) { $targets += @{ id = $masterId; label = 'Deployer (master)' } }
  if (Test-Path $LedgerPath) {
    $led = Get-Content $LedgerPath -Raw | ConvertFrom-Json
    foreach ($p in $led.PSObject.Properties) {
      if ($p.Name -eq $masterId) { continue }
      $lbl = if ($p.Value.PSObject.Properties['label'] -and $p.Value.label) { "$($p.Value.label)" } else { $p.Name.Substring(0, 8) }
      $targets += @{ id = $p.Name; label = $lbl }
    }
  } else {
    Write-Warning "No ledger at $LedgerPath - provisioning the master only."
  }
}

# --- load existing tokens.json (preserve any real tokens already minted) ---
$tokens = [ordered]@{}
if (Test-Path $tokensPath) {
  $raw = Get-Content $tokensPath -Raw | ConvertFrom-Json
  foreach ($p in $raw.PSObject.Properties) { if ($p.Name -notlike '_*') { $tokens[$p.Name] = $p.Value } }
}

$mode = if ($LocalOnly) { '--local' } else { '--remote' }
Push-Location $ApiDir
try {
  foreach ($t in $targets) {
    $id = $t.id; $label = $t.label
    if (-not $id) { continue }
    $short = $id.Substring(0, [Math]::Min(6, $id.Length))
    $cur = $tokens[$id]
    $token = if ($cur -and $cur.PSObject.Properties['token'] -and "$($cur.token)" -and "$($cur.token)" -notmatch 'REPLACE') { "$($cur.token)" } else { New-Token }
    $hash = Get-Sha256Hex $token
    $safeLabel = ($label -replace "'", "''")
    $sql = "INSERT OR REPLACE INTO tokens (token_hash, stick_id, label, enabled) VALUES ('$hash','$short','$safeLabel',1)"
    Write-Host ("  {0}  [{1}]  {2}" -f $id, $short, $label)
    & wrangler d1 execute labboard $mode --command $sql -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "wrangler d1 execute failed for $id (exit $LASTEXITCODE)" }
    $tokens[$id] = [pscustomobject]@{ token = $token; label = $label }
  }
} finally { Pop-Location }

# --- write tokens.json (doc keys first) ---
$out = [ordered]@{ _note = 'Per-stick telemetry tokens, keyed by drive-id GUID. Gitignored; ships to sticks. (Re)generate with provision-tokens.ps1. The server stores only the SHA-256 hash.' }
foreach ($k in $tokens.Keys) { $out[$k] = $tokens[$k] }
([pscustomobject]$out) | ConvertTo-Json -Depth 5 | Set-Content $tokensPath -Encoding UTF8
Write-Host ""
Write-Host ("Wrote {0} ({1} tokens) - register mode: {2}" -f $tokensPath, $tokens.Count, $mode)
Write-Host "Next: sync the sticks so each carries tokens.json (and telemetry.json)."
