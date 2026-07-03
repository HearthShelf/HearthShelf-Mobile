<#
.SYNOPSIS
  Launch the Desktop Head Unit (DHU) to test Android Auto against the phone.

.DESCRIPTION
  Forwards the DHU port (5277) to the attached device, then starts
  desktop-head-unit.exe. The phone must have Android Auto's head-unit server
  running (Android Auto app -> Settings -> Developer -> "Start head unit server")
  before you connect.

  Does NOT build or install the app - use ./scripts/deploy.ps1 for that. Pair them:
    ./scripts/deploy.ps1 -Release -Serial <phone>   # sideload the standalone APK
    ./scripts/dhu.ps1                                # launch DHU to test it

.PARAMETER Serial
  adb device serial to forward from. Omit to auto-pick when only one device is
  attached; required if several are.

.EXAMPLE
  ./scripts/dhu.ps1
  Forward port 5277 and launch the Desktop Head Unit.
#>
[CmdletBinding()]
param(
  [string]$Serial
)

$ErrorActionPreference = 'Stop'

# --- tool paths (prefer ANDROID_HOME/LOCALAPPDATA, fall back to PATH) ---
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path $adb)) { $adb = 'adb' }
$dhu = Join-Path $sdk 'extras\google\auto\desktop-head-unit.exe'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

if (-not (Test-Path $dhu)) {
  throw "Desktop Head Unit not found at '$dhu'. Install it via Android Studio's SDK Manager (SDK Tools -> Android Auto Desktop Head Unit Emulator)."
}

# --- device selection ---
$attached = @(
  (& $adb devices) |
    Select-Object -Skip 1 |
    Where-Object { $_ -match '^\S+\s+device$' } |
    ForEach-Object { ($_ -split '\s+')[0] }
)
if ($attached.Count -eq 0) {
  throw 'No devices attached. Plug in a phone with USB debugging on.'
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
  throw "Multiple devices attached ($($attached -join ', ')). Pass -Serial to pick one."
}

# --- forward the DHU port to the phone ---
Write-Step "Forwarding tcp:5277 -> $Serial"
& $adb -s $Serial forward tcp:5277 tcp:5277 | Out-Null

# --- launch DHU (from its own dir; it expects to run there) ---
Write-Step 'Launching Desktop Head Unit'
Push-Location (Split-Path -Parent $dhu)
try {
  & $dhu
} finally {
  Pop-Location
}
