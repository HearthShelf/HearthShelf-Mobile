/**
 * The app's paginated-list primitive.
 *
 * History is the first screen here to page a list at all - everything else loads
 * one page or fetches the lot with `limit=0` - and both of its views need the
 * same machinery, so it lives here rather than twice in one file.
 *
 * Two things it gets right that a naive version does not:
 *
 * 1. The next fetch is anchored on HOW MANY ROWS ARE HELD, not on a page
 *    counter. Removing a row shifts every later row one place toward the front,
 *    so a counter steps straight over whatever crossed the page boundary -
 *    silently, and de-duping cannot recover a row that was never served.
 *    Re-requesting from the loaded count overlaps what we already have, and the
 *    overlap is de-duped.
 *
 * 2. `onEndReached` fires repeatedly while a finger keeps moving, so the fetch
 *    is guarded by a ref rather than by state (which lands a render too late).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface PagedResult<T> {
  rows: T[]
  /** The server's own count of everything available. The only honest total. */
  total: number
  /** False when the backend cannot serve this data at all, as distinct from
   *  having none of it. Omit for sources that are always available. */
  available?: boolean
}

export interface PagedList<T> {
  rows: T[]
  total: number
  /** True until the first fetch settles - the screen shows a skeleton. */
  firstLoad: boolean
  /** True while a subsequent page is in flight - only the footer changes. */
  loadingMore: boolean
  error: string | null
  /** True once every row the server has is held. */
  atEnd: boolean
  /** False only when the backend reported it cannot serve this data. */
  available: boolean
  onEndReached: () => void
  reload: () => void
  /** Remove a row locally (optimistic delete), keeping the paging anchor and
   *  total in step. Returns a restore function for rolling back on failure. */
  removeRow: (predicate: (row: T) => boolean) => () => void
  /** Replace a row in place (optimistic edit). Row count is unchanged, so the
   *  paging anchor and total stay as they are. */
  patchRow: (predicate: (row: T) => boolean, update: (row: T) => T) => void
}

export function usePagedList<T>(
  fetchPage: (offset: number, limit: number) => Promise<PagedResult<T>>,
  {
    pageSize = 25,
    keyOf,
    errorMessage = 'Could not load that.',
  }: {
    pageSize?: number
    /** Stable identity per row, used to drop overlap between pages. */
    keyOf: (row: T) => string
    errorMessage?: string
  },
): PagedList<T> {
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [available, setAvailable] = useState(true)
  const [firstLoad, setFirstLoad] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inFlight = useRef(false)
  const loadedCount = useRef(0)
  // Read through refs so `load` never has to be rebuilt, which would re-arm
  // onEndReached on every append.
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const keyRef = useRef(keyOf)
  keyRef.current = keyOf

  const load = useCallback(
    async (replace: boolean) => {
      if (inFlight.current) return
      inFlight.current = true
      if (!replace) setLoadingMore(true)
      try {
        const offset = replace ? 0 : loadedCount.current
        const res = await fetchRef.current(offset, pageSize)
        setTotal(res.total)
        setAvailable(res.available !== false)
        setRows((prev) => {
          const merged = replace
            ? res.rows
            : (() => {
                const seen = new Set(prev.map(keyRef.current))
                return [...prev, ...res.rows.filter((r) => !seen.has(keyRef.current(r)))]
              })()
          loadedCount.current = merged.length
          return merged
        })
        setError(null)
      } catch {
        setError(errorMessage)
      } finally {
        inFlight.current = false
        setLoadingMore(false)
        setFirstLoad(false)
      }
    },
    [pageSize, errorMessage],
  )

  useEffect(() => {
    void load(true)
  }, [load])

  const atEnd = rows.length >= total

  const onEndReached = useCallback(() => {
    if (firstLoad || loadingMore || atEnd || error || !available) return
    void load(false)
  }, [firstLoad, loadingMore, atEnd, error, available, load])

  const reload = useCallback(() => {
    loadedCount.current = 0
    setFirstLoad(true)
    void load(true)
  }, [load])

  const removeRow = useCallback((predicate: (row: T) => boolean) => {
    let snapshot: T[] = []
    let snapshotTotal = 0
    setRows((prev) => {
      snapshot = prev
      const next = prev.filter((r) => !predicate(r))
      loadedCount.current = next.length
      return next
    })
    setTotal((t) => {
      snapshotTotal = t
      return Math.max(0, t - 1)
    })
    return () => {
      setRows(snapshot)
      loadedCount.current = snapshot.length
      setTotal(snapshotTotal)
    }
  }, [])

  const patchRow = useCallback((predicate: (row: T) => boolean, update: (row: T) => T) => {
    setRows((prev) => prev.map((r) => (predicate(r) ? update(r) : r)))
  }, [])

  return {
    rows,
    total,
    firstLoad,
    loadingMore,
    error,
    atEnd,
    available,
    onEndReached,
    reload,
    removeRow,
    patchRow,
  }
}
