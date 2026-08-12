import type { HSAudibleSearchResult } from '@hearthshelf/core'

export type UpcomingRouteBook = HSAudibleSearchResult & {
  sequence?: string | null
  seriesTitle?: string
}

/**
 * Carry a series-roster result into the upcoming screen. Some announced books
 * have already disappeared from Audible's product endpoint, so the destination
 * must not throw away the metadata the series roster already supplied.
 *
 * `from` is the tab that should stay lit on the destination (it renders its own
 * tab bar, being pushed above the tabs navigator). Omit it for a deep-link,
 * where there is no origin tab to preserve.
 */
export function upcomingBookPath(book: UpcomingRouteBook, from?: string): string {
  // Keep this deliberately compact: product descriptions can be several KB and
  // are not needed to make the fallback detail screen useful.
  const fallback = encodeURIComponent(
    JSON.stringify({
      asin: book.asin,
      title: book.title,
      author: book.author,
      narrator: book.narrator,
      coverArtUrl: book.coverArtUrl,
      durationMinutes: book.durationMinutes,
      releaseDate: book.releaseDate,
      publicationDatetime: book.publicationDatetime,
      series: book.series,
      seriesAsin: book.seriesAsin,
      seriesTitle: book.seriesTitle,
      sequence: book.sequence,
      upcoming: book.upcoming,
    }),
  )
  const origin = from ? `&from=${encodeURIComponent(from)}` : ''
  return `/upcoming/${encodeURIComponent(book.asin)}?fallback=${fallback}${origin}`
}

export function parseUpcomingBookFallback(
  value: string | string[] | undefined,
  routeAsin: string,
): UpcomingRouteBook | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null

  try {
    const candidate: unknown = JSON.parse(raw)
    if (!isRecord(candidate)) return null
    if (candidate.asin !== routeAsin || typeof candidate.title !== 'string') return null

    return {
      asin: candidate.asin,
      title: candidate.title,
      author: stringField(candidate, 'author') ?? '',
      authorAsin: stringField(candidate, 'authorAsin'),
      narrator: stringField(candidate, 'narrator'),
      description: stringField(candidate, 'description'),
      coverArtUrl: stringField(candidate, 'coverArtUrl'),
      durationMinutes: numberField(candidate, 'durationMinutes'),
      releaseDate: stringField(candidate, 'releaseDate'),
      publicationDatetime: stringField(candidate, 'publicationDatetime'),
      rating: numberField(candidate, 'rating'),
      series: stringField(candidate, 'series'),
      seriesAsin: stringField(candidate, 'seriesAsin'),
      seriesTitle: stringField(candidate, 'seriesTitle'),
      sequence: nullableStringField(candidate, 'sequence'),
      upcoming: booleanField(candidate, 'upcoming'),
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  return value[key] === null ? null : stringField(value, key)
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined
}

function booleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  return typeof value[key] === 'boolean' ? value[key] : undefined
}
