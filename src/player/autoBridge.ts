/**
 * JS side of the native Android Auto bridge. Hands the connected ABS server URL
 * + token (and the user's skip-second settings) to the native
 * HearthShelfAutoService, which serves the car browse tree and plays audio in its
 * own process. Also publishes the phone-computed Discover feed for the car to
 * browse, since the car can't run the TS taste engine itself. No-op on platforms
 * without the module.
 */
import { NativeModules, Platform } from 'react-native'

/** One Discover row handed to the car: a label and its books (id/title/author). */
export interface AutoDiscoverShelf {
  id: string
  label: string
  items: { id: string; title: string; author: string }[]
}

interface HearthShelfAutoNative {
  setSession(serverUrl: string, token: string, skipBackSec: number, skipForwardSec: number): void
  setDiscover(json: string): void
  setNotePopsEnabled(enabled: boolean): void
  clearSession(): void
}

const native: HearthShelfAutoNative | undefined = NativeModules.HearthShelfAuto

export function setAutoSession(
  serverUrl: string,
  token: string,
  skipBackSec: number,
  skipForwardSec: number,
): void {
  if (Platform.OS === 'android') native?.setSession(serverUrl, token, skipBackSec, skipForwardSec)
}

/** Publish the current Discover shelves so the car's Discover tab can browse them. */
export function setAutoDiscover(shelves: AutoDiscoverShelf[]): void {
  if (Platform.OS === 'android') native?.setDiscover(JSON.stringify({ shelves }))
}

/**
 * Mirror the notePops master on/off into the car service. The Auto service runs
 * headlessly and can't read the RN settings store (AsyncStorage/SQLite), so JS
 * pushes the current value here whenever it changes. See docs/social.md Phase 7.
 */
export function setAutoNotePops(enabled: boolean): void {
  if (Platform.OS === 'android') native?.setNotePopsEnabled(enabled)
}

export function clearAutoSession(): void {
  if (Platform.OS === 'android') native?.clearSession()
}
