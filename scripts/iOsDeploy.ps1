<#
.SYNOPSIS
  iOS dev loop: start Metro so the dev-client app on your iPhone live-reloads JS,
  and (with -Build) mint a new iOS dev client on EAS when native code changes.

.DESCRIPTION
  iOS is NOT built locally - Apple toolchains need macOS. So this script has two
  jobs, split by whether native code changed:

    DAY TO DAY (no flag):
      The dev-client app is already on your iPhone (built once via -Build). Just
      start Metro bound to your PC's LAN IP; open the HearthShelf dev client on
      the phone and connect to the server it lists (or scan the QR). Edit JS/TS
      and save -> Fast Refresh, no rebuild. This mirrors ./scripts/dev-server.ps1
      on Android, minus adb: the iPhone reaches Metro over Wi-Fi, so both devices
      must be on the same network. There is no USB tunnel for iOS.

    NATIVE CHANGED (-Build):
      A new native module, a config-plugin edit, an app.config.js native key, or
      an SDK bump means the installed dev client is stale and JS-over-Metro will
      crash or behave oddly. Run with -Build to kick a cloud dev-client build:
        npx eas build --platform ios --profile development
      EAS builds + signs it (using the ASC API key + the dev cert/ad-hoc profile
      already on Expo's servers), then gives a QR/URL to install on the iPhone.
      That build is ~15-25 min in the free-tier queue and spends one iOS build
      slot - only do it for native changes, not JS edits.

  PROD / TestFlight builds are done manually via expo.dev (the ios-testflight
  workflow) - this script never touches them.

  No Android/iOS file swaps are needed: app.config.js drives both platforms, and
  the Android-only exclusion of expo-dev-client lives in package.json autolinking
  (so iOS keeps the dev client, Android never gets it).

.PARAMETER Build
  Build a fresh iOS dev client on EAS (native change). Runs
  `eas build --platform ios --profile development`. Omit for the day-to-day
  Metro-only loop against the dev client already on the phone.

.PARAMETER NoWait
  With -Build: submit the EAS build and return immediately instead of waiting for
  it to finish (`--no-wait`). Watch progress on expo.dev.

.PARAMETER Clear
  Start Metro with a cleared cache (expo start --dev-client --clear). Use when a
  stale bundle cache causes weird module-resolution errors.

.PARAMETER Tunnel
  Serve Metro through an Expo tunnel instead of the LAN. Slower, but works when
  the phone and PC are on different subnets or a firewall blocks port 8081.

.PARAMETER HostIp
  Override the LAN IP advertised to the phone. Defaults to auto-detecting the
  primary IPv4 address. Only needed if auto-detection picks the wrong adapter.

.EXAMPLE
  ./scripts/iOsDeploy.ps1
  Day-to-day: start Metro on the LAN, connect the dev client, live-reload JS.

.EXAMPLE
  ./scripts/iOsDeploy.ps1 -Build
  Native change: build a new iOS dev client on EAS, then install it on the phone.

.EXAMPLE
  ./scripts/iOsDeploy.ps1 -Tunnel
  Same day-to-day loop, but route Metro through an Expo tunnel (cross-network).
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$NoWait,
  [switch]$Clear,
  [switch]$Tunnel,
  [string]$HostIp
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- -Build: mint a new iOS dev client on EAS (native changes only) ---
if ($Build) {
  Write-Step 'Building iOS dev client on EAS (development profile)'
  Write-Host 'Native change path: this spends one iOS build slot (~15-25 min queue).' -ForegroundColor DarkGray
  Write-Host 'When it finishes, open the QR/URL on the iPhone to install, then trust' -ForegroundColor DarkGray
  Write-Host 'the profile in Settings > General > VPN & Device Management.' -ForegroundColor DarkGray
  Push-Location $RepoRoot
  try {
    $easArgs = @('eas', 'build', '--platform', 'ios', '--profile', 'development')
    if ($NoWait) { $easArgs += '--no-wait' }
    # When Apple login is prompted, answer NO: the ASC API key + stored dev
    # credentials let EAS manage the cert/profile without interactive 2FA.
    & npx @easArgs
  } finally { Pop-Location }
  return
}

# --- day-to-day: start Metro for the dev client already on the phone ---

# Detect the PC's LAN IPv4 so the phone can reach Metro over Wi-Fi. Skip loopback,
# APIPA (169.254.*), and the WSL/Hyper-V virtual switch (172.* on a /20). Prefer a
# 192.168.* address, then any remaining private one.
if (-not $HostIp) {
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -ne '127.0.0.1' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -ExpandProperty IPAddress
  $HostIp = ($candidates | Where-Object { $_ -like '192.168.*' } | Select-Object -First 1)
  if (-not $HostIp) { $HostIp = ($candidates | Select-Object -First 1) }
}

if ($Tunnel) {
  Write-Step 'Starting Metro via Expo tunnel (cross-network)'
} else {
  if (-not $HostIp) {
    Write-Host 'WARNING: could not auto-detect a LAN IP. Pass -HostIp <ip>, or use -Tunnel.' -ForegroundColor Yellow
  } else {
    Write-Step "Starting Metro on the LAN (advertising $HostIp to the phone)"
    # expo-cli reads this to build the bundle URL the dev client connects to.
    $env:REACT_NATIVE_PACKAGER_HOSTNAME = $HostIp
  }
}

Write-Host 'On the iPhone: open the HearthShelf dev client, then tap this PC under' -ForegroundColor DarkGray
Write-Host 'Development servers (or scan the QR below). Same Wi-Fi required.' -ForegroundColor DarkGray
Write-Host 'Edit JS/TS and save to live-reload. Shake the phone for the dev menu.' -ForegroundColor DarkGray

Push-Location $RepoRoot
try {
  $startArgs = @('expo', 'start', '--dev-client')
  if ($Tunnel) { $startArgs += '--tunnel' }
  if ($Clear) { $startArgs += '--clear' }
  & npx @startArgs
} finally {
  Pop-Location
  if ($env:REACT_NATIVE_PACKAGER_HOSTNAME) { Remove-Item Env:\REACT_NATIVE_PACKAGER_HOSTNAME -ErrorAction SilentlyContinue }
}
