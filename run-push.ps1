# run-push.ps1 — trigger a real telemetry push from the MASTER without the GUI.
# Lifts the telemetry functions out of Deploy-LabGUI.ps1 (same AST trick the tests
# use), seeds the real $script: state, and pushes the master store to Cloudflare.
# Advances the real master cursor, so a later GUI Refresh won't re-push everything.
# -LabRoot is your LabDeploy folder (the one holding Deploy-LabGUI.ps1). Set it once
# as the LABDEPLOY_ROOT environment variable, or pass it every run.
param(
  [string]$LabRoot = $env:LABDEPLOY_ROOT,
  [string]$ObsUrl  = 'https://labboard-api.REPLACE.workers.dev/obs',
  [string]$LogsDir = '',
  [int]$DeadlineSec = 0
)
$ErrorActionPreference = 'Stop'

if (-not $LabRoot) {
  throw "No LabDeploy folder given. Pass -LabRoot <path>, or set the LABDEPLOY_ROOT environment variable."
}
if ($ObsUrl -match 'REPLACE') {
  throw "ObsUrl is still the placeholder. Pass -ObsUrl https://labboard-api.<your-subdomain>.workers.dev/obs"
}
$masterRoot = if ($env:LABDEPLOY_MASTER_ROOT) { $env:LABDEPLOY_MASTER_ROOT } else { 'C:\LabDeployMaster' }
if (-not $LogsDir) { $LogsDir = Join-Path $masterRoot 'logs' }

$guiPath = Join-Path $LabRoot 'Deploy-LabGUI.ps1'
$tok = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($guiPath, [ref]$tok, [ref]$errs)
if ($errs.Count) { throw "GUI script has $($errs.Count) parse errors" }
$want = @('Get-ObsStableId','ConvertTo-ObsTimestamp','ConvertTo-ObsKvMap','New-LabObservation',
          'ConvertTo-LabObservation','Test-ObsMachineInBounds','Import-TelemetryConfig','Import-StickToken',
          'Get-PushCursor','Save-PushCursor','Invoke-ObsPost','Push-Observations','ConvertFrom-LabHostname',
          'Get-VendorLogPath','Get-CappedLogBytes','Invoke-LogPost')
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($want -notcontains $fn.Name) { continue }
    Set-Item -Path "function:script:$($fn.Name)" -Value $fn.Body.GetScriptBlock() -Force
}

# simple logger so every step is visible
function script:Write-LabLog { param($Event, $Data)
    $kv = if ($Data) { ($Data.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ' } else { '' }
    Write-Host ("  {0}  {1}" -f $Event, $kv)
}

# --- seed the top-level state the lifted functions read ---
$script:DriveId            = (Get-Content (Join-Path $LabRoot 'drive-id.txt') -TotalCount 1).Trim()
$script:BuildingsConfig    = (Get-Content (Join-Path $LabRoot 'config\buildings.json') -Raw | ConvertFrom-Json)
$script:TokensFile         = Join-Path $LabRoot 'config\tokens.json'
$script:StickTokenCache    = $null
$script:PushCursorFile     = Join-Path $LabRoot 'telemetry-pushed.json'
$script:MasterRoot         = $masterRoot
$script:IsMaster              = $true
$script:LogRoot            = $LogsDir
# obs-only backfill (R2/logs not enabled yet): real obsUrl, blank logUrl
$script:TelemetryConfig    = @{ enabled = $true; obsUrl = $ObsUrl; logUrl = ''; timeoutSec = 8; chunkSize = 500; backfill = $true }

Write-Host "Pushing $LogsDir  ->  $ObsUrl   (drive $($script:DriveId.Substring(0,6)))" -ForegroundColor Cyan
$r = Push-Observations -LogsDir $LogsDir -DeadlineSec $DeadlineSec
Write-Host ""
Write-Host ("RESULT: ok={0} files={1} observations={2} reason='{3}'" -f $r.ok, $r.files, $r.sent, $r.reason) -ForegroundColor Green
