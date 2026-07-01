/**
 * The persistent audio engine bridge. Instead of rendering a react-native-video
 * <Video>, this drives a native Media3 ExoPlayer (HearthShelfPlayerService) that
 * owns the phone MediaSession - so WE control the lock-screen / Android Auto
 * chapter-relative progress and the custom circular skip icons, which rn-video
 * could not do.
 *
 * The JS store stays the single source of truth: this component pushes store
 * changes down to the native player (load/play/pause/seek/rate/volume) and feeds
 * native progress/state events back into the store (reportPosition + syncProgress,
 * setPlaying) - the exact same store calls the old <Video> onProgress made, so no
 * player-UI screen changes.
 */
import { useEffect, useRef } from 'react'
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native'
import {
  getState,
  subscribe,
  reportPosition,
  clearSeek,
  setPlaying,
  jumpBy,
  togglePlay,
} from './store'
import { syncProgress } from './playback'

// Native module (added in HearthShelfAutoModule / HearthShelfPlayerService).
// Typed loosely - it's a thin old-arch bridge.
interface HSPlayer {
  load(url: string, startSec: number, title: string, author: string, artworkUri: string, chaptersJson: string): void
  play(): void
  pause(): void
  seekTo(sec: number): void
  setRate(rate: number): void
  setVolume(volume: number): void
  stop(): void
}
const Native = NativeModules.HearthShelfAuto as HSPlayer | undefined

export function PlayerHost() {
  // Track what we last pushed so store ticks don't re-issue identical commands.
  const loadedKey = useRef<string | null>(null)
  const lastPlaying = useRef<boolean | null>(null)
  const lastRate = useRef<number | null>(null)
  const lastVolume = useRef<number | null>(null)
  // Timestamp (ms) until which onState events are treated as seek transients and
  // ignored, so a skip doesn't bounce the play/pause intent.
  const seekingUntil = useRef(0)

  // Android 13+ needs runtime POST_NOTIFICATIONS or the media notification never
  // shows. Ask once on mount (no-op below API 33 / on iOS).
  useEffect(() => {
    if (Platform.OS !== 'android' || Platform.Version < 33) return
    void PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    ).catch(() => {})
  }, [])

  // ---- native -> store: progress / state / ended ----
  useEffect(() => {
    if (!Native) return
    const emitter = new NativeEventEmitter(NativeModules.HearthShelfAuto)
    const subs = [
      emitter.addListener('onProgress', (e: { position: number }) => {
        reportPosition(e.position)
        syncProgress(e.position)
      }),
      emitter.addListener('onState', (e: { isPlaying: boolean }) => {
        // Ignore the brief play/pause ExoPlayer emits while it re-buffers a
        // JS-initiated seek (the native seekToSec preserves playWhenReady, so the
        // engine keeps playing; this just stops the transient from flipping our
        // intent and echoing a pause back). Genuine external transport (lock
        // screen) still comes through once the seek window closes.
        if (Date.now() < seekingUntil.current) return
        // Keep our "last pushed" marker in step so the store update below doesn't
        // make sync() re-issue the very command native just reported.
        lastPlaying.current = e.isPlaying
        setPlaying(e.isPlaying)
        // On pause/stop (incl. the sleep timer stopping playback), flush a final
        // sync so the server has the real stop point and Recent listens is fresh.
        if (!e.isPlaying) void syncProgress(getState().position, true)
      }),
      // Native transport (lock screen / car) routes back through the store so it
      // stays the source of truth.
      emitter.addListener('onTogglePlay', () => togglePlay()),
      emitter.addListener('onJump', (e: { delta: number }) => jumpBy(e.delta)),
    ]
    return () => subs.forEach((s) => s.remove())
  }, [])

  // ---- store -> native: load / play / pause / seek / rate / volume ----
  useEffect(() => {
    const sync = () => {
      if (!Native) return
      const s = getState()
      const np = s.nowPlaying

      if (!np) {
        if (loadedKey.current !== null) {
          Native.stop()
          loadedKey.current = null
        }
        return
      }

      // (Re)load when the track changes.
      const key = `${np.itemId}:${np.sessionId}`
      if (key !== loadedKey.current) {
        loadedKey.current = key
        lastPlaying.current = null
        lastRate.current = null
        lastVolume.current = null
        Native.load(
          np.url,
          np.startPosition,
          np.title,
          np.author,
          np.artworkUrl ?? '',
          JSON.stringify(np.chapters ?? [])
        )
      }

      if (s.seekTo !== null) {
        Native.seekTo(s.seekTo)
        clearSeek()
        // Open a window where the onState handler treats native play/pause as a
        // seek transient and corrects it back to our intent (see above).
        seekingUntil.current = Date.now() + 1500
      }
      if (s.isPlaying !== lastPlaying.current) {
        lastPlaying.current = s.isPlaying
        if (s.isPlaying) Native.play()
        else Native.pause()
      }
      if (s.rate !== lastRate.current) {
        lastRate.current = s.rate
        Native.setRate(s.rate)
      }
      if (s.volume !== lastVolume.current) {
        lastVolume.current = s.volume
        Native.setVolume(s.volume)
      }
    }

    sync()
    return subscribe(sync)
  }, [])

  // Renders nothing; the audio lives entirely in the native service.
  return null
}

// Re-exported so the notification/remote control handlers (registered by the
// host) can drive the same store the car uses.
export { togglePlay, jumpBy }
