<#
.SYNOPSIS
  Wipes every place ComfyUI/ComfyRemix media accumulates, then verifies and re-TRIMs.

.DESCRIPTION
  Written after the 2026-08-16 sweep, which found 7.79 GB of generated PNGs sitting in
  a folder none of the obvious cleanup covered. The point of this script is that the
  target list lives in ONE place instead of being re-derived (and re-missed) each time.

  Locations, and why each is here. Every path comes from config.json -- none is
  hardcoded, because a constant here that has gone stale does not fail, it silently
  wipes the wrong thing, or nothing at all:
    <comfyDir>\input          ComfyUI inputs
    <comfyOutput>             ComfyUI outputs
    <mediaDir>                the app's library / archive root
    <comfyTemp>               preview + temp renders  <-- THE ONE THAT GETS MISSED.
                              ComfyUI writes temp beside its own code, which on a
                              Docker install is a different tree from the bind-mounted
                              input/output pair -- so nothing under comfyDir points at
                              it and the app never lists it. It needs its own config
                              key, and is skipped (loudly) when that key is unset.
  Extended scope adds whatever "maintenanceExtraTargets" names in config.json: source or
  training material that is ComfyUI-adjacent but NOT generated, and so not regenerable.
  Empty by default -- these are originals, and the script assumes none of them.

  Deliberately NOT touched at any scope: custom_nodes\* under the ComfyUI checkout, and
  any backup of it. That is example art shipped by the node repos -- not yours, and
  deleting it breaks node documentation.

  Run with NO arguments and it turns interactive: it measures each item in turn, tells you
  what it holds, and asks y or n, then confirms once before deleting anything. Any single
  parameter switches that off and the flags below behave exactly as documented -- so the
  old no-questions dry run is now "-Scope Core" rather than a bare invocation.

.PARAMETER Scope
  Core     (default) generated media + app library only.
  Extended also source clips/stills and LoRA training sets. Destructive to originals.

.PARAMETER Only
  Narrow the run to specific targets instead of all of them. One or more of:
    Input    <comfyDir>\input
    Output   <comfyOutput>
    Media    the app library (<mediaDir>)
    Temp     <comfyTemp> -- ComfyUI's preview/render cache, usually the biggest of
             the four and the only one that is pure throwaway
    Extra    everything maintenanceExtraTargets names (an Extended target, so naming
             it implies -Scope Extended)
  Everything else still applies: it is still a dry run without -Execute, and the
  Recycle Bin / ReTrim passes still run unless you also pass -SkipRecycleBin / -SkipTrim.
.PARAMETER Execute
  Actually delete. WITHOUT this the script is a dry run and only reports -- always look
  at the dry run first.

.PARAMETER IncludeRepoAssets
  Also delete git-tracked files inside mediaDir. Off by default: Media\Anima_Demo.png is
  committed, so deleting it just leaves a dirty worktree and the blob stays in history.

.PARAMETER IncludeThumbCache
  Also clear Explorer's thumbcache_*.db. These retain thumbnails of files you browsed in
  Explorer and survive deleting the originals. Requires killing explorer.exe, so it is
  opt-in.

.PARAMETER IncludeBrowserCache
  Also clear Edge's and Chrome's caches. The browser keeps its own copy of every image
  the app served, so media thumbnails keep rendering out of cache after the files are
  gone. Cache only -- cookies, history, passwords and saved tabs are left alone.

.PARAMETER CloseBrowsers
  Let -IncludeBrowserCache close a running Edge/Chrome instead of skipping it. The cache
  files are locked while the browser runs. Tabs are restored on next launch, but anything
  unsaved in a page is lost, so this is opt-in.

.PARAMETER SkipMedia
  Do not touch the media targets at all -- no ComfyUI input/output, no app library, no
  temp. Use it to exercise the browser-cache or recycle-bin passes on their own.

.PARAMETER SkipRecycleBin
  Leave the Recycle Bin alone.

.PARAMETER BrowserCacheOnly
  Shorthand for "browsers and nothing else": implies -IncludeBrowserCache, -SkipMedia,
  -SkipRecycleBin and -SkipTrim. Nothing new is freed on D:/E: in this mode, so the
  ReTrim would only cost you a UAC prompt for no benefit.

.PARAMETER IncludeShellArtifacts
  Also clear the Windows breadcrumb layer -- the record that a file existed, as opposed
  to the file itself:
    Recent\*.lnk              full path, size, timestamps and volume serial of every
                              file you opened, kept long after the file is deleted
    Recent\*Destinations      jump lists: the same data again, per application
    ActivitiesCache.db        Timeline -- which app had which file open, and when
    WebCacheV01.dat           the WinINET store: URL history, download records and
                              Explorer's file:// navigations. NOT Chrome/Edge-Chromium,
                              whose caches -IncludeBrowserCache handles.
  With -Execute this kills taskhostw.exe and stops the per-user CDPUserSvc, because both
  databases are held open. Both come back on their own; Windows rebuilds the files empty.
  The registry equivalents (RecentDocs, OpenSavePidlMRU, ShellBags) are NOT touched.
.PARAMETER IncludeShadowCopies
  Also delete the Volume Shadow Copies (System Restore points). A snapshot keeps the
  blocks it references alive, so a cache you clear today still exists, readable, inside
  any restore point taken while that cache was full -- clearing the live copy does not
  reach into them. This is the only way to remove that copy.
  Costs you the ability to roll back to those points, and NEEDS AN ELEVATED PROMPT:
  unelevated, Windows will not even enumerate them, so the pass reports and does nothing.
  Windows creates new restore points afterwards unless System Protection is turned off.
.PARAMETER SkipTrim
  Skip the ReTrim pass at the end.

.EXAMPLE
  .\wipe_media.ps1                      # INTERACTIVE: asks about each item, confirms once
  .\wipe_media.ps1 -Scope Core          # dry run, no questions (any flag = non-interactive)
  .\wipe_media.ps1 -Execute             # wipe generated media
  .\wipe_media.ps1 -Scope Extended -Execute -IncludeThumbCache
  .\wipe_media.ps1 -Execute -IncludeBrowserCache -CloseBrowsers   # also flush Edge/Chrome
  .\wipe_media.ps1 -BrowserCacheOnly -Execute -CloseBrowsers      # browsers ONLY -- media untouched
  .\wipe_media.ps1 -Only Temp -Execute -SkipRecycleBin            # just ComfyUI's render cache
  .\wipe_media.ps1 -SkipMedia -IncludeShellArtifacts -Execute      # breadcrumbs only
#>
[CmdletBinding()]
param(
  [ValidateSet('Core','Extended')] [string] $Scope = 'Core',
  [ValidateSet('Input','Output','Media','Temp','Extra')] [string[]] $Only,
  [switch] $Execute,
  [switch] $IncludeRepoAssets,
  [switch] $IncludeThumbCache,
  [switch] $IncludeBrowserCache,
  [switch] $CloseBrowsers,
  [switch] $IncludeShellArtifacts,
  [switch] $IncludeShadowCopies,
  [switch] $SkipMedia,
  [switch] $SkipRecycleBin,
  [switch] $BrowserCacheOnly,
  [switch] $SkipTrim,
  # -Report measures every target and writes the result as JSON instead of deleting
  # anything. It exists so a caller that is not a console -- the app's Settings ->
  # Clean page -- can put the same "N files, N GB" beside each checkbox that the
  # interactive run prints above each question, without re-deriving the target list on
  # its own side. That re-derivation is how temp got missed in the first place.
  # -Report never deletes, whatever else is passed alongside it.
  [switch] $Report,
  [string] $ReportPath
)

$ErrorActionPreference = 'Continue'
# The repo root, which is NOT simply the script's parent: this ships in tools\maintenance\
# and may also be run from a copy kept elsewhere. Locate it by config.json, walking up,
# and REFUSE if it is not found. There used to be a fallback to a fixed path here, which
# is worse than failing: $root is what the git-tracked-file check compares mediaDir
# against, so a wrong root silently switches that protection off and the committed
# Anima_Demo.png goes with the wipe.
$root = @($PSScriptRoot,
          (Split-Path $PSScriptRoot -Parent),
          (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)) |
        Where-Object { $_ -and (Test-Path (Join-Path $_ 'config.json')) } | Select-Object -First 1
if (-not $root) {
  throw "Could not find config.json in '$PSScriptRoot' or the two directories above it. " +
        "This script deletes files and will not guess where the install is -- run it from " +
        "inside the ComfyRemix checkout."
}
# A report is a look, not a run, so it logs somewhere else: opening the app's Clean page
# would otherwise overwrite the record of the last real wipe with a scan.
$log  = Join-Path $PSScriptRoot $(if ($Report) { 'wipe_report_log.txt' } else { 'wipe_result.txt' })
if ($Report -and -not $ReportPath) { $ReportPath = Join-Path $PSScriptRoot 'wipe_report.json' }

function Say {
  param([string] $Text)
  $Text | Tee-Object -FilePath $log -Append | Write-Host
}

# Interactive mode is the no-arguments case -- someone typed the script name and nothing
# else. ANY parameter means the caller already knows what they want, so every documented
# flag combination behaves exactly as it did before.
$interactive = ($PSBoundParameters.Count -eq 0)

function Ask {
  param([string] $Question, [switch] $DefaultYes)
  $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
  while ($true) {
    # No console at all -- piped, scheduled, or a non-interactive host. Read-Host throws
    # there, so take the default (which is "no" everywhere that matters) and say so,
    # rather than spraying an exception per question or looping forever on nothing.
    try { $a = Read-Host "$Question $hint" }
    catch {
      $assumed = if ($DefaultYes) { 'yes' } else { 'no' }
      Write-Host "      (no console available -- assuming $assumed)"
      return [bool]$DefaultYes
    }
    if ($null -eq $a) { return [bool]$DefaultYes }
    $a = $a.Trim().ToLowerInvariant()
    if ($a -eq '') { return [bool]$DefaultYes }
    if (@('y','yes') -contains $a) { return $true }
    if (@('n','no')  -contains $a) { return $false }
    Write-Host '      please answer y or n'
  }
}

"=== $(Get-Date) === scope=$Scope execute=$($Execute.IsPresent) interactive=$interactive" | Out-File $log -Encoding utf8
if (-not $Execute -and -not $interactive) { Say 'DRY RUN -- nothing will be deleted. Re-run with -Execute to act.' }
if ($interactive) {
  Say 'INTERACTIVE -- no flags given. Each item is measured, then you are asked y or n.'
  Say 'Nothing is deleted until the single confirmation at the end. Enter on its own = no.'
}

# ------------------------------------------------------------------ mode ----
# What this run is allowed to touch, resolved once so no section has to re-derive it.
# Kept as separate booleans rather than reassigning the switch params, so -WhatIf-style
# reasoning stays possible and the params still report what the caller actually typed.
# -Only Extra names targets that exist only under Extended scope, so asking for them
# implies it -- otherwise the filter below would narrow the run to nothing and the
# script would cheerfully report that it had cleaned everything.
if ($Only -and ($Only -contains 'Extra')) { $Scope = 'Extended' }
$doMedia    = -not ($SkipMedia      -or $BrowserCacheOnly)
$doBin      = -not ($SkipRecycleBin -or $BrowserCacheOnly)
$doTrim     = -not ($SkipTrim       -or $BrowserCacheOnly)
$doBrowsers = $IncludeBrowserCache -or $BrowserCacheOnly
$binDrives  = if ($doBin) { @('C','D','E') } else { @() }
if (-not $doMedia) { Say 'MEDIA SKIPPED -- ComfyUI folders and the app library will not be touched.' }
# Asked here rather than with the other questions because $Scope decides which targets get
# BUILT below -- by the time the per-target questions run, the list already exists.
if ($interactive) {
  Write-Host ''
  if (Ask '  Include the EXTENDED targets too (whatever maintenanceExtraTargets names -- these are ORIGINALS, not regenerable)?') { $Scope = 'Extended' }
}
# A report is a menu, not a run: it measures the Extended targets as well so the caller
# can offer them as options. Measuring something does not select it.
if ($Report) { $Scope = 'Extended' }
if (-not $doBrowsers -and -not $doMedia -and -not $doBin -and -not $IncludeShellArtifacts -and -not $IncludeThumbCache -and -not $IncludeShadowCopies) { Say 'Nothing selected to clean -- did you mean -BrowserCacheOnly?' }

# ---------------------------------------------------------------- config ----
# Read paths from config.json rather than hardcoding: a media root gets moved or renamed
# eventually, and a stale constant here does not fail loudly -- it wipes nothing, or the
# wrong thing, and reports success either way.
# Fatal, not a warning. There are no path defaults left to fall back TO, and carrying on
# with an empty $cfg would mean deciding what to delete from nothing at all.
$cfg = $null
try { $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json }
catch { throw "Could not read $(Join-Path $root 'config.json'): $($_.Exception.Message)" }

function Cfg { param($Name, $Default) if ($cfg -and $cfg.$Name) { return $cfg.$Name } else { return $Default } }
# For the paths the script cannot sensibly invent. Deleting is not the place for a guess.
function CfgRequired {
  param($Name)
  $v = Cfg $Name $null
  if (-not $v) { throw "config.json has no '$Name'. This script deletes files; it will not guess a path." }
  return $v
}

# Normalize separators: config.json stores paths with FORWARD slashes, while $root
# arrives with backslashes. Without this the "is mediaDir inside the repo?" test below
# compares two spellings of the same path and silently fails, so git-tracked assets stop
# being skipped and a wipe deletes committed files.
function Norm { param($P) if ($P) { return ([IO.Path]::GetFullPath($P.Replace('/','\'))).TrimEnd('\') } else { return $P } }

$mediaDir    = Norm (CfgRequired 'mediaDir')
$comfyDir    = Norm (CfgRequired 'comfyDir')
$comfyOutput = Norm (Cfg 'comfyOutput' (Join-Path $comfyDir 'output'))
$comfyUrl    = Cfg 'comfyUrl' 'http://127.0.0.1:8188'
# comfyDir is the HOST side of the bind mounts, not the source checkout. temp lives with
# the checkout, which is a different tree on a Docker install -- so it gets its own key,
# and is skipped rather than guessed at when that key is unset.
$comfyTemp   = Norm (Cfg 'comfyTemp' $null)

$targets = @(
  [pscustomobject]@{ Path = (Join-Path $comfyDir 'input'); Label = 'ComfyUI input';  Key = 'input';  Keep = $true }
  [pscustomobject]@{ Path = $comfyOutput;                  Label = 'ComfyUI output'; Key = 'output'; Keep = $true }
  [pscustomobject]@{ Path = $mediaDir;                     Label = 'App media root'; Key = 'media';  Keep = $true }
)
# The whole point of this script is that temp is the one that gets missed, so an unset
# comfyTemp says so out loud rather than quietly cleaning three of the four.
if ($comfyTemp) {
  $targets += [pscustomobject]@{ Path = $comfyTemp; Label = 'ComfyUI temp (the easily-missed one)'; Key = 'temp'; Keep = $true }
} else {
  Say 'NOTE: comfyTemp is not set in config.json, so ComfyUI''s preview/render cache is NOT included. It is usually the largest of the four.'
}
if ($Scope -eq 'Extended') {
  # Config-driven and empty by default: these are ORIGINALS, not regenerable output, so a
  # target exists here only because someone named it. Each entry is either a path string,
  # or { path, label, childSubfolder } -- the last sweeps one level down and takes the
  # named subfolder of each child, which is how a training-set root is laid out.
  foreach ($x in @(Cfg 'maintenanceExtraTargets' @())) {
    $isStr  = $x -is [string]
    $xp     = Norm $(if ($isStr) { $x } else { $x.path })
    if (-not $xp) { continue }
    $xl     = $(if (-not $isStr -and $x.label) { $x.label } else { 'Extra target' })
    $child  = $(if ($isStr) { $null } else { $x.childSubfolder })
    if ($child) {
      Get-ChildItem $xp -Directory -EA SilentlyContinue | ForEach-Object {
        $sub = Join-Path $_.FullName $child
        if (Test-Path $sub) { $script:targets += [pscustomobject]@{ Path = $sub; Label = ($xl + ': ' + $_.Name); Key = 'extra'; Keep = $true } }
      }
    } else {
      $targets += [pscustomobject]@{ Path = $xp; Label = $xl; Key = 'extra'; Keep = $true }
    }
  }
}

# -Only narrows the list before anything measures or deletes, so the filter cannot be
# forgotten by a later pass. Applied BEFORE the -SkipMedia guard below, so -SkipMedia
# still wins if both are given.
if ($Only) {
  $targets = @($targets | Where-Object { $Only -contains $_.Key })
  Say ("ONLY: " + ($Only -join ', ') + "  ($($targets.Count) target(s) selected; everything else is untouched)")
}
# An empty target list is how -SkipMedia is enforced: every later pass (measure, delete,
# verify, container check) iterates $targets, so clearing it here disables all of them
# at once instead of leaving four separate places that each have to remember the flag.
if (-not $doMedia) { $targets = @() }
# ------------------------------------------------------------- preflight ----
# Deleting temp mid-generation yanks previews out from under a running job.
Say ''
Say '--- preflight: ComfyUI queue ---'
$queueIdle = $false
try {
  $q = Invoke-RestMethod -Uri "$comfyUrl/queue" -TimeoutSec 10 -ErrorAction Stop
  $running = @($q.queue_running).Count
  $pending = @($q.queue_pending).Count
  Say "    running=$running pending=$pending"
  if ($running -eq 0 -and $pending -eq 0) { $queueIdle = $true }
} catch {
  Say "    ComfyUI not reachable ($($_.Exception.Message)) -- treating as idle"
  $queueIdle = $true
}
if ($doMedia -and -not $queueIdle) {
  if ($Report) {
    # Measuring is read-only, so a busy queue is something to carry INTO the report --
    # the caller warns before it offers Run -- not a reason to refuse to look.
    Say 'ComfyUI is BUSY -- measured anyway; a real run would refuse the media targets.'
  } elseif ($interactive) {
    # Do not kill the whole run: the browser, thumbnail and breadcrumb passes have nothing
    # to do with the render queue, and only the media targets are unsafe to touch mid-job.
    Say 'ComfyUI is BUSY -- media targets are off the table this run. Other passes can still go.'
    $targets = @(); $doMedia = $false
  } else {
    Say 'ABORT: ComfyUI is busy. Let the queue drain, then re-run.'
    return
  }
}
# NOTE: do NOT stop the container to do this. restart=unless-stopped will not resurrect a
# deliberately stopped container, so you would be back to the start-comfyui.ps1 gate dance
# for no reason. The mount makes deletions visible to the container immediately.

# ------------------------------------------------------- measure + delete ----
function Measure-Target {
  param([string] $Path)
  # Enumerate and COUNT ERRORS. A Win32Exception mid-enumeration truncates the pipeline
  # silently -- that is how a full D: sweep once reported 0 media files when there were
  # thousands. A scan that errored must never be reported as "clean".
  $err = $null
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorVariable err -ErrorAction SilentlyContinue)
  $hard  = @($err | Where-Object { $_.Exception -is [System.ComponentModel.Win32Exception] })
  [pscustomobject]@{
    Count      = $files.Count
    Bytes      = ($files | Measure-Object Length -Sum).Sum
    Files      = $files
    Suspect    = ($hard.Count -gt 0)
    ErrorCount = @($err).Count
  }
}

# The browser and shell-artifact target lists live in these two functions because they are
# now needed TWICE: once by the interactive prompt, to say what a "y" would cost, and once
# by the pass that does the deleting. Two copies would drift, and a drifted list is how
# temp got missed in the first place.
function Get-BrowserCaches {
  # Per-profile stores. Chromium spreads images across several of these: Cache_Data holds
  # ordinary HTTP responses, CacheStorage holds whatever a service worker cached itself --
  # clearing only Cache_Data leaves a PWA still serving old thumbnails offline.
  $perProfile = @(
    'Cache\Cache_Data', 'Code Cache\js', 'Code Cache\wasm', 'GPUCache',
    'Service Worker\CacheStorage', 'Service Worker\ScriptCache',
    'DawnGraphiteCache', 'DawnWebGPUCache'
  )
  # Shared stores that sit at the User Data root, outside any profile.
  $perRoot = @('ShaderCache', 'GrShaderCache', 'GraphiteDawnCache')
  $known = @(
    [pscustomobject]@{ Name = 'Edge';   Process = 'msedge'; Root = (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data') }
    [pscustomobject]@{ Name = 'Chrome'; Process = 'chrome'; Root = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data') }
  )
  $out = @()
  foreach ($b in $known) {
    $present = Test-Path $b.Root
    $dirs = @()
    if ($present) {
      foreach ($r in $perRoot) { $p = Join-Path $b.Root $r; if (Test-Path $p) { $dirs += $p } }
      Get-ChildItem -LiteralPath $b.Root -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' -or $_.Name -like '* Profile' } |
        ForEach-Object {
          $prof = $_.FullName
          foreach ($sub in $perProfile) { $p = Join-Path $prof $sub; if (Test-Path $p) { $dirs += $p } }
        }
    }
    $out += [pscustomobject]@{ Name = $b.Name; Process = $b.Process; Root = $b.Root; Present = $present; Dirs = $dirs }
  }
  $out
}

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ShadowCopies {
  # Returns $null for "cannot tell", @() for "none exist". The distinction matters:
  # unelevated, Win32_ShadowCopy throws an initialization failure rather than returning an
  # empty set, and reporting that as "no snapshots" would be the exact false all-clear this
  # script exists to avoid.
  if (-not (Test-Admin)) { return $null }
  try { return @(Get-CimInstance Win32_ShadowCopy -ErrorAction Stop) } catch { return $null }
}
function Get-ShellArtifactGroups {
  $recent = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'
  @(
    [pscustomobject]@{ Label = 'Recent items (.lnk)';       Path = $recent; Filter = '*.lnk' }
    [pscustomobject]@{ Label = 'Jump lists (automatic)';    Path = (Join-Path $recent 'AutomaticDestinations'); Filter = '*' }
    [pscustomobject]@{ Label = 'Jump lists (custom)';       Path = (Join-Path $recent 'CustomDestinations');    Filter = '*' }
    [pscustomobject]@{ Label = 'Timeline (ActivitiesCache)';Path = (Join-Path $env:LOCALAPPDATA 'ConnectedDevicesPlatform'); Filter = 'ActivitiesCache.db*' }
    [pscustomobject]@{ Label = 'WebCache (WinINET store)';  Path = (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WebCache'); Filter = '*' }
  )
}

function Get-ShellArtifactFiles {
  # Recurse: ConnectedDevicesPlatform buries the db one folder deep under a per-account
  # id, and the WebCache folder carries .jfm and log files beside the database itself.
  param($Group)
  if (-not (Test-Path $Group.Path)) { return @() }
  @(Get-ChildItem -LiteralPath $Group.Path -Filter $Group.Filter -File -Force -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'desktop.ini' })
}
# Files inside mediaDir that git tracks (Anima_Demo.png). Skipped unless -IncludeRepoAssets:
# deleting them only dirties the worktree, and the blob survives in history regardless.
$tracked = @()
if ($doMedia -and -not $IncludeRepoAssets -and $mediaDir.StartsWith((Norm $root), [StringComparison]::OrdinalIgnoreCase)) {
  try {
    Push-Location $root
    $rel = $mediaDir.Substring((Norm $root).Length).TrimStart('\')
    $tracked = @(git ls-files -- $rel 2>$null | ForEach-Object { Norm (Join-Path $root $_) })
    Pop-Location
  } catch { }
  if ($tracked.Count) { Say "    (skipping $($tracked.Count) git-tracked file(s) in mediaDir; -IncludeRepoAssets to include)" }
}

Say ''
# ---------------------------------------------------------------- report ----
# The same measurements the interactive pass makes below, emitted as JSON instead of
# asked aloud -- same $targets, same Measure-Target, same Get-BrowserCaches /
# Get-ShellArtifactGroups / Get-ShadowCopies. Labels are deliberately thin: the caller
# draws the list, and all it needs from this side is which key holds how much.
if ($Report) {
  function New-Row {
    param(
      [hashtable] $R
    )
    [pscustomobject]@{
      key     = $R.Key
      label   = $R.Label
      path    = [string]$R.Path
      present = [bool]$R.Present
      files   = [int]$R.Files
      bytes   = [long]$R.Bytes
      suspect = [bool]$R.Suspect
      detail  = [string]$R.Detail
    }
  }
  $rows = @()

  # Media targets, grouped by Key rather than by folder: -Only takes one token per key,
  # and the extra targets may be several folders behind the single 'Extra' one, so the caller
  # gets one row per flag it can actually send back.
  foreach ($g in ($targets | Group-Object Key)) {
    $gFiles = 0; $gBytes = [long]0; $gSuspect = $false; $gPresent = $false; $gPaths = @()
    foreach ($t in $g.Group) {
      $gPaths += $t.Path
      if (-not (Test-Path $t.Path)) { continue }
      $gPresent = $true
      $m = Measure-Target $t.Path
      $victims = @($m.Files | Where-Object { $tracked -notcontains $_.FullName -and $_.Name -ne 'desktop.ini' })
      $gFiles += $victims.Count
      $gBytes += [long](($victims | Measure-Object Length -Sum).Sum)
      if ($m.Suspect) { $gSuspect = $true }
    }
    $rows += New-Row @{
      Key = $g.Name; Label = $g.Group[0].Label; Path = ($gPaths -join '; ')
      Files = $gFiles; Bytes = $gBytes; Present = $gPresent; Suspect = $gSuspect
      Detail = $(if ($g.Count -gt 1) { "$($g.Count) folders" } else { '' })
    }
  }

  # Recycle Bin, across the same three drives the delete pass sweeps.
  $rbFiles = 0; $rbBytes = [long]0
  foreach ($d in 'C','D','E') {
    $rb = $d + ':\$Recycle.Bin'
    if (-not (Test-Path $rb)) { continue }
    Get-ChildItem -LiteralPath $rb -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      $f = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -ne 'desktop.ini' })
      $rbFiles += $f.Count
      $rbBytes += [long](($f | Measure-Object Length -Sum).Sum)
    }
  }
  $rows += New-Row @{ Key = 'recycle'; Label = 'Recycle Bin (C:, D:, E:)'; Path = 'C:, D:, E:'; Files = $rbFiles; Bytes = $rbBytes; Present = $true }

  # Explorer thumbnails. Found through $env:LOCALAPPDATA -- which is exactly why this
  # script has to run as the signed-in user and not as the service account. See
  # scripts\maintenance_run.ps1 in the app repo.
  $tcDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
  $tc = @(Get-ChildItem $tcDir -Filter 'thumbcache_*.db' -Force -ErrorAction SilentlyContinue)
  $rows += New-Row @{
    Key = 'thumbs'; Label = 'Explorer thumbnail cache'; Path = $tcDir
    Files = $tc.Count; Bytes = [long](($tc | Measure-Object Length -Sum).Sum)
    Present = ($tc.Count -gt 0); Detail = 'clearing this restarts Explorer'
  }

  # Browser caches, plus which of them are running right now -- the caller needs that to
  # decide whether to offer the "close them" tick, exactly as the console does.
  $bc = @(Get-BrowserCaches | Where-Object { $_.Present })
  $bcFiles = 0; $bcBytes = [long]0
  foreach ($b in $bc) { foreach ($d in $b.Dirs) { $mm = Measure-Target $d; $bcFiles += $mm.Count; $bcBytes += [long]$mm.Bytes } }
  $busy = @($bc | Where-Object { @(Get-Process -Name $_.Process -ErrorAction SilentlyContinue).Count } | ForEach-Object { $_.Name })
  $rows += New-Row @{
    Key = 'browsers'; Label = ('Browser caches (' + (($bc | ForEach-Object { $_.Name }) -join ' + ') + ')')
    Path = (($bc | ForEach-Object { $_.Root }) -join '; ')
    Files = $bcFiles; Bytes = $bcBytes; Present = ($bc.Count -gt 0)
    Detail = $(if ($busy.Count) { 'running: ' + ($busy -join ', ') } else { '' })
  }

  # Breadcrumbs, with the per-group breakdown the console prints under the heading.
  $sg = @(Get-ShellArtifactGroups | ForEach-Object { [pscustomobject]@{ Label = $_.Label; Files = @(Get-ShellArtifactFiles $_) } })
  $sgFiles = [int](($sg | ForEach-Object { $_.Files.Count } | Measure-Object -Sum).Sum)
  $sgBytes = [long](($sg | ForEach-Object { $_.Files } | Measure-Object Length -Sum).Sum)
  $rows += New-Row @{
    Key = 'breadcrumbs'; Label = 'Recent, jump lists, Timeline, WebCache'
    Path = (Join-Path $env:APPDATA 'Microsoft\Windows\Recent')
    Files = $sgFiles; Bytes = $sgBytes; Present = ($sgFiles -gt 0)
    Detail = (($sg | Where-Object { $_.Files.Count } | ForEach-Object { "$($_.Label): $($_.Files.Count)" }) -join ', ')
  }

  # Shadow copies. $null means "could not look" (unelevated), which is NOT the same as
  # none -- present:false carrying that detail is how the caller tells the two apart.
  $shadows = Get-ShadowCopies
  if ($null -eq $shadows) {
    # $null covers two different failures and they must not read the same. Unelevated,
    # Win32_ShadowCopy throws an initialization failure by design. Elevated, the same $null
    # means the provider did not answer -- and blaming admin rights there sends you off to
    # fix something that is not broken.
    $why = $(if (Test-Admin) { 'could not be read -- VSS did not answer this query' } else { 'cannot be inspected without admin' })
    $rows += New-Row @{ Key = 'shadows'; Label = 'Volume Shadow Copies'; Present = $false; Detail = $why }
  } else {
    $rows += New-Row @{
      Key = 'shadows'; Label = 'Volume Shadow Copies (System Restore points)'
      Files = $shadows.Count; Present = ($shadows.Count -gt 0)
      Detail = (($shadows | Group-Object VolumeName | ForEach-Object { "$($_.Name.Trim()): $($_.Count)" }) -join ', ')
    }
  }

  # NOT $report: PowerShell variables are case-insensitive, so that name is the -Report
  # switch parameter itself, and assigning an object to it fails the cast.
  $reportObj = [pscustomobject]@{
    generated = (Get-Date).ToString('o')
    user      = "$env:USERDOMAIN\$env:USERNAME"
    elevated  = (Test-Admin)
    queueIdle = $queueIdle
    mediaDir  = $mediaDir
    tracked   = $tracked.Count
    items     = $rows
  }
  try {
    # No BOM: the reader is JSON.parse on the other side, which throws on one.
    [IO.File]::WriteAllText($ReportPath, ($reportObj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
    Say "REPORT -> $ReportPath"
  } catch {
    Say "REPORT FAILED -> $($_.Exception.Message)"
    exit 2
  }
  return
}

# ----------------------------------------------------------- interactive ----
# Measure first, ask second, delete last. Every question states what a "y" would actually
# cost, and NOTHING is acted on until the single confirmation at the bottom -- so a
# mistyped answer anywhere above is still recoverable by the time you reach it.
if ($interactive) {
  $picked = @(); $selFiles = 0; $selBytes = 0; $selShadows = 0

  Write-Host ''
  Write-Host '=============== what would you like to clear? ==============='

  $keep = @()
  foreach ($t in $targets) {
    if (-not (Test-Path $t.Path)) { continue }
    $m = Measure-Target $t.Path
    $victims = @($m.Files | Where-Object { $tracked -notcontains $_.FullName -and $_.Name -ne 'desktop.ini' })
    if (-not $victims.Count) { Write-Host ''; Write-Host ("  {0} -- already empty" -f $t.Label); continue }
    $bytes = [long](($victims | Measure-Object Length -Sum).Sum)
    Write-Host ''
    Write-Host ("  {0}" -f $t.Label)
    Write-Host ("    {0}" -f $t.Path)
    Write-Host ("    {0:N0} files, {1:N2} GB" -f $victims.Count, ($bytes/1GB))
    if ($m.Suspect) { Write-Host '    [!] enumeration errored -- this count may be short' }
    if (Ask '    clear it?') { $keep += $t; $selFiles += $victims.Count; $selBytes += $bytes; $picked += $t.Label }
  }
  $targets = @($keep)
  $doMedia = [bool]$targets.Count

  # --- Recycle Bin ---
  $rbFiles = 0; $rbBytes = 0
  foreach ($d in 'C','D','E') {
    $rb = $d + ':\$Recycle.Bin'
    if (-not (Test-Path $rb)) { continue }
    Get-ChildItem -LiteralPath $rb -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      $f = @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
             Where-Object { $_.Name -ne 'desktop.ini' })
      $rbFiles += $f.Count
      $rbBytes += [long](($f | Measure-Object Length -Sum).Sum)
    }
  }
  $doBin = $false
  if ($rbFiles) {
    Write-Host ''
    Write-Host '  Recycle Bin (C:, D:, E:)'
    Write-Host ("    {0:N0} files, {1:N2} GB  -- includes the stubs that keep original names and paths" -f $rbFiles, ($rbBytes/1GB))
    if (Ask '    empty it?') { $doBin = $true; $selFiles += $rbFiles; $selBytes += $rbBytes; $picked += 'Recycle Bin' }
  }

  # --- Explorer thumbnails ---
  $tc = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer') -Filter 'thumbcache_*.db' -Force -ErrorAction SilentlyContinue)
  if ($tc.Count) {
    $tcBytes = [long](($tc | Measure-Object Length -Sum).Sum)
    Write-Host ''
    Write-Host '  Explorer thumbnail cache'
    Write-Host '    thumbnails of files you browsed -- these outlive the originals'
    Write-Host ("    {0} files, {1:N1} MB  -- clearing this restarts Explorer" -f $tc.Count, ($tcBytes/1MB))
    if (Ask '    clear it?') { $IncludeThumbCache = $true; $selFiles += $tc.Count; $selBytes += $tcBytes; $picked += 'Thumbnail cache' }
  }

  # --- Browser caches ---
  $bc = @(Get-BrowserCaches | Where-Object { $_.Present })
  if ($bc.Count) {
    $bcFiles = 0; $bcBytes = 0
    foreach ($b in $bc) { foreach ($d in $b.Dirs) { $mm = Measure-Target $d; $bcFiles += $mm.Count; $bcBytes += [long]$mm.Bytes } }
    $busy = @($bc | Where-Object { @(Get-Process -Name $_.Process -ErrorAction SilentlyContinue).Count })
    if ($bcFiles) {
      Write-Host ''
      Write-Host ("  Browser caches ({0})" -f (($bc | ForEach-Object { $_.Name }) -join ' + '))
      Write-Host '    every image the app served, still renderable straight out of cache'
      Write-Host ("    {0:N0} files, {1:N2} GB  -- cache only; cookies, history and logins survive" -f $bcFiles, ($bcBytes/1GB))
      if ($busy.Count) { Write-Host ("    running right now: {0}" -f (($busy | ForEach-Object { $_.Name }) -join ', ')) }
      if (Ask '    clear it?') {
        $IncludeBrowserCache = $true; $selFiles += $bcFiles; $selBytes += $bcBytes; $picked += 'Browser caches'
        if ($busy.Count -and (Ask '    close the running browser(s) so the files can go? (tabs come back next launch)')) { $CloseBrowsers = $true }
      }
    }
  }

  # --- Breadcrumbs ---
  $sg = @(Get-ShellArtifactGroups | ForEach-Object { [pscustomobject]@{ Label = $_.Label; Files = @(Get-ShellArtifactFiles $_) } })
  $sgFiles = [int](($sg | ForEach-Object { $_.Files.Count } | Measure-Object -Sum).Sum)
  if ($sgFiles) {
    $sgBytes = [long](($sg | ForEach-Object { $_.Files } | Measure-Object Length -Sum).Sum)
    Write-Host ''
    Write-Host '  Breadcrumbs: Recent, jump lists, Timeline, WebCache'
    Write-Host '    not the pictures -- the RECORD that they existed: paths, sizes, timestamps'
    foreach ($g in $sg) { if ($g.Files.Count) { Write-Host ("      {0,-26} {1,5} files" -f $g.Label, $g.Files.Count) } }
    Write-Host ("    {0:N0} files, {1:N1} MB  -- Windows rebuilds all of them empty" -f $sgFiles, ($sgBytes/1MB))
    if (Ask '    clear it?') { $IncludeShellArtifacts = $true; $selFiles += $sgFiles; $selBytes += $sgBytes; $picked += 'Breadcrumbs' }
  }

  # --- Volume Shadow Copies ---
  $shadows = Get-ShadowCopies
  Write-Host ''
  Write-Host '  Volume Shadow Copies (System Restore points)'
  if ($null -eq $shadows) {
    Write-Host '    cannot be inspected without admin -- not offered this run'
    Write-Host '    they can still hold last week''s copy of the caches above; re-run this'
    Write-Host '    script from an elevated PowerShell if you want them included'
  } elseif (-not $shadows.Count) {
    Write-Host '    none exist'
  } else {
    $byVol = $shadows | Group-Object VolumeName
    foreach ($v in $byVol) {
      $dates = @($v.Group | ForEach-Object { $_.InstallDate } | Sort-Object)
      Write-Host ("      {0,-46} {1,3} snapshot(s)" -f $v.Name, $v.Count)
      if ($dates.Count) { Write-Host ("      {0,-46} {1:d} .. {2:d}" -f '', $dates[0], $dates[-1]) }
    }
    Write-Host '    deleting these loses those rollback points, and Windows will make new ones'
    Write-Host '    unless System Protection is turned off'
    if (Ask '    delete them?') { $IncludeShadowCopies = $true; $selShadows = $shadows.Count; $picked += 'Shadow copies' }
  }
  # Nothing chosen means there is nothing to confirm -- do not make them answer twice.
  if (-not $picked.Count) {
    Write-Host ''
    Say 'Nothing selected -- exiting without touching anything.'
    return
  }

  # Only worth offering when something was freed on E: or D:. A browsers-only run frees
  # space on C:, which this script does not ReTrim, so the prompt would be a lie.
  $doTrim = $false
  if ($doMedia -or $doBin) {
    Write-Host ''
    $doTrim = Ask '  Re-TRIM E: and D: afterwards? (~20s, one UAC prompt; makes the deleted blocks unrecoverable)' -DefaultYes
  }

  Write-Host ''
  Write-Host '============================================================'
  Say ('Selected: ' + ($picked -join ', '))
  Say ("Totals:   {0:N0} files, {1:N2} GB" -f $selFiles, ($selBytes/1GB))
  if ($selShadows) { Say ("          plus {0} shadow copy/copies -- restore points go with them" -f $selShadows) }
  Write-Host 'This deletes PERMANENTLY -- nothing goes to the Recycle Bin, and there is no undo.'
  if (-not (Ask 'Proceed?')) { Say 'Aborted -- nothing was touched.'; return }

  $Execute    = [switch]$true
  $doBrowsers = [bool]$IncludeBrowserCache
  $binDrives  = if ($doBin) { @('C','D','E') } else { @() }
  Say ''
  Say '=== proceeding ==='
}
if ($targets.Count) { Say '--- targets ---' } else { Say '--- targets --- SKIPPED (-SkipMedia)' }
$totalFiles = 0; $totalBytes = 0
foreach ($t in $targets) {
  if (-not (Test-Path $t.Path)) { Say ("    {0,-42} MISSING  {1}" -f $t.Label, $t.Path); continue }
  $m = Measure-Target $t.Path
  $victims = @($m.Files | Where-Object { $tracked -notcontains $_.FullName -and $_.Name -ne 'desktop.ini' })
  $vBytes = ($victims | Measure-Object Length -Sum).Sum
  $flag = ''
  if ($m.Suspect) { $flag = '  [!] enumeration errored - count may be short' }
  Say ("    {0,-42} {1,7} files  {2,9:N2} GB  {3}{4}" -f $t.Label, $victims.Count, ($vBytes/1GB), $t.Path, $flag)
  $totalFiles += $victims.Count; $totalBytes += $vBytes

  if ($Execute -and $victims.Count) {
    # Remove-Item deletes permanently -- no Recycle Bin round trip, nothing to empty after.
    # Delete CONTENTS and keep the folder: ComfyUI expects temp/input/output to exist.
    foreach ($v in $victims) {
      try { Remove-Item -LiteralPath $v.FullName -Force -Confirm:$false -ErrorAction Stop }
      catch {
        # Fall back to the extended-path prefix, which addresses names Win32 cannot
        # (trailing dots, reserved chars) -- the trick that finally cleared $RO7VS8O.
        try { [IO.File]::Delete("\\?\$($v.FullName)") }
        catch { Say "        FAILED: $($v.FullName) -> $($_.Exception.GetBaseException().Message)" }
      }
    }
    # Sweep now-empty subdirectories, keeping the target root itself.
    Get-ChildItem -LiteralPath $t.Path -Recurse -Directory -Force -EA SilentlyContinue |
      Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
        if (-not @(Get-ChildItem -LiteralPath $_.FullName -Force -EA SilentlyContinue).Count) {
          Remove-Item -LiteralPath $_.FullName -Force -Recurse -Confirm:$false -EA SilentlyContinue
        }
      }
  }
}
if ($targets.Count) { Say ("    {0,-42} {1,7} files  {2,9:N2} GB  TOTAL" -f '', $totalFiles, ($totalBytes/1GB)) }

# ----------------------------------------------------------- recycle bin ----
Say ''
if ($doBin) { Say '--- recycle bin ---' } else { Say '--- recycle bin --- SKIPPED (-SkipRecycleBin)' }
foreach ($d in $binDrives) {
  $rb = $d + ':\$Recycle.Bin'
  if (-not (Test-Path $rb)) { continue }
  if ($Execute) { try { Clear-RecycleBin -DriveLetter $d -Force -ErrorAction Stop } catch { } }
  # Clear-RecycleBin misses orphaned $I stubs and dangling entries, so sweep the raw store.
  # $I stubs are metadata only, but they still record the original filename and path.
  $left = @()
  Get-ChildItem -LiteralPath $rb -Directory -Force -EA SilentlyContinue | ForEach-Object {
    $left += @(Get-ChildItem -LiteralPath $_.FullName -Force -EA SilentlyContinue |
               Where-Object { $_.Name -ne 'desktop.ini' })
  }
  foreach ($item in $left) {
    if (-not $Execute) { Say "    would remove: $($item.FullName)"; continue }
    try {
      if ($item.PSIsContainer) { [IO.Directory]::Delete("\\?\$($item.FullName)", $true) }
      else { [IO.File]::Delete("\\?\$($item.FullName)") }
      Say "    removed: $($item.Name)"
    } catch { Say "    STUCK: $($item.FullName) -> $($_.Exception.GetBaseException().Message)" }
  }
  # Known-stuck: two .0002* entries on E: survive deletion even via \\?\ (the call reports
  # success and the entry remains). That is NTFS index corruption -- needs chkdsk E: /f,
  # which needs exclusive access, which means stopping the comfyui container first.
  $still = @()
  Get-ChildItem -LiteralPath $rb -Directory -Force -EA SilentlyContinue | ForEach-Object {
    $still += @(Get-ChildItem -LiteralPath $_.FullName -Force -EA SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' })
  }
  Say ("    {0}: {1} entries remaining" -f $d, $still.Count)
}

# ------------------------------------------------------------ thumb cache ----
if ($IncludeThumbCache) {
  Say ''
  Say '--- Explorer thumbnail cache ---'
  $tc = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
  $dbs = @(Get-ChildItem $tc -Filter 'thumbcache_*.db' -Force -EA SilentlyContinue)
  Say ("    {0} db files, {1:N1} MB" -f $dbs.Count, (($dbs | Measure-Object Length -Sum).Sum/1MB))
  if ($Execute) {
    Stop-Process -Name explorer -Force -EA SilentlyContinue
    foreach ($db in $dbs) { Remove-Item -LiteralPath $db.FullName -Force -EA SilentlyContinue }
    Start-Process explorer.exe
    Say '    cleared and explorer restarted'
  }
}

# --------------------------------------------------------- browser cache ----
# Explorer is not the only thing holding thumbnails. Edge and Chrome cache every image
# the app served, so the grid keeps rendering media straight out of cache after the
# files are gone from disk -- and the cached copy is a real, extractable JPEG/PNG.
# CACHE ONLY: cookies, history, passwords, saved tabs and extensions are untouched,
# so this does not log you out of anything. It just makes the next load slower.
if ($doBrowsers) {
  Say ''
  Say '--- browser cache (Edge + Chrome) ---'

  foreach ($b in (Get-BrowserCaches)) {
    if (-not $b.Present) { Say ("    {0,-7} not installed -- skipped" -f $b.Name); continue }

    # Chromium holds its cache files open. Deleting them underneath a live browser
    # leaves a half-torn cache it may keep serving from, so close it or skip it --
    # never half-delete.
    $procs = @(Get-Process -Name $b.Process -ErrorAction SilentlyContinue)
    if ($procs.Count -and $Execute) {
      if (-not $CloseBrowsers) {
        Say ("    {0,-7} RUNNING -- skipped. Close it, or re-run with -CloseBrowsers." -f $b.Name)
        continue
      }
      Say ("    {0,-7} closing {1} process(es)..." -f $b.Name, $procs.Count)
      Stop-Process -Name $b.Process -Force -ErrorAction SilentlyContinue
      Wait-Process -Name $b.Process -Timeout 15 -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2   # handles linger briefly after the process is gone
    }

    # Delete the CONTENTS and keep the folders: Chromium recreates missing cache dirs,
    # but removing them while it runs has been known to disable caching for the session.
    $dirs = $b.Dirs

    $bFiles = 0; $bBytes = 0; $locked = 0
    foreach ($d in $dirs) {
      $m = Measure-Target $d
      $bFiles += $m.Count; $bBytes += [long]$m.Bytes
      if (-not $Execute) { continue }
      foreach ($f in $m.Files) {
        try { Remove-Item -LiteralPath $f.FullName -Force -Confirm:$false -ErrorAction Stop }
        catch { try { [IO.File]::Delete("\\?\$($f.FullName)") } catch { $locked++ } }
      }
    }
    $verb = if ($Execute) { 'cleared' } else { 'would clear' }
    Say ("    {0,-7} {1,7} files  {2,9:N2} GB  {3} in {4} cache folder(s)" -f $b.Name, $bFiles, ($bBytes/1GB), $verb, $dirs.Count)
    if ($locked) { Say ("    {0,-7} {1} file(s) locked -- close the browser and re-run" -f $b.Name, $locked) }
  }
}

# -------------------------------------------------------- shell artifacts ----
# The breadcrumb layer: not the pictures, but the record that they existed. A .lnk in
# Recent keeps the full path, size, timestamps and volume serial of a file long after the
# file itself is gone; jump lists hold the same per application; ActivitiesCache.db logs
# which app had which file open and when; WebCacheV01.dat is the WinINET store behind
# Windows components, Office and Explorer's file:// navigations -- NOT Chrome or
# Edge-Chromium, whose caches the browser pass above already covers.
# Deliberately out of scope: the registry equivalents (RecentDocs, OpenSavePidlMRU,
# ShellBags). Same breadcrumbs, but a bad registry edit is not a file you can restore.
if ($IncludeShellArtifacts) {
  Say ''
  Say '--- shell artifacts (Timeline, WebCache, Recent/jump lists) ---'

  $groups = Get-ShellArtifactGroups

  if ($Execute) {
    # Both databases are held open while you are signed in. Nothing reopens the OLD file
    # once it is gone -- Windows rebuilds each empty -- but the holder has to let go first
    # or the delete is just a sharing violation. taskhostw restarts itself in seconds.
    $th = @(Get-Process -Name taskhostw -ErrorAction SilentlyContinue)
    if ($th.Count) {
      Say ("    stopping taskhostw ({0} process(es)) -- it holds WebCacheV01.dat" -f $th.Count)
      $th | ForEach-Object { try { $_.Kill() } catch { } }
    }
    Get-Service -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'CDPUserSvc*' -and $_.Status -eq 'Running' } |
      ForEach-Object {
        try   { Stop-Service -Name $_.Name -Force -ErrorAction Stop; Say ("    stopped {0}" -f $_.Name) }
        catch { Say ("    could not stop {0} -- ActivitiesCache.db will stay locked" -f $_.Name) }
      }
    Start-Sleep -Seconds 2   # handles are released a beat after the process exits
  }

  foreach ($g in $groups) {
    if (-not (Test-Path $g.Path)) { Say ("    {0,-26} absent" -f $g.Label); continue }
    $files = Get-ShellArtifactFiles $g
    $locked = 0
    if ($Execute) {
      foreach ($f in $files) {
        try { Remove-Item -LiteralPath $f.FullName -Force -Confirm:$false -ErrorAction Stop }
        catch { try { [IO.File]::Delete("\\?\$($f.FullName)") } catch { $locked++ } }
      }
    }
    $verb = if ($Execute) { 'cleared' } else { 'would clear' }
    Say ("    {0,-26} {1,5} files  {2,8:N1} MB  {3}" -f $g.Label, $files.Count, (($files | Measure-Object Length -Sum).Sum/1MB), $verb)
    if ($locked) {
      Say ("    {0,-26} {1} file(s) still locked -- sign out and re-run, or clear it from" -f $g.Label, $locked)
      Say ("    {0,-26}   Settings > Privacy & security > Activity history" -f '')
    }
  }
  Say '    Windows rebuilds all of these empty by itself; there is nothing to restore.'
}
# ----------------------------------------------------------- shadow copies ----
# A snapshot keeps the blocks it references alive, which is why it survives both deletion
# and TRIM: the data was never free. Anything cleared above still exists inside a restore
# point taken while it was full, and this is the only thing that reaches it.
if ($IncludeShadowCopies) {
  Say ''
  Say '--- volume shadow copies ---'
  $sh = Get-ShadowCopies
  if ($null -eq $sh) {
    Say '    NOT DONE -- needs an elevated prompt. Nothing was deleted.'
    Say '    Re-run this script from an admin PowerShell, or: vssadmin delete shadows /for=C: /all'
  } elseif (-not $sh.Count) {
    Say '    none exist'
  } elseif (-not $Execute) {
    # Dry run has to speak up here too, or a rehearsal reads as "no snapshots to worry about".
    Say ("    {0} snapshot(s) would be deleted:" -f $sh.Count)
    $sh | Group-Object VolumeName | ForEach-Object { Say ("      {0,-46} {1,3}" -f $_.Name, $_.Count) }
  } else {
    $gone = 0; $failed = 0
    foreach ($s in $sh) {
      try { Remove-CimInstance -InputObject $s -ErrorAction Stop; $gone++ }
      catch { $failed++; Say ("    FAILED {0} -> {1}" -f $s.ID, $_.Exception.GetBaseException().Message) }
    }
    Say ("    deleted {0} of {1}" -f $gone, $sh.Count)
    # A snapshot held open by a running backup job refuses to go; that is not a script bug.
    if ($failed) { Say ("    {0} refused -- in use by a backup or writer; try again later" -f $failed) }
    Say '    System Restore will create new ones unless System Protection is turned off.'
  }
}
# ----------------------------------------------------------- verification ----
if ($targets.Count) { Say ''; Say '--- verify ---' }
foreach ($t in $targets) {
  if (-not (Test-Path $t.Path)) { continue }
  $m = Measure-Target $t.Path
  $left = @($m.Files | Where-Object { $_.Name -ne 'desktop.ini' })
  $note = ''
  if ($m.Suspect) { $note = '  [!] enumeration errored - NOT proven clean' }
  Say ("    {0,-42} {1,7} files left{2}" -f $t.Label, $left.Count, $note)
}
# The container sees temp through the mount; confirm from its side too, since that is the
# view that actually matters to ComfyUI.
# The container name is this install's, so it comes from config. Unset simply means the
# host-side check stands on its own -- which is the normal case for a non-Docker install.
$dockerName = Cfg 'dockerContainer' $null
if ($targets.Count -and $dockerName) {
  try {
    $inside = docker exec $dockerName sh -c 'find /opt/ComfyUI/temp /opt/ComfyUI/input /opt/ComfyUI/output -type f 2>/dev/null | wc -l' 2>$null
    if ($LASTEXITCODE -eq 0) { Say "    container view (temp+input+output): $($inside.Trim()) files" }
  } catch { Say '    container not reachable -- host-side check only' }
}

# ------------------------------------------------------------------ trim ----
if ($doTrim -and $Execute) {
  Say ''
  Say '--- ReTrim (hands the freed blocks to the SSD controller) ---'
  Say '    delegating to retrim_volumes.ps1 (self-elevating; expect one UAC prompt)'
  Say '    free space will NOT change -- that is the expected result, not a failure'
  & (Join-Path $PSScriptRoot 'retrim_volumes.ps1')
  Say ("    see " + (Join-Path $PSScriptRoot 'retrim_result.txt'))
}

Say ''
Say "=== done $(Get-Date) ==="
if (-not $Execute) { Say 'Reminder: this was a DRY RUN. Re-run with -Execute to actually delete.' }
