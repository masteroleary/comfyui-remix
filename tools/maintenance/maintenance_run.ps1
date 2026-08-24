# Runs wipe_media.ps1 on behalf of the app's Settings -> Clean page.
#
# WHY THIS EXISTS AT ALL, AND WHY IT IS A SCHEDULED TASK
#
# The server runs as SYSTEM (the ComfyRemixAutoStart boot task), and SYSTEM is the wrong
# account for this script even though it is the more privileged one. Every per-user store
# wipe_media.ps1 clears is found through $env:LOCALAPPDATA / $env:APPDATA -- the Explorer
# thumbnail cache, the Edge and Chrome caches, Recent, jump lists, Timeline, WebCache.
# Under SYSTEM those resolve to C:\Windows\System32\config\systemprofile, so the pass
# would walk an empty profile and report success having cleared nothing. Worse, the
# thumbnail pass kills explorer.exe and starts it again; started from session 0 the new
# explorer lands in session 0, and the signed-in desktop never comes back.
#
# So the work runs as the signed-in user, through a task registered with RunLevel
# Highest: the same account and the same elevation as running the script by hand, minus
# the consent prompt. That is the whole trick -- a task marked Highest is launched
# already-elevated, so no UAC dialog is ever raised, which is what makes the button
# usable from a phone.
#
# WHY A REQUEST FILE
#
# Arguments cannot travel with `schtasks /run`, so the server writes what it wants here
# and this reads it. Nothing out of that file ever reaches a command line: each key is
# checked against the allowlist below and bound as a real parameter, so the worst a
# corrupted or hand-edited request can do is fail validation and say so.
#
# Files, all under C:\ProgramData\ComfyRemix (readable by SYSTEM, writable by the task
# user -- register_maintenance_task.ps1 grants that):
#   maintenance-request.json   in    what to run
#   maintenance-status.json    out   state machine the server polls
#   maintenance-report.json    out   -Report output, when kind is 'scan'
#   maintenance.log            out   everything the run printed, appended line by line
[CmdletBinding()]
param(
  [string] $Dir = 'C:\ProgramData\ComfyRemix'
)

$ErrorActionPreference = 'Continue'

$requestPath = Join-Path $Dir 'maintenance-request.json'
$statusPath  = Join-Path $Dir 'maintenance-status.json'
$reportPath  = Join-Path $Dir 'maintenance-report.json'
$logPath     = Join-Path $Dir 'maintenance.log'

$utf8 = New-Object Text.UTF8Encoding $false   # no BOM: the reader is JSON.parse

function Log {
  param([string] $Text)
  try { [IO.File]::AppendAllText($logPath, $Text + "`r`n", $utf8) } catch { }
}

# Written open/close per call rather than held: the server polls this file while the run
# is going, and a handle kept open across a multi-minute wipe is a file it cannot read.
function Set-Status {
  param([hashtable] $Fields)
  $obj = [pscustomobject]$Fields
  try { [IO.File]::WriteAllText($statusPath, ($obj | ConvertTo-Json -Depth 4), $utf8) } catch { }
}

$startedAt = (Get-Date).ToString('o')
$id = ''
$kind = ''

try {
  if (-not (Test-Path $requestPath)) { throw "No request file at $requestPath" }
  $reqRaw = Get-Content -LiteralPath $requestPath -Raw
  # Consume it BEFORE parsing, so the request is single-use whatever it contains.
  # "schtasks /run" carries no arguments, so any later trigger -- a retry, a stray run
  # from Task Scheduler, a second server pointed at this directory -- re-executes
  # whatever file is still sitting here. After a clean, that file IS the clean, flags
  # and all, and nobody asked for it a second time.
  try { Move-Item -LiteralPath $requestPath -Destination ($requestPath + '.done') -Force } catch { }
  $req = $reqRaw | ConvertFrom-Json
  $id   = [string]$req.id
  $kind = [string]$req.kind
  if ($kind -ne 'scan' -and $kind -ne 'clean') { throw "Unknown kind '$kind'" }

  # ---------------------------------------------------------------- allowlist ----
  # Switch parameters this wrapper is willing to pass on, and the only values -Only may
  # carry. A name outside these lists is a hard failure, not a silently dropped flag:
  # dropping -SkipMedia would turn a cache clean into a media wipe.
  $ALLOWED_SWITCH = @(
    'Execute', 'Report',
    'IncludeRepoAssets', 'IncludeThumbCache', 'IncludeBrowserCache', 'CloseBrowsers',
    'IncludeShellArtifacts', 'IncludeShadowCopies',
    'SkipMedia', 'SkipRecycleBin', 'SkipTrim'
  )
  $ALLOWED_ONLY = @('Input', 'Output', 'Media', 'Temp', 'Samples', 'Lora')

  $p = @{}
  if ($req.params) {
    foreach ($prop in $req.params.PSObject.Properties) {
      $name = $prop.Name
      if ($name -eq 'Only') {
        $vals = @($prop.Value)
        foreach ($v in $vals) {
          if ($ALLOWED_ONLY -notcontains $v) { throw "Only: '$v' is not a known target" }
        }
        if ($vals.Count) { $p['Only'] = [string[]]$vals }
        continue
      }
      if ($ALLOWED_SWITCH -notcontains $name) { throw "Parameter '$name' is not allowed" }
      if ($prop.Value) { $p[$name] = $true }
    }
  }

  # The kind decides the mode, not the caller's flags -- a scan can never delete and a
  # clean can never quietly turn into a dry run that reports success.
  if ($kind -eq 'scan') {
    $p.Remove('Execute') | Out-Null
    $p['Report'] = $true
    $p['ReportPath'] = $reportPath
  } else {
    $p.Remove('Report') | Out-Null
    $p['Execute'] = $true
  }

  # ------------------------------------------------------------------- script ----
  # A sibling by default: wipe_media.ps1 ships next to this file. config.json's
  # maintenanceScript can point elsewhere without touching this file. The repo root is
  # found by walking up looking for config.json, since this lives two levels down.
  $root = @((Split-Path $PSScriptRoot -Parent),
            (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)) |
          Where-Object { $_ -and (Test-Path (Join-Path $_ 'config.json')) } | Select-Object -First 1
  $wipe = ''
  if ($root) {
    try {
      $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
      if ($cfg.maintenanceScript) { $wipe = [string]$cfg.maintenanceScript }
    } catch { }
  }
  if (-not $wipe) { $wipe = Join-Path $PSScriptRoot 'wipe_media.ps1' }
  if (-not (Test-Path -LiteralPath $wipe)) { throw "wipe_media.ps1 not found at $wipe" }

  # Fresh log per run: this is the transcript of THIS run, and the server shows all of it.
  try { [IO.File]::WriteAllText($logPath, '', $utf8) } catch { }

  # ReportPath is plumbing, not a choice -- the page shows this line back to the user
  # as what it ran, and a temp path in it is noise.
  $flags = ($p.GetEnumerator() | Where-Object { $_.Key -ne 'ReportPath' } | Sort-Object Name | ForEach-Object {
    if ($_.Value -is [array]) { "-$($_.Key) $($_.Value -join ',')" }
    elseif ($_.Value -is [string]) { "-$($_.Key) $($_.Value)" }
    else { "-$($_.Key)" }
  }) -join ' '
  Log "=== $startedAt  kind=$kind  id=$id ==="
  Log "running as $env:USERDOMAIN\$env:USERNAME (session $((Get-Process -Id $PID).SessionId))"
  Log "$wipe $flags"
  Log ''

  Set-Status @{ id = $id; kind = $kind; state = 'running'; startedAt = $startedAt; endedAt = ''; exitCode = $null; error = ''; flags = $flags }

  # *>&1 folds every stream into one, Write-Host included -- in 5.1 that goes to the
  # information stream, and without the 6> half of this the log would be nearly empty
  # (almost everything wipe_media.ps1 prints goes through Say -> Write-Host).
  & $wipe @p *>&1 | ForEach-Object {
    $text = if ($_ -is [System.Management.Automation.ErrorRecord]) { 'ERROR: ' + $_.Exception.Message } else { [string]$_ }
    Log $text
  }
  $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

  Log ''
  Log "=== finished $((Get-Date).ToString('o'))  exit=$code ==="
  Set-Status @{ id = $id; kind = $kind; state = 'done'; startedAt = $startedAt; endedAt = (Get-Date).ToString('o'); exitCode = $code; error = ''; flags = $flags }
} catch {
  $msg = $_.Exception.Message
  Log "WRAPPER FAILED: $msg"
  Set-Status @{ id = $id; kind = $kind; state = 'failed'; startedAt = $startedAt; endedAt = (Get-Date).ToString('o'); exitCode = $null; error = $msg; flags = '' }
  exit 1
}
