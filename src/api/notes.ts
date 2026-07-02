/**
 * Public/club notes client - per-book notes with server-side spoiler gating by
 * playback position (see HearthShelf docs/social.md). The server returns full
 * notes only where allowed and anonymous locked stubs for ahead-notes; this
 * client just relays those. Same direct-origin + degrade-on-404 convention as
 * social.ts: an older server (or notes disabled) yields { enabled:false } and
 * the UI hides the surface instead of erroring.
 */
import type { HSNote, HSNotesResponse } from '@hearthshelf/core'
import { getSession } from './session'

const DISABLED_NOTES: HSNotesResponse = {
  enabled: false,
  notes: [],
  locked: [],
  hiddenAhead: 0,
  now: Date.now(),
}

export interface GetNotesParams {
  libraryItemId: string
  /** Present for club-scoped notes; omitted/'' for public notes. */
  clubId?: string
  /** The caller's playback position in seconds; gates ahead-notes server-side. */
  position?: number
  /** Delta poll: only notes created after this ms timestamp. */
  after?: number
  /** Client's finished claim (a hint; the server verifies when absdb is present). */
  finished?: boolean
}

/** Fetch the gated notes + locked stubs for a book (public or club scope). */
export async function getNotes(params: GetNotesParams): Promise<HSNotesResponse> {
  const session = getSession()
  if (!session) return DISABLED_NOTES
  const { serverUrl, token } = session
  const q = new URLSearchParams({ libraryItemId: params.libraryItemId })
  if (params.clubId) q.set('clubId', params.clubId)
  if (params.position != null) q.set('position', String(Math.round(params.position)))
  if (params.after != null) q.set('after', String(params.after))
  if (params.finished) q.set('finished', '1')
  try {
    const res = await fetch(`${serverUrl}/hs/notes?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return DISABLED_NOTES
    return (await res.json()) as HSNotesResponse
  } catch {
    return DISABLED_NOTES
  }
}

export interface PostNoteParams {
  libraryItemId: string
  clubId?: string
  parentId?: string
  /** Seconds into the book; null/omitted for a general (ungated) note. */
  timeSec?: number | null
  body: string
}

/** Post a note. Returns the created HSNote, or null on any failure (the caller
 *  surfaces a toast and re-fetches). */
export async function postNote(params: PostNoteParams): Promise<HSNote | null> {
  const session = getSession()
  if (!session) return null
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        libraryItemId: params.libraryItemId,
        clubId: params.clubId ?? '',
        parentId: params.parentId ?? '',
        timeSec: params.timeSec ?? null,
        body: params.body,
      }),
    })
    if (!res.ok) return null
    return (await res.json()) as HSNote
  } catch {
    return null
  }
}

/** Soft-delete a note (author, club owner, or admin). Returns true on success. */
export async function deleteNote(id: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok
  } catch {
    return false
  }
}
