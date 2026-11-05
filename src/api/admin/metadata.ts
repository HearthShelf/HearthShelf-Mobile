/** Tags and genres across the whole server. */
import { ABS_ENDPOINTS, encodeNamePathParam } from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

export type MetadataKind = 'tags' | 'genres'

/** ABS rewrites every matching item, and its metadata file, before it answers. */
const REWRITE_TIMEOUT_MS = 120000
const LIST_TIMEOUT_MS = 30000

export async function getMetadataNames(kind: MetadataKind): Promise<string[]> {
  if (kind === 'tags') {
    const res = await adminRequest<{ tags?: string[] }>(ABS_ENDPOINTS.tags, undefined, {
      timeoutMs: LIST_TIMEOUT_MS,
    })
    return res?.tags ?? []
  }
  const res = await adminRequest<{ genres?: string[] }>(ABS_ENDPOINTS.genres, undefined, {
    timeoutMs: LIST_TIMEOUT_MS,
  })
  return res?.genres ?? []
}

export async function renameMetadataName(
  kind: MetadataKind,
  name: string,
  newName: string,
): Promise<void> {
  const path = kind === 'tags' ? ABS_ENDPOINTS.tagRename : ABS_ENDPOINTS.genreRename
  const body = kind === 'tags' ? { tag: name, newTag: newName } : { genre: name, newGenre: newName }
  await adminRequest(
    path,
    { method: 'POST', body: JSON.stringify(body) },
    { timeoutMs: REWRITE_TIMEOUT_MS },
  )
}

export async function deleteMetadataName(kind: MetadataKind, name: string): Promise<void> {
  const encoded = encodeNamePathParam(name)
  const path = kind === 'tags' ? ABS_ENDPOINTS.tag(encoded) : ABS_ENDPOINTS.genre(encoded)
  await adminRequest(path, { method: 'DELETE' }, { timeoutMs: REWRITE_TIMEOUT_MS })
}
