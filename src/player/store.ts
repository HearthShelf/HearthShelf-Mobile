/**
 * Player state shared by the phone UI, the persistent <Video> host, and the
 * Android Auto / CarPlay car screens.
 *
 * react-native-video is a COMPONENT, not an imperative service, so the engine is
 * a mounted <Video> driven by this state (see PlayerHost.tsx). Everything else -
 * the home screen reads here and calls the commands. (The car surface is a
 * native MediaLibraryService with its own player, so it doesn't use this store.)
 *
 * Plain subscribe/snapshot store so it's usable from React (useSyncExternalStore)
 * and from non-React car callbacks alike, with no extra dependency.
 */

export interface NowPlaying {
  itemId: string
  /** ABS play-session id (for progress sync / close). */
  sessionId: string
  title: string
  author: string
  artworkUrl?: string
  /** Token-bearing absolute stream URL fed to <Video>. */
  url: string
  duration: number
  /** Where to start playback (seconds) - ABS resume position. */
  startPosition: number
}

export interface PlayerState {
  nowPlaying: NowPlaying | null
  isPlaying: boolean
  /** Current position in seconds (driven by <Video> onProgress). */
  position: number
  /** A seek request the <Video> host should honor once, then clear. */
  seekTo: number | null
}

let state: PlayerState = {
  nowPlaying: null,
  isPlaying: false,
  position: 0,
  seekTo: null,
}

const listeners = new Set<() => void>()

export function getState(): PlayerState {
  return state
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

// ---- commands (called from phone UI and car callbacks) ----

export function loadTrack(track: NowPlaying): void {
  set({
    nowPlaying: track,
    isPlaying: true,
    position: track.startPosition,
    seekTo: null,
  })
}

export function setPlaying(isPlaying: boolean): void {
  if (state.nowPlaying) set({ isPlaying })
}

export function togglePlay(): void {
  if (state.nowPlaying) set({ isPlaying: !state.isPlaying })
}

export function requestSeek(seconds: number): void {
  if (state.nowPlaying) set({ seekTo: Math.max(0, seconds) })
}

export function jumpBy(delta: number): void {
  if (!state.nowPlaying) return
  requestSeek(state.position + delta)
}

/** Called by the <Video> host on each progress tick. */
export function reportPosition(position: number): void {
  if (state.position !== position) set({ position })
}

/** Called by the host once it has applied a seek. */
export function clearSeek(): void {
  if (state.seekTo !== null) set({ seekTo: null })
}

export function clearTrack(): void {
  set({ nowPlaying: null, isPlaying: false, position: 0, seekTo: null })
}
