# Registers ComfyRemixMaintenance -- the on-demand task behind Settings -> Clean.
# Self-elevating: expect one UAC prompt, ONCE. That prompt is the whole point of the
# exercise: a task registered with RunLevel Highest is launched already-elevated, so
# every later run from the app raises no prompt at all and needs nobody at the console.
#
# The task deliberately runs as the signed-in user, NOT as SYSTEM like the server does.
# wipe_media.ps1 finds the thumbnail cache, the browser caches and the Recent/jump-list
# breadcrumbs through $env:LOCALAPPDATA and $env:APPDATA; under SYSTEM those point at
# C:\Windows\System32\config\systemprofile and the passes clear nothing while reporting
# success. It also restarts explorer.exe, which from session 0 comes back in session 0
# and leaves the real desktop without a shell. See tools\maintenance\maintenance_run.ps1.
#
# LogonType Interactive means the task runs inside that user's session -- so the desktop
# it restarts is the one they are looking at. The cost is that it will not start when
# nobody is signed in; the app says so rather than pretending the run happened.
[CmdletBinding()]
param(
  # Defaults to whoever runs this. Elevation keeps the same identity, so a normal
  # "run this script" from the desk registers the task for the person at the desk.
  [string] $TaskUser = "$env:USERDOMAIN\$env:USERNAME",
  [string] $TaskName = 'ComfyRemixMaintenance',
  # Left empty on purpose: taken from config.json's maintenanceDir if it is set there, so
  # the task and the server cannot end up watching two different folders. Changing that
  # key means re-running this script.
  [string] $DataDir  = '',
  # Skip the end-to-end scan that proves the chain works. Only useful if nobody is
  # signed in at the moment of registering.
  [switch] $NoVerify
)

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # Carry -TaskUser across the elevation: the elevated shell is the same account here,
  # but not if someone ran this with an explicit user in mind.
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $MyInvocation.MyCommand.Path + '"'),
    '-TaskUser', ('"' + $TaskUser + '"')
  )
  exit
}

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'register_maintenance_result.txt'
"=== $(Get-Date) ===" | Out-File $log -Encoding utf8
function Say { param([string] $T) $T | Tee-Object -FilePath $log -Append | Write-Host }

if (-not $DataDir) {
  # Two levels up, since this lives in tools\maintenance\ inside the checkout.
  $root = @((Split-Path $PSScriptRoot -Parent),
            (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)) |
          Where-Object { $_ -and (Test-Path (Join-Path $_ 'config.json')) } | Select-Object -First 1
  try {
    if ($root) {
      $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
      if ($cfg.maintenanceDir) { $DataDir = [string]$cfg.maintenanceDir }
    }
  } catch { }
}
if (-not $DataDir) { $DataDir = 'C:\ProgramData\ComfyRemix' }

$runner = Join-Path $PSScriptRoot 'maintenance_run.ps1'
if (-not (Test-Path -LiteralPath $runner)) {
  Say "FAILED: runner not found at $runner"
  Read-Host 'Press Enter to close'
  exit 1
}
Say "runner   : $runner"
Say "data dir : $DataDir"
Say "task user: $TaskUser"

# ------------------------------------------------------------------ data dir ----
# SYSTEM (the server) writes the request here; the task user writes status, log and
# report back. ProgramData's default ACL gives Users read but not write, so grant it --
# without this the task fails on its first Set-Status and the app sees a run that
# never started.
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
$icacls = & icacls $DataDir /grant ("{0}:(OI)(CI)M" -f $TaskUser) 2>&1
Say ("acl      : " + ($icacls | Select-Object -Last 1))

# ---------------------------------------------------------------------- task ----
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# -Dir is passed explicitly rather than left to the runner's default: the server reads
# maintenanceDir from config.json, and a task defaulting elsewhere would leave the two
# writing and watching different folders, which reads as a run that never started.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $PSScriptRoot -Argument (
  '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '" -Dir "' + $DataDir + '"'
)
# RunLevel Highest is the no-UAC half; LogonType Interactive is the right-session half.
$principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Highest
# No trigger at all -- this task exists only to be run on demand by the app.
# IgnoreNew so a second press while a wipe is running is dropped by the scheduler as
# well as by the server, and a two-hour ceiling so a stuck run cannot sit forever.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings `
    -Description 'On-demand media/cache cleanup for ComfyRemix (Settings -> Clean). Runs wipe_media.ps1 as the signed-in user, elevated.' `
    -Force -ErrorAction Stop | Out-Null
  Say "registered: $TaskName"
} catch {
  Say "FAILED to register: $($_.Exception.Message)"
  Read-Host 'Press Enter to close'
  exit 1
}

$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($t) {
  Say ("state    : {0}  user={1}  runlevel={2}  logontype={3}" -f `
    $t.State, $t.Principal.UserId, $t.Principal.RunLevel, $t.Principal.LogonType)
}

# -------------------------------------------------------------------- verify ----
# Registering a task and finding out later that it never runs is the failure this
# project keeps hitting, so prove the round trip now: fire a scan and wait for the
# status file to come back 'done'. A scan only measures -- it deletes nothing.
if (-not $NoVerify) {
  Say ''
  Say 'verifying: firing a scan (measures only, deletes nothing)...'
  $reqPath = Join-Path $DataDir 'maintenance-request.json'
  $statusPath = Join-Path $DataDir 'maintenance-status.json'
  $id = [string](Get-Date).Ticks
  $utf8 = New-Object Text.UTF8Encoding $false
  [IO.File]::WriteAllText($reqPath, (@{ id = $id; kind = 'scan'; params = @{} } | ConvertTo-Json -Depth 4), $utf8)
  Remove-Item $statusPath -Force -ErrorAction SilentlyContinue

  & schtasks /run /tn $TaskName 2>&1 | ForEach-Object { Say ("schtasks : " + $_) }

  $deadline = (Get-Date).AddSeconds(180)
  $final = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    if (-not (Test-Path $statusPath)) { continue }
    try { $st = Get-Content $statusPath -Raw | ConvertFrom-Json } catch { continue }
    if ($st.id -ne $id) { continue }
    if ($st.state -eq 'running') { continue }
    $final = $st
    break
  }
  if ($null -eq $final) {
    Say 'VERIFY FAILED: the task never reported back.'
    Say '  Most likely nobody is signed in -- LogonType Interactive needs a live session.'
    Say ('  Check the task history, and ' + (Join-Path $DataDir 'maintenance.log'))
  } elseif ($final.state -eq 'done') {
    Say "VERIFY OK: scan finished (exit=$($final.exitCode))."
    $rep = Join-Path $DataDir 'maintenance-report.json'
    if (Test-Path $rep) {
      try {
        $r = Get-Content $rep -Raw | ConvertFrom-Json
        Say ("  measured {0} item(s) as {1}, elevated={2}" -f @($r.items).Count, $r.user, $r.elevated)
        if (-not $r.elevated) { Say '  WARNING: the run was NOT elevated -- shadow copies cannot be inspected.' }
      } catch { Say "  report unreadable: $($_.Exception.Message)" }
    } else {
      Say '  WARNING: no report file was produced.'
    }
  } else {
    Say "VERIFY FAILED: state=$($final.state) error=$($final.error)"
  }
}

Say ''
Say "log: $log"
Read-Host 'Press Enter to close'
