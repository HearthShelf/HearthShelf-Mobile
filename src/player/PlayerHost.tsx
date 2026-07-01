/**
 * The persistent audio engine: a single <Video> element (audio-only) mounted
 * once at the app root and never unmounted. It renders nothing visible; it just
 * plays whatever the player store says and reports progress back.
 *
 * Background playback + lock-screen / Android Auto / CarPlay transport come from
 * react-native-video's MediaSession integration, enabled via the source
 * `metadata` (title/artist/artwork) and the `showNotificationControls` prop.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import Video, { type VideoRef } from 'react-native-video'
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

export function PlayerHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const ref = useRef<VideoRef>(null)
  const { nowPlaying, isPlaying, seekTo, rate, volume } = state

  // Honor one-shot seek requests from the store (skip buttons, scrubbing).
  useEffect(() => {
    if (seekTo !== null && ref.current) {
      ref.current.seek(seekTo)
      clearSeek()
    }
  }, [seekTo])

  if (!nowPlaying) return null

  return (
    <Video
      ref={ref}
      source={{
        uri: nowPlaying.url,
        startPosition: Math.round(nowPlaying.startPosition * 1000),
        metadata: {
          title: nowPlaying.title,
          artist: nowPlaying.author,
          imageUri: nowPlaying.artworkUrl,
        },
      }}
      paused={!isPlaying}
      rate={rate}
      volume={volume}
      playInBackground
      playWhenInactive
      showNotificationControls
      progressUpdateInterval={1000}
      // Lock-screen / car transport events route back into the store.
      onProgress={(e) => {
        reportPosition(e.currentTime)
        syncProgress(e.currentTime)
      }}
      onPlaybackStateChanged={(e) => setPlaying(e.isPlaying)}
      style={{ width: 0, height: 0 }}
    />
  )
}

// Re-exported so the notification/remote control handlers (registered by the
// host) can drive the same store the car uses.
export { togglePlay, jumpBy }
