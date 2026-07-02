/**
 * Book Club client (see HearthShelf docs/social.md). A club is a persistent
 * multi-book reading group; the server owns membership, book history, per-book
 * chat (notes), the member progress race, and the unread cursor. Same
 * direct-origin + degrade convention as social.ts/notes.ts: an older server (or
 * clubs disabled) yields { enabled:false } and the UI hides the surface.
 */
import type { HSClub, HSClubsResponse, HSClubDetail } from '@hearthshelf/core'
import { getSession } from './session'

const DISABLED_CLUBS: HSClubsResponse = { enabled: false, mine: [], joinable: [] }

/** The caller's clubs and (with libraryItemId) open clubs joinable for that item
 *  - open clubs whose current book is the item. Without the id, `mine` only. */
export async function getClubs(libraryItemId?: string): Promise<HSClubsResponse> {
  const session = getSession()
  if (!session) return DISABLED_CLUBS
  const { serverUrl, token } = session
  const q = libraryItemId ? `?libraryItemId=${encodeURIComponent(libraryItemId)}` : ''
  try {
    const res = await fetch(`${serverUrl}/hs/clubs${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return DISABLED_CLUBS
    return (await res.json()) as HSClubsResponse
  } catch {
    return DISABLED_CLUBS
  }
}

export interface GetClubParams {
  /** Which book in the history to view; defaults to the current book. */
  bookId?: string
  /** The caller's position in the viewed book, for the notes spoiler gate. */
  position?: number
}

/** Full club detail: club, book history, members with progress in the viewed
 *  book, that book's gated notes, and the unread count. null when unavailable. */
export async function getClub(id: string, params: GetClubParams = {}): Promise<HSClubDetail | null> {
  const session = getSession()
  if (!session) return null
  const { serverUrl, token } = session
  const q = new URLSearchParams()
  if (params.bookId) q.set('bookId', params.bookId)
  if (params.position != null) q.set('position', String(Math.round(params.position)))
  const qs = q.toString()
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const detail = (await res.json()) as HSClubDetail
    return detail.enabled ? detail : null
  } catch {
    return null
  }
}

/** Create a club; the creator becomes owner. An optional first current book. */
export async function createClub(name: string, libraryItemId?: string): Promise<HSClub | null> {
  const session = getSession()
  if (!session) return null
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, libraryItemId: libraryItemId ?? '' }),
    })
    if (!res.ok) return null
    return (await res.json()) as HSClub
  } catch {
    return null
  }
}

/** Join or leave a club (membership row). Returns true on success. */
export async function setClubMembership(id: string, join: boolean): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(
      `${serverUrl}/hs/clubs/${encodeURIComponent(id)}/${join ? 'join' : 'leave'}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    )
    return res.ok
  } catch {
    return false
  }
}

/** Owner: advance the club to a new current book (previous one gets finished). */
export async function setClubCurrentBook(id: string, libraryItemId: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryItemId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Owner: remove a member (never the owner). Returns true on success. */
export async function kickClubMember(id: string, userId: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/kick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Bump the per-club unread cursor (server applies max(stored, incoming)). */
export async function markClubRead(id: string, lastReadAt: number): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/read`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastReadAt }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Owner or admin: archive the club. Returns true on success. */
export async function archiveClub(id: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok
  } catch {
    return false
  }
}
