/**
 * Resolving followed series into their rosters, shared by every surface that
 * needs to know what the NEXT book in a followed series is.
 *
 * A series subscription carries no release date of its own - only its roster
 * does - so any "what am I waiting on?" surface has to resolve the roster before
 * Core's pendingReleases() can flatten series follows in alongside directly
 * followed books. Following and the Home countdown banner both need exactly
 * this, so it lives here rather than being private to either screen.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  nextSeriesBook,
  type HSAudibleSeriesBook,
  type HSAudibleSeriesResponse,
  type HSSubscription,
} from '@hearthshelf/core'
import { fetchAudibleSeriesByAsin, fetchAudibleSeries } from '@/api/absAudible'

export type SeriesRosterMap = Record<string, HSAudibleSeriesResponse | null | undefined>

/** Resolve one followed series. Two lookups are deliberate: an older server
 *  ignores ?seriesAsin= and answers empty, so fall back to the by-name endpoint
 *  but only keep a roster whose ASIN really matches this follow. */
export async function fetchSeriesRoster(
  sub: HSSubscription,
): Promise<HSAudibleSeriesResponse | null> {
  if (!sub.seriesAsin) return null
  let roster = await fetchAudibleSeriesByAsin(sub.seriesAsin)
  const title = sub.seriesTitle ?? sub.title
  if (!roster.seriesAsin && title) {
    const byName = await fetchAudibleSeries(title)
    if (byName.seriesAsin === sub.seriesAsin) roster = byName
  }
  return roster.seriesAsin ? roster : null
}

/** Resolve every followed series in one stable effect so a screen can build ONE
 *  upcoming-release list from direct book follows plus series follows. A roster
 *  stays undefined while loading and becomes null only when resolution really
 *  failed, which keeps a series card's status truthful.
 *
 *  The effect keys off the subscription ids rather than the array identity, so
 *  a caller that rebuilds its filtered list each render does not refetch every
 *  roster on every render. */
export function useSeriesRosters(series: HSSubscription[]): SeriesRosterMap {
  const [rosters, setRosters] = useState<SeriesRosterMap>({})
  const key = series.map((s) => s.id).join(',')

  useEffect(() => {
    let alive = true
    if (series.length === 0) {
      setRosters({})
      return () => {
        alive = false
      }
    }

    void Promise.all(
      series.map(async (sub) => {
        try {
          return [sub.id, await fetchSeriesRoster(sub)] as const
        } catch {
          return [sub.id, null] as const
        }
      }),
    ).then((entries) => {
      if (alive) setRosters(Object.fromEntries(entries))
    })

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return rosters
}

/**
 * The map Core's pendingReleases() expects: followed-series ASIN -> the next
 * book to expect in it, or null when the roster failed or has nothing left.
 * Ignored books are skipped by nextSeriesBook, so an ignored next book falls
 * through to the one after it rather than blanking the series.
 */
export function useNextBySeriesAsin(
  series: HSSubscription[],
  rosters: SeriesRosterMap,
  ignoredAsins: readonly string[],
  now: number,
): Map<string, HSAudibleSeriesBook | null> {
  return useMemo(() => {
    const out = new Map<string, HSAudibleSeriesBook | null>()
    for (const sub of series) {
      if (!sub.seriesAsin) continue
      const roster = rosters[sub.id]
      out.set(
        sub.seriesAsin,
        roster?.seriesAsin ? nextSeriesBook(roster.books, now, ignoredAsins) : null,
      )
    }
    return out
  }, [series, rosters, ignoredAsins, now])
}
