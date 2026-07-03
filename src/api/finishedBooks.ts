/**
 * Finished-books, Goodreads import, and Hardcover sync against the connected
 * HearthShelf server. These endpoints live under /hs/finished-books on the
 * same origin as ABS and use the same ABS bearer token as the rest of mobile.
 */
import { getSession } from './session'
import type {
  HSMatchCandidate as MatchCandidate,
  HSFinishedBookMatch as MatchRow,
  HSFinishedBookImportRow as ImportRow,
  HSHardcoverAccount as HardcoverAccountStatus,
  HSHardcoverSyncResult as HardcoverSyncResult,
} from '@hearthshelf/core'

export type { MatchCandidate, MatchRow, ImportRow, HardcoverAccountStatus, HardcoverSyncResult }

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

async function fbFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/finished-books${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body as { error?: string } | null)?.error ?? `finished_books_${res.status}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export function matchRows(
  libraryId: string,
  rows: { title: string; author: string; isbn: string | null }[],
): Promise<{ matches: MatchRow[] }> {
  return fbFetch('/match', {
    method: 'POST',
    body: JSON.stringify({ libraryId, rows }),
  })
}

export function importRows(rows: ImportRow[]): Promise<{ inserted: number; updated: number }> {
  return fbFetch('/import', {
    method: 'POST',
    body: JSON.stringify({ rows }),
  })
}

export function getHardcoverAccount(): Promise<HardcoverAccountStatus> {
  return fbFetch('/hardcover')
}

export function connectHardcover(token: string): Promise<HardcoverAccountStatus> {
  return fbFetch('/hardcover', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  })
}

export function disconnectHardcover(): Promise<void> {
  return fbFetch('/hardcover', { method: 'DELETE' })
}

export function triggerHardcoverSync(): Promise<HardcoverSyncResult> {
  return fbFetch('/hardcover/sync', { method: 'POST' })
}
