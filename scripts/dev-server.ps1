<#
.SYNOPSIS
  Start the Metro dev server and point a device at it for live-reloading RN edits.

.DESCRIPTION
  For JS/TS-only work: edit React Native code and see it update on the device via
  Fast Refresh, no rebuild. This does NOT build or install - it assumes the debug
  dev-client APK is already on the device (run ./scripts/deploy.ps1 once to
  get it there). If the app isn't installed yet, this will tell you.

  Steps:
    1. pick the device (auto or menu) - same picker as deploy.ps1
    2. adb reverse tcp:8081 - so the device reaches Metro on your machine
    3. (optional) launch the app
    4. start Metro (npx expo start --dev-client) and stay in the foreground

  Leave this running while you edit. Save a file -> the device refreshes. In the
  app, shake or press R-R to reload manually; press M for the dev menu.
  Ctrl+C stops Metro.

  Native changes (Kotlin under plugins/hearthshelf-auto, config plugin, adding a
  native module) are NOT picked up here - those need ./scripts/deploy.ps1
  -Prebuild to rebuild the APK.

.PARAMETER Serial
  adb device serial to target. Omit to auto-pick: one device -> use it; several ->
  prompt to choose (emulator or a plugged-in phone).

.PARAMETER NoLaunch
  Start Metro and set up the reverse tunnel but don't launch the app (open it
  yourself).

.PARAMETER Clear
  Start Metro with a cleared cache (npx expo start --dev-client --clear). Use when
  a stale bundle cache is causing weird module-resolution errors.

.EXAMPLE
  ./scripts/dev-server.ps1
  Pick the device, reverse the port, launch the app, start Metro with live reload.

.EXAMPLE
  ./scripts/dev-server.ps1 -Clear
  Same, but wipe Metro's cache first.
#>
[CmdletBinding()]
param(
  [string]$Serial,
  [switch]$NoLaunch,
  [switch]$Clear
)

$ErrorActionPreference = 'Stop'

# --- config (matches deploy.ps1) ---
$Package = 'com.hearthshelf.mobile'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# adb: prefer ANDROID_HOME/LOCALAPPDATA, fall back to PATH.
$adb = if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
       else { Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe' }
if (-not (Test-Path $adb)) { $adb = 'adb' }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- device selection (same logic as deploy.ps1) ---
Write-Step 'Finding devices'
$attached = @(
  (& $adb devices) |
    Select-Object -Skip 1 |
    Where-Object { $_ -match '^\S+\s+device$' } |
    ForEach-Object { ($_ -split '\s+')[0] }
)

if ($attached.Count -eq 0) {
  throw 'No devices attached. Run ./scripts/boot-emulator.ps1 (AVD "hs_auto") or plug in a phone with USB debugging on.'
}

if ($Serial) {
  if ($attached -notcontains $Serial) {
    throw "Device '$Serial' not attached. Attached: $($attached -join ', ')"
  }
}
elseif ($attached.Count -eq 1) {
  $Serial = $attached[0]
}
else {
  Write-Host 'Multiple devices attached - pick one:' -ForegroundColor Yellow
  for ($i = 0; $i -lt $attached.Count; $i++) {
    $s = $attached[$i]
    $model = (& $adb -s $s shell getprop ro.product.model 2>$null).Trim()
    $kind = if ($s -like 'emulator-*') { 'emulator' } else { 'device' }
    Write-Host ("  [{0}] {1}  ({2}, {3})" -f $i, $s, $model, $kind)
  }
  do {
    $choice = Read-Host "Enter number (0-$($attached.Count - 1))"
  } until ($choice -match '^\d+$' -and [int]$choice -lt $attached.Count)
  $Serial = $attached[[int]$choice]
}
Write-Host "Target: $Serial" -ForegroundColor Green

# --- warn if the app isn't installed (this script never builds/installs) ---
$installed = (& $adb -s $Serial shell pm list packages $Package 2>$null)
if (-not $installed) {
  Write-Host "WARNING: $Package isn't installed on $Serial." -ForegroundColor Yellow
  Write-Host "  Run ./scripts/deploy.ps1 once to build + install the dev-client APK first." -ForegroundColor Yellow
}

# --- reverse the Metro port so the device can reach localhost:8081 ---
# Harmless on a real phone over USB too; expo also does this, but doing it up front
# means the app connects on first launch without a manual reload.
Write-Step 'Reversing tcp:8081 (device -> Metro)'
& $adb -s $Serial reverse tcp:8081 tcp:8081 | Out-Null

# --- launch the app (it'll connect to Metro once the bundler is up) ---
if (-not $NoLaunch -and $installed) {
  Write-Step 'Launching app'
  # monkey writes progress to stderr; swallow both streams so it doesn't look like
  # an error. (2>&1 alone still surfaces stderr as PowerShell error records.)
  & $adb -s $Serial shell am force-stop $Package *> $null
  & $adb -s $Serial shell monkey -p $Package -c android.intent.category.LAUNCHER 1 *> $null
}

# --- start Metro in the foreground (Ctrl+C to stop) ---
Write-Step 'Starting Metro (expo start --dev-client)'
Write-Host 'Edit RN code and save to live-reload. In the app: R-R reloads, M opens the dev menu.' -ForegroundColor DarkGray
Push-Location $RepoRoot
try {
  if ($Clear) { npx expo start --dev-client --clear }
  else { npx expo start --dev-client }
} finally { Pop-Location }
