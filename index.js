// Entry point. The Android Auto / CarPlay surface is now a NATIVE
// MediaLibraryService (Kotlin) - Google forbids the Car App Library template
// model for media apps - so there's nothing to register from JS here.
import 'expo-router/entry'

// Register the notifee background event handler at module load so a tapped/replied
// club-note notification is handled even when the app is woken with no UI (Phase 7
// - see docs/social.md). Also consumes a cold-start notification tap.
import { registerNoteEventHandlers } from '@/social/noteEvents'
void registerNoteEventHandlers()
