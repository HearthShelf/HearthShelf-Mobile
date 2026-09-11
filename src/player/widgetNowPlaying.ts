/**
 * Keeps the home-screen widget's `nowPlaying` prefs record in step with the
 * player.
 *
 * Why this file exists: the widget runs in the LAUNCHER's process. There is no
 * React there, no bridge, and no network - so it can only draw what it finds in
 * SharedPreferences. Nothing in the app wrote "what is playing right now" in a
 * form native code could read: the home hero derives from getItemsInProgress(),
 * a network call, and the car's offlineLibrary snapshot covers only completed
 * downloads and is gated on car mode. This is that missing record.
 *
 * Subscribes to the player store rather than being called from each transport
 * site, so nothing can move the playhead without the widget hearing about it.
 *
 * Throttled on position: the store ticks about once a second, and a widget
 * repaint crosses a Binder and re-renders in another process. A progress bar
 * measured in hours does not need per-second fidelity - but play/pause and book
 * changes are pushed IMMEDIATELY, because those are the ones a listener sees and
 * expects to be instant.
 */
import { Platform } from 'react-native'
import { getState, subscribe } from './store'
import { localCoverFor } from './downloads'
import { setAutoNowPlaying, setAutoWidgetQueue, type WidgetNowPlaying } from './autoBridge'
import { getQueueState, subscribeQueue } from './queue'

/** How far the playhead must move before a repaint is worth a cross-process
 *  hop. The bar is ~250px wide over a book of many hours, so anything finer is
 *  invisible. */
const POSITION_STEP_SEC = 20

let lastKey = ''
let lastPositionSec = 0

function snapshot(): WidgetNowPlaying | null {
  const s = getState()
  const np = s.nowPlaying
  if (!np) return null
  return {
    itemId: np.itemId,
    title: np.title,
    author: np.author,
    // Downloaded books only: RemoteViews cannot fetch a network image, so a
    // streaming book gets the placeholder tile rather than a broken one.
    cover: localCoverFor(np.itemId) ?? '',
    position: Math.max(0, Math.round(s.position)),
    duration: Math.max(0, Math.round(np.duration)),
    isPlaying: s.isPlaying,
  }
}

function publish(): void {
  const next = snapshot()
  if (!next) {
    // Nothing loaded. Push once so the widget can show its ready state instead
    // of a stale book, then go quiet.
    if (lastKey !== '') {
      lastKey = ''
      lastPositionSec = 0
      setAutoNowPlaying(null)
    }
    return
  }
  // Everything except position; a change in any of these is user-visible at once.
  const key = `${next.itemId}|${next.title}|${next.author}|${next.cover}|${next.duration}|${next.isPlaying}`
  const moved = Math.abs(next.position - lastPositionSec) >= POSITION_STEP_SEC
  if (key === lastKey && !moved) return
  lastKey = key
  lastPositionSec = next.position
  setAutoNowPlaying(next)
}

let lastQueueKey = ''

/** Mirror the first few up-next titles; the tall layout draws at most three. */
function publishQueue(): void {
  const titles = getQueueState()
    .items.slice(0, 3)
    .map((i) => i.title)
    .filter((t): t is string => !!t)
  const key = titles.join('|')
  if (key === lastQueueKey) return
  lastQueueKey = key
  setAutoWidgetQueue(titles)
}

/**
 * Start mirroring the player into the widget record. Idempotent; returns an
 * unsubscribe for symmetry with the other player subscriptions.
 *
 * Android only - the widget is an Android surface, and the bridge no-ops
 * elsewhere anyway.
 */
export function startWidgetNowPlaying(): () => void {
  if (Platform.OS !== 'android') return () => {}
  // Publish once at startup: after a reboot the launcher may draw the widget
  // before anything in the player has changed, and a record written last run is
  // exactly what it should show.
  publish()
  publishQueue()
  const unsubPlayer = subscribe(publish)
  const unsubQueue = subscribeQueue(publishQueue)
  return () => {
    unsubPlayer()
    unsubQueue()
  }
}
