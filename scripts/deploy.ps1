<#
.SYNOPSIS
  Build the debug APK for the attached device (emulator or phone) and launch it.

.DESCRIPTION
  Wraps the local build/install/launch loop documented in TESTING.md so you don't
  have to retype the gradle + adb dance. Builds ONLY the target device's ABI (one
  ABI, not all four) for a ~4x faster build. CI is the ~27 min path; this is fast.

  Device pick: one attached -> use it; several -> prompt a menu (emulator or a
  plugged-in phone). The build ABI follows the pick - x86_64 for emulators,
  arm64-v8a for real phones - so `npm run emulator` loads onto your Android too.

  Steps:
    1. pick the device (auto or menu) and its build ABI
    2. (optional) expo prebuild        - only for NATIVE changes (Kotlin / config plugin)
    3. (optional) clear native caches  - fixes the stale-CMake "libworklets.so" ninja error
    4. gradlew :app:assembleDebug -PreactNativeArchitectures=<abi>
    5. adb install -r  (auto-uninstalls first if a version-downgrade blocks it)
    6. force-stop + launch the app

.PARAMETER Prebuild
  Run `expo prebuild --platform android` first. REQUIRED after editing anything under
  plugins/hearthshelf-auto (native Kotlin) or the app config. Not needed for JS-only edits.

.PARAMETER Clean
  Remove the worklets / expo-modules-core / app .cxx build caches before building.
  Use when the build fails with: ninja: error '...libworklets.so' ... missing and no known rule.

.PARAMETER NoLaunch
  Build and install but don't launch the app.

.PARAMETER Serial
  adb device serial to target. Defaults to emulator-5554. Pinned on purpose so a
  plugged-in physical phone is never touched.

.EXAMPLE
  ./scripts/deploy.ps1
  JS-only change: build, install, launch on emulator-5554.

.EXAMPLE
  ./scripts/deploy.ps1 -Prebuild
  Native (Kotlin/config-plugin) change: prebuild first, then build + install + launch.

.EXAMPLE
  ./scripts/deploy.ps1 -Prebuild -Clean
  Native change plus a wiped CMake cache (the libworklets.so ninja fix).
#>
[CmdletBinding()]
param(
  [switch]$Prebuild,
  [switch]$Clean,
  [switch]$NoLaunch,
  # Target device serial. Omit to auto-pick: one device -> use it; several ->
  # prompt to choose (emulator or a plugged-in phone). The build ABI follows the
  # picked device (x86_64 for emulators, arm64-v8a for real phones).
  [string]$Serial,
  # Force a build ABI instead of auto-detecting from the device (e.g. arm64-v8a).
  [string]$Abi
)

$ErrorActionPreference = 'Stop'

# --- config (matches TESTING.md) ---
$JdkPath = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot'
$Package = 'com.hearthshelf.mobile'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Apk = Join-Path $RepoRoot 'android\app\build\outputs\apk\debug\app-debug.apk'

# adb: prefer ANDROID_HOME/LOCALAPPDATA, fall back to PATH.
$adb = if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
       else { Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe' }
if (-not (Test-Path $adb)) { $adb = 'adb' }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

if (-not (Test-Path $JdkPath)) {
  throw "JDK 17 not found at '$JdkPath'. Update `$JdkPath in this script or install Temurin JDK 17 (see TESTING.md)."
}
$env:JAVA_HOME = $JdkPath

# --- device selection ---
Write-Step 'Finding devices'
# Parse `adb devices` into the serials that are actually ready (state 'device').
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
  # Multiple devices - show a labelled menu (serial + model) and let the user pick.
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

# --- pick the build ABI for the target (emulators = x86_64, phones = arm64) ---
if (-not $Abi) {
  $deviceAbi = (& $adb -s $Serial shell getprop ro.product.cpu.abi 2>$null).Trim()
  $Abi = if ($deviceAbi) { $deviceAbi } elseif ($Serial -like 'emulator-*') { 'x86_64' } else { 'arm64-v8a' }
}
Write-Host "Target: $Serial  (abi: $Abi)" -ForegroundColor Green

# --- 1. prebuild (native changes only) ---
if ($Prebuild) {
  Write-Step 'expo prebuild --platform android'
  Push-Location $RepoRoot
  try { npx expo prebuild --platform android } finally { Pop-Location }

  # prebuild can wipe the JDK pin in android/gradle.properties - re-assert it.
  $gp = Join-Path $RepoRoot 'android\gradle.properties'
  $pin = @(
    'org.gradle.java.installations.auto-download=false'
    'org.gradle.java.installations.paths=C:/Program Files/Eclipse Adoptium/jdk-17.0.19.10-hotspot'
  )
  $content = if (Test-Path $gp) { Get-Content $gp -Raw } else { '' }
  if ($content -notmatch 'installations\.auto-download=false') {
    Write-Step 'Re-adding JDK 17 pin to android/gradle.properties'
    Add-Content -Path $gp -Value ("`n" + ($pin -join "`n"))
  }
}

# --- 2. clear stale native caches (the libworklets.so ninja fix) ---
if ($Clean) {
  Write-Step 'Clearing native build caches (.cxx / android build dirs)'
  $paths = @(
    'node_modules\react-native-worklets\android\build'
    'node_modules\react-native-worklets\android\.cxx'
    'node_modules\expo-modules-core\android\build'
    'node_modules\expo-modules-core\android\.cxx'
    'android\app\.cxx'
  )
  foreach ($p in $paths) {
    $full = Join-Path $RepoRoot $p
    if (Test-Path $full) { Remove-Item -Recurse -Force $full }
  }
}

# --- 3. build ---
Write-Step "Building debug APK ($Abi only)"
Push-Location (Join-Path $RepoRoot 'android')
try {
  & .\gradlew.bat :app:assembleDebug "-PreactNativeArchitectures=$Abi"
  if ($LASTEXITCODE -ne 0) { throw "Gradle build failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }

if (-not (Test-Path $Apk)) { throw "APK not found at $Apk after build." }

# --- 4. install (retry once after uninstall on version-downgrade) ---
Write-Step "Installing on $Serial"
$install = & $adb -s $Serial install -r $Apk 2>&1
Write-Host $install
if ($install -match 'INSTALL_FAILED_VERSION_DOWNGRADE') {
  Write-Step 'Version downgrade - uninstalling then reinstalling'
  & $adb -s $Serial uninstall $Package | Out-Null
  & $adb -s $Serial install $Apk
}

# --- 5. launch (force-stop first so the fresh build is what comes up) ---
if (-not $NoLaunch) {
  Write-Step 'Launching app'
  & $adb -s $Serial shell am force-stop $Package 2>&1 | Out-Null
  & $adb -s $Serial shell monkey -p $Package -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
}

Write-Host "`nDone." -ForegroundColor Green
