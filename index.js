// Entry point. The Android Auto / CarPlay surfaces are native media surfaces
// wired by Expo config plugins, so there's nothing to register from JS here.
import 'expo-router/entry'

// Crash breadcrumbs. Init the on-disk trail and install the global JS error
// capture as early as possible so a crash during startup is still recorded. The
// prior-run report (if the last run died) is read + flushed from app/_layout.tsx,
// where a Clerk token is available to authenticate the upload.
//
// ORDER MATTERS - do not hoist this above the 'expo-router/entry' import. That
// import pulls in app/_layout.tsx, which calls Sentry.init() and installs
// Sentry's global error handler. Running installCrashHandler() after it means
// ours wraps Sentry's and chains through via prev(), so BOTH report every
// fatal. Install ours first and Sentry's wrapper would sit outermost with no
// chain back to ours, silently dropping our breadcrumb capture.
import { initCrashLog, installCrashHandler } from '@/lib/crashLog'
void initCrashLog()
installCrashHandler()

// Register the notifee background event handler at module load so a tapped/replied
// club-note notification is handled even when the app is woken with no UI (Phase 7
// - see docs/social.md). Also consumes a cold-start notification tap.
import { registerNoteEventHandlers } from '@/social/noteEvents'
void registerNoteEventHandlers()

// Define the offline-progress background flush task at module load so a headless
// OS wake (network returned) can find it by name (see backgroundFlushTask.ts).
import '@/player/backgroundFlushTask'
