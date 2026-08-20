/**
 * Lock/unlock + session lifecycle tracing.
 *
 * Exists to diagnose two field reports that are probably one bug:
 *   1. Progress resets after locking the phone, waiting, and unlocking.
 *   2. An overnight listen arrives in ABS as ~15-minute segments instead of one
 *      session.
 *
 * Neither reproduces on demand, and the interesting window is exactly when the
 * screen is off and nobody can watch a debugger. So the app records the shape of
 * that window into the crash-log breadcrumb ring, which the in-app feedback
 * form uploads.
 *
 * What each crumb answers:
 *   - `background`/`foreground`: how long the screen was off, and where the
 *     playhead sat on each side of it. A position that moves BACKWARDS across
 *     the gap is the reset, captured directly rather than inferred.
 *   - the paired `session`/`progress` crumbs (playback.ts, progress.ts) then say
 *     WHICH mechanism moved it: a 404 reopen chain, or a refresh that declined
 *     to keep the local row.
 *
 * Tracing only - it must never alter playback. Everything here is read-only
 * against the player store.
 */
import { AppState, type AppStateStatus } from 'react-native'
import { breadcrumb } from '@/lib/crashLog'
import { getState } from './store'

let sub: { remove: () => void } | null = null
let leftAt: number | null = null
let leftPosition: number | null = null

function snapshot(): { pos: number; item: string; playing: boolean; car: boolean } {
  const s = getState()
  return {
    pos: Math.round(s.position ?? 0),
    item: s.nowPlaying?.itemId?.slice(0, 8) ?? 'none',
    playing: s.isPlaying,
    // The car runs its own ABS session and gates JS sync, so a handback can look
    // like a rewind for reasons unrelated to this bug. Recorded to rule it out.
    car: s.carActive,
  }
}

function onChange(next: AppStateStatus): void {
  // 'inactive' is a transient iOS state (and fires on Android for some system
  // dialogs); only the settled states are worth a crumb.
  if (next === 'background') {
    const { pos, item, playing, car } = snapshot()
    leftAt = Date.now()
    leftPosition = pos
    breadcrumb('lifecycle', `background @${pos}s item=${item} playing=${playing} car=${car}`)
    return
  }
  if (next !== 'active') return

  const { pos, item, playing, car } = snapshot()
  if (leftAt === null) {
    breadcrumb('lifecycle', `foreground @${pos}s item=${item} playing=${playing} car=${car}`)
    return
  }
  const awaySec = Math.round((Date.now() - leftAt) / 1000)
  const delta = leftPosition === null ? null : pos - leftPosition
  // A backwards jump across a background window IS the reported bug, so call it
  // out explicitly rather than leaving it to be spotted in the arithmetic.
  const move =
    delta === null
      ? ''
      : delta < -5
        ? ` REWOUND ${Math.abs(delta)}s`
        : ` moved ${delta >= 0 ? '+' : ''}${delta}s`
  breadcrumb(
    'lifecycle',
    `foreground after ${awaySec}s away @${pos}s (was ${leftPosition ?? '?'}s)${move} item=${item} playing=${playing} car=${car}`,
  )
  leftAt = null
  leftPosition = null
}

/** Mount once from the root layout. Returns an unsubscribe for symmetry with the
 *  other mount* helpers. */
export function mountLifecycleTrace(): () => void {
  if (sub) return () => {}
  sub = AppState.addEventListener('change', onChange)
  return () => {
    sub?.remove()
    sub = null
    leftAt = null
    leftPosition = null
  }
}
