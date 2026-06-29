# HearthShelf Mobile - Project Plan

From validated spike to shippable product. Android first, iOS second.

Status as of 2026-06-29: spike is truck-verified (auth -> connect -> ABS ->
phone playback + Android Auto). This plan turns it into a real project. iOS /
CarPlay is explicitly **deferred** (its own milestone later).

## Build progress (2026-06-29)

All four milestones implemented to the limit of what's verifiable without a
device build / external accounts. `tsc --noEmit` clean throughout.

- **M1 (native Google) - CODE DONE, needs provisioning.** Migrated
  @clerk/clerk-expo 2.x -> @clerk/expo 3.6.3 (SDK 56 / RN 0.85 in peer range; no
  SDK bump needed). useSignInWithGoogle() wired, gated by NATIVE_GOOGLE_ENABLED;
  falls back to browser OAuth until Google Cloud + Clerk dashboard + keystore
  SHA are provisioned. **You must do AUTH_SETUP.md** + a device rebuild to flip
  it on and verify.
- **M2 (auth hardening) - DONE.** Env/secret separation (config.ts + app.config
  extra + .env.example), 401 -> sign-out-with-reason, no-linked-server screen,
  sign-out teardown audit.
- **M3 (features) - DONE.** Search, full library browsing + pagination, full
  player screen, chapters, sleep timer, multi-server picker. In-car (Android
  Auto) search left as a tracked follow-up - it touches the truck-verified
  native service and needs DHU/car verification.
- **M4 (release) - CODE DONE, signing needs your keystore.** CI typecheck +
  manual Android build workflows, standalone-js config plugin, versionCode,
  RELEASE.md. Signed Play uploads await your upload keystore as CI secrets.

**What needs YOU before this ships:** AUTH_SETUP.md (Google/Clerk/keystore),
RELEASE.md signing, and on-device verification of native Google + the new
screens. None of those are blocked on code.

## Where the spike actually is

What works today, in this repo:

- **Auth**: browser-tab Google OAuth via `useSSO({ strategy: 'oauth_google' })`
  + email/password fallback (`app/sign-in.tsx`). Clerk session -> control-plane
  grant -> `/hs/hosted/connect` -> per-user ABS token. Token uses the
  `hearthshelf` JWT template (`app/home.tsx:54`), matching the web app.
- **Connect/ABS**: `src/api/controlPlane.ts`, `src/api/connect.ts`,
  `src/api/abs.ts`, `src/api/session.ts`. Single linked server (`servers[0]`).
- **Playback**: persistent `<Video>` engine (`src/player/`), background +
  lock-screen, throttled progress sync.
- **Android Auto**: native Kotlin Media3 `MediaLibraryService`
  (`plugins/hearthshelf-auto/`), an Expo config plugin -> survives prebuild.
- **Config**: Clerk pk + control-plane URL inlined in `src/lib/config.ts`
  (publishable key is public by design). No env/secret separation yet.

Spike gaps (deferred by design): single server, first-page-per-library, no
search / chapters / sleep timer, browser-tab (not native) Google sign-in.

## Decided scope (this pass)

1. **Native "Sign in with Google"** (Android Credential Manager account-picker
   sheet) - replacing the browser tab.
2. **Auth + production config** hardening.
3. **Core playback features** - search, chapters, sleep timer, multi-server,
   full library browsing.
4. **Release / CI-CD pipeline** - signing, versioning, Play Store internal track.

iOS / CarPlay deferred.

---

## Milestone 1 - Native Sign in with Google (Android)

### The key finding (evidence-based)

The native account-picker flow uses Clerk's **`useSignInWithGoogle()`** hook,
which on Android drives the **Credential Manager** (one-tap, no browser) and on
iOS drives `ASAuthorization`. Verified against Clerk's Expo docs.

**Blocker / decision:** `useSignInWithGoogle()` ships in **`@clerk/expo` (3.x)**,
the renamed successor package. This repo has **`@clerk/clerk-expo@2.19.31`**,
which does NOT export it (verified: grep of installed `dist` finds nothing).
So Milestone 1 begins with a **package migration**:

- `@clerk/clerk-expo` -> `@clerk/expo` (3.x). Import paths change; some
  components were renamed (per Clerk's 3.0/3.1 migration notes). `useSSO`,
  `useAuth`, `useSignIn`, `ClerkProvider`, `tokenCache` all still exist - the
  `hearthshelf` JWT-template handshake is unaffected.
- Keep `useSSO` as the iOS-now / fallback path so we don't lose a working flow
  during migration.

### Required setup (cited from Clerk Expo docs)

- **Google Cloud Console** OAuth client IDs:
  - Android (native) - needs the **SHA-256** of the signing keystore
    (`keytool -keystore <path> -list -v`). NOTE: debug keystore SHA for dev
    builds; upload/Play-signing SHA for release. Both must be registered.
  - Web (application type) Client ID **+ secret** - for token verification.
  - iOS (native) - for Milestone (iOS), register now if cheap.
- **Clerk Dashboard**: Google social connection -> "Use custom credentials" ON
  -> add Web Client ID + secret; register the native apps on the Native
  Applications page with platform credentials.
- **Env vars** (public, `EXPO_PUBLIC_*`): `..._GOOGLE_WEB_CLIENT_ID`,
  `..._GOOGLE_ANDROID_CLIENT_ID`, (`..._GOOGLE_IOS_CLIENT_ID` for later). Added
  to `extra` in app config. `expo-crypto` already installed (nonce generation).
- **Build**: native dev-client rebuild required - not Expo Go.

### Tasks

1. Migrate `@clerk/clerk-expo` -> `@clerk/expo` 3.x; fix imports; typecheck green.
2. Stand up Google Cloud client IDs + register SHA-256 (debug first).
3. Configure Clerk dashboard custom Google credentials + native apps.
4. Wire env vars through `app.config.js` `extra` + `src/lib/config.ts`.
5. Add `useSignInWithGoogle()` as the primary button in `app/sign-in.tsx`;
   keep `useSSO` as fallback. On success -> same `setActive` -> `/home`.
6. Prebuild + rebuild dev-client APK; verify native sheet on a real device.
7. Verify the downstream handshake is unchanged (grant -> connect -> ABS token).

**Exit:** tapping "Continue with Google" shows the native Android account-picker
(no browser tab), signs in, and reaches a connected `/home`.

---

## Milestone 2 - Auth + production config hardening

1. **Env/secret separation**: move `CONTROL_PLANE_URL`, Clerk pk, Google client
   IDs out of the inlined `src/lib/config.ts` into app config `extra` +
   `EXPO_PUBLIC_*`, read via `expo-constants`. Support dev vs prod values.
2. **Sign-up + account-linking** path (spike was sign-in only): handle Clerk
   statuses beyond `complete` (verification, existing-account linking).
3. **Session/expiry UX**: port the web app's session-expired handler
   (`ClerkTokenBridge` registers one) - on 401 from control plane, sign out with
   a reason instead of a dead error screen. Currently `home.tsx` just shows the
   raw message.
4. **No-linked-server UX**: today `servers.length === 0` throws a bare error.
   Give a real "link a server at app.hearthshelf.com" screen with a retry.
5. **Sign-out completeness audit** (`handleSignOut` clears track/session/auto -
   confirm nothing leaks across accounts in SecureStore).

---

## Milestone 3 - Core playback features

Lift the spike's deferred limits. Most ABS endpoints already exist in
`src/api/abs.ts`; this is mostly UI + a few new calls.

1. **Multi-server**: server picker when `servers.length > 1` (today hardcodes
   `servers[0]`). Persist last-used server.
2. **Full library browsing**: pagination past the first 50 items; library list
   screen; per-library item lists. (Phone UI + the Android Auto tree.)
3. **Search**: ABS search endpoint -> phone search screen + (later) the car's
   Search template/voice.
4. **Chapters**: chapter list + seek; surface in NowPlayingBar / player screen
   and as car browse children.
5. **Sleep timer**: end-of-chapter + duration options; integrate with the
   player store + native session.
6. **Player screen**: a full-screen player beyond the `NowPlayingBar` (scrubber,
   speed, chapter nav, cover).
7. **Android Auto parity**: extend the native `MediaLibraryService` browse tree
   to match (libraries, search, chapters). HTTPS covers only (ATS constraint).

Sequence suggestion: full library browsing + player screen first (unblocks the
rest), then search, chapters, sleep timer, multi-server.

---

## Milestone 4 - Release / CI-CD pipeline

1. **Signing**: generate a release upload keystore; document it; register its
   SHA-256 with Google (Milestone 1) and Clerk. Keep the debug key for dev.
2. **Standalone JS bundling**: the spike hand-edited `debuggableVariants = []`
   in the gitignored `android/` dir (TESTING.md). Move that into a config plugin
   so release builds embed JS and survive prebuild.
3. **Versioning**: `version` + Android `versionCode` strategy; wire to CI.
4. **Build pipeline**: local Gradle path is documented (JDK 17 pin). Decide
   local-only vs EAS cloud for release. CI workflow: prebuild -> assembleRelease
   -> artifact. (Repo note: never push without ask - pushes trigger CI.)
5. **Play Store internal track**: app listing, internal testing track, upload
   automation (fastlane or EAS Submit).
6. **Crash/telemetry**: lightweight error reporting before wider testing.

---

## Open questions to resolve before/within each milestone

- **Clerk package migration risk**: confirm `@clerk/expo` 3.x is compatible with
  Expo SDK 56 / RN 0.85 pinned here before migrating (Clerk has per-Expo-version
  compat notes). If not, native Google may need an SDK bump - re-scope.
- **Keystore custody**: where the release upload key lives (this machine vs a
  secrets store) - gates Milestones 1 (SHA registration) and 4.
- **Dev vs prod Clerk instance**: spike uses the **live** pk
  (`pk_live_...`). Decide whether dev builds should point at a Clerk dev
  instance to avoid polluting prod users.

## iOS / CarPlay (deferred - noted for later)

Same RN codebase. Adds: iOS native Google client ID + URL scheme, a CarPlay
Swift content-tree module mirroring the Android Auto service, and the Apple
CarPlay **audio entitlement** request (a form/approval, not engineering).
