<#
.SYNOPSIS
  Build an APK for the attached device (emulator or phone) and launch it. Debug
  by default (loads JS from Metro); -StandaloneDebug bundles JS into the APK so
  it runs away from the PC with no Metro needed.

.DESCRIPTION
  Wraps the local build/install/launch loop documented in TESTING.md so you don't
  have to retype the gradle + adb dance. Builds ONLY the target device's ABI (one
  ABI, not all four) for a ~4x faster build. CI is the ~27 min path; this is fast.

  Device pick: one attached -> use it; several -> prompt a menu (emulator or a
  plugged-in phone). The build ABI follows the pick - x86_64 for emulators,
  arm64-v8a for real phones - so `npm run emulator` loads onto your Android also.

  Steps:
    1. pick the device (auto or menu) and its build ABI
    2. (optional) expo prebuild        - only for NATIVE changes (Kotlin / config plugin)
    3. (optional) clear native caches  - fixes the stale-CMake "libworklets.so" ninja error
    4. gradlew :app:assemble{Debug|Release} -PreactNativeArchitectures=<abi>
    5. adb install -r  (auto-uninstalls first if a version-downgrade blocks it)
    6. force-stop + launch the app

  Debug mode (default): Metro is required. If nothing is listening on port 8081 the
  script starts Metro in a background window automatically, then runs `adb reverse`
  so the device can reach it.

  Away mode (-StandaloneDebug): runs expo prebuild with HEARTHSHELF_STANDALONE_DEBUG=1
  so the debug APK bundles its own JS. The installed APK works offline with no PC
  nearby. Uses the debug keystore (matches Clerk's assetlinks) - correct for
  sideload testing and in-car use.

.PARAMETER Prebuild
  Run `expo prebuild --platform android` first. REQUIRED after editing anything under
  plugins/hearthshelf-auto (native Kotlin) or the app config. Not needed for JS-only edits.

.PARAMETER Clean
  Remove the worklets / reanimated / expo-modules-core / react-native-screens /
  react-native-gesture-handler / app .cxx build caches before building. Use when
  the build fails with a stale-CMake ninja error: "ninja: error '...libworklets.so'
  ... missing and no known rule"; a reanimated "fatal error: file
  '...sysroot/.../algorithm' has been modified since the precompiled header ... was
  built" (stale PCH after an NDK mtime change); or "ninja: error: rebuilding
  'build.ninja': subcommand failed ... CreateProcess failed: The system cannot find
  the file specified" (a corrupted .cxx, e.g. after two builds ran concurrently).

  You normally don't need to pass this up front: the build step recognizes both
  error signatures itself, clears the caches, and retries the build once
  automatically. -Clean remains useful to force a clear before the first attempt
  (skips the wasted first failing build) or for cache issues outside those two
  known signatures.

.PARAMETER Release
  Build :app:assembleRelease instead of debug. Requires a signing keystore configured
  in android/gradle.properties. For untethered testing use -StandaloneDebug instead.

.PARAMETER StandaloneDebug
  Bundle JS into the debug APK so it runs with no Metro server (away from the PC).
  Runs expo prebuild with HEARTHSHELF_STANDALONE_DEBUG=1 then assembles debug.
  Uses the debug signing key so Clerk assetlinks work. Implies -Prebuild.

.PARAMETER NoLaunch
  Build and install but don't launch the app.

.PARAMETER Ios
  Let the background Metro server also serve iOS. Off by default: Metro bundles
  per client request, so with only an Android device attached it never touches
  iOS anyway, and dropping the --android launch flag is all -Ios does. Only useful
  if you connect an iOS client to this same Metro.

.PARAMETER Serial
  adb device serial to target. Defaults to emulator-5554. Pinned on purpose so a
  plugged-in physical phone is never touched.

.EXAMPLE
  ./scripts/deploy.ps1
  JS-only change: build, install, launch. Metro is started automatically if needed.

.EXAMPLE
  ./scripts/deploy.ps1 -Prebuild
  Native (Kotlin/config-plugin) change: prebuild first, then build + install + launch.

.EXAMPLE
  ./scripts/deploy.ps1 -Prebuild -Clean
  Native change plus a wiped CMake cache (the libworklets.so ninja fix).

.EXAMPLE
  ./scripts/deploy.ps1 -StandaloneDebug -Serial 58100DLCQ0039Z
  Away build: JS is bundled into the APK. Runs on the phone with no PC, no Metro.
#>
[CmdletBinding()]
param(
  [switch]$Prebuild,
  [switch]$Clean,
  [switch]$NoLaunch,
  # Build a standalone release APK. For untethered/away testing prefer -StandaloneDebug
  # (debug key, no keystore config needed, Clerk assetlinks compatible).
  [switch]$Release,
  # Bundle JS into the debug APK so it runs with no Metro server (away from the PC).
  # Runs expo prebuild with HEARTHSHELF_STANDALONE_DEBUG=1 before building.
  [switch]$StandaloneDebug,
  # Target device serial. Omit to auto-pick: one device -> use it; several ->
  # prompt to choose (emulator or a plugged-in phone). The build ABI follows the
  # picked device (x86_64 for emulators, arm64-v8a for real phones).
  [string]$Serial,
  # Force a build ABI instead of auto-detecting from the device (e.g. arm64-v8a).
  [string]$Abi,
  # Also bundle iOS in the background Metro server. Off by default so cold boots
  # don't pay to transform/serialize a platform we don't run here (Windows/Android).
  [switch]$Ios
)

$ErrorActionPreference = 'Stop'

# -StandaloneDebug implies -Prebuild (needs the gradle plugin reapplied).
if ($StandaloneDebug) { $Prebuild = $true }

# --- config (matches TESTING.md) ---
$JdkPath = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot'
$Package = 'com.hearthshelf.mobile'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# --- guard: android/ config must match the JS-delivery mode this run wants ---
# The standalone-js plugin bakes `debuggableVariants = []` into android/app/
# build.gradle when prebuilt with HEARTHSHELF_STANDALONE_DEBUG=1. That marker
# persists in the gitignored android/ tree across later runs, and a plain run
# doesn't re-prebuild - so the config goes stale BOTH ways:
#   - plain debug after a standalone -> marker present -> debug bundles its JS
#     and ignores Metro (looks like "Metro isn't working")
#   - standalone after a plain debug -> marker absent -> the "standalone" APK
#     loads from Metro and dies away from the PC
# Detect the mismatch and force a prebuild so the plugin (re)writes the correct
# android/ config for this run. Only debug builds care; -Release is bundled
# regardless of this marker.
if (-not $Prebuild) {
  $appGradle = Join-Path $RepoRoot 'android\app\build.gradle'
  if (-not (Test-Path $appGradle)) {
    # android/ is gitignored and regenerated by prebuild. First run (or a clean
    # checkout) has no native tree, so nothing to build - always prebuild.
    Write-Warning 'No android/ tree found (first run or clean checkout). Forcing -Prebuild to generate it.'
    $Prebuild = $true
  } elseif (-not $Release) {
    # Only debug builds care about the bundled-JS marker; -Release is bundled
    # regardless. Match a real (uncommented) assignment, same test the plugin uses.
    $hasBundledMarker = (Get-Content $appGradle -Raw) -match '(?m)^\s*debuggableVariants\s*='
    if ($StandaloneDebug -and -not $hasBundledMarker) {
      Write-Warning 'android/ is configured for Metro-loading debug but this is a -StandaloneDebug run. Forcing -Prebuild so JS gets bundled into the APK.'
      $Prebuild = $true
    } elseif (-not $StandaloneDebug -and $hasBundledMarker) {
      Write-Warning 'android/ is configured for a standalone (bundled-JS) debug build but this is a plain Metro-loading run. Forcing -Prebuild so the APK loads JS from Metro.'
      $Prebuild = $true
    }
  }
}
# Release: explicit release variant. StandaloneDebug: debug APK with bundled JS.
# Default debug: loads JS from Metro.
$Variant = if ($Release) { 'release' } else { 'debug' }
$GradleTask = if ($Release) { ':app:assembleRelease' } else { ':app:assembleDebug' }
$Apk = Join-Path $RepoRoot "android\app\build\outputs\apk\$Variant\app-$Variant.apk"

# adb: prefer ANDROID_HOME/LOCALAPPDATA, fall back to PATH.
$adb = if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
       else { Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe' }
if (-not (Test-Path $adb)) { $adb = 'adb' }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

if (-not (Test-Path $JdkPath)) {
  throw "JDK 21 not found at '$JdkPath'. Update `$JdkPath in this script or install Temurin JDK 21 (see TESTING.md)."
}
$env:JAVA_HOME = $JdkPath

# Gradle's Sentry plugin shells out to sentry-cli, which reads SENTRY_AUTH_TOKEN from the
# environment. Expo CLI loads .env.local for its own tasks but Gradle never sees it.
#
# The FILE WINS over an inherited $env:SENTRY_AUTH_TOKEN, which is the reverse of
# what this used to do. A token left in the shell from an earlier session used to
# take precedence and the file was never read - so after the Sentry org was
# renamed, .env.local held a perfectly good token while every build kept failing
# with "organization not found" from the stale one, and nothing in the output
# said which token was in play. .env.local is the copy the developer actually
# edits and rotates, so it is the source of truth; the environment stays as a
# fallback for CI, where there is no .env.local.
#
# The regex is anchored to the exact name so a suffixed variant (e.g. a
# SENTRY_AUTH_TOKEN_REGEN pasted in while rotating) can't be picked up by
# -First 1 depending on line order.
$sentryTokenSource = $null
foreach ($envFile in @('.env.local', '.env')) {
  $envPath = Join-Path $RepoRoot $envFile
  if (-not (Test-Path $envPath)) { continue }
  $match = Select-String -Path $envPath -Pattern '^\s*SENTRY_AUTH_TOKEN\s*=\s*(.+?)\s*$' | Select-Object -First 1
  if ($match) {
    $fileToken = $match.Matches[0].Groups[1].Value.Trim("'", '"')
    if ($env:SENTRY_AUTH_TOKEN -and $env:SENTRY_AUTH_TOKEN -ne $fileToken) {
      Write-Host "  overriding SENTRY_AUTH_TOKEN from the environment with the one in $envFile" -ForegroundColor DarkGray
    }
    $env:SENTRY_AUTH_TOKEN = $fileToken
    $sentryTokenSource = $envFile
    break
  }
}
# A DEBUG build has nothing worth symbolicating: no R8 mapping, and unstripped
# .so files the local machine already has. But the Sentry Gradle plugin's upload
# tasks are wired into assembleDebug all the same, and they are NOT gated on
# having a token - `shouldSentryAutoUpload()` only checks the
# SENTRY_DISABLE_* opt-outs (see @sentry/react-native/sentry.gradle.kts). So a
# token that is missing, expired, or scoped without project:releaseS fails
# :app:uploadSentryNativeSymbolsForDebug with "Auth token is required for this
# request" and takes the whole local build down with it - after the APK has
# already been assembled successfully. The app.config.js comment claiming
# "Android tolerates a missing token" was simply wrong.
#
# Turning the upload off for debug removes a network+auth dependency from the
# inner dev loop entirely, so `deploy.ps1` cannot fail on Sentry's account state.
# Release builds are untouched: that is where the mapping file actually matters
# (see the experimental_android block in app.config.js), and where a missing
# token SHOULD be loud.
if (-not $Release) {
  $env:SENTRY_DISABLE_NATIVE_DEBUG_UPLOAD = 'true'
  $env:SENTRY_DISABLE_AUTO_UPLOAD = 'true'
}

if (-not $env:SENTRY_AUTH_TOKEN) {
  if ($Release) {
    Write-Host "SENTRY_AUTH_TOKEN not set - Sentry symbol upload will fail. Add it to .env.local." -ForegroundColor Yellow
  }
} else {
  if (-not $sentryTokenSource) { $sentryTokenSource = 'environment' }
  # Report the org the token actually carries. sentry-cli PREFERS the org baked
  # into a sntrys_ token over defaults.org in sentry.properties, so a token issued
  # before an org rename fails with "organization not found" no matter what the
  # config says - and the only way to see that coming is to print it.
  $sentryOrg = '(unknown)'
  if ($env:SENTRY_AUTH_TOKEN.StartsWith('sntrys_')) {
    $body = $env:SENTRY_AUTH_TOKEN.Substring(7)
    for ($c = $body.Length; $c -gt 0; $c--) {
      try {
        $seg = $body.Substring(0, $c)
        $pad = $seg.PadRight($seg.Length + ((4 - $seg.Length % 4) % 4), '=')
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($pad.Replace('-', '+').Replace('_', '/'))) | ConvertFrom-Json
        if ($claims.org) { $sentryOrg = $claims.org; break }
      } catch { }
    }
  }
  Write-Host "Loaded SENTRY_AUTH_TOKEN from $sentryTokenSource (org: $sentryOrg)" -ForegroundColor DarkGray
}

# --- sideload version stamp ---
#
# A sideloaded build used to report the static app.config.js fallback (0.0.2) for
# EVERY sideload ever made. That value is also Sentry's `release`, so field
# reports from this phone were indistinguishable from each other AND from a real
# 0.0.2 - which is how HS-MOBILEAPP-V arrived: a 6-hour progress reset whose
# diagnostic telemetry had shipped in 0.7.0, but the build under test said 0.0.2
# and nobody could tell it was running older code than the fix.
#
# So a sideload now stamps itself from the LAST RELEASE TAG plus the commit it was
# actually built from: 0.7.1-dev.467af25. The tag says which release this is
# descended from; the sha says exactly which build, so two sideloads from the same
# tag are never confused and "when did I last sideload?" is answerable from the
# About screen or any Sentry event.
#
# Release builds are untouched: -Release defers to the tag-driven CD value (or the
# static fallback), because that version is a store/OTA identity, not a local marker.
#
# NOTE this feeds runtimeVersion (policy: appVersion), so each sideload gets its own
# OTA namespace - correct, since a dev build must never be handed a store OTA bundle.
if (-not $Release -and -not $env:EXPO_PUBLIC_APP_VERSION) {
  # Tags live on the remote too, but a local read keeps this working offline. Fetch
  # is deliberately NOT done here - it would add network latency to every deploy,
  # and a tag created elsewhere since the last pull is not what this build contains.
  $lastTag = (& git -C $RepoRoot describe --tags --abbrev=0 2>$null)
  $sha = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
  if ($lastTag -and $sha) {
    $dirty = if ((& git -C $RepoRoot status --porcelain 2>$null)) { '.dirty' } else { '' }
    $env:EXPO_PUBLIC_APP_VERSION = "$lastTag-dev.$sha$dirty"
    Write-Host "Sideload version: $env:EXPO_PUBLIC_APP_VERSION" -ForegroundColor DarkGray
  } else {
    Write-Warning 'Could not read a git tag/sha - falling back to the static app.config.js version.'
  }
}

if (-not $env:NODE_ENV) {
  $env:NODE_ENV = if ($Release) { 'production' } else { 'development' }
}

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

# --- Metro: ensure it is running for debug builds that load JS at runtime ---
# StandaloneDebug and Release APKs embed their own JS - no Metro needed.
if (-not $Release -and -not $StandaloneDebug) {
  $metroRunning = $false
  try {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    $tcp.Connect('127.0.0.1', 8081)
    $tcp.Close()
    $metroRunning = $true
  } catch { }

  if ($metroRunning) {
    Write-Host 'Metro already running on :8081' -ForegroundColor DarkGray
  } else {
    Write-Step 'Starting Metro bundler in background window'
    # Metro bundles per client request, so with only an Android device connected it
    # never bundles iOS. --android also auto-opens the Android app. -Ios drops the
    # flag if you ever want to drive an iOS client off the same Metro.
    $metroCmd = if ($Ios) { 'npx expo start --dev-client' } else { 'npx expo start --dev-client --android' }
    Start-Process powershell -ArgumentList "-NoProfile -Command `"Set-Location '$RepoRoot'; $metroCmd`"" -WindowStyle Normal
    # Give Metro a moment to bind the port before we run adb reverse.
    Write-Host 'Waiting for Metro to be ready...' -ForegroundColor DarkGray
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 500
      try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $tcp.Connect('127.0.0.1', 8081)
        $tcp.Close()
        break
      } catch { }
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      Write-Warning 'Metro did not start within 60 s. adb reverse may fail - check the Metro window.'
    }
  }

  Write-Step "Forwarding adb reverse tcp:8081 tcp:8081 on $Serial"
  & $adb -s $Serial reverse tcp:8081 tcp:8081 | Out-Null
}

# --- 1. prebuild (native changes only, or always for StandaloneDebug) ---
if ($Prebuild) {
  # Stop Gradle/Kotlin daemons BEFORE prebuild wipes android/.
  #
  # prebuild deletes the whole android/ tree, and the Kotlin compiler daemon from
  # the previous build keeps a handle on android/sentry.properties (the file the
  # Sentry gradle plugin writes). The delete then fails with
  # "EBUSY: resource busy or locked ... sentry.properties" AFTER prebuild has
  # already removed most of the tree - leaving a husk with no gradlew.bat, so the
  # next step died with a baffling "'.\gradlew.bat' is not recognized".
  #
  # Verified by killing PIDs one at a time: the GRADLE daemon was not the holder,
  # the KOTLIN compiler daemon was. `--stop` only stops Gradle daemons, so kill
  # the Kotlin ones directly. Daemons are disposable - the next build spawns new
  # ones (at the cost of a slower first compile).
  Write-Step 'Stopping Gradle/Kotlin daemons (they lock android/sentry.properties)'
  Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'GradleDaemon|kotlin-compiler-embeddable|KotlinCompileDaemon' } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        Write-Host "  stopped java PID $($_.ProcessId)" -ForegroundColor DarkGray
      } catch {
        Write-Warning "  could not stop java PID $($_.ProcessId): $($_.Exception.Message)"
      }
    }

  # Clear a HUSK left by a previous prebuild that died mid-delete.
  #
  # The EBUSY failure below aborts partway through removing android/, so the tree
  # survives with app/ and sentry.properties but WITHOUT gradlew.bat or the
  # top-level gradle files. prebuild does not reliably recover from that by
  # itself, and the leftover sentry.properties is the very file that gets locked -
  # so the next run can fail on the same file again. Deleting the husk up front
  # removes both problems. android/ is gitignored and fully regenerated, so this
  # is never destructive.
  $androidDir = Join-Path $RepoRoot 'android'
  if ((Test-Path $androidDir) -and -not (Test-Path (Join-Path $androidDir 'gradlew.bat'))) {
    Write-Step 'Clearing incomplete android/ tree from a previous failed prebuild'
    try {
      Remove-Item -LiteralPath $androidDir -Recurse -Force -ErrorAction Stop
    } catch {
      throw "android/ is incomplete (no gradlew.bat) and could not be deleted: $($_.Exception.Message). Close anything holding files under android/ and re-run."
    }
  }

  Write-Step 'expo prebuild --platform android'
  Push-Location $RepoRoot
  try {
    if ($StandaloneDebug) {
      $env:HEARTHSHELF_STANDALONE_DEBUG = '1'
      npx expo prebuild --platform android
      $prebuildExit = $LASTEXITCODE
      Remove-Item Env:\HEARTHSHELF_STANDALONE_DEBUG
    } else {
      npx expo prebuild --platform android
      $prebuildExit = $LASTEXITCODE
    }
  } finally { Pop-Location }

  # Fail loudly HERE if prebuild didn't finish. It exits non-zero on the EBUSY
  # above but the script used to carry on into the build, where the only symptom
  # was a missing gradlew.bat - which reads like a broken install rather than a
  # failed prebuild. Check the wrapper too, since that's what step 4 needs.
  # One automatic retry on the file-lock failure.
  #
  # The daemon-stop above races the OS actually releasing the handle: a daemon
  # that exits still holds android/sentry.properties for a moment, and any Gradle
  # command run outside this script (a manual ./gradlew, an IDE sync) spawns a
  # fresh daemon it never saw. Both leave the same husk. Since a re-run of the
  # whole script is what fixed it by hand - purely because the lock had lapsed by
  # then - do that here instead of making the user do it: clear the husk, wait for
  # the handle to drop, and prebuild once more.
  if ($prebuildExit -ne 0) {
    Write-Warning 'prebuild failed (usually the android/sentry.properties file lock) - clearing android/ and retrying once'
    if (Test-Path $androidDir) {
      # The lock can outlive the process by a moment; give it a few tries rather
      # than failing on the first EBUSY.
      $cleared = $false
      foreach ($attempt in 1..5) {
        try { Remove-Item -LiteralPath $androidDir -Recurse -Force -ErrorAction Stop; $cleared = $true; break }
        catch { Start-Sleep -Seconds 2 }
      }
      if (-not $cleared) {
        throw "expo prebuild failed (exit $prebuildExit) and android/ could not be deleted - something still holds a file under it. Close Gradle/Android Studio and re-run."
      }
    }
    Push-Location $RepoRoot
    try {
      if ($StandaloneDebug) {
        $env:HEARTHSHELF_STANDALONE_DEBUG = '1'
        npx expo prebuild --platform android
        $prebuildExit = $LASTEXITCODE
        Remove-Item Env:\HEARTHSHELF_STANDALONE_DEBUG
      } else {
        npx expo prebuild --platform android
        $prebuildExit = $LASTEXITCODE
      }
    } finally { Pop-Location }
  }
  if ($prebuildExit -ne 0) {
    throw "expo prebuild failed twice (exit $prebuildExit). android/ is now incomplete - check for a process holding android/sentry.properties (Gradle/Kotlin daemon, Android Studio) and re-run."
  }
  if (-not (Test-Path (Join-Path $RepoRoot 'android\gradlew.bat'))) {
    throw 'expo prebuild finished but android/gradlew.bat is missing - the native tree is incomplete. Delete android/ and re-run.'
  }

  # prebuild can wipe the JDK pin in android/gradle.properties - re-assert it.
  $gp = Join-Path $RepoRoot 'android\gradle.properties'
  $pin = @(
    'org.gradle.java.installations.auto-download=false'
    'org.gradle.java.installations.paths=C:/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot'
  )
  $content = if (Test-Path $gp) { Get-Content $gp -Raw } else { '' }
  if ($content -notmatch 'installations\.auto-download=false') {
    Write-Step 'Re-adding JDK 21 pin to android/gradle.properties'
    Add-Content -Path $gp -Value ("`n" + ($pin -join "`n"))
  }

  # Expo's template jvmargs (2 GiB heap / 512 MiB metaspace) OOMs the Gradle
  # daemon during :app:minifyReleaseWithR8 on -Release builds - bump it. Same
  # wiped-by-prebuild problem as the JDK pin above, same fix.
  $content = if (Test-Path $gp) { Get-Content $gp -Raw } else { '' }
  if ($content -match '(?m)^org\.gradle\.jvmargs=.*$') {
    Write-Step 'Raising Gradle daemon heap for R8 (org.gradle.jvmargs)'
    $content = $content -replace '(?m)^org\.gradle\.jvmargs=.*$', 'org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m'
    Set-Content -Path $gp -Value $content -NoNewline
  }
}

# --- 2. clear stale native caches (the libworklets.so ninja fix) ---
# A live Gradle daemon keeps build-output jars (e.g. expo-modules-core's
# classes.jar) open, so deleting those dirs fails with "being used by another
# process" and the daemons pile up across runs. Stop all daemons before touching
# the dirs, then retry each delete for a moment in case a scanner briefly holds a
# freshly-released handle.
function Stop-GradleDaemons {
  Write-Step 'Stopping Gradle daemons (they hold build-output jars open)'
  Push-Location (Join-Path $RepoRoot 'android')
  try { & .\gradlew.bat --stop 2>&1 | Out-Null } catch { }
  finally { Pop-Location }
  # Belt and suspenders: kill any java that survived the graceful stop.
  Get-Process java -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

function Remove-ItemResilient($path) {
  for ($i = 1; $i -le 5; $i++) {
    try {
      Remove-Item -Recurse -Force $path -ErrorAction Stop
      return
    } catch {
      if ($i -eq 5) { throw }
      Start-Sleep -Seconds 1
    }
  }
}

function Clear-NativeCaches {
  Stop-GradleDaemons
  Write-Step 'Clearing native build caches (.cxx / android build dirs)'
  $paths = @(
    'node_modules\react-native-worklets\android\build'
    'node_modules\react-native-worklets\android\.cxx'
    'node_modules\react-native-reanimated\android\build'
    'node_modules\react-native-reanimated\android\.cxx'
    'node_modules\expo-modules-core\android\build'
    'node_modules\expo-modules-core\android\.cxx'
    'node_modules\react-native-screens\android\build'
    'node_modules\react-native-screens\android\.cxx'
    'node_modules\react-native-gesture-handler\android\build'
    'node_modules\react-native-gesture-handler\android\.cxx'
    'android\app\.cxx'
  )
  foreach ($p in $paths) {
    $full = Join-Path $RepoRoot $p
    if (Test-Path $full) { Remove-ItemResilient $full }
  }
}

if ($Clean) { Clear-NativeCaches }

# Signatures of the known stale-CMake/PCH failures (see deploy.ps1 -Clean docs
# above): a missing libworklets.so ninja rule, or a reanimated precompiled
# header invalidated by an NDK sysroot mtime change. Both are fixed by wiping
# the same native caches, so auto-recover once instead of making the user
# diagnose and re-run with -Clean by hand.
$StaleCacheSignatures = @(
  'missing and no known rule to make it'
  'has been modified since the precompiled header'
  # A stranded Gradle daemon (spawned before this run's gradle.properties edits
  # changed the JVM args) keeps library-output jars open on Windows, so the new
  # daemon can't rewrite them. Clear-NativeCaches stops all daemons first, which
  # releases the lock, so the retry succeeds.
  'Unable to delete file'
)

# --- 3. build (auto-retry once after clearing caches on a known stale-cache error) ---
Write-Step "Building $Variant APK ($Abi only)"
Push-Location (Join-Path $RepoRoot 'android')
try {
  $attempt = 1
  $maxAttempts = if ($Clean) { 1 } else { 2 }
  while ($true) {
    $buildOutput = & .\gradlew.bat $GradleTask "-PreactNativeArchitectures=$Abi" 2>&1
    $buildOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) { break }

    $isStaleCache = $StaleCacheSignatures | Where-Object { $buildOutput -match $_ }
    if ($isStaleCache -and $attempt -lt $maxAttempts) {
      Write-Warning 'Detected a stale native build cache (reanimated PCH / libworklets.so). Clearing caches and retrying once.'
      Clear-NativeCaches
      $attempt++
      continue
    }

    throw "Gradle build failed (exit $LASTEXITCODE)."
  }
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
