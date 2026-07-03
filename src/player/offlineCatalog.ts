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
 * Each row is either a real download (`presence: 'downloaded'`) or a metadata-only
 * "skeleton" of another book in a downloaded book's series (`presence: 'skeleton'`),
 * so a partially-downloaded series can show its whole reading order offline. A
 * downloaded row always wins over a skeleton for the same book.
 *
 * Backed by expo-sqlite (queryable + the storage standard across the apps).
 * Hydrated into an in-memory snapshot on start so screens read synchronously,
 * matching the other stores (downloads, progress).
 */
import * as SQLite from 'expo-sqlite'
import type { ABSBookShelf, ABSLibraryItem, ABSLibraryItemDetail } from '@hearthshelf/core'

/** Whether a catalog row is an actual download or a metadata-only series skeleton. */
export type CatalogPresence = 'downloaded' | 'skeleton'

/** A book's browse metadata (everything the screens need offline). */
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
  /** What this row represents:
   *  - 'downloaded': the book's audio is on this device (plays offline, shows in
   *    the library list, Home, author/narrator groups).
   *  - 'skeleton': metadata only, captured because another book in its series was
   *    downloaded. Shows only inside its series (greyed "not downloaded"), never in
   *    the main library.
   *  A downloaded row always wins over a skeleton for the same book. */
  presence: CatalogPresence
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
      // Rollback-journal mode (not WAL): this tiny, low-write metadata catalog
      // doesn't need WAL's concurrency, and DELETE mode is durable across a
      // force-stop (swiping the app away). An uncheckpointed WAL can otherwise
      // lose recent writes - e.g. a series skeleton captured just before exit.
      await database.execAsync('PRAGMA journal_mode = DELETE')
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS catalog_items (
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
          addedAt INTEGER NOT NULL,
          presence TEXT NOT NULL DEFAULT 'downloaded'
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

/** Downloaded books only (drives the library list, Home, author/narrator groups).
 *  Skeleton siblings are excluded - they exist only to complete a series view. */
export function catalogItems(): CatalogItem[] {
  return [...state.byId.values()].filter((c) => c.presence === 'downloaded')
}

/** Every catalog row including metadata-only series skeletons (for series views). */
function allCatalogRows(): CatalogItem[] {
  return [...state.byId.values()]
}

/** A libraryId to use offline (from the downloaded books), or null if none. Lets
 *  the Library screen mount its list even when getLibraries() is unreachable. */
export function catalogLibraryId(): string | null {
  for (const c of catalogItems()) {
    if (c.libraryId && c.libraryId !== 'offline') return c.libraryId
  }
  // Fall back to any libraryId (incl. the 'offline' placeholder) so the list mounts.
  for (const c of catalogItems()) {
    if (c.libraryId) return c.libraryId
  }
  return null
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
  presence: string
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
    presence: row.presence === 'skeleton' ? 'skeleton' : 'downloaded',
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** Load the catalog from SQLite into memory (call once at app start). Merges with
 *  any rows already emitted (e.g. a basic backfill-from-downloads that raced this
 *  hydrate), DB-authoritative, so neither clobbers the other. */
export async function hydrateCatalog(): Promise<void> {
  try {
    const d = await getDb()
    const rows = await d.getAllAsync<CatalogRow>('SELECT * FROM catalog_items')
    const byId = new Map(state.byId)
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
  await upsertRows([itemFromDetail(detail, duration)])
}

/** Build a downloaded CatalogItem from an ABS item detail. */
function itemFromDetail(detail: ABSLibraryItemDetail, duration: number): CatalogItem {
  const m = detail.media.metadata
  return {
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
    presence: 'downloaded',
  }
}

/**
 * Write catalog rows and update the in-memory snapshot. A 'skeleton' row never
 * downgrades an existing 'downloaded' row for the same book - the download's
 * audio is on disk, so it stays a download regardless of series captures.
 */
async function upsertRows(items: CatalogItem[]): Promise<void> {
  if (!items.length) return
  try {
    const d = await getDb()
    const written: CatalogItem[] = []
    for (const item of items) {
      const row = await resolveRow(d, item)
      await d.runAsync(
        `INSERT OR REPLACE INTO catalog_items
           (id, libraryId, title, titleIgnorePrefix, author, narrator, genresJson, seriesJson, publishedYear, duration, addedAt, presence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.libraryId,
        row.title,
        row.titleIgnorePrefix,
        row.author,
        row.narrator,
        JSON.stringify(row.genres),
        JSON.stringify(row.series),
        row.publishedYear,
        row.duration,
        row.addedAt,
        row.presence,
      )
      written.push(row)
    }
    // Merge our writes into the CURRENT state (read now, after all awaits), so a
    // hydrate/emit that landed in between is preserved rather than clobbered.
    const byId = new Map(state.byId)
    for (const row of written) byId.set(row.id, row)
    emit(byId)
  } catch {
    // Non-fatal: playback + basic download still work; only rich offline browse
    // for these items is degraded.
  }
}

/** A 'skeleton' write must not overwrite an existing 'downloaded' row (in memory
 *  or on disk). For those, keep the downloaded presence but let the richer
 *  series metadata through - so the downloaded book still gets its series info. */
async function resolveRow(
  d: SQLite.SQLiteDatabase,
  item: CatalogItem,
): Promise<CatalogItem> {
  if (item.presence === 'downloaded') return item
  // item is a skeleton: does a downloaded row already exist for this id?
  if (state.byId.get(item.id)?.presence === 'downloaded') {
    return { ...item, presence: 'downloaded' }
  }
  const dbRow = await d.getFirstAsync<{ presence: string }>(
    'SELECT presence FROM catalog_items WHERE id = ?',
    item.id,
  )
  if (dbRow?.presence === 'downloaded') return { ...item, presence: 'downloaded' }
  return item
}

/**
 * Capture skeleton (metadata-only) rows for the books in a downloaded book's
 * series, so a partially-downloaded series shows its full reading order offline.
 * Takes the series' minified book list (from getLibrarySeries) plus the series
 * id/name (minified items only carry a flat "Name #3" seriesName). Only this
 * series is captured - nothing for unrelated books. The already-downloaded book
 * in the list keeps its 'downloaded' presence (resolveRow guards it).
 */
export async function saveSeriesSkeleton(
  seriesId: string,
  seriesName: string,
  books: ABSLibraryItem[],
): Promise<void> {
  await upsertRows(books.map((b) => skeletonFromMinified(b, seriesId, seriesName)))
}

function skeletonFromMinified(
  b: ABSLibraryItem,
  seriesId: string,
  seriesName: string,
): CatalogItem {
  const m = b.media.metadata
  // Pull the reading-order sequence out of the flat "Name #3" seriesName.
  const seqMatch = m.seriesName?.match(/#([\d.]+)\s*$/)
  return {
    id: b.id,
    libraryId: b.libraryId,
    title: m.title || 'Untitled',
    titleIgnorePrefix: m.titleIgnorePrefix || m.title || 'Untitled',
    author: m.authorName || 'Unknown author',
    narrator: m.narratorName || '',
    genres: m.genres ?? [],
    series: [{ id: seriesId, name: seriesName, sequence: seqMatch?.[1] ?? null }],
    publishedYear: m.publishedYear ?? null,
    duration: b.media.duration ?? 0,
    addedAt: b.addedAt ?? 0,
    presence: 'skeleton',
  }
}

/** Minimal browse metadata for a downloaded book, from what the downloads store
 *  already knows (no server needed). Genres/series/narrator/year are unknown, so
 *  the book still lists and sorts by title/author/duration/date, just without the
 *  richer groupings until a server-detail backfill fills them in. */
export interface BasicDownloadMeta {
  id: string
  libraryId: string
  title: string
  author: string
  duration: number
  addedAt: number
}

/** Seed catalog rows for downloaded books that have none yet, using only local
 *  download data. Runs offline (no server), so the library is browseable even if
 *  a richer server-detail backfill never gets to run. A later saveCatalogItem
 *  (from the server) overwrites the row with full metadata. */
export async function backfillFromDownloads(items: BasicDownloadMeta[]): Promise<void> {
  if (!items.length) return
  try {
    const d = await getDb()
    const added: CatalogItem[] = []
    for (const i of items) {
      const row: CatalogItem = {
        id: i.id,
        libraryId: i.libraryId,
        title: i.title || 'Untitled',
        titleIgnorePrefix: i.title || 'Untitled',
        author: i.author || 'Unknown author',
        narrator: '',
        genres: [],
        series: [],
        publishedYear: null,
        duration: i.duration,
        addedAt: i.addedAt,
        presence: 'downloaded',
      }
      // INSERT OR IGNORE: only seed a book we have NO row for. This must never
      // overwrite a richer row (enriched download or skeleton) already in the DB -
      // it runs at hydrate and could otherwise race ahead of hydrateCatalog and
      // clobber the persisted metadata with this empty-series basic version.
      const res = await d.runAsync(
        `INSERT OR IGNORE INTO catalog_items
           (id, libraryId, title, titleIgnorePrefix, author, narrator, genresJson, seriesJson, publishedYear, duration, addedAt, presence)
         VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', NULL, ?, ?, 'downloaded')`,
        row.id,
        row.libraryId,
        row.title,
        row.titleIgnorePrefix,
        row.author,
        row.narrator,
        row.duration,
        row.addedAt,
      )
      if (res.changes > 0) added.push(row)
    }
    if (!added.length) return
    // Merge only the rows we actually inserted into current state (don't drop a
    // hydrate that landed meanwhile, and don't override its richer rows).
    const byId = new Map(state.byId)
    for (const row of added) if (!byId.has(row.id)) byId.set(row.id, row)
    emit(byId)
  } catch {
    // ignore; the richer server backfill will still try later
  }
}

/** Drop an item from the catalog (when its download is removed). */
export async function removeCatalogItem(itemId: string): Promise<void> {
  try {
    const d = await getDb()
    await d.runAsync('DELETE FROM catalog_items WHERE id = ?', itemId)
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
    // Skeleton siblings (not downloaded) ride ABS's isMissing flag, so the series
    // screen can grey them and block playback offline.
    isMissing: c.presence !== 'downloaded',
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

/** A series with its books in reading order (for the Series screen). Shaped as
 *  ABSSeries so the screen renders it unchanged. */
export interface CatalogSeries {
  id: string
  name: string
  nameIgnorePrefix: string
  description: string | null
  books: ABSLibraryItem[]
}

/** Group books into their series for offline browse. Includes metadata-only
 *  skeleton siblings so a partially-downloaded series shows its full reading
 *  order, but only surfaces a series that has at least one downloaded book. Books
 *  are ordered by sequence, then title. */
export function catalogSeries(): CatalogSeries[] {
  const byId = new Map<string, { name: string; items: CatalogItem[]; hasDownload: boolean }>()
  for (const c of allCatalogRows()) {
    const s = c.series[0]
    if (!s) continue
    const entry = byId.get(s.id) ?? { name: s.name, items: [], hasDownload: false }
    entry.items.push(c)
    if (c.presence === 'downloaded') entry.hasDownload = true
    byId.set(s.id, entry)
  }
  return [...byId.entries()]
    .filter(([, e]) => e.hasDownload)
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

/** One series' books (downloaded + skeleton siblings) in reading order, or null if
 *  none of its books are downloaded. */
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
 *  - `shelves`: the rest of your downloads grouped into genre categories. */
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
 * item's detail from the server, so it only runs online. Best-effort and throttled
 * implicitly by being serial - a handful of downloads at most. Also captures each
 * book's full series skeleton so a partially-downloaded series browses offline.
 */
export async function backfillCatalog(
  downloadedItemIds: string[],
  fetchDetail: (id: string) => Promise<ABSLibraryItemDetail>,
  durationFor: (id: string) => number,
  fetchSeriesBooks: (
    libraryId: string,
    seriesId: string,
  ) => Promise<{ id: string; name: string; books: ABSLibraryItem[] } | null>,
): Promise<void> {
  // Enrich any downloaded book we don't have RICH metadata for yet - a basic
  // backfill-from-downloads row (empty series/genres) still needs the server pass.
  const needsRich = downloadedItemIds.filter((id) => {
    const c = state.byId.get(id)
    return !c || (c.genres.length === 0 && c.series.length === 0)
  })
  for (const id of needsRich) {
    try {
      const detail = await fetchDetail(id)
      await saveCatalogItem(detail, durationFor(id))
      // Also capture the full series skeleton (once per series) so a partially
      // downloaded series shows its whole reading order offline.
      const seriesRef = detail.media.metadata.series?.[0]
      if (seriesRef) {
        const series = await fetchSeriesBooks(detail.libraryId, seriesRef.id)
        if (series) await saveSeriesSkeleton(series.id, series.name, series.books)
      }
    } catch {
      // Skip; try again on the next connect.
    }
  }
}
