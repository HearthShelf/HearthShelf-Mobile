# HearthShelf Mobile

[![CI](https://github.com/HearthShelf/HearthShelf-Mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/HearthShelf/HearthShelf-Mobile/actions/workflows/ci.yml)
[![Android](https://github.com/HearthShelf/HearthShelf-Mobile/actions/workflows/build-android-release.yml/badge.svg)](https://github.com/HearthShelf/HearthShelf-Mobile/actions/workflows/build-android-release.yml)
[![Website](https://img.shields.io/badge/site-hearthshelf.com-2c6e6b)](https://hearthshelf.com)
[![Docs](https://img.shields.io/badge/docs-docs.hearthshelf.com-2c6e6b)](https://docs.hearthshelf.com)

React Native (Expo) mobile app for HearthShelf - a browser-first, self-hosted
UI/UX over AudiobookShelf (ABS). The phone app signs into the hosted front door
(`app.hearthshelf.com`), connects to the user's linked server, and plays their
audiobook library - including in the car via **Android Auto** (native Media3
`MediaLibraryService`). iOS uses the same React Native app; GitHub Actions can
build an unsigned iOS Simulator app, while device/TestFlight builds wait on
Apple developer credentials.

This started as a spike (`spike/android-auto-rn` in the `HearthShelf` repo) and
was extracted here once it was proven end-to-end on a real device + a real car.
See `SPIKE_FINDINGS.md` for the full decision trail (why this stack, what was
ruled out) and `TESTING.md` for build/run/in-car testing.

## Stack

- **App:** Expo SDK 57, React Native 0.86, Expo Router, TypeScript
- **Auth:** Clerk (Google OAuth) -> control-plane grant -> `/hs/hosted/connect`
  -> per-user ABS token (mirrors the web app's flow)
- **Audio:** `react-native-video` (Media3 engine, background + lock-screen)
- **Android Auto:** a native Kotlin Media3 `MediaLibraryService`
  (`plugins/hearthshelf-auto`, an Expo config plugin) - the only free path that
  works; Google forbids the Car App Library template model for car *audio*.
- **iOS:** native Swift media controller + CarPlay audio browse surface
  (`plugins/hearthshelf-carplay`), with simulator builds in GitHub Actions and
  device builds via EAS -> TestFlight.

## Try the beta

Both platforms are in public beta. Opt in:

- **iOS (TestFlight):** https://testflight.apple.com/join/ehxv65Ms
- **Android (internal test):** https://play.google.com/apps/internaltest/4701644118536911529

## Quick start

```bash
npm install
npx expo prebuild --platform android   # runs the config plugins (incl. Android Auto)
npm run android                        # build + run on a connected device
```

A local Android toolchain (JDK 21 + Android SDK) is required - see `TESTING.md`.
iOS builds require macOS/Xcode, so use the GitHub Actions simulator workflow
until you have a Mac or cloud release credentials.

## Relationship to the other repos

- [**HearthShelf**](https://github.com/HearthShelf/HearthShelf) - self-hosted SPA + Node backend + Docker (the server users run)
- [**HearthShelf-WebApp**](https://github.com/HearthShelf/HearthShelf-WebApp) - hosted front door (`app.hearthshelf.com`) the mobile
  app signs into; the auth/connect flow here is ported from its `controlPlane` +
  `connectServer`
- [**HearthShelf-Core**](https://github.com/HearthShelf/HearthShelf-Core) - shared ABS types + pure logic (`@hearthshelf/core`)
- **HearthShelf-Mobile** (this repo) - the phone app

Shared logic (ABS types, format/discover/stats helpers) lives in
[`@hearthshelf/core`](https://github.com/HearthShelf/HearthShelf-Core), consumed
here as a git submodule at `packages/core`. This app is the reference wiring for
that package. Run `npm run sync-core` to pull the latest core.
