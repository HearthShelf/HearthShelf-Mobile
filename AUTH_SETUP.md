# Auth setup - native Sign in with Google

The app code for native Google sign-in is done (`useSignInWithGoogle()` in
`app/sign-in.tsx`, gated by `NATIVE_GOOGLE_ENABLED`). It stays on the working
browser-tab OAuth flow until the platform credentials below are completed and
the env vars are set - at which point it switches to the native Google flow with
no code change.

These steps need a Google Cloud account and the HearthShelf Clerk dashboard;
they can't be automated from here. Sourced from Clerk's Expo "Sign in with
Google" guide and verified against the installed `@clerk/expo@3.6.3` package.

## 1. Get the signing keystore SHA-256

The Android OAuth client is bound to your app's signing cert.

```powershell
# Debug keystore (for dev builds) - default location:
keytool -keystore $env:USERPROFILE\.android\debug.keystore -list -v `
  -alias androiddebugkey -storepass android -keypass android
# Release upload keystore (for Play builds) - your own keystore:
keytool -keystore <path-to-upload-keystore.jks> -list -v -alias <alias>
```

Copy the **SHA-256** line. Register BOTH the debug SHA (dev) and the release/
Play-app-signing SHA (prod) - one Android client per cert, or add both.

> If you enroll in Play App Signing, also grab the **App signing key
> certificate** SHA-256 from the Play Console (Setup -> App integrity); that's
> the cert end users actually get.

## 2. Create Google Cloud OAuth clients

In Google Cloud Console -> APIs & Services -> Credentials, create:

- **Web application** client -> gives a **Client ID + Client SECRET**.
  (Used by Clerk's backend to verify the ID token.)
- **Android** client -> package name `com.hearthshelf.mobile` + the SHA-256
  from step 1. Gives an **Android Client ID** (no secret).
- **iOS** client -> bundle ID `com.hearthshelf.mobile`. Gives an **iOS Client
  ID** + a reversed URL scheme.

## 3. Configure Clerk dashboard

In the HearthShelf Clerk dashboard:

1. **User & Authentication -> Social Connections -> Google** -> enable.
2. Toggle **"Use custom credentials"** ON.
3. Paste the **Web** Client ID + Client SECRET from step 2.
4. On the **Native Applications** page, register the Android (and later iOS)
   app with their platform Client IDs.

The Android Client ID is verified server-side by Clerk; it is NOT baked into the
APK (the `@clerk/expo` config plugin only wires the iOS URL scheme + Android
packaging exclusions - confirmed by reading the shipped plugin).

## 4. Set the env vars

Copy `.env.example` -> `.env` and fill in the **public** IDs (never the secret):

```
EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID=<web client id>
EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID=<android client id>
EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID=<ios client id>
EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME=<reversed ios client id>
```

Android native sign-in turns on when the Web and Android client IDs are present.
iOS native sign-in turns on when the Web client ID, iOS client ID, and iOS URL
scheme are present. Metro inlines `EXPO_PUBLIC_*` at build time, so:

## 5. Rebuild (native, not Expo Go)

```bash
npx expo prebuild --platform android   # re-runs config plugins
npm run android                        # build + install dev client
```

For iOS without a Mac, run the GitHub Actions iOS simulator workflow. It verifies
the native project compiles, but real sign-in still needs an iOS device or
simulator runtime with the proper Clerk/Google dashboard setup.

Native Google sign-in does not work in Expo Go - it needs a dev/native build.

## 6. Verify on a real device

Tap **Continue with Google**. You should get the native Android account-picker
bottom sheet (your device's Google accounts), NOT a browser tab. After picking
an account you land on `/home` connected to your server - confirming the
downstream grant -> `/hs/hosted/connect` -> ABS token handshake still works
(the Clerk session is identical regardless of which Google flow produced it).

## Discord sign-in

"Continue with Discord" is wired in `app/sign-in.tsx` and needs no client IDs in
this repo - Clerk has no native Discord hook, so it always uses the browser-tab
OAuth flow (`startSSOFlow({ strategy: 'oauth_discord' })`), the same mechanism as
the Google browser fallback. All the Discord credentials live in Clerk.

To turn it on:

1. **Discord Developer Portal** (https://discord.com/developers/applications):
   create an application -> OAuth2. Copy the **Client ID** and **Client Secret**.
   Add Clerk's redirect URL (shown in the Clerk dashboard step below) to the
   OAuth2 **Redirects** list.
2. **Clerk dashboard** -> **User & Authentication -> Social Connections ->
   Discord** -> enable. For production, toggle **"Use custom credentials"** ON
   and paste the Discord Client ID + Secret; copy the **Redirect URI** Clerk
   shows back into the Discord portal (step 1).
3. No env var and no rebuild are needed for a JS-only change - but the button
   already ships, so once the Clerk connection is enabled it works on the next
   run. The app-side redirect it uses is the same `hearthshelf://sso-callback`
   deep link already allowlisted for Google's browser flow.

There is no native account-picker for Discord on Android or iOS; it always opens
the in-app browser tab. That is expected, not a gap.

## iOS readiness (native Google + Discord)

The code paths for iOS already exist; iOS is gated only on Apple provisioning
(the $99 Apple Developer enrollment) and dashboard config, not on new code here:

- **Native Google on iOS**: `NATIVE_GOOGLE_ENABLED` has an iOS branch that turns
  on when `EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID` and
  `EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME` are set (plus the shared web client
  ID). `useSignInWithGoogle()` drives `ASAuthorization` on iOS. Create the iOS
  OAuth client (step 2 above), register it on Clerk's Native Applications page,
  and set the two env vars. The reversed iOS client ID goes in
  `EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME`; the `@clerk/expo` config plugin
  writes it into the iOS `CFBundleURLTypes` during prebuild.
- **Discord on iOS**: nothing iOS-specific - the browser-tab flow is identical
  across platforms once the Clerk Discord connection is enabled.

Until the Apple account is paid and an iOS build can be produced, none of this is
verifiable on-device; the GitHub Actions iOS simulator workflow only proves the
native project compiles.

## Notes / decisions still open

- **Dev vs prod Clerk instance**: the default `pk_live_...` points at the prod
  Clerk instance. For dev builds, set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` to a
  `pk_test_...` so test sign-ins don't create prod users. (You'd register the
  debug-keystore Android client under that dev instance.)
- **Client Trust / device attestation** must stay OFF for sideloaded debug
  builds to sign in (per CLAUDE.local.md).
