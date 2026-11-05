/** Server and library totals, the activity chart, and the live counts on the admin
 *  home. Stats and home tiles share this file because they read the same sources. */
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  normalizeActivityBuckets,
  type ABSBackupsResponse,
  type ABSLibrary,
  type ABSLibraryStats,
  type ABSServerStats,
  type ABSUsersOnlineResponse,
  type HSServerActivity,
  type HsBackupsResponse,
} from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

/** Podcast libraries have no authors, and the server leaves the count out for them. */
export type AdminLibraryStats = Omit<ABSLibraryStats, 'totalAuthors'> & { totalAuthors?: number }

export function getServerStats(): Promise<ABSServerStats> {
  return adminRequest<ABSServerStats>(ABS_ENDPOINTS.serverStats)
}

export async function getServerActivity(): Promise<HSServerActivity> {
  const tz = new Date().getTimezoneOffset()
  const raw = await adminRequest<Partial<HSServerActivity>>(
    `${HS_ENDPOINTS.serverActivity}?tz=${tz}`,
  )
  return {
    available: raw.available === true,
    byHour: normalizeActivityBuckets(raw.byHour, 24),
    byDay: normalizeActivityBuckets(raw.byDay, 7),
  }
}

export async function getAdminLibraryList(): Promise<ABSLibrary[]> {
  const res = await adminRequest<{ libraries?: ABSLibrary[] }>(ABS_ENDPOINTS.libraries)
  return res.libraries ?? []
}

export async function getLibraryStats(libraryId: string): Promise<AdminLibraryStats> {
  const res = await adminRequest<Partial<AdminLibraryStats>>(ABS_ENDPOINTS.libraryStats(libraryId))
  return {
    totalItems: res.totalItems ?? 0,
    totalAuthors: res.totalAuthors,
    totalGenres: res.totalGenres ?? 0,
    totalSize: res.totalSize ?? 0,
    totalDuration: res.totalDuration ?? 0,
    numAudioTracks: res.numAudioTracks ?? 0,
    largestItems: res.largestItems ?? [],
    longestItems: res.longestItems ?? [],
  }
}

export function getOnlineStatus(): Promise<ABSUsersOnlineResponse> {
  return adminRequest<ABSUsersOnlineResponse>(ABS_ENDPOINTS.usersOnline)
}

/**
 * When the newest backup of either kind was made, or null if there are none. The
 * server keeps library backups and HearthShelf backups apart, and one half failing
 * should not hide the other. It only throws when neither can be read.
 */
export async function getLastBackupAt(): Promise<number | null> {
  const [abs, hs] = await Promise.allSettled([
    adminRequest<Partial<ABSBackupsResponse>>(ABS_ENDPOINTS.backups),
    adminRequest<Partial<HsBackupsResponse>>(HS_ENDPOINTS.backups),
  ])
  if (abs.status === 'rejected' && hs.status === 'rejected') throw abs.reason
  const times = [
    ...(abs.status === 'fulfilled' ? (abs.value.backups ?? []) : []),
    ...(hs.status === 'fulfilled' ? (hs.value.backups ?? []) : []),
  ].map((backup) => backup.createdAt)
  return times.length ? Math.max(...times) : null
}
