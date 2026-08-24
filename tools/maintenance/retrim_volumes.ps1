# Forces a full ReTrim on the media volumes so the SSD controller's garbage collection
# erases blocks freed by large deletions now, instead of waiting for the weekly
# maintenance run. Called by wipe_media.ps1 as its last step, and runnable on its own.
#
# Windows sends TRIM at delete time (DisableDeleteNotify = 0), so this is belt-and-
# braces: ReTrim re-issues TRIM for ALL current free space, catching anything the
# inline notification dropped -- which is also what makes the deleted media
# unrecoverable rather than merely unlinked.
#
# Safe: ReTrim only marks already-free blocks as free. It touches no live data.
# Self-elevating -- expect one UAC prompt at the console.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  # Quote the path explicitly: a checkout can sit anywhere, and a folder with a space in
  # it would otherwise split into two arguments and the relaunch would silently do nothing.
  Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $MyInvocation.MyCommand.Path + '"')
  exit
}

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'retrim_result.txt'
"=== $(Get-Date) ===" | Out-File $log -Encoding utf8

# Which volumes to ReTrim comes from the configured paths, not from a hardcoded pair:
# the drives that hold the media library and ComfyUI's input/output/temp are exactly the
# ones a wipe just freed space on, and they differ per install. Skip anything that is not
# a real SSD -- ReTrim is meaningless on spinning rust, and Optimize-Volume would want
# -Defrag instead.
$root = @($PSScriptRoot,
          (Split-Path $PSScriptRoot -Parent),
          (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)) |
        Where-Object { $_ -and (Test-Path (Join-Path $_ 'config.json')) } | Select-Object -First 1
$drives = @()
if ($root) {
  try {
    $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
    $drives = @($cfg.mediaDir, $cfg.comfyDir, $cfg.comfyOutput, $cfg.comfyTemp) |
              Where-Object { $_ } |
              ForEach-Object { ([string]$_).Substring(0,1).ToUpper() } |
              Where-Object { $_ -match '^[A-Z]$' } |
              Select-Object -Unique
  } catch { }
}
if (-not $drives -or -not $drives.Count) {
  "no drives derived from config.json -- nothing to ReTrim" | Out-File $log -Append -Encoding utf8
  Write-Host "Wrote $log"
  exit
}
"volumes: $($drives -join ', ')  (from mediaDir / comfyDir / comfyOutput / comfyTemp)" |
  Out-File $log -Append -Encoding utf8

foreach ($drv in $drives) {
  $part = Get-Partition -DriveLetter $drv -ErrorAction SilentlyContinue
  if (-not $part) { "$drv : no such partition, skipped" | Out-File $log -Append -Encoding utf8; continue }

  $phys = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq $part.DiskNumber }
  if ($phys.MediaType -ne 'SSD') {
    "$drv : MediaType=$($phys.MediaType), not an SSD -- skipped" | Out-File $log -Append -Encoding utf8
    continue
  }

  $before = (Get-Volume -DriveLetter $drv).SizeRemaining
  "$drv : $($phys.FriendlyName) [$($phys.BusType) $($phys.MediaType)] free before = $([math]::Round($before/1GB,2)) GB" |
    Out-File $log -Append -Encoding utf8

  try {
    Optimize-Volume -DriveLetter $drv -ReTrim -Verbose -ErrorAction Stop 4>&1 |
      Out-File $log -Append -Encoding utf8
    $after = (Get-Volume -DriveLetter $drv).SizeRemaining
    # Free space is not expected to move -- the blocks were already unlinked. This
    # line exists to prove the volume was untouched, not to show a gain.
    "$drv : OK, free after = $([math]::Round($after/1GB,2)) GB" | Out-File $log -Append -Encoding utf8
  } catch {
    "$drv : FAILED -> $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
  }
}

"=== done $(Get-Date) ===" | Out-File $log -Append -Encoding utf8
Write-Host "Wrote $log"
