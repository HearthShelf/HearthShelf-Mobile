// Entry point. The Android Auto / CarPlay surfaces are native media surfaces
// wired by Expo config plugins, so there's nothing to register from JS here.
import 'expo-router/entry'

// Crash breadcrumbs. Init the on-disk trail and install the global JS error
// capture as early as possible so a crash during startup is still recorded. The
// prior-run report (if the last run died) is read + flushed from app/_layout.tsx,
// where a Clerk token is available to authenticate the upload.
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
