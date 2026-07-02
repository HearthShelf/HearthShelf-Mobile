<#
.SYNOPSIS
  Boot the Android emulator (AVD "hs_auto") and wait until it's ready.

.DESCRIPTION
  Starts the AVD in the background and blocks until the OS has finished booting
  (sys.boot_completed=1), so the device is ready for a following build/install.
  Does NOT build or install anything - use ./scripts/deploy.ps1 for that.

  If an emulator is already running it does nothing and returns. Pair it with the
  other scripts:
    ./scripts/boot-emulator.ps1   # get an emulator up
    ./scripts/deploy.ps1          # build + install + launch the app
    ./scripts/dev-server.ps1      # Metro live-reload (JS-only)

.PARAMETER Avd
  AVD name to boot. Defaults to "hs_auto".

.PARAMETER Cold
  Cold boot (wipe the snapshot / start from a clean state) instead of resuming.

.PARAMETER TimeoutSeconds
  How long to wait for boot to complete before giving up. Default 180.

.EXAMPLE
  ./scripts/boot-emulator.ps1
  Boot hs_auto and wait until it's ready.

.EXAMPLE
  ./scripts/boot-emulator.ps1 -Cold
  Cold-boot hs_auto from a clean state.
#>
[CmdletBinding()]
param(
  [string]$Avd = 'hs_auto',
  [switch]$Cold,
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'

# --- tool paths (prefer ANDROID_HOME/LOCALAPPDATA, fall back to PATH) ---
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path $adb)) { $adb = 'adb' }
$emulator = Join-Path $sdk 'emulator\emulator.exe'
if (-not (Test-Path $emulator)) { $emulator = 'emulator' }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- already running? then we're done ---
$running = @(
  (& $adb devices) |
    Select-Object -Skip 1 |
    Where-Object { $_ -match '^emulator-\S+\s+device$' } |
    ForEach-Object { ($_ -split '\s+')[0] }
)
if ($running.Count -gt 0) {
  Write-Host "Emulator already running: $($running -join ', ')" -ForegroundColor Green
  return
}

# --- confirm the AVD exists ---
$avds = & $emulator -list-avds 2>$null
if ($avds -notcontains $Avd) {
  throw "AVD '$Avd' not found. Available: $($avds -join ', '). Create it in Android Studio's Device Manager."
}

# --- launch (detached; the emulator process stays up on its own) ---
Write-Step "Booting AVD '$Avd'$(if ($Cold) { ' (cold boot)' })"
$emuArgs = @('-avd', $Avd)
if ($Cold) { $emuArgs += '-no-snapshot-load' }
Start-Process -FilePath $emulator -ArgumentList $emuArgs | Out-Null

# --- wait for adb to see the device, then for the OS to finish booting ---
Write-Step 'Waiting for device'
& $adb wait-for-device

Write-Step 'Waiting for boot to complete'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Seconds 2
  $booted = (& $adb shell getprop sys.boot_completed 2>$null).Trim()
  if ((Get-Date) -gt $deadline) {
    throw "Emulator '$Avd' did not finish booting within $TimeoutSeconds s."
  }
} until ($booted -eq '1')

Write-Host "`nEmulator '$Avd' is ready." -ForegroundColor Green
