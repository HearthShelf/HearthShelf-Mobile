<#
.SYNOPSIS
  Boot an Android emulator (AVD) and wait until it's ready.

.DESCRIPTION
  Starts the AVD in the background and blocks until the OS has finished booting
  (sys.boot_completed=1), so the device is ready for a following build/install.
  Does NOT build or install anything - use ./scripts/deploy.ps1 for that.

  If an emulator is already running it does nothing and returns. AVD pick: pass
  -Avd to boot a specific one; omit it and one AVD on the system -> use it;
  several -> prompt a menu ("hs_auto" is pre-selected as the default choice if
  present). Pair it with the other scripts:
    ./scripts/boot-emulator.ps1   # get an emulator up
    ./scripts/deploy.ps1          # build + install + launch the app
    ./scripts/dev-server.ps1      # Metro live-reload (JS-only)

.PARAMETER Avd
  AVD name to boot. Omit to auto-pick (see above).

.PARAMETER Cold
  Cold boot (wipe the snapshot / start from a clean state) instead of resuming.

.PARAMETER TimeoutSeconds
  How long to wait for boot to complete before giving up. Default 180.

.EXAMPLE
  ./scripts/boot-emulator.ps1
  Boot the only AVD (or prompt if there are several) and wait until it's ready.

.EXAMPLE
  ./scripts/boot-emulator.ps1 -Avd hs_auto -Cold
  Cold-boot a specific AVD from a clean state.
#>
[CmdletBinding()]
param(
  [string]$Avd,
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

# --- pick the AVD ---
$avds = @(& $emulator -list-avds 2>$null)
if ($avds.Count -eq 0) {
  throw "No AVDs found. Create one in Android Studio's Device Manager."
}

if ($Avd) {
  if ($avds -notcontains $Avd) {
    throw "AVD '$Avd' not found. Available: $($avds -join ', '). Create it in Android Studio's Device Manager."
  }
}
elseif ($avds.Count -eq 1) {
  $Avd = $avds[0]
}
else {
  Write-Host 'Multiple AVDs found - pick one:' -ForegroundColor Yellow
  # Pre-select "hs_auto" (this project's usual AVD) when present, so a bare Enter
  # does the right thing without retyping it every time.
  $defaultIndex = [array]::IndexOf($avds, 'hs_auto')
  for ($i = 0; $i -lt $avds.Count; $i++) {
    $marker = if ($i -eq $defaultIndex) { ' (default)' } else { '' }
    Write-Host ("  [{0}] {1}{2}" -f $i, $avds[$i], $marker)
  }
  $prompt = if ($defaultIndex -ge 0) { "Enter number (0-$($avds.Count - 1)), or Enter for default" } else { "Enter number (0-$($avds.Count - 1))" }
  do {
    $choice = Read-Host $prompt
    if ($choice -eq '' -and $defaultIndex -ge 0) { $choice = $defaultIndex }
  } until ($choice -match '^\d+$' -and [int]$choice -lt $avds.Count)
  $Avd = $avds[[int]$choice]
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
