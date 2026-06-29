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
} from '@hearthshelf/core'

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

async function absRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { serverUrl, token } = requireSession()
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init?.body) headers.set('Content-Type', 'application/json')

  const res = await fetch(`${serverUrl}${path}`, { ...init, headers })
  if (!res.ok) {
    throw new Error(`abs_request_failed ${res.status} ${path}`)
  }
  // Some endpoints (sync/close) return empty / non-JSON; guard it.
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** Build an absolute, token-bearing media URL (covers, audio files). */
export function mediaUrl(path: string): string {
  const { serverUrl, token } = requireSession()
  const sep = path.includes('?') ? '&' : '?'
  return `${serverUrl}${path}${sep}token=${encodeURIComponent(token)}`
}

export function coverUrl(itemId: string): string {
  return mediaUrl(`/api/items/${itemId}/cover`)
}

// ---- Library browsing ----

export async function getLibraries(): Promise<ABSLibrary[]> {
  const data = await absRequest<ABSLibrariesResponse>('/api/libraries')
  return data.libraries
}

export async function getLibraryItems(
  libraryId: string,
  page = 0,
  limit = 50
): Promise<ABSLibraryItem[]> {
  const data = await absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?page=${page}&limit=${limit}&minified=1`
  )
  return data.results
}

/** Like getLibraryItems but returns the page envelope (total) for infinite scroll. */
export async function getLibraryItemsPage(
  libraryId: string,
  page = 0,
  limit = 50
): Promise<LibraryItemsPage> {
  const data = await absRequest<ABSLibraryItemsResponse>(
    `/api/libraries/${libraryId}/items?page=${page}&limit=${limit}&minified=1`
  )
  return { results: data.results, total: data.total, page: data.page, limit: data.limit }
}

export async function getPersonalized(libraryId: string): Promise<ABSShelf[]> {
  return absRequest<ABSShelf[]>(`/api/libraries/${libraryId}/personalized`)
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
  limit = 25
): Promise<ABSLibraryItem[]> {
  const q = encodeURIComponent(query)
  const data = await absRequest<ABSSearchResponse>(
    `/api/libraries/${libraryId}/search?q=${q}&limit=${limit}`
  )
  return (data.book ?? []).map((b) => b.libraryItem)
}

export async function getItemsInProgress(): Promise<ABSLibraryItem[]> {
  const data = await absRequest<ABSItemsInProgressResponse>('/api/me/items-in-progress')
  return data.libraryItems
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
      supportedMimeTypes: [
        'audio/mpeg',
        'audio/mp4',
        'audio/aac',
        'audio/flac',
        'audio/ogg',
      ],
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

/** Title/author helpers tolerant of ABS's nullable metadata. */
export function itemTitle(item: ABSLibraryItem): string {
  return item.media.metadata.title || 'Untitled'
}

export function itemAuthor(item: ABSLibraryItem): string {
  return item.media.metadata.authorName || 'Unknown author'
}
