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

## Notes / decisions still open

- **Dev vs prod Clerk instance**: the default `pk_live_...` points at the prod
  Clerk instance. For dev builds, set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` to a
  `pk_test_...` so test sign-ins don't create prod users. (You'd register the
  debug-keystore Android client under that dev instance.)
- **Client Trust / device attestation** must stay OFF for sideloaded debug
  builds to sign in (per CLAUDE.local.md).
