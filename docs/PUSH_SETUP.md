# Push notifications setup (release alerts)

The app can push a notification when a book you follow becomes available, on its
Audible release day, or a few days before. All the **code** is wired; what's left
is provisioning two external things that need your accounts. Until they're set,
the app degrades gracefully: the Home countdown banner and the whole
Notifications screen work, and the screen shows a "push isn't set up on this
build yet" note. No crash, no missing UI.

Delivery uses **Expo's push service** (`expo-notifications` -> Expo -> FCM/APNs).

## What's already wired (no action needed)

- `expo-notifications` + `expo-device` installed; `expo-notifications` config
  plugin registered in `app.config.js`.
- `src/player/pushRegister.ts` mints the Expo token and registers it with the
  server (`POST /hs/push/register`) after sign-in. Self-guards: no project id ->
  no-op; native module absent -> no-op (lazy dynamic import).
- `src/player/pushHandlers.ts` shows notifications in the foreground, creates the
  Android `releases` channel, and routes a tapped notification to
  `/upcoming/<asin>` (mounted in `app/_layout.tsx`).
- Server: `push_tokens` table, `/hs/push/register`, and the `release-notify`
  scheduled job (every 6h) that sends the three signals via Expo's push API,
  deduped per book. Per-user toggles come from the `notify*` settings.

## What you need to provide

### 1. EAS project id  (`EXPO_PUBLIC_EAS_PROJECT_ID`)

This is what `getExpoPushTokenAsync` uses to mint a token.

```sh
npm i -g eas-cli        # if you don't have it
eas login               # your Expo account
eas init                # creates/links an EAS project, prints the project id
```

Put the id in `.env` (and CI secrets):

```
EXPO_PUBLIC_EAS_PROJECT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

`app.config.js` also exposes it at `extra.eas.projectId` automatically when set.

### 2. FCM credentials  (Android)  (`GOOGLE_SERVICES_JSON`)

Android push needs a Firebase project with Cloud Messaging.

1. Firebase console -> add project -> add an **Android app** with package
   `com.hearthshelf.mobile`.
2. Download its `google-services.json`.
3. Point the build at it:

   ```
   GOOGLE_SERVICES_JSON=./google-services.json    # path is picked up by app.config.js
   ```

4. Give Expo the FCM key so it can deliver on your behalf:

   ```sh
   eas credentials      # choose Android -> push key -> upload the FCM V1 service account JSON
   ```

   (From Firebase: Project settings -> Service accounts -> Generate new private
   key. Expo uses FCM v1.)

### 3. Rebuild natively

`expo-notifications` is a native module, so a JS reload is NOT enough:

```sh
npx expo prebuild --clean
npm run android          # or the local build in TESTING.md
```

## Verify

1. Sign in on a **real device** (push tokens don't mint on emulators).
2. The Notifications screen should no longer show the "push isn't set up" note.
3. Follow an upcoming book (series screen missing-book -> upcoming page ->
   "Notify me"). Confirm a row appears under Following.
4. Server: run the `release-notify` job from the admin Tasks panel ("Run now").
   It logs "sent N notifications". A quick end-to-end test: temporarily set a
   followed book's `release_date` to today in the DB, or fake availability by
   following a book whose ASIN is already in the library - the job will fire the
   "available" push.

## Notes

- iOS additionally needs an APNs key uploaded via `eas credentials`; the code
  path is identical.
- The server sends through `https://exp.host/--/api/v2/push/send` (no SDK). If
  you later self-host delivery, only `server/lib/expoPush.js` changes.
