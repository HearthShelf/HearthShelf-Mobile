/**
 * Local catalog of downloaded books' metadata, so Home / Library / Series can be
 * browsed fully offline.
 *
 * The downloads store (downloads.ts) keeps only what playback needs (title,
 * author, cover, duration, chapters, local files). This catalog captures the
 * richer library metadata - genres, series, narrator, published year, added date
 * - snapshotted from the ABS item detail at download time, so the browse screens
 * can filter, sort, and group downloaded books without the server.
 *
 * Backed by expo-sqlite (queryable + the storage standard across the apps). One
 * row per downloaded item; genres/series are JSON columns (small, per-item).
 * Hydrated into an in-memory snapshot on start so screens read synchronously,
 * matching the other stores (downloads, progress).
 */
import * as SQLite from 'expo-sqlite'
import type { ABSBookShelf, ABSLibraryItem, ABSLibraryItemDetail } from '@hearthshelf/core'

/** A downloaded book's browse metadata (everything the screens need offline). */
export interface CatalogItem {
  id: string
  libraryId: string
  title: string
  titleIgnorePrefix: string
  author: string
  narrator: string
  genres: string[]
  /** Series this book belongs to (usually 0 or 1), with reading-order sequence. */
  series: { id: string; name: string; sequence: string | null }[]
  publishedYear: string | null
  duration: number
  /** ms epoch the book was added to the library (for "date added" sort). */
  addedAt: number
}

interface CatalogState {
  byId: ReadonlyMap<string, CatalogItem>
}

let state: CatalogState = { byId: new Map() }
const listeners = new Set<() => void>()

// Cache the open promise (not just the resolved db) so concurrent callers -
// hydrate on mount racing a download's saveCatalogItem - share one open + one
// table create, never opening the database twice.
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const database = await SQLite.openDatabaseAsync('hearthshelf.db')
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS downloaded_items (
          id TEXT PRIMARY KEY NOT NULL,
          libraryId TEXT NOT NULL,
          title TEXT NOT NULL,
          titleIgnorePrefix TEXT NOT NULL,
          author TEXT NOT NULL,
          narrator TEXT NOT NULL,
          genresJson TEXT NOT NULL,
          seriesJson TEXT NOT NULL,
          publishedYear TEXT,
          duration REAL NOT NULL,
          addedAt INTEGER NOT NULL
        );
      `)
      return database
    })()
  }
  return dbPromise
}

function emit(byId: Map<string, CatalogItem>): void {
  state = { byId }
  listeners.forEach((l) => l())
}

export function getCatalogState(): CatalogState {
  return state
}

export function subscribeCatalog(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** All downloaded books as a flat array. */
export function catalogItems(): CatalogItem[] {
  return [...state.byId.values()]
}

function parseRow(row: CatalogRow): CatalogItem {
  return {
    id: row.id,
    libraryId: row.libraryId,
    title: row.title,
    titleIgnorePrefix: row.titleIgnorePrefix,
    author: row.author,
    narrator: row.narrator,
    genres: safeParse<string[]>(row.genresJson, []),
    series: safeParse<CatalogItem['series']>(row.seriesJson, []),
    publishedYear: row.publishedYear,
    duration: row.duration,
    addedAt: row.addedAt,
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

interface CatalogRow {
  id: string
  libraryId: string
  title: string
  titleIgnorePrefix: string
  author: string
  narrator: string
  genresJson: string
  seriesJson: string
  publishedYear: string | null
  duration: number
  addedAt: number
}

/** Load the catalog from SQLite into memory (call once at app start). */
export async function hydrateCatalog(): Promise<void> {
  try {
    const d = await getDb()
    const rows = await d.getAllAsync<CatalogRow>('SELECT * FROM downloaded_items')
    const byId = new Map<string, CatalogItem>()
    for (const row of rows) byId.set(row.id, parseRow(row))
    emit(byId)
  } catch {
    // A missing/corrupt DB just means an empty catalog; screens fall back to the
    // basic downloads store where they can.
  }
}

/** Snapshot a downloaded item's metadata from the ABS item detail. `duration` is
 *  passed in because the detail media shape omits the flat duration (the download
 *  flow already has it from the play session). */
export async function saveCatalogItem(
  detail: ABSLibraryItemDetail,
  duration: number,
): Promise<void> {
  const m = detail.media.metadata
  const item: CatalogItem = {
    id: detail.id,
    libraryId: detail.libraryId,
    title: m.title || 'Untitled',
    titleIgnorePrefix: m.titleIgnorePrefix || m.title || 'Untitled',
    author: m.authorName || 'Unknown author',
    narrator: (m.narrators ?? []).join(', ') || m.narratorName || '',
    genres: m.genres ?? [],
    series: (m.series ?? []).map((s) => ({ id: s.id, name: s.name, sequence: s.sequence })),
    publishedYear: m.publishedYear ?? null,
    duration: duration || 0,
    addedAt: detail.addedAt ?? 0,
  }
  try {
    const d = await getDb()
    await d.runAsync(
      `INSERT OR REPLACE INTO downloaded_items
         (id, libraryId, title, titleIgnorePrefix, author, narrator, genresJson, seriesJson, publishedYear, duration, addedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id,
      item.libraryId,
      item.title,
      item.titleIgnorePrefix,
      item.author,
      item.narrator,
      JSON.stringify(item.genres),
      JSON.stringify(item.series),
      item.publishedYear,
      item.duration,
      item.addedAt,
    )
    const byId = new Map(state.byId)
    byId.set(item.id, item)
    emit(byId)
  } catch {
    // Non-fatal: playback + basic download still work; only rich offline browse
    // for this item is degraded.
  }
}

/** Drop an item from the catalog (when its download is removed). */
export async function removeCatalogItem(itemId: string): Promise<void> {
  try {
    const d = await getDb()
    await d.runAsync('DELETE FROM downloaded_items WHERE id = ?', itemId)
  } catch {
    // ignore
  }
  if (state.byId.has(itemId)) {
    const byId = new Map(state.byId)
    byId.delete(itemId)
    emit(byId)
  }
}

/** True if we already have catalog metadata for this item (skip re-snapshot). */
export function hasCatalogItem(itemId: string): boolean {
  return state.byId.has(itemId)
}

/** "Series Name #3" flat label, matching ABS's minified seriesName field. */
function flatSeriesName(item: CatalogItem): string {
  const s = item.series[0]
  if (!s) return ''
  return s.sequence ? `${s.name} #${s.sequence}` : s.name
}

/**
 * Present catalog items as ABSLibraryItem[] so the browse screens' existing
 * filter / sort / group / render code (which reads item.media.metadata.*) works
 * offline unchanged. Only the fields those code paths touch are populated.
 */
export function catalogAsLibraryItems(): ABSLibraryItem[] {
  return catalogItems().map((c) => catalogToLibraryItem(c))
}

function catalogToLibraryItem(c: CatalogItem): ABSLibraryItem {
  return {
    id: c.id,
    libraryId: c.libraryId,
    folderId: '',
    path: '',
    mediaType: 'book',
    addedAt: c.addedAt,
    updatedAt: c.addedAt,
    isMissing: false,
    isInvalid: false,
    media: {
      id: c.id,
      coverPath: null,
      tags: [],
      numTracks: 0,
      numAudioFiles: 0,
      numChapters: 0,
      duration: c.duration,
      size: 0,
      metadata: {
        title: c.title,
        titleIgnorePrefix: c.titleIgnorePrefix,
        subtitle: null,
        authorName: c.author,
        narratorName: c.narrator,
        seriesName: flatSeriesName(c),
        publishedYear: c.publishedYear,
        description: null,
        genres: c.genres,
        language: null,
        explicit: false,
      },
    },
  }
}

/** A downloaded series with its books in reading order (for the Series screen).
 *  Shaped as ABSSeries so the screen renders it unchanged. */
export interface CatalogSeries {
  id: string
  name: string
  nameIgnorePrefix: string
  description: string | null
  books: ABSLibraryItem[]
}

/** Group downloaded books into their series (skips books with no series). Books
 *  are ordered by sequence, then title. */
export function catalogSeries(): CatalogSeries[] {
  const byId = new Map<string, { name: string; items: CatalogItem[] }>()
  for (const c of catalogItems()) {
    const s = c.series[0]
    if (!s) continue
    const entry = byId.get(s.id) ?? { name: s.name, items: [] }
    entry.items.push(c)
    byId.set(s.id, entry)
  }
  return [...byId.entries()]
    .map(([id, { name, items }]) => ({
      id,
      name,
      nameIgnorePrefix: name,
      description: null,
      books: items
        .slice()
        .sort((a, b) => seq(a) - seq(b) || a.titleIgnorePrefix.localeCompare(b.titleIgnorePrefix))
        .map(catalogToLibraryItem),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function seq(c: CatalogItem): number {
  return Number(c.series[0]?.sequence ?? 0) || 0
}

/** One series' downloaded books in reading order, or null if none downloaded. */
export function catalogSeriesById(seriesId: string): CatalogSeries | null {
  return catalogSeries().find((s) => s.id === seriesId) ?? null
}

/** A person (author or narrator) grouping of downloaded books. */
export interface CatalogGroup {
  /** Stable key: the person's name (we have no offline id for them). */
  name: string
  count: number
}

/** Distinct authors across downloaded books, with book counts. */
export function catalogAuthors(): CatalogGroup[] {
  return groupByName(catalogItems().map((c) => c.author))
}

/** Distinct narrators across downloaded books, with book counts. A book with a
 *  "A, B" narrator credit counts for both A and B. */
export function catalogNarrators(): CatalogGroup[] {
  const names: string[] = []
  for (const c of catalogItems()) {
    for (const n of c.narrator.split(',').map((s) => s.trim()).filter(Boolean)) names.push(n)
  }
  return groupByName(names)
}

/** Home content built from downloaded books, for offline mode:
 *  - `inProgress`: downloaded books you've started (for the hero + Continue row),
 *    most-progressed first.
 *  - `shelves`: the rest of your downloads grouped into genre categories, plus an
 *    "All downloads" catch-all. */
export function catalogHomeShelves(
  progressOf: (id: string) => number | undefined,
): { inProgress: ABSLibraryItem[]; shelves: ABSBookShelf[] } {
  const items = catalogItems()
  const inProgress = items
    .filter((c) => {
      const p = progressOf(c.id)
      return p !== undefined && p > 0 && p < 1
    })
    .sort((a, b) => (progressOf(b.id) ?? 0) - (progressOf(a.id) ?? 0))
    .map(catalogToLibraryItem)

  // Group ALL downloads by genre (a book can appear under each of its genres).
  const byGenre = new Map<string, CatalogItem[]>()
  for (const c of items) {
    const genres = c.genres.length ? c.genres : ['Other']
    for (const g of genres) {
      const arr = byGenre.get(g) ?? []
      arr.push(c)
      byGenre.set(g, arr)
    }
  }
  const genreShelves: ABSBookShelf[] = [...byGenre.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([genre, list]) => ({
      id: `offline-genre-${genre}`,
      label: genre,
      type: 'book' as const,
      entities: list
        .slice()
        .sort((a, b) => a.titleIgnorePrefix.localeCompare(b.titleIgnorePrefix))
        .map(catalogToLibraryItem),
    }))

  return { inProgress, shelves: genreShelves }
}

function groupByName(names: string[]): CatalogGroup[] {
  const counts = new Map<string, number>()
  for (const n of names) {
    if (!n) continue
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Fill in catalog metadata for downloaded items that don't have it yet (books
 * downloaded before this catalog existed, or whose snapshot failed). Fetches each
 * missing item's detail from the server, so it only runs online. Best-effort and
 * throttled implicitly by being serial - a handful of downloads at most.
 */
export async function backfillCatalog(
  downloadedItemIds: string[],
  fetchDetail: (id: string) => Promise<ABSLibraryItemDetail>,
  durationFor: (id: string) => number,
): Promise<void> {
  const missing = downloadedItemIds.filter((id) => !state.byId.has(id))
  for (const id of missing) {
    try {
      const detail = await fetchDetail(id)
      await saveCatalogItem(detail, durationFor(id))
    } catch {
      // Skip; try again on the next connect.
    }
  }
}
