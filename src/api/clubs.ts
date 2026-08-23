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

export interface ClubInvitee {
  userId: string
  username: string
  pendingInviteId: string | null
}

export interface ClubInviteResult {
  userId: string
  inviteId?: string
  invited: boolean
  reason?: string
  emailSent?: boolean
}

function visibleClubs(res: HSClubsResponse): HSClubsResponse {
  if (!res.enabled) return DISABLED_CLUBS
  return {
    enabled: true,
    mine: res.mine.filter((club) => !club.archived),
    joinable: res.joinable.filter((club) => !club.archived),
  }
}

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
    return visibleClubs((await res.json()) as HSClubsResponse)
  } catch {
    return DISABLED_CLUBS
  }
}

export interface GetClubParams {
  /** Which club book to view, including Up next read-ahead books; defaults to
   *  the current book. */
  bookId?: string
  /** The caller's position in the viewed book, for the notes spoiler gate. */
  position?: number
}

/** Full club detail: club, book history, members with progress in the viewed
 *  book, that book's gated notes, and the unread count. null when unavailable. */
export async function getClub(
  id: string,
  params: GetClubParams = {},
): Promise<HSClubDetail | null> {
  const session = getSession()
  if (!session) return null
  const { serverUrl, token } = session
  const q = new URLSearchParams()
  if (params.bookId) q.set('bookId', params.bookId)
  if (params.position != null) q.set('position', String(Math.round(params.position)))
  const qs = q.toString()
  try {
    const res = await fetch(
      `${serverUrl}/hs/clubs/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    )
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

export async function getClubInvitees(id: string): Promise<ClubInvitee[]> {
  const session = getSession()
  if (!session) return []
  try {
    const res = await fetch(`${session.serverUrl}/hs/clubs/${encodeURIComponent(id)}/invitees`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    if (!res.ok) return []
    const value = (await res.json()) as { users?: ClubInvitee[] }
    return Array.isArray(value.users) ? value.users : []
  } catch {
    return []
  }
}

export async function inviteClubUsers(id: string, userIds: string[]): Promise<ClubInviteResult[]> {
  const session = getSession()
  if (!session) return []
  try {
    const res = await fetch(`${session.serverUrl}/hs/clubs/${encodeURIComponent(id)}/invites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds }),
    })
    if (!res.ok) return []
    const value = (await res.json()) as { results?: ClubInviteResult[] }
    return Array.isArray(value.results) ? value.results : []
  } catch {
    return []
  }
}

export async function respondToClubInvite(
  clubId: string,
  inviteId: string,
  accept: boolean,
): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  try {
    const action = accept ? 'accept' : 'decline'
    const res = await fetch(
      `${session.serverUrl}/hs/clubs/${encodeURIComponent(clubId)}/invites/${encodeURIComponent(inviteId)}/${action}`,
      { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } },
    )
    return res.ok
  } catch {
    return false
  }
}

export async function revokeClubInvite(clubId: string, inviteId: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  try {
    const res = await fetch(
      `${session.serverUrl}/hs/clubs/${encodeURIComponent(clubId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` } },
    )
    return res.ok
  } catch {
    return false
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

/**
 * Owner: advance the club to a new current book. What happens to the outgoing
 * book is the caller's choice: `finishPrevious` true files it under past reads
 * (the club read it to the end), false sets it aside unfinished so it stays
 * eligible to come back via requeueClubBook.
 */
export async function setClubCurrentBook(
  id: string,
  libraryItemId: string,
  finishPrevious = true,
): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/books`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryItemId, finishPrevious }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Owner: move a past read or a set aside book back into the up-next queue. The
 *  server refuses (409) when the book is the club's current read. */
export async function requeueClubBook(id: string, libraryItemId: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/requeue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryItemId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Owner: rewrite the up-next order. Books the caller leaves out keep their
 *  relative order at the back, so reordering from a stale list never drops one. */
export async function reorderClubQueue(id: string, libraryItemIds: string[]): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/queue-order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryItemIds }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Owner: add a book to the club's up-next queue. Returns true on success (incl.
 *  a no-op when the book is already in the club). */
export async function enqueueClubBook(id: string, libraryItemId: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/queue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryItemId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Owner: remove a book from the club's up-next queue. Returns true on success. */
export async function removeClubQueued(id: string, libraryItemId: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(
      `${serverUrl}/hs/clubs/${encodeURIComponent(id)}/queue/${encodeURIComponent(libraryItemId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    )
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

/** Owner or admin: permanently delete the club. Returns true on success. */
export async function deleteClub(id: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/clubs/${encodeURIComponent(id)}/hard`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok
  } catch {
    return false
  }
}
