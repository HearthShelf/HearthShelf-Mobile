/**
 * ABS API client for the spike.
 *
 * Unlike the web app (which proxies everything through /abs-api on its own
 * origin), the mobile client talks DIRECTLY to the connected server's origin
 * with the per-user ABS token. JSON calls use `Authorization: Bearer`; media
 * URLs (audio stream) carry the token as a `?token=` query param because native
 * players can't set headers - same convention ABS uses.
 *
 * Covers and author images are the exception: ABS serves those two routes
 * unauthenticated, so they get token-free URLs to keep the native image cache
 * from being invalidated every time the token rotates. See coverUrl().
 */
import { Platform } from 'react-native'
import { getSession } from './session'
import type {
  ABSLibrariesResponse,
  ABSLibrary,
  ABSLibraryItemsResponse,
  ABSShelf,
  ABSItemsInProgressResponse,
  ABSLibraryItem,
  ABSLibraryItemDetail,
  ABSChapter,
  ABSPlaybackSession,
  ABSSearchResponse,
  ABSListeningStats,
  HSListeningStats,
  HSStatsHistory,
  ABSSeries,
  ABSSeriesResponse,
  ABSLibraryAuthor,
  ABSAuthorsResponse,
  ABSNarrator,
  ABSNarratorsResponse,
  ABSAuthorDetail,
  ABSMeResponse,
  ABSBookmark,
  ABSListeningSessionsResponse,
  ABSListeningSession,
  ABSDeviceInfo,
  ABSCollection,
  ABSCollectionsResponse,
  ABSPlaylist,
  ABSPlaylistsResponse,
} from '@hearthshelf/core'
import { computeListeningStats } from '@hearthshelf/core'
import { setMeId } from './me'

/** A page of library items plus the total count, for infinite scroll. */
export interface LibraryItemsPage {
  results: ABSLibraryItem[]
  total: number
  page: number
  limit: number
}

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

/** An ABS request that reached the server but got a non-2xx status. Carries the
 *  HTTP status so callers can branch on it - notably a 404 on a session sync
 *  means the session is gone from ABS's memory (server restarted / it expired),
 *  which needs reopening rather than a blind retry. A network failure throws a
 *  plain Error instead (no `status`), so `err instanceof ABSRequestError` cleanly
 *  separates "server said no" from "couldn't reach server." */
export class ABSRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`abs_request_failed ${status} ${path}`)
    this.name = 'ABSRequestError'
  }
}

/** How long an ABS call waits before we treat the server as unreachable.
 *
 *  Without this, `fetch` inherits the platform socket timeout (a minute or more
 *  on Android), so every offline-mode fallback that's written as
 *  try-server-then-use-local stalls for that whole window before the local path
 *  runs: a resume tap or a book-detail open looks dead, then fires late. The
 *  server is on the LAN or a quick hop away, so anything past a few seconds is
 *  already a failure, not slowness. */
const ABS_TIMEOUT_MS = 6000

/**
 * Re-establish the ABS session (re-mint a grant, redeem it, setSession).
 * Registered by ConnectionProvider so this module doesn't have to import it -
 * that would be a cycle, and this file is also loaded by the headless car service.
 *
 * Resolves true when a NEW token is in place, false when it couldn't be refreshed.
 */
type Reconnect = () => Promise<boolean>
let reconnectHandler: Reconnect | null = null

export function setAbsReconnectHandler(fn: Reconnect | null): void {
  reconnectHandler = fn
}

/** Serialize refreshes: a burst of 401s must trigger ONE reconnect, not N. */
let inFlightRefresh: Promise<boolean> | null = null

function refreshSession(): Promise<boolean> {
  if (!reconnectHandler) return Promise.resolve(false)
  if (!inFlightRefresh) {
    inFlightRefresh = reconnectHandler()
      .catch(() => false)
      .finally(() => {
        inFlightRefresh = null
      })
  }
  return inFlightRefresh
}

async function absRequest<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const { serverUrl, token } = requireSession()
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')

  // Respect a caller-supplied signal (in-flight cancellation) while still
  // enforcing our own deadline.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ABS_TIMEOUT_MS)
  const onCallerAbort = () => controller.abort()
  init?.signal?.addEventListener('abort', onCallerAbort)

  let res: Response
  try {
    res = await fetch(`${serverUrl}${path}`, { ...init, headers, signal: controller.signal })
  } catch {
    // An abort (our timeout) reads the same as a network failure to callers:
    // a plain Error with no `status`, i.e. "couldn't reach the server", which is
    // what drives the offline/local fallbacks.
    throw new Error(`abs_request_unreachable ${path}`)
  } finally {
    clearTimeout(timer)
    init?.signal?.removeEventListener('abort', onCallerAbort)
  }
  if (!res.ok) {
    // A 401 means our ABS token is no longer accepted - it expired, was revoked,
    // or the server re-minted it. Previously NOTHING handled this: the only status
    // branch in the app was a 404 in playback, so a stale token degraded into
    // opaque request failures until some unrelated reconnect happened to fix it.
    //
    // Refresh once and replay. `isRetry` bounds this to a single attempt, so a
    // server that 401s even a brand-new token surfaces the error instead of
    // looping - which also means an origin that rejects everything (a spoofed or
    // misbehaving endpoint) can never pull us into a re-mint loop that keeps
    // handing out fresh grants.
    if (res.status === 401 && !isRetry) {
      const refreshed = await refreshSession()
      if (refreshed) return absRequest<T>(path, init, true)
    }
    throw new ABSRequestError(res.status, path)
  }
  // Some endpoints (sync/close, progress PATCH) return empty or plain-text
  // bodies on success; a 2xx must never surface as a failure just because the
  // body isn't JSON.
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined as T
  }
}

/** Build an absolute, token-bearing media URL (covers, audio files). Returns ''
 *  when there's no session (e.g. mid server-switch) so callers used during render
 *  - like coverUrl() in a <Cover uri=...> - degrade to their fallback art instead
 *  of throwing not_connected and red-boxing the screen. */
export function mediaUrl(path: string): string {
  const s = getSession()
  if (!s) return ''
  const sep = path.includes('?') ? '&' : '?'
  return `${s.serverUrl}${path}${sep}token=${encodeURIComponent(s.token)}`
}

/**
 * Cover art URL - deliberately WITHOUT a token, unlike every other media URL.
 *
 * ABS whitelists `GET /api/items/:id/cover` (and author images) as
 * unauthenticated: they sit in `Auth.ignorePatterns`, so `ifAuthNeeded` calls
 * next() without ever consulting a credential. Verified against ABS 2.35.1
 * (server/Auth.js).
 *
 * WHY it matters that we leave the token off: the native image loader (Fresco on
 * Android) keys its disk+memory cache on the FULL url. Baking in the rotating ABS
 * token meant that any time the token changed, every cover URI in the app changed
 * with it, orphaning the entire cover cache - so every visible cover was
 * re-downloaded and re-decoded at once. That decode burst is heap pressure we were
 * paying for a query param ABS does not even read here.
 *
 * `?ts` is ABS's own opt-in for a cacheable response (it sets
 * `Cache-Control: private, max-age=86400`), but it takes the item's mtime, which
 * a render-path helper with only an id cannot know. Omitted rather than faked: a
 * wrong/rotating ts value would re-introduce exactly the churn this fixes.
 *
 * Still returns '' with no session so callers degrade to fallback art: the URL
 * needs no token, but the server ORIGIN comes from the session, and a
 * half-built URL against no server is worse than the typeset cover.
 */
export function coverUrl(itemId: string): string {
  const s = getSession()
  if (!s) return ''
  return `${s.serverUrl}/api/items/${encodeURIComponent(itemId)}/cover`
}

/** Tokenized URL to download a set of items as a single zip (bulk download).
 *  '' when disconnected. Opened in the browser/download manager, since native
 *  loaders can't stream a zip inline. */
export function libraryDownloadUrl(libraryId: string, itemIds: string[]): string {
  return mediaUrl(
    `/api/libraries/${encodeURIComponent(libraryId)}/download?ids=${encodeURIComponent(itemIds.join(','))}`,
  )
}

// ---- Library browsing ----

export async function getLibraries(): Promise<ABSLibrary[]> {
  const data = await absRequest<ABSLibrariesResponse>('/api/libraries')
  return data.libraries
}

export async function getLibraryItems(
  libraryId: string,
  page = 0,
  limit = 50,
): Promise<ABSLibraryItem[]> {
  const data = await absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?page=${page}&limit=${limit}&minified=1`,
  )
  return data.results
}

/** Like getLibraryItems but returns the page envelope (total) for infinite scroll. */
export async function getLibraryItemsPage(
  libraryId: string,
  page = 0,
  limit = 50,
): Promise<LibraryItemsPage> {
  const data = await absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?page=${page}&limit=${limit}&minified=1`,
  )
  return { results: data.results, total: data.total, page: data.page, limit: data.limit }
}

export async function getPersonalized(libraryId: string): Promise<ABSShelf[]> {
  return absRequest<ABSShelf[]>(`/api/libraries/${libraryId}/personalized`)
}

// The entire library in one request (limit=0), NOT minified - so items carry the
// full metadata (genres, narrator, series) the taste engine needs. Feeds the
// Home discovery shelves and the car's Discover snapshot.
export async function getAllLibraryItems(libraryId: string): Promise<ABSLibraryItem[]> {
  const data = await absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?limit=0`,
  )
  return data.results
}

// ---- Series / Authors / Narrators (Library view selector) ----

/**
 * Short-lived cache for the full series catalog.
 *
 * getLibrarySeries pages the ENTIRE library's series with their books, and 13
 * call sites reach for it - Home alone calls it twice per load (ignored-series
 * filtering, then Continue-Series). On a large library that is megabytes of JSON
 * per call, repeated on every navigation, which is a large part of why the app
 * drags (HS-MOBILEAPP-13).
 *
 * A few seconds is enough to collapse a burst of callers around one navigation
 * into a single fetch, while staying short enough that a series edit shows up
 * essentially immediately. The in-flight promise is shared too, so concurrent
 * callers (Home's two, or a screen mounting mid-fetch) await one request rather
 * than starting their own.
 *
 * Deliberately NOT a long-lived cache: this data changes when the user edits
 * series membership, and a stale catalog is a correctness problem, not just a
 * cosmetic one.
 */
const SERIES_CACHE_MS = 5000
const seriesCache = new Map<string, { at: number; series: ABSSeries[] }>()
const seriesInFlight = new Map<string, Promise<ABSSeries[]>>()

/** Drop the cached series catalog (all libraries). Call after anything that
 *  changes series membership so the next read is fresh. */
export function invalidateSeriesCache(): void {
  seriesCache.clear()
  seriesInFlight.clear()
}

/** All series in a library, each carrying its books (for the group drilldown).
 *  Served from a few-second cache; see SERIES_CACHE_MS. Prefer
 *  getSeriesWithBooks when you want ONE series. */
export async function getLibrarySeries(libraryId: string): Promise<ABSSeries[]> {
  const hit = seriesCache.get(libraryId)
  if (hit && Date.now() - hit.at < SERIES_CACHE_MS) return hit.series
  const flight = seriesInFlight.get(libraryId)
  if (flight) return flight
  const p = fetchLibrarySeries(libraryId)
    .then((series) => {
      seriesCache.set(libraryId, { at: Date.now(), series })
      return series
    })
    .finally(() => {
      seriesInFlight.delete(libraryId)
    })
  seriesInFlight.set(libraryId, p)
  return p
}

async function fetchLibrarySeries(libraryId: string): Promise<ABSSeries[]> {
  // ABS's series endpoint treats limit=0 as "count only" (returns an empty
  // results[] with the real total), unlike the items endpoint where 0 = all. So
  // page through with an explicit large limit to actually get the series.
  const out: ABSSeries[] = []
  const limit = 500
  for (let page = 0; page < 50; page++) {
    const data = await absRequest<ABSSeriesResponse>(
      `/api/libraries/${libraryId}/series?limit=${limit}&page=${page}`,
    )
    const results = data.results ?? []
    out.push(...results)
    if (results.length < limit) break
  }
  return out
}

/**
 * base64 for the ABS filter param. Series ids are ASCII (uuid-like), so a plain
 * per-char encode is sufficient and avoids a Buffer polyfill; `btoa` is not
 * dependable across Hermes builds, and `atob` (used elsewhere in this app) only
 * covers the decode direction.
 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64Utf8(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i += 3) {
    const c0 = input.charCodeAt(i)
    const c1 = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN
    const c2 = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN
    out += B64_ALPHABET[c0 >> 2]
    out += B64_ALPHABET[((c0 & 3) << 4) | (Number.isNaN(c1) ? 0 : c1 >> 4)]
    out += Number.isNaN(c1)
      ? '='
      : B64_ALPHABET[((c1 & 15) << 2) | (Number.isNaN(c2) ? 0 : c2 >> 6)]
    out += Number.isNaN(c2) ? '=' : B64_ALPHABET[c2 & 63]
  }
  return out
}

/**
 * One series and its books, without downloading the whole series catalog.
 *
 * The series screen used to call getLibrarySeries() and `.find()` the one it
 * wanted - which pages the ENTIRE library's series (up to 50 pages of 500, each
 * carrying its books) to render a single page. On a large library that is
 * megabytes of JSON per tap, and every tap starts another one: series that open
 * only after several taps, some that never open at all, and the whole app
 * dragging while the fetches pile up (HS-MOBILEAPP-10/11/13).
 *
 * ABS filters library items by series directly. The filter value is the series id
 * base64'd (libraryFilters.decode does `Buffer.from(decodeURIComponent(v),
 * 'base64')`), and `sort=sequence` gives reading order server-side. Minified
 * items carry everything the screen renders.
 *
 * Returns null when the series has no items - the caller falls back to the
 * offline catalog, exactly as it did when the find() missed.
 */
export async function getSeriesWithBooks(
  libraryId: string,
  seriesId: string,
): Promise<ABSSeries | null> {
  const filter = `series.${encodeURIComponent(base64Utf8(seriesId))}`
  const data = await absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?filter=${filter}&sort=sequence&limit=500&minified=1`,
  )
  const books = data.results ?? []
  if (!books.length) return null
  // The filtered item list carries no series NAME, so take it from the books'
  // own series metadata (every item in the result belongs to this series).
  const name = books.map((b) => b.media?.metadata?.seriesName).find((n): n is string => !!n) ?? ''
  return {
    id: seriesId,
    name,
    nameIgnorePrefix: name,
    description: null,
    books,
  }
}

export async function getLibraryAuthors(libraryId: string): Promise<ABSLibraryAuthor[]> {
  const data = await absRequest<ABSAuthorsResponse>(`/api/libraries/${libraryId}/authors`)
  return data.authors ?? []
}

/** ABS author photo. Token-free for the same reason as coverUrl - author images
 *  are the other entry in ABS's auth bypass list, and a rotating token in the URL
 *  would re-key the image cache on every reconnect. '' when disconnected; falls
 *  back to initials. */
export function authorImageUrl(authorId: string): string {
  const s = getSession()
  if (!s) return ''
  return `${s.serverUrl}/api/authors/${encodeURIComponent(authorId)}/image`
}

/** HearthShelf's custom narrator photo (NOT ABS - lives at /hs/narrators/:name/image),
 *  keyed by name. Token-free for the same cache-stability reason as coverUrl: the
 *  route's GET is public (server/routes/narrators.js), so a rotating token would
 *  re-key the image cache on every reconnect for nothing. '' when disconnected;
 *  falls back to initials. */
export function narratorImageUrl(name: string): string {
  const s = getSession()
  if (!s) return ''
  return `${s.serverUrl}/hs/narrators/${encodeURIComponent(name)}/image`
}

/** A user's HearthShelf profile photo (NOT ABS - lives at /hs/avatars/:userId).
 *  Public GET (server/routes/avatars.js), so no token - same cache-stability
 *  reason as coverUrl. The session is still required for the origin, and ''
 *  mid server-switch keeps callers on their fallback. 404s to Gravatar or
 *  initials server-side; the client falls back to the Avatar initials on load
 *  failure. */
export function avatarUrl(userId: string): string {
  const s = getSession()
  if (!s) return ''
  return `${s.serverUrl}/hs/avatars/${encodeURIComponent(userId)}`
}

/** An author's books (for the group drilldown) - richer than the library list. */
export async function getAuthorDetail(authorId: string): Promise<ABSAuthorDetail> {
  return absRequest<ABSAuthorDetail>(`/api/authors/${authorId}?include=items`)
}

/**
 * Narrators are derived from item metadata, not first-class ABS records: this
 * endpoint gives a synthetic id + name + book count, but not the books
 * themselves. The narrator -> books drilldown filters the full item list by
 * narratorName client-side (see getLibraryItems + itemNarrator).
 */
export async function getLibraryNarrators(libraryId: string): Promise<ABSNarrator[]> {
  const data = await absRequest<ABSNarratorsResponse>(`/api/libraries/${libraryId}/narrators`)
  return data.narrators ?? []
}

/** Full item detail (NOT minified) - carries media.chapters[] for the chapter list. */
export async function getItemDetail(itemId: string): Promise<ABSLibraryItemDetail> {
  return absRequest<ABSLibraryItemDetail>(`/api/items/${itemId}`)
}

/** Chapters for an item, from the detail endpoint. Empty for single-file books. */
export async function getItemChapters(itemId: string): Promise<ABSChapter[]> {
  const detail = await getItemDetail(itemId)
  return detail.media.chapters ?? []
}

/**
 * Search a library. ABS returns books/series/authors/narrators; we surface the
 * flat list of matched library items (books) for the search screen.
 */
export async function searchLibrary(
  libraryId: string,
  query: string,
  limit = 25,
): Promise<ABSLibraryItem[]> {
  const data = await searchLibraryAll(libraryId, query, limit)
  return (data.book ?? []).map((b) => b.libraryItem)
}

/** Full ABS search response - books plus series/authors/narrators, for the
 *  unified search screen's scoped sections. */
export async function searchLibraryAll(
  libraryId: string,
  query: string,
  limit = 25,
): Promise<ABSSearchResponse> {
  const q = encodeURIComponent(query)
  return absRequest<ABSSearchResponse>(`/api/libraries/${libraryId}/search?q=${q}&limit=${limit}`)
}

/**
 * Find the owned library item for an Audible ASIN, or null when it isn't in the
 * library (yet).
 *
 * Why a search rather than a lookup: ABS exposes no by-ASIN endpoint, and the
 * minified list metadata omits `asin` entirely - only the expanded item read
 * carries it (ABSBookMetadataDetail). ABS's search does index the ASIN, so we
 * query it directly and then CONFIRM against the detail record rather than
 * trusting the hit: a bare ASIN is also a substring that can match a
 * description, and routing someone to the wrong book is worse than leaving them
 * on the upcoming page.
 *
 * Best-effort by design - every failure mode (offline, no libraries, no match)
 * returns null so callers can fall back rather than error.
 */
export async function findOwnedItemByAsin(asin: string): Promise<string | null> {
  const wanted = asin.trim().toLowerCase()
  if (!wanted) return null
  try {
    const libraries = await getLibraries()
    for (const library of libraries) {
      const hits = await searchLibrary(library.id, asin, 5)
      for (const hit of hits) {
        try {
          const detail = await getItemDetail(hit.id)
          if ((detail.media?.metadata?.asin ?? '').trim().toLowerCase() === wanted) return hit.id
        } catch {
          // Skip an item we can't read and try the next hit.
        }
      }
    }
  } catch {
    // Offline or the server refused - the caller falls back to the upcoming page.
  }
  return null
}

export async function getItemsInProgress(): Promise<ABSLibraryItem[]> {
  const data = await absRequest<ABSItemsInProgressResponse>('/api/me/items-in-progress')
  return data.libraryItems
}

/** The caller's full progress list, for the Library screen's In progress/Finished filters. */
export async function getMe(): Promise<ABSMeResponse> {
  const me = await absRequest<ABSMeResponse>('/api/me')
  // Cache the caller's own ABS id so social surfaces can identify their own
  // notes and gate spoilers against their own position (see src/api/me.ts).
  if (me?.id) setMeId(me.id)
  return me
}

/**
 * Mark an item finished or not finished (ABS PATCH /api/me/progress/:id).
 *
 * When finishing, an optional `finishedAt` (epoch ms) backdates completion so it
 * lands in the right bucket for year/listening stats. ABS honors a supplied
 * `finishedAt`; omit it and the server stamps the current time.
 */
export async function setItemFinished(
  itemId: string,
  finished: boolean,
  finishedAt?: number,
): Promise<void> {
  const body: { isFinished: boolean; finishedAt?: number } = { isFinished: finished }
  if (finished && typeof finishedAt === 'number') body.finishedAt = finishedAt
  await absRequest<void>(`/api/me/progress/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/**
 * Reset an item's progress to the very start (ABS PATCH /api/me/progress/:id).
 * Sets currentTime/progress to 0 and clears the finished flag, so the book looks
 * un-started again. Used by the Continue-Listening "Reset progress" action.
 */
export async function resetItemProgress(itemId: string): Promise<void> {
  await absRequest<void>(`/api/me/progress/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ currentTime: 0, progress: 0, isFinished: false }),
  })
}

// ---- Bookmarks ----
// User-scoped, per item. ABS has no per-item bookmark GET, so reads go through
// /api/me (bookmarks[]); create/delete hit the per-item routes.

/** Every bookmark for this user, across all items. Filter to one item by id. */
export async function getBookmarks(): Promise<ABSBookmark[]> {
  const me = await getMe()
  return me.bookmarks ?? []
}

export async function createBookmark(
  libraryItemId: string,
  time: number,
  title: string,
): Promise<ABSBookmark> {
  const b = await absRequest<ABSBookmark | undefined>(`/api/me/item/${libraryItemId}/bookmark`, {
    method: 'POST',
    body: JSON.stringify({ time: Math.round(time), title }),
  })
  return b ?? { libraryItemId, title, time: Math.round(time), createdAt: Date.now() }
}

export async function deleteBookmark(libraryItemId: string, time: number): Promise<void> {
  await absRequest<void>(`/api/me/item/${libraryItemId}/bookmark/${Math.round(time)}`, {
    method: 'DELETE',
  })
}

// ---- Recent listening sessions ----

/** One session, flattened to the fields a list actually renders. ABS's own field
 *  names (libraryItemId/displayTitle/timeListening) leak its API shape into the
 *  UI; normalizing here keeps screens readable and gives one place to absorb a
 *  rename. */
export interface SessionRow {
  id: string
  itemId: string
  title: string
  author: string
  /** Seconds actually listened in this session. */
  seconds: number
  /** Epoch ms the session began - what history groups by. */
  startedAt: number
  device?: ABSDeviceInfo
  /** Carried through unrendered so a correction can re-submit the session
   *  through the local-session ingest, which needs the whole record (see
   *  updateListeningSession - ABS has no session PATCH). */
  duration: number
  currentTime: number
  updatedAt: number
}

export function toSessionRow(s: ABSListeningSession): SessionRow {
  return {
    id: s.id,
    itemId: s.libraryItemId,
    title: s.displayTitle,
    author: s.displayAuthor,
    seconds: s.timeListening ?? 0,
    startedAt: s.startedAt,
    device: s.deviceInfo,
    duration: s.duration ?? 0,
    currentTime: s.currentTime ?? 0,
    updatedAt: s.updatedAt ?? s.startedAt,
  }
}

/**
 * A page of listening sessions WITH the server's envelope, which is what an
 * infinite list needs: `total` is the only honest session count (a client can
 * only ever see what it has loaded), and `numPages` is how paging knows it is
 * done.
 *
 * `getRecentSessions` below keeps returning a bare array for the callers that
 * only ever want "the most recent N".
 */
export async function getSessionsPage(
  page = 0,
  itemsPerPage = 25,
): Promise<{ rows: SessionRow[]; total: number; page: number; numPages: number }> {
  const data = await absRequest<ABSListeningSessionsResponse>(
    `/api/me/listening-sessions?page=${page}&itemsPerPage=${itemsPerPage}`,
  )
  return {
    rows: (data.sessions ?? []).map(toSessionRow),
    total: data.total ?? 0,
    page: data.page ?? page,
    numPages: Math.max(1, data.numPages ?? 1),
  }
}

/**
 * Offset-addressed sessions, for the shared paged-list hook.
 *
 * ABS only pages by index, so an offset is translated to the page containing it.
 * The caller always asks from the count of rows it holds, and a page boundary
 * rarely lands there exactly, so the response is trimmed to start at the
 * requested offset - the hook de-dupes any remaining overlap.
 */
export async function getSessionsAtOffset(
  offset = 0,
  limit = 25,
): Promise<{ rows: SessionRow[]; total: number }> {
  const page = Math.floor(offset / limit)
  const res = await getSessionsPage(page, limit)
  const skip = offset - page * limit
  return { rows: skip > 0 ? res.rows.slice(skip) : res.rows, total: res.total }
}

export async function getRecentSessions(itemsPerPage = 100, page = 0) {
  const data = await absRequest<ABSListeningSessionsResponse>(
    `/api/me/listening-sessions?page=${page}&itemsPerPage=${itemsPerPage}`,
  )
  return data.sessions ?? []
}

/** Remove a listening session outright - the fix for a sleep-through that banked
 *  hours you didn't hear. Requires the user's delete permission on the server. */
export async function deleteListeningSession(sessionId: string): Promise<void> {
  await absRequest<void>(`/api/sessions/${sessionId}`, { method: 'DELETE' })
}

/**
 * Correct an existing session's listened-time and/or which day it lands on.
 *
 * There is no session PATCH in ABS. Instead this re-submits the session through
 * the same local-session ingest we use to replay offline listens, keeping the
 * original id so the server updates in place rather than adding a duplicate.
 * Only `timeListening` and the day (re-derived from `updatedAt`) are honored on
 * an existing session, so those are the only fields worth exposing in the UI.
 */
export async function updateListeningSession(session: {
  id: string
  libraryItemId: string
  displayTitle: string
  duration: number
  currentTime: number
  timeListening: number
  startedAt: number
  updatedAt: number
}): Promise<void> {
  await absRequest<void>('/api/session/local', {
    method: 'POST',
    body: JSON.stringify({ ...session, mediaType: 'book' }),
  })
}

// ---- Collections / Playlists (Add to list) ----

// `limit=0` is ABS's "return everything". It is also what you get by OMITTING
// limit - both library controllers build `limit: req.query.limit || 0` and slice
// only `if (payload.limit)` (LibraryController.js:823, 861), so zero is falsy
// and nothing is truncated either way. Passing it is parity with hosted web plus
// insurance against the `// TODO: Create paginated queries` sitting in both
// controllers - not a fix for a bug.
export async function getLibraryCollections(libraryId: string): Promise<ABSCollection[]> {
  const data = await absRequest<ABSCollectionsResponse>(
    `/api/libraries/${libraryId}/collections?limit=0`,
  )
  return data.results ?? []
}

export async function getLibraryPlaylists(libraryId: string): Promise<ABSPlaylist[]> {
  const data = await absRequest<ABSPlaylistsResponse>(
    `/api/libraries/${libraryId}/playlists?limit=0`,
  )
  return data.results ?? []
}

// ---- Collections / Playlists (browse + maintain) ----
//
// BODY-SHAPE ASYMMETRY, and an easy thing to mis-port. ABS is not consistent
// between the two kinds or between their single and batch routes:
//
//   collection add single -> { id: libraryItemId }
//   collection add batch  -> { books: [libraryItemId] }
//   playlist   add single -> { libraryItemId }
//   playlist   add batch  -> { items: [{ libraryItemId }] }
//
// Removal differs again, and is path-based rather than body-based:
//
//   collection remove -> DELETE /collections/:id/book/:libraryItemId
//                        (:bookId in ABS's route, but it looks the LIBRARY ITEM
//                        up and resolves mediaId itself - CollectionController
//                        removeBook)
//   playlist   remove -> DELETE /playlists/:id/item/:libraryItemId[/:episodeId]
//
// PERMISSIONS also differ. Collections are library-wide, so ABS gates them:
// PATCH/POST need canUpdate and DELETE needs canDelete
// (CollectionController.js:447-453). Playlists are private and gated only on
// ownership (PlaylistController.js:581) - no permission flags at all.

export async function getCollection(collectionId: string): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}`)
}

export async function updateCollection(
  collectionId: string,
  patch: { name?: string; description?: string },
): Promise<ABSCollection> {
  return absRequest<ABSCollection>(`/api/collections/${collectionId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function deleteCollection(collectionId: string): Promise<void> {
  await absRequest<void>(`/api/collections/${collectionId}`, { method: 'DELETE' })
}

/** Take a book out of a collection. The book itself stays in the library. */
export async function removeBookFromCollection(
  collectionId: string,
  libraryItemId: string,
): Promise<void> {
  await absRequest<void>(`/api/collections/${collectionId}/book/${libraryItemId}`, {
    method: 'DELETE',
  })
}

export async function getPlaylist(playlistId: string): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`)
}

export async function updatePlaylist(
  playlistId: string,
  patch: { name?: string; description?: string },
): Promise<ABSPlaylist> {
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  await absRequest<void>(`/api/playlists/${playlistId}`, { method: 'DELETE' })
}

/**
 * Take an item out of a playlist. `episodeId` addresses a specific episode; ABS
 * matches on it directly when given and falls back to the library item
 * otherwise, so a podcast contributing several episodes needs it to remove the
 * right one.
 *
 * NOTE: ABS DELETES THE WHOLE PLAYLIST when its last item is removed
 * (PlaylistController.removeItem - "has no more items - removing it"). The
 * response is the removed playlist rather than an empty one, so callers must
 * expect to leave the detail screen rather than render an empty list.
 */
export async function removeItemFromPlaylist(
  playlistId: string,
  libraryItemId: string,
  episodeId?: string,
): Promise<ABSPlaylist> {
  const suffix = episodeId ? `/${episodeId}` : ''
  return absRequest<ABSPlaylist>(`/api/playlists/${playlistId}/item/${libraryItemId}${suffix}`, {
    method: 'DELETE',
  })
}

/** Create a collection. ABS requires at least one book id, and returns the new
 *  record so callers can navigate straight to it. */
export async function createCollection(
  libraryId: string,
  name: string,
  books: string[],
): Promise<{ id: string }> {
  const made = await absRequest<{ id: string }>('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, books }),
  })
  return { id: made?.id ?? '' }
}

export async function addBookToCollection(
  collectionId: string,
  libraryItemId: string,
): Promise<void> {
  await absRequest<void>(`/api/collections/${collectionId}/book`, {
    method: 'POST',
    body: JSON.stringify({ id: libraryItemId }),
  })
}

/** Create a playlist, returning the new record so callers can navigate to it. */
export async function createPlaylist(
  libraryId: string,
  name: string,
  items: { libraryItemId: string }[],
): Promise<{ id: string }> {
  const made = await absRequest<{ id: string }>('/api/playlists', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, items }),
  })
  return { id: made?.id ?? '' }
}

export async function addItemToPlaylist(playlistId: string, libraryItemId: string): Promise<void> {
  await absRequest<void>(`/api/playlists/${playlistId}/item`, {
    method: 'POST',
    body: JSON.stringify({ libraryItemId }),
  })
}

/** Add several books to a collection at once (ABS batch route). */
export async function addBooksToCollection(
  collectionId: string,
  libraryItemIds: string[],
): Promise<void> {
  await absRequest<void>(`/api/collections/${collectionId}/batch/add`, {
    method: 'POST',
    body: JSON.stringify({ books: libraryItemIds }),
  })
}

/** Add several items to a playlist at once (ABS batch route). */
export async function addItemsToPlaylist(
  playlistId: string,
  libraryItemIds: string[],
): Promise<void> {
  await absRequest<void>(`/api/playlists/${playlistId}/batch/add`, {
    method: 'POST',
    body: JSON.stringify({ items: libraryItemIds.map((libraryItemId) => ({ libraryItemId })) }),
  })
}

// ---- Listening stats ----

/**
 * The caller's listening stats (streak, this-week, active days, most-listened),
 * computed server-side by /hs/stats so mobile and web all agree. The server
 * lives on the same origin as ABS (it already fronts /hs/hosted/connect), so we
 * hit it with the same ABS bearer token and pass our local tz offset for
 * caller-local day bucketing.
 *
 * Falls back to reading raw ABS /api/me/listening-stats and computing locally
 * (via the same core helper) when the server predates /hs/stats - detected by a
 * 404 - so the app still works against an older HearthShelf server.
 */
export async function getHSStats(): Promise<HSListeningStats> {
  const { serverUrl, token } = requireSession()
  const tz = new Date().getTimezoneOffset()
  const res = await fetch(`${serverUrl}/hs/stats?tz=${tz}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) {
    return (await res.json()) as HSListeningStats
  }
  if (res.status === 404) {
    // Older server without /hs/stats: compute from raw ABS stats client-side.
    const raw = await absRequest<ABSListeningStats>('/api/me/listening-stats')
    return computeListeningStats(raw, new Date())
  }
  throw new Error(`hs_stats_failed ${res.status}`)
}

const HISTORY_UNAVAILABLE: HSStatsHistory = { available: false, days: [], months: [] }

/**
 * Durable daily listening history (`GET /hs/stats/history?range=`), the nightly
 * snapshot job's output. Unlike ABS's trailing window this survives ABS
 * restarts/re-scans and grows for every day since the job started - the source
 * for the full-year heatmap and the by-month averages. Degrades to an
 * unavailable/empty shape on ANY failure (network, 404 on an older server, or
 * the server's own available:false) so the Stats screen just hides those
 * snapshot-dependent sections instead of erroring.
 */
export async function getStatsHistory(
  range: 'week' | 'month' | 'year' | 'all' = 'year',
): Promise<HSStatsHistory> {
  const session = getSession()
  if (!session) return HISTORY_UNAVAILABLE
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/stats/history?range=${encodeURIComponent(range)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return HISTORY_UNAVAILABLE
    const data = (await res.json()) as HSStatsHistory
    if (!data || data.available !== true) return HISTORY_UNAVAILABLE
    return { available: true, days: data.days ?? [], months: data.months ?? [] }
  } catch {
    return HISTORY_UNAVAILABLE
  }
}

// ---- Playback ----

/** Device info sent with every session we open. The platform is baked into both
 *  deviceId and osName so Recent Listens can tell an Apple phone apart from an
 *  Android one (the server can't infer it - our client sends no User-Agent).
 *
 *  `purpose` splits the deviceId for sessions that are NOT the user listening.
 *  ABS's PlaybackSessionManager.startSession() force-closes every existing
 *  session matching (userId, deviceId) before opening a new one - so a session
 *  opened under the listening deviceId while playback is live kills that
 *  playback server-side, with syncData=null (no final position sync). Giving
 *  non-listening sessions their own deviceId makes that filter miss.
 *
 *  Keep any suffix free of the substring "auto" - classifyDevice() matches that
 *  first and would file the session under Android Auto in Recent Listens. */
function mobileDeviceInfo(purpose?: 'download') {
  const isApple = Platform.OS === 'ios'
  const base = isApple ? 'hearthshelf-mobile-ios' : 'hearthshelf-mobile-android'
  return {
    deviceId: purpose ? `${base}-${purpose}` : base,
    clientName: 'HearthShelf Mobile',
    osName: isApple ? 'iOS' : 'Android',
    clientVersion: '0.0.1',
  }
}

/**
 * Open an ABS playback session.
 *
 * `purpose: 'download'` marks a session opened only to enumerate a book's tracks
 * for offline download - not a listen. It gets its own deviceId so it can't
 * evict the user's live listening session (see mobileDeviceInfo).
 */
export async function startPlay(itemId: string, purpose?: 'download'): Promise<ABSPlaybackSession> {
  return absRequest<ABSPlaybackSession>(`/api/items/${itemId}/play`, {
    method: 'POST',
    body: JSON.stringify({
      deviceInfo: mobileDeviceInfo(purpose),
      supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg'],
    }),
  })
}

export interface SyncPayload {
  currentTime: number
  timeListened: number
  duration: number
}

export async function syncSession(sessionId: string, payload: SyncPayload): Promise<void> {
  await absRequest<void>(`/api/session/${sessionId}/sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function closeSession(sessionId: string, payload: SyncPayload): Promise<void> {
  await absRequest<void>(`/api/session/${sessionId}/close`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** A playback session recorded locally (offline) to replay to ABS on reconnect.
 *  ABS fills in library/book/duration/metadata server-side from libraryItemId,
 *  so only these fields are required. It honors the client timeListening and
 *  updatedAt, so a fully-offline listen is credited with the right time + date. */
export interface LocalSession {
  id: string
  libraryItemId: string
  mediaType: 'book'
  displayTitle: string
  duration: number
  currentTime: number
  timeListening: number
  /** ms epoch. */
  startedAt: number
  /** ms epoch. */
  updatedAt: number
}

/** Replay locally-recorded sessions to ABS (POST /api/session/local-all). Each
 *  is ingested as a real playback session, so offline listening lands in recent
 *  listens and stats with its true listened-time. */
export async function syncLocalSessions(sessions: LocalSession[]): Promise<void> {
  await absRequest<void>('/api/session/local-all', {
    method: 'POST',
    body: JSON.stringify({
      deviceInfo: mobileDeviceInfo(),
      sessions,
    }),
  })
}

/** Replay ONE locally-recorded session. Same endpoint, batch of one.
 *
 *  ABS rejects or accepts the whole /local-all batch, so a single bad record (a
 *  deleted library item, a zero duration) fails every good session banked
 *  alongside it - forever, since a failed flush clears nothing. The pending-store
 *  flush falls back to this on a server REJECTION so the good ones land and only
 *  the genuinely-bad record stays behind. */
export async function syncLocalSession(session: LocalSession): Promise<void> {
  await syncLocalSessions([session])
}

/** Title/author helpers tolerant of ABS's nullable metadata. */
export function itemTitle(item: ABSLibraryItem): string {
  return item.media.metadata.title || 'Untitled'
}

export function itemAuthor(item: ABSLibraryItem): string {
  return item.media.metadata.authorName || 'Unknown author'
}

/** Raw narrator credit string ("Name A, Name B"), empty when uncredited. */
export function itemNarrator(item: ABSLibraryItem): string {
  return item.media.metadata.narratorName || ''
}
