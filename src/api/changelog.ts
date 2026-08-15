/**
 * Release notes, read from the public changelog API on the marketing site.
 *
 * This is NOT the control plane (api.hearthshelf.com) - it's the same D1-backed
 * service the website's Changelog page reads, served from the site origin with
 * open CORS and no auth. So it deliberately does not go through
 * controlPlane.ts's `request()`, which would attach a pointless bearer token and
 * aim at the wrong host.
 *
 * The CI release workflow posts entries here with product `HearthShelf-Mobile`
 * (.github/workflows/release.yml), so what the app shows is exactly what shipped.
 */
import { fetchWithTimeout } from './fetchWithTimeout'

const CHANGELOG_API_URL = 'https://hearthshelf.com/api/v1'
const PRODUCT = 'HearthShelf-Mobile'
const FETCH_TIMEOUT_MS = 10000

/** The six buckets the API classifies every line into. */
export type ChangelogSection = 'breaking' | 'feature' | 'fix' | 'change' | 'docs' | 'other'

export interface ChangelogItem {
  id: string
  section: ChangelogSection
  text: string
  sort_order: number
  tags: string[]
}

export interface ChangelogEntry {
  id: string
  product: string
  version: string
  released_at: string
  changelog: string | null
  download_url: string | null
  items: ChangelogItem[]
}

/**
 * Recent mobile releases, newest first.
 *
 * `channel` defaults to 'all' rather than the API's own 'release' default: a
 * beta build's own version is by definition on the beta channel, and a What's
 * New sheet that can't show the notes for the build you're running is worse than
 * useless.
 */
export async function fetchMobileChangelog(opts?: {
  limit?: number
  channel?: 'release' | 'beta' | 'all'
}): Promise<ChangelogEntry[]> {
  const params = new URLSearchParams({
    product: PRODUCT,
    limit: String(opts?.limit ?? 15),
    channel: opts?.channel ?? 'all',
  })
  const res = await fetchWithTimeout(
    `${CHANGELOG_API_URL}/changelogs?${params}`,
    {},
    FETCH_TIMEOUT_MS,
  )
  if (!res.ok) throw new Error(`Changelog request failed (${res.status})`)
  const body = (await res.json()) as { entries?: ChangelogEntry[] }
  return body?.entries ?? []
}
