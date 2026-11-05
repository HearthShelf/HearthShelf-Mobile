/** Library admin calls. Shapes checked against audiobookshelf's LibraryController. */
import {
  ABS_ENDPOINTS,
  type ABSLibrariesResponse,
  type ABSLibrary,
  type LibraryUpdatePayload,
  type MetadataProvider,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

/** These walk every item in a library before the server answers. A timeout here
 *  means "unconfirmed", so it is set long enough to rarely be reached. */
export const LIBRARY_SLOW_TIMEOUT_MS = 5 * 60 * 1000

export type LibraryMediaType = 'book' | 'podcast'
export type LibraryFolderCheck = 'exists' | 'missing' | 'unknown'
export type LibraryMetadataExt = 'json' | 'abs'

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}

export async function getLibraries(): Promise<ABSLibrary[]> {
  const res = await adminRequest<ABSLibrariesResponse>(ABS_ENDPOINTS.libraries)
  return [...res.libraries].sort((a, b) => a.displayOrder - b.displayOrder)
}

export function getLibrary(id: string): Promise<ABSLibrary> {
  return adminRequest<ABSLibrary>(ABS_ENDPOINTS.library(id))
}

export function createLibrary(values: {
  name: string
  mediaType: LibraryMediaType
  fullPath: string
}): Promise<ABSLibrary> {
  return adminRequest<ABSLibrary>(
    ABS_ENDPOINTS.libraries,
    jsonInit('POST', {
      name: values.name,
      mediaType: values.mediaType,
      icon: values.mediaType === 'podcast' ? 'podcast' : 'audiobookshelf',
      folders: [{ fullPath: values.fullPath }],
    }),
  )
}

/** The server answers 400 for a missing or relative path. Anything else means the
 *  check itself failed, which says nothing about the folder. */
export async function checkLibraryFolder(fullPath: string): Promise<LibraryFolderCheck> {
  try {
    await adminRequest<unknown>(
      `${ABS_ENDPOINTS.filesystem}?path=${encodeURIComponent(fullPath)}&level=0`,
    )
    return 'exists'
  } catch (e) {
    return e instanceof ABSRequestError && e.status === 400 ? 'missing' : 'unknown'
  }
}

export function scanLibrary(id: string, force = false): Promise<void> {
  return adminRequest<void>(`${ABS_ENDPOINTS.libraryScan(id)}${force ? '?force=1' : ''}`, {
    method: 'POST',
  })
}

export function updateLibrary(
  id: string,
  patch: LibraryUpdatePayload,
  timeoutMs?: number,
): Promise<ABSLibrary> {
  return adminRequest<ABSLibrary>(
    ABS_ENDPOINTS.library(id),
    jsonInit('PATCH', patch),
    timeoutMs ? { timeoutMs } : undefined,
  )
}

export function deleteLibrary(id: string): Promise<void> {
  return adminRequest<void>(
    ABS_ENDPOINTS.library(id),
    { method: 'DELETE' },
    { timeoutMs: LIBRARY_SLOW_TIMEOUT_MS },
  )
}

export function reorderLibraries(order: { id: string; newOrder: number }[]): Promise<unknown> {
  return adminRequest<unknown>(ABS_ENDPOINTS.librariesOrder, jsonInit('POST', order))
}

export function matchAllLibraryItems(id: string): Promise<void> {
  return adminRequest<void>(ABS_ENDPOINTS.libraryMatchAll(id), undefined, {
    timeoutMs: LIBRARY_SLOW_TIMEOUT_MS,
  })
}

/** `removed` is missing from the answer when no files were found. */
export async function removeLibraryMetadata(
  id: string,
  ext: LibraryMetadataExt,
): Promise<{ found: number; removed: number }> {
  const res = await adminRequest<{ found?: number; removed?: number }>(
    `${ABS_ENDPOINTS.libraryRemoveMetadata(id)}?ext=${ext}`,
    { method: 'POST' },
    { timeoutMs: LIBRARY_SLOW_TIMEOUT_MS },
  )
  return { found: res.found ?? 0, removed: res.removed ?? 0 }
}

export async function getSearchProviders(): Promise<{
  books: MetadataProvider[]
  podcasts: MetadataProvider[]
}> {
  const res = await adminRequest<{
    providers: { books: MetadataProvider[]; podcasts: MetadataProvider[] }
  }>(ABS_ENDPOINTS.searchProviders)
  return res.providers
}
