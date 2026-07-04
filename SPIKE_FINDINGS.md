# Android Auto RN spike - findings & stack

Branch: `spike/android-auto-rn`. Goal: a sideloadable Android app, built from the
HearthShelf web codebase via React Native, to evaluate **Android Auto** (browse +
playback controls) modeled on a typical audiobook car UX. CarPlay comes along for free.

## OUTCOME: TRUCK-VERIFIED SUCCESS (2026-06-29)

The app was built, installed on a Pixel 10 Pro XL, signed in (Clerk + Google
OAuth), loaded the real ABS library, and **played audiobooks in a real truck over
Android Auto** - browsing Continue Listening + libraries -> books -> playback.

**Final working stack (all free / MIT, one shared JS codebase + a bounded native
car module):**
- **UI / auth / phone playback:** React Native + Expo Router + Clerk +
  `react-native-video` (Media3 audio engine).
- **Android Auto car surface:** a **self-rolled native Kotlin Media3
  `MediaLibraryService`** (`plugins/hearthshelf-auto`, shipped as an Expo config
  plugin). This was the ONLY free path that works - see the dependency hunt below.

**Why self-rolled (definitive):** Google forbids the Car App Library template
model (`@iternio`) for car *audio* - templates are nav/POI/IoT/weather only; audio
MUST use a MediaBrowserService. `@rntp/player` does it correctly but is paid
(non-commercial-only). So a native MediaLibraryService (~250 lines) was the only
free, working option. Proven in the truck, not just on the bench.

**Known polish TODOs (not architectural):**
- Playback start is slow - preload/cache the `POST /api/items/:id/play` session
  (currently resolved on-select before audio begins).
- Audio keeps playing on the phone speaker after USB disconnect (Android's default
  hand-back) - add pause-on-`ACTION_AUDIO_BECOMING_NOISY` / disconnect if desired.
- iOS CarPlay: same architecture (a Swift content-tree module) + an Apple CarPlay
  audio **entitlement request** (a form/approval, not engineering).

## The dependency hunt (why this stack)

The obvious pick - `react-native-track-player` - turned out to be a trap, and the
landscape took real digging. Summary of what was verified against each package's
**published runtime bundle** (not docs/marketing):

| Package | Verdict |
| --- | --- |
| `react-native-track-player` (latest 4.1.2) | No Android Auto at all. |
| `react-native-track-player@5.0.0-alpha0` | `setBrowseTree` exists only in a stale source copy the package never loads; not in the runtime. Dead end. |
| **`@rntp/player`** (the renamed successor, 5.6.0) | DOES ship real Android Auto (`setBrowseTree` + native `MediaLibraryService`). **But it's commercial: free only for personal/academic use, else EUR99/mo.** A self-hostable product doesn't qualify. **Rejected.** |
| `@weights-ai/react-native-track-player` | Dead fork - no commits in a year, issues disabled. Rejected. |
| `@g4rb4g3/react-native-carplay` | Archived 2026-02 in favor of `@iternio/...`. |
| **`@iternio/react-native-auto-play`** | **CHOSEN.** MIT, active (Jun 2026), company-backed (Iternio), Nitro-based. Built on the `androidx.car.app` **template** model (List/Grid/Search/SignIn), full CarPlay too. The richer car model - we compose the screens ourselves. |

`@iternio` does car integration ONLY (no audio), so it's paired with an engine:

| Audio engine candidate | Verdict |
| --- | --- |
| `react-native-audio-api` | Web Audio API (AudioContext/buffers) - wrong tool for streaming long files. |
| `expo-audio` | Real Media3 player, but **no JS-settable now-playing metadata** (title/author/art) - the car would show blank. Rejected. |
| **`react-native-video`** | **CHOSEN.** Media3 `MediaSessionService` + iOS `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`; full now-playing **metadata from JS** (title/subtitle/artist/imageUri); HLS+DASH; `withBackgroundAudio` Expo plugin. Despite the name, the best free audio engine here. |

**Final stack: `@iternio/react-native-auto-play` (car) + `react-native-video`
(audio).** Both MIT, both actively maintained, one RN codebase. So it does NOT
come down to one (paid) dependency.

## What's built

- **Auth** - faithful port of the web handshake: Clerk session -> control-plane
  `/servers/:id/grant` -> server `/hs/hosted/connect` -> per-user ABS token.
  (`src/api/controlPlane.ts`, `src/api/connect.ts`, `src/lib/tokenCache.ts`)
- **ABS client** - libraries, items, continue-listening, covers, play-session,
  progress sync. Direct-to-server; `Authorization: Bearer` for JSON, `?token=`
  for media. (`src/api/abs.ts`, `src/api/types.ts`)
- **Audio engine** - a single persistent audio-only `<Video>` (`PlayerHost.tsx`)
  driven by a small shared store (`store.ts`); background + lock-screen via
  `showNotificationControls` + source `metadata`. (`src/player/`)
- **Playback orchestration** - ABS play-session -> stream + metadata into the
  store; resume at saved position; throttled progress sync to ABS.
  (`playback.ts`)
- **Phone UI** - Clerk sign-in + a home screen that connects to the first linked
  server, lists books (tap to play), and a NowPlayingBar (play/pause, +-skip) so
  transport is testable without a car. (`app/`)
- **Car experience** (`src/player/autoplay.tsx`):
  root `ListTemplate` with **Continue Listening** + one row per **library**;
  drilling in pushes a `ListTemplate` of that library's books (cover art +
  author); tapping a book starts playback through the same store the phone uses.
  Registered via `registerAutoPlay()` in `index.js`, driven by
  `HybridAutoPlay.addListener('didConnect', ...)`.

Typecheck: `npx tsc --noEmit` = 0 errors.

## Known constraints / TODO before a real build

- **Cover art in the car must be HTTPS** - `@iternio` blocks `http://` images
  (App Transport Security). HearthShelf-over-HTTPS is fine; a plain-LAN-HTTP
  server would show no covers in the car.
- **iternio native setup**: it's a Nitro module with no Expo config plugin. A
  real build needs the Android Auto manifest entries (`androidx.car.app`
  service/intent-filter + `automotive_app_desc`) and the iOS CarPlay scene
  delegate wiring. For EAS this means a small config plugin or a prebuild
  patch - see iternio README "Installation".
- **No local Android toolchain** on the build machine, so builds go via **EAS
  cloud** (dev-client; this won't run in Expo Go - it has native modules).
- Spike scope: single linked server, first page of each library, no search /
  sleep timer / chapters in the car yet.

## How to test the car surface

1. EAS dev/preview build -> install the APK.
2. Sign in on the phone (proves auth + playback via the NowPlayingBar).
3. Android Auto **Desktop Head Unit (DHU)** over ADB (or a real car) -> browse
   Continue Listening / libraries, tap a book, exercise transport.
