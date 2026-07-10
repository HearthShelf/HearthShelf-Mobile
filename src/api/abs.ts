/**
 * ABS API client for the spike.
 *
 * Unlike the web app (which proxies everything through /abs-api on its own
 * origin), the mobile client talks DIRECTLY to the connected server's origin
 * with the per-user ABS token. JSON calls use `Authorization: Bearer`; media
 * URLs (cover, audio stream) carry the token as a `?token=` query param because
 * native players/image loaders can't set headers - same convention ABS uses.
 */
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

async function absRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { serverUrl, token } = requireSession()
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')

  const res = await fetch(`${serverUrl}${path}`, { ...init, headers })
  if (!res.ok) {
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

export function coverUrl(itemId: string): string {
  return mediaUrl(`/api/items/${itemId}/cover`)
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

/** All series in a library, each carrying its books (for the group drilldown). */
export async function getLibrarySeries(libraryId: string): Promise<ABSSeries[]> {
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

export async function getLibraryAuthors(libraryId: string): Promise<ABSLibraryAuthor[]> {
  const data = await absRequest<ABSAuthorsResponse>(`/api/libraries/${libraryId}/authors`)
  return data.authors ?? []
}

/** ABS author photo (token-bearing). '' when disconnected; falls back to initials. */
export function authorImageUrl(authorId: string): string {
  return mediaUrl(`/api/authors/${authorId}/image`)
}

/** HearthShelf's custom narrator photo (NOT ABS - lives at /hs/narrators/:name/image),
 *  keyed by name. '' when disconnected; falls back to initials. */
export function narratorImageUrl(name: string): string {
  return mediaUrl(`/hs/narrators/${encodeURIComponent(name)}/image`)
}

/** A user's HearthShelf profile photo (NOT ABS - lives at /hs/avatars/:userId,
 *  public GET so no token is required, but mediaUrl's session-gated '' fallback
 *  still applies mid server-switch). 404s to Gravatar or initials server-side;
 *  the client just falls back to the Avatar component's initials on load failure. */
export function avatarUrl(userId: string): string {
  return mediaUrl(`/hs/avatars/${encodeURIComponent(userId)}`)
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
  const q = encodeURIComponent(query)
  const data = await absRequest<ABSSearchResponse>(
    `/api/libraries/${libraryId}/search?q=${q}&limit=${limit}`,
  )
  return (data.book ?? []).map((b) => b.libraryItem)
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

export async function getRecentSessions(itemsPerPage = 100) {
  const data = await absRequest<ABSListeningSessionsResponse>(
    `/api/me/listening-sessions?page=0&itemsPerPage=${itemsPerPage}`,
  )
  return data.sessions ?? []
}

// ---- Collections / Playlists (Add to list) ----

export async function getLibraryCollections(libraryId: string): Promise<ABSCollection[]> {
  const data = await absRequest<ABSCollectionsResponse>(`/api/libraries/${libraryId}/collections`)
  return data.results ?? []
}

export async function getLibraryPlaylists(libraryId: string): Promise<ABSPlaylist[]> {
  const data = await absRequest<ABSPlaylistsResponse>(`/api/libraries/${libraryId}/playlists`)
  return data.results ?? []
}

export async function createCollection(
  libraryId: string,
  name: string,
  books: string[],
): Promise<void> {
  await absRequest<void>('/api/collections', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, books }),
  })
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

export async function createPlaylist(
  libraryId: string,
  name: string,
  items: { libraryItemId: string }[],
): Promise<void> {
  await absRequest<void>('/api/playlists', {
    method: 'POST',
    body: JSON.stringify({ libraryId, name, items }),
  })
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

export async function startPlay(itemId: string): Promise<ABSPlaybackSession> {
  return absRequest<ABSPlaybackSession>(`/api/items/${itemId}/play`, {
    method: 'POST',
    body: JSON.stringify({
      deviceInfo: {
        deviceId: 'hearthshelf-mobile',
        clientName: 'HearthShelf Mobile',
        clientVersion: '0.0.1',
      },
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
      deviceInfo: {
        deviceId: 'hearthshelf-mobile',
        clientName: 'HearthShelf Mobile',
        clientVersion: '0.0.1',
      },
      sessions,
    }),
  })
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
