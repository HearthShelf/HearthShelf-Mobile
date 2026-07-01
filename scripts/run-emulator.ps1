<#
.SYNOPSIS
  Build the debug APK for the x86_64 emulator and launch it.

.DESCRIPTION
  Wraps the local build/install/launch loop documented in TESTING.md so you don't
  have to retype the gradle + adb dance. Builds ONLY the x86_64 ABI (the emulator's)
  for a ~4x faster build than all-arch. CI is the ~27 min path; this is the fast one.

  Steps:
    1. (optional) expo prebuild        - only for NATIVE changes (Kotlin / config plugin)
    2. (optional) clear native caches  - fixes the stale-CMake "libworklets.so" ninja error
    3. gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64
    4. adb install -r  (auto-uninstalls first if a version-downgrade blocks it)
    5. launch the app

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
  ./scripts/run-emulator.ps1
  JS-only change: build, install, launch on emulator-5554.

.EXAMPLE
  ./scripts/run-emulator.ps1 -Prebuild
  Native (Kotlin/config-plugin) change: prebuild first, then build + install + launch.

.EXAMPLE
  ./scripts/run-emulator.ps1 -Prebuild -Clean
  Native change plus a wiped CMake cache (the libworklets.so ninja fix).
#>
[CmdletBinding()]
param(
  [switch]$Prebuild,
  [switch]$Clean,
  [switch]$NoLaunch,
  [string]$Serial = 'emulator-5554'
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

# --- device check ---
Write-Step "Checking device $Serial"
$devices = & $adb devices
if (-not ($devices -match [regex]::Escape($Serial))) {
  Write-Host $devices
  throw "Device '$Serial' not attached. Start the emulator (AVD 'hs_auto') or pass -Serial <id>."
}

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
Write-Step 'Building debug APK (x86_64 only)'
Push-Location (Join-Path $RepoRoot 'android')
try {
  & .\gradlew.bat :app:assembleDebug -PreactNativeArchitectures=x86_64
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
