// Entry point. The Android Auto / CarPlay surfaces are native media surfaces
// wired by Expo config plugins, so there's nothing to register from JS here.
import { LogBox } from 'react-native'
import 'expo-router/entry'

// Silence known-benign RN core deprecation warnings. These fire from RN's own
// `react-native` barrel getters (via warnOnce -> console.warn) when a third-party
// lib or Metro's wildcard interop enumerates the barrel - none originate in our
// code (we already use the modern replacements: react-native-safe-area-context,
// expo-clipboard, expo-notifications). Nothing we can fix by changing our imports.
//
// Two channels emit these, so we quiet both: LogBox handles the in-app overlay;
// the console.warn filter handles the Metro terminal (LogBox does not touch that).
const IGNORED_DEPRECATION_WARNINGS = [
  /ProgressBarAndroid has been extracted from react-native core/,
  /SafeAreaView has been deprecated/,
  /Clipboard has been extracted from react-native core/,
  /InteractionManager has been deprecated/,
  /PushNotificationIOS has been extracted from react-native core/,
]

LogBox.ignoreLogs(IGNORED_DEPRECATION_WARNINGS)

const originalWarn = console.warn.bind(console)
console.warn = (...args) => {
  const first = args[0]
  if (typeof first === 'string' && IGNORED_DEPRECATION_WARNINGS.some((re) => re.test(first))) {
    return
  }
  originalWarn(...args)
}

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
