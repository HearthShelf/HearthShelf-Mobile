/**
 * JS side of the native car bridge. Hands the connected ABS server URL + token
 * (and the user's skip-second settings) to the native Android Auto / iOS CarPlay
 * surface, which serves the car browse tree and owns native media controls. Also
 * publishes the phone-computed Discover feed for the car to browse, since the
 * car can't run the TS taste engine itself. No-op on platforms without the
 * module.
 */
import { NativeModules, Platform } from 'react-native'

/** One Discover row handed to the car: a label and its books (id/title/author). */
export interface AutoDiscoverShelf {
  id: string
  label: string
  items: { id: string; title: string; author: string }[]
}

/** One downloaded book as the car sees it offline: enough metadata to browse and
 *  enough local file detail to play, with no server in the loop. */
export interface AutoOfflineBook {
  id: string
  title: string
  /** Title with a leading article dropped, so the car's A-Z matches the app's. */
  sortKey: string
  author: string
  /** file:// uri of the downloaded cover, or '' when there isn't one. */
  cover: string
  duration: number
  /** Last known position (seconds) - what the car resumes at with no server. */
  position: number
  finished: boolean
  addedAt: number
  seriesId: string
  seriesName: string
  sequence: number
  chapters: { title: string; start: number; end: number }[]
  tracks: { uri: string; startOffset: number; duration: number }[]
}

/** A playback session the car banked while offline (mirrors LocalSession). */
export interface AutoOfflineProgress {
  itemId: string
  title: string
  duration: number
  currentTime: number
  timeListening: number
  startedAt: number
  updatedAt: number
  /** Set when the listen ended by the user finishing the book in the car (next
   *  chapter from the last chapter) while offline, so the drain marks it
   *  finished instead of only replaying the position. */
  finished?: boolean
}

/** A bookmark the car couldn't POST because there was no server to take it. */
export interface AutoOfflineBookmark {
  itemId: string
  time: number
  title: string
  createdAt: number
}

interface HearthShelfAutoNative {
  setSession(serverUrl: string, token: string, skipBackSec: number, skipForwardSec: number): void
  setSkipSeconds(skipBackSec: number, skipForwardSec: number): void
  setDiscover(json: string): void
  setOfflineLibrary(json: string): void
  getOfflineProgress(): Promise<string>
  clearOfflineProgress(idsJson: string): void
  getOfflineBookmarks(): Promise<string>
  clearOfflineBookmarks(keysJson: string): void
  isAirplaneMode(): Promise<boolean>
  getMemoryStats(): Promise<MemoryStats | Record<string, never>>
  setNotePopsEnabled(enabled: boolean): void
  setChapterProgress(enabled: boolean): void
  setSleepShake(enabled: boolean, minutes: number, timerActive: boolean, hapticLevel: string): void
  setSleepBeep(
    enabled: boolean,
    at2min: boolean,
    at1min: boolean,
    atFinal: boolean,
    sound: string,
    volume: number,
    remainingSec: number,
  ): void
  loadCarBook(itemId: string, positionSec: number): void
  syncCarState(): void
  /** Publish what is playing now, for the home-screen widget. */
  setNowPlaying(json: string): void
  /** Publish up-next titles for the widget's tall layout. */
  setWidgetQueue(json: string): void
  /** Pause whoever currently owns playback. Native routes to the car player when
   *  the car holds it and to the phone service otherwise, so this is the only
   *  pause that reaches the car. */
  pause(): void
  clearSession(): void
}

const native: HearthShelfAutoNative | undefined = NativeModules.HearthShelfAuto

export function setAutoSession(
  serverUrl: string,
  token: string,
  skipBackSec: number,
  skipForwardSec: number,
): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    native?.setSession(serverUrl, token, skipBackSec, skipForwardSec)
  }
}

/**
 * Push the user's skip-second settings to native so the phone notification's
 * rewind/forward buttons honor them (the car session also carries these, but only
 * while a car session is active - the notification is always live during playback).
 * Android only: iOS shares one player + MPRemoteCommandCenter, which already picks
 * up the intervals from setSession.
 */
export function setAutoSkipSeconds(skipBackSec: number, skipForwardSec: number): void {
  if (Platform.OS === 'android') native?.setSkipSeconds(skipBackSec, skipForwardSec)
}

/**
 * Publish the downloaded books to the car surface, so Android Auto has a browse
 * tree and something to play with no network. Everything else the car does is a
 * request to the user's server, which is why an offline car showed no book list
 * and no controls at all. Android only: iOS CarPlay routes taps up to JS, which
 * already resolves downloads itself.
 */
export function setAutoOfflineLibrary(books: AutoOfflineBook[]): void {
  if (Platform.OS === 'android') native?.setOfflineLibrary(JSON.stringify({ books }))
}

/** Progress the car banked while playing downloads offline, keyed per listen
 *  ("<itemId>@<startedAt>"). Empty on any platform without the native side. */
export async function getAutoOfflineProgress(): Promise<Record<string, AutoOfflineProgress>> {
  if (Platform.OS !== 'android' || !native?.getOfflineProgress) return {}
  try {
    return JSON.parse(await native.getOfflineProgress()) as Record<string, AutoOfflineProgress>
  } catch {
    return {}
  }
}

/** Drop the banked car listens we've taken ownership of, by their keys. */
export function clearAutoOfflineProgress(keys: string[]): void {
  if (Platform.OS !== 'android' || !keys.length) return
  native?.clearOfflineProgress(JSON.stringify(keys))
}

/** Bookmarks the car queued while offline. */
export async function getAutoOfflineBookmarks(): Promise<AutoOfflineBookmark[]> {
  if (Platform.OS !== 'android' || !native?.getOfflineBookmarks) return []
  try {
    const parsed = JSON.parse(await native.getOfflineBookmarks()) as AutoOfflineBookmark[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Drop the queued bookmarks we've taken ownership of, keyed "<itemId>@<time>". */
export function clearAutoOfflineBookmarks(keys: string[]): void {
  if (Platform.OS !== 'android' || !keys.length) return
  native?.clearOfflineBookmarks(JSON.stringify(keys))
}

/**
 * Is the device in airplane mode? Android only (iOS exposes no such API) - false
 * everywhere else, which just means we fall back to the normal connect attempt.
 */
export async function isAirplaneMode(): Promise<boolean> {
  if (Platform.OS !== 'android' || !native?.isAirplaneMode) return false
  try {
    return await native.isAirplaneMode()
  } catch {
    return false
  }
}

/** Java heap usage (MB) and live thread count. See getMemoryStats in the module. */
export interface MemoryStats {
  usedMb: number
  totalMb: number
  limitMb: number
  threads: number
}

/**
 * Sample the Java heap and thread count, or null when unavailable (iOS, or an
 * older native build without the method).
 *
 * Used to breadcrumb memory pressure so an OOM has something to be read against.
 * An OOM stack names only where the failing allocation happened to land, which in
 * HS-MOBILEAPP-1C was a React Fabric mount with no app frames at all - unusable
 * for finding the retainer.
 */
export async function getMemoryStats(): Promise<MemoryStats | null> {
  if (Platform.OS !== 'android' || !native?.getMemoryStats) return null
  try {
    const m = await native.getMemoryStats()
    return typeof (m as MemoryStats)?.limitMb === 'number' ? (m as MemoryStats) : null
  } catch {
    return null
  }
}

/** Publish the current Discover shelves so the car's Discover tab can browse them. */
export function setAutoDiscover(shelves: AutoDiscoverShelf[]): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    native?.setDiscover(JSON.stringify({ shelves }))
  }
}

/**
 * Mirror the notePops master on/off into the car service. The Auto service runs
 * headlessly and can't read the RN settings store (AsyncStorage/SQLite), so JS
 * pushes the current value here whenever it changes. See docs/social.md Phase 7.
 */
export function setAutoNotePops(enabled: boolean): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') native?.setNotePopsEnabled(enabled)
}

/**
 * Mirror the "scrubber scope" setting (chapter vs whole book) into the CarPlay
 * player, so the car/lock-screen progress bar tracks the current chapter or the
 * whole book to match the phone. iOS only: the Android Auto service computes
 * chapter-relative progress from its own chapter-clipped windows.
 */
export function setAutoChapterProgress(chapterScoped: boolean): void {
  if (Platform.OS === 'ios') native?.setChapterProgress(chapterScoped)
}

/**
 * Push the shake-to-extend sleep-timer state to native. Shake detection lives in
 * the phone media service (not JS) so it fires with the screen off / app
 * backgrounded - a JS accelerometer listener is suspended by Android then.
 * `timerActive` is true only while a duration/clock sleep timer is live, so the
 * service subscribes the accelerometer only when a shake could actually add time.
 * Android only: iOS shake-to-extend is unchanged (foreground JS listener).
 */
export function setAutoSleepShake(
  enabled: boolean,
  minutes: number,
  timerActive: boolean,
  hapticLevel: string,
): void {
  // Both platforms now detect the shake natively so it works with the phone
  // locked (iOS suspends the JS DeviceMotion listener when the screen is off).
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    native?.setSleepShake(enabled, minutes, timerActive, hapticLevel)
  }
}

/**
 * Push the warning-beep settings + the live sleep timer's remaining playback
 * seconds to native, so the phone media service fires the cues itself (screen-off
 * / backgrounded, like shake-to-extend). `remainingSec` is -1 when no
 * duration/clock timer is armed. Android only: the iOS beep runs foreground in JS
 * (see useSleepBeep), since the background media service is Android-only here.
 */
export function setAutoSleepBeep(
  enabled: boolean,
  at2min: boolean,
  at1min: boolean,
  atFinal: boolean,
  sound: string,
  volume: number,
  remainingSec: number,
): void {
  if (Platform.OS === 'android') {
    native?.setSleepBeep(enabled, at2min, at1min, atFinal, sound, volume, remainingSec)
  }
}

/**
 * Load the book the phone is playing into the car player at the given position,
 * on the car-takeover edge. Without this the car connects with an empty player
 * and Android Auto auto-plays the browse tree's first item (the up-next queue
 * head) instead of resuming the current book. Android only: iOS CarPlay shares
 * one player, so there's nothing to hand over.
 */
export function loadAutoCarBook(itemId: string, positionSec: number): void {
  if (Platform.OS === 'android') native?.loadCarBook(itemId, positionSec)
}

/**
 * Ask native to re-announce whether the car owns playback (and re-mirror the book
 * it holds). Called when the JS runtime comes up, because carActive is otherwise
 * set only by the onCarActive event - which fires on the car's connect edge, and
 * so is missed entirely by an app launched into an already-connected car. Android
 * only: iOS CarPlay shares one player, so there is no ownership to reconcile.
 */
export function syncAutoCarState(): void {
  if (Platform.OS === 'android') native?.syncCarState()
}

/**
 * Pause the player that actually owns playback right now.
 *
 * Setting `isPlaying: false` in the JS store only stands down the phone's
 * <Video> host. When the car owns playback the audio is coming from a SEPARATE
 * native ExoPlayer in the car service, which never sees that state - so the
 * sleep timer fired, the app went quiet, and the car played on
 * (HS-MOBILEAPP-2Q).
 *
 * Native pause() routes by carPlayer (car when it holds playback, phone service
 * otherwise), so this is the one call that reaches both. Android only: iOS
 * CarPlay shares a single player, so the store's own pause already covers it.
 */
export function pauseAutoPlayback(): void {
  if (Platform.OS === 'android') native?.pause()
}

/** One book as the home-screen widget sees it. */
export interface WidgetNowPlaying {
  itemId: string
  title: string
  author: string
  /** file:// uri of the downloaded cover, or '' - RemoteViews cannot load a
   *  network image, so a streaming book shows the placeholder tile. */
  cover: string
  position: number
  duration: number
  isPlaying: boolean
}

/**
 * Publish the current book to the widget.
 *
 * Its own prefs key, NOT a read of the car's offlineLibrary snapshot. That
 * snapshot looks like it would serve: it already carries title, author, cover
 * and position. But it holds only COMPLETED downloads and it is gated on car
 * mode (cleared on the same edge), so a streaming-only listener - or anyone with
 * car mode off - would get a permanently blank widget.
 *
 * This is also the only native-readable notion of "the current book" in the app.
 * The home hero derives from getItemsInProgress(), a network call, which a
 * widget running in the launcher process cannot make.
 *
 * Android only: iOS widgets are a separate (unbuilt) surface.
 */
export function setAutoNowPlaying(np: WidgetNowPlaying | null): void {
  if (Platform.OS !== 'android') return
  native?.setNowPlaying(JSON.stringify(np ?? {}))
}

/**
 * Publish up-next titles for the widget's tall layout.
 *
 * The queue is server-persisted with no local store (queue.ts is explicit about
 * keeping no AsyncStorage copy), so without this the widget's up-next section
 * has no data source at all. Titles only - that is everything the section draws.
 */
export function setAutoWidgetQueue(titles: string[]): void {
  if (Platform.OS !== 'android') return
  native?.setWidgetQueue(JSON.stringify({ items: titles.map((title) => ({ title })) }))
}

export function clearAutoSession(): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') native?.clearSession()
}
