# HearthShelf Mobile

React Native (Expo) mobile app for HearthShelf - a browser-first, self-hosted
UI/UX over AudiobookShelf (ABS). The phone app signs into the hosted front door
(`app.hearthshelf.com`), connects to the user's linked server, and plays their
audiobook library - including in the car via **Android Auto** (native Media3
`MediaLibraryService`).

This started as a spike (`spike/android-auto-rn` in the `HearthShelf` repo) and
was extracted here once it was proven end-to-end on a real device + a real car.
See `SPIKE_FINDINGS.md` for the full decision trail (why this stack, what was
ruled out) and `TESTING.md` for build/run/in-car testing.

## Stack

- **App:** Expo SDK 56, React Native 0.85, Expo Router, TypeScript
- **Auth:** Clerk (Google OAuth) -> control-plane grant -> `/hs/hosted/connect`
  -> per-user ABS token (mirrors the web app's flow)
- **Audio:** `react-native-video` (Media3 engine, background + lock-screen)
- **Android Auto:** a native Kotlin Media3 `MediaLibraryService`
  (`plugins/hearthshelf-auto`, an Expo config plugin) - the only free path that
  works; Google forbids the Car App Library template model for car *audio*.

## Quick start

```bash
npm install
npx expo prebuild --platform android   # runs the config plugins (incl. Android Auto)
npm run android                        # build + run on a connected device
```

A local Android toolchain (JDK 17 + Android SDK) is required - see `TESTING.md`.
No EAS account needed for local builds.

## Relationship to the other repos

- **HearthShelf** - self-hosted SPA + Node backend + Docker (the server users run)
- **HearthShelf-WebApp** - hosted front door (`app.hearthshelf.com`) the mobile
  app signs into; the auth/connect flow here is ported from its `controlPlane` +
  `connectServer`
- **HearthShelf-Mobile** (this repo) - the phone app

Shared logic (ABS types, control-plane client, format/discover helpers) is
currently duplicated by deliberate choice; it may be extracted into a small
shared package if drift becomes a maintenance cost.
