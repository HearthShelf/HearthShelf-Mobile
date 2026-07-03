// Entry point. The Android Auto / CarPlay surfaces are native media surfaces
// wired by Expo config plugins, so there's nothing to register from JS here.
import 'expo-router/entry'

// Register the notifee background event handler at module load so a tapped/replied
// club-note notification is handled even when the app is woken with no UI (Phase 7
// - see docs/social.md). Also consumes a cold-start notification tap.
import { registerNoteEventHandlers } from '@/social/noteEvents'
void registerNoteEventHandlers()

// Define the offline-progress background flush task at module load so a headless
// OS wake (network returned) can find it by name (see backgroundFlushTask.ts).
import '@/player/backgroundFlushTask'
