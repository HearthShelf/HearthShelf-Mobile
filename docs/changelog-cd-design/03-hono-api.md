I now have complete context. I have everything I need to write implementation-ready code that matches the exact style (Hono, `c.env.DB.prepare`, `nanoid`, `hasApiKey`, prettier 2-space no-semis single-quote). Here is my deliverable.

---

# Website Hono API: Structured Tagged Line Items

## 0. Design decisions up front

**Schema shape (child tables, not one blob).** Keep the `changelogs` table as the release header but drop the `changelog` text column as the source of truth. Add `changelog_items` (one row per bullet) and `item_tags` (join table). Keep a denormalized `tags` TEXT column on each item as a fallback/debug convenience, but the join table is authoritative for filtering.

**`changelog` blob stays, derived.** The existing UI still renders a markdown blob and the `/resolve` + date-tree paths lean on it. Rather than rip out the whole render path, the POST handler *also* stores a rebuilt markdown blob on the header so nothing that reads `changelog` breaks during the transition. The new nested `items[]` is what the enhanced UI filters on. This is the cheap way to keep the existing channel/date-tree/deep-link UX working with zero changes to those code paths.

**Auto-tagging is server-side.** The client can send explicit tags, but the server always runs the auto-tag rules and merges. This means the rules live in one place (the Website) and a re-upload picks up rule improvements without re-running mobile CI.

**Filtering + pagination interaction.** Pagination is over *releases*. When `?tag=` / `?section=` is present, a release qualifies if it has `>=1` matching item. Both the page query and the COUNT query must filter to *releases that have a match* (via `EXISTS`), never to items — otherwise the count and the page rows disagree.

---

## 1. Migration (D1 empty, so just replace 0001)

```sql
-- migrations/0001_changelogs.sql  (replace in place; remote D1 is empty)

-- Release header: one row per (product, version).
CREATE TABLE IF NOT EXISTS changelogs (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  released_at TEXT NOT NULL,
  -- Rebuilt markdown blob, derived from items. Kept so the existing
  -- render/search/resolve paths keep working. Items are authoritative.
  changelog TEXT NOT NULL DEFAULT '',
  download_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(product, version)
);

CREATE INDEX IF NOT EXISTS idx_changelogs_released_at
  ON changelogs(released_at DESC, created_at DESC);

-- One row per bullet line.
CREATE TABLE IF NOT EXISTS changelog_items (
  id TEXT PRIMARY KEY,
  changelog_id TEXT NOT NULL
    REFERENCES changelogs(id) ON DELETE CASCADE,
  section TEXT NOT NULL,          -- feature | fix | change | docs | breaking | other
  text TEXT NOT NULL,             -- bullet body, verb prefix already stripped
  sort_order INTEGER NOT NULL,    -- original order within the release
  -- Denormalized fallback: comma-joined tag list. item_tags is authoritative.
  tags TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_items_changelog ON changelog_items(changelog_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_items_section   ON changelog_items(section);

-- Tag join table (authoritative for tag filtering).
CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL
    REFERENCES changelog_items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag);
```

**Important D1 caveat:** D1 enforces `ON DELETE CASCADE` only when `PRAGMA foreign_keys = ON`, and D1 does **not** persist that pragma across statements in a `batch()`. So I do **not** rely on cascade for deletes — every delete path below explicitly removes children in a batch. The `REFERENCES ... ON DELETE CASCADE` is documentation + safety-net, not the mechanism.

---

## 2. Shared helpers (add to `functions/api/_shared/helpers.ts`)

Section canonicalization + auto-tag rules + a blob rebuilder. These mirror the SUI generator's prefix categories so the mobile script and the server agree.

```ts
// ---- Section normalization ------------------------------------------------

export type Section = 'feature' | 'fix' | 'change' | 'docs' | 'breaking' | 'other'

const SECTION_ALIASES: Record<string, Section> = {
  feature: 'feature',
  features: 'feature',
  new: 'feature',
  added: 'feature',
  add: 'feature',
  fix: 'fix',
  fixes: 'fix',
  fixed: 'fix',
  bug: 'fix',
  change: 'change',
  changed: 'change',
  changes: 'change',
  improved: 'change',
  improvement: 'change',
  refactor: 'change',
  perf: 'change',
  docs: 'docs',
  documentation: 'docs',
  breaking: 'breaking',
  removed: 'change',
  remove: 'change',
}

/** Fold whatever the uploader sent into one of the canonical sections. */
export function normalizeSection(raw: string | undefined | null): Section {
  if (!raw) return 'other'
  return SECTION_ALIASES[raw.trim().toLowerCase()] ?? 'other'
}

// ---- Auto-tag rules -------------------------------------------------------

// Each rule: if any pattern matches the bullet text (case-insensitive),
// attach `tag`. Add rules here; they run on every upload/re-upload.
const AUTO_TAG_RULES: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'android-auto', patterns: [/\bandroid auto\b/i, /\bcar\b/i, /\bhead unit\b/i, /\bmedia3\b/i] },
  { tag: 'ios', patterns: [/\bios\b/i, /\bapple\b/i, /\biphone\b/i, /\bipad\b/i, /\btestflight\b/i, /\bcarplay\b/i] },
  { tag: 'android', patterns: [/\bandroid\b(?!\s+auto)/i, /\bgoogle play\b/i, /\bplay store\b/i] },
  { tag: 'offline', patterns: [/\boffline\b/i, /\bdownload(s|ed|ing)?\b/i] },
  { tag: 'player', patterns: [/\bplayer\b/i, /\bplayback\b/i, /\bsleep timer\b/i, /\bchapter/i] },
  { tag: 'sync', patterns: [/\bsync/i, /\bprogress\b/i, /\bresume\b/i] },
  { tag: 'auth', patterns: [/\bsign[- ]?in\b/i, /\blogin\b/i, /\bclerk\b/i, /\bauth\b/i] },
]

/**
 * Compute the full tag set for one bullet: merge caller-supplied tags with
 * every auto rule that fires. Returns a sorted, de-duped, lowercased list.
 */
export function computeTags(text: string, explicit?: string[]): string[] {
  const set = new Set<string>()
  for (const t of explicit ?? []) {
    const norm = t.trim().toLowerCase()
    if (norm) set.add(norm)
  }
  for (const rule of AUTO_TAG_RULES) {
    if (rule.patterns.some((re) => re.test(text))) set.add(rule.tag)
  }
  return Array.from(set).sort()
}

// ---- Blob rebuild (keeps legacy render/search/resolve working) ------------

const SECTION_HEADINGS: Record<Section, string> = {
  feature: '### Features',
  change: '### Changes',
  fix: '### Fixes',
  breaking: '### Breaking Changes',
  docs: '### Documentation',
  other: '### Other',
}

const SECTION_ORDER: Section[] = ['breaking', 'feature', 'change', 'fix', 'docs', 'other']

/** Rebuild a grouped markdown blob from structured items (legacy compatibility). */
export function rebuildChangelogBlob(
  items: Array<{ section: Section; text: string }>,
): string {
  const bySection = new Map<Section, string[]>()
  for (const it of items) {
    const arr = bySection.get(it.section) ?? []
    arr.push(`- ${it.text}`)
    bySection.set(it.section, arr)
  }
  const parts: string[] = []
  for (const section of SECTION_ORDER) {
    const lines = bySection.get(section)
    if (lines && lines.length > 0) {
      parts.push(SECTION_HEADINGS[section], ...lines, '')
    }
  }
  return parts.join('\n').trim()
}
```

---

## 3. Types (add to nested response shape)

```ts
// _shared/types.ts additions

export interface ChangelogItemRow {
  id: string
  section: string
  text: string
  sort_order: number
  tags: string[]
  /** true when this item matched an active ?tag/?section filter */
  matched?: boolean
}

export interface ChangelogEntryOut {
  id: string
  product: string
  version: string
  released_at: string
  changelog: string // legacy blob, still rendered by old path
  download_url: string | null
  items: ChangelogItemRow[]
  /** present only when a tag/section filter is active */
  filtered?: boolean
}
```

---

## 4. POST /changelogs — structured payload, idempotent, batched

```ts
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { AppEnv } from '../_shared/types'
import {
  cleanChangelog,
  buildChangelogWhere,
  hasApiKey,
  normalizeSection,
  computeTags,
  rebuildChangelogBlob,
} from '../_shared/helpers'

const app = new Hono<AppEnv>()

interface ItemInput {
  section?: string
  text: string
  tags?: string[]
}

app.post('/', async (c) => {
  if (!hasApiKey(c)) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{
    product: string
    version: string
    released_at: string
    download_url?: string
    items: ItemInput[]
  }>()

  // NOTE: uploader must send `product` (SUI uploader historically sent
  // `addon_name` — see item 6). We only accept `product` now.
  if (
    !body.product ||
    !body.version ||
    !body.released_at ||
    !Array.isArray(body.items) ||
    body.items.length === 0
  ) {
    return c.json(
      { error: 'Missing required fields: product, version, released_at, items[]' },
      400,
    )
  }

  // Normalize items once: canonical section, computed tags, order preserved.
  const normalized = body.items
    .filter((it) => it && typeof it.text === 'string' && it.text.trim().length > 0)
    .map((it, idx) => {
      const section = normalizeSection(it.section)
      const text = it.text.trim()
      const tags = computeTags(text, it.tags)
      return { id: nanoid(), section, text, sort_order: idx, tags }
    })

  if (normalized.length === 0) {
    return c.json({ error: 'items[] contained no usable bullets' }, 400)
  }

  const blob = cleanChangelog(rebuildChangelogBlob(normalized))

  // Upsert header first (separate call) so we can read back its id, then
  // rebuild the children in one atomic batch. Two round-trips total.
  const headerId = nanoid()
  await c.env.DB.prepare(
    `INSERT INTO changelogs (id, product, version, released_at, changelog, download_url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, version) DO UPDATE SET
       released_at  = excluded.released_at,
       changelog    = excluded.changelog,
       download_url = excluded.download_url`,
  )
    .bind(headerId, body.product, body.version, body.released_at, blob, body.download_url || null)
    .run()

  // Fetch the surviving header id (on conflict, the original id is kept).
  const header = await c.env.DB.prepare(
    `SELECT id FROM changelogs WHERE product = ? AND version = ?`,
  )
    .bind(body.product, body.version)
    .first<{ id: string }>()

  const changelogId = header!.id

  // Idempotent rebuild: wipe old children, insert new. item_tags is deleted
  // explicitly (not via cascade) because D1 does not keep foreign_keys ON
  // across batched statements.
  const stmts = [
    c.env.DB.prepare(
      `DELETE FROM item_tags WHERE item_id IN
         (SELECT id FROM changelog_items WHERE changelog_id = ?)`,
    ).bind(changelogId),
    c.env.DB.prepare(`DELETE FROM changelog_items WHERE changelog_id = ?`).bind(changelogId),
  ]

  for (const it of normalized) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO changelog_items (id, changelog_id, section, text, sort_order, tags)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(it.id, changelogId, it.section, it.text, it.sort_order, it.tags.join(',')),
    )
    for (const tag of it.tags) {
      stmts.push(
        c.env.DB.prepare(`INSERT INTO item_tags (item_id, tag) VALUES (?, ?)`).bind(it.id, tag),
      )
    }
  }

  // D1 batch() runs the array as a single implicit transaction.
  await c.env.DB.batch(stmts)

  return c.json(
    { id: changelogId, items: normalized.length, tags: [...new Set(normalized.flatMap((n) => n.tags))] },
    201,
  )
})
```

**Why header-upsert-then-batch and not one giant batch:** D1's `batch()` is atomic but you can't read a value out mid-batch to feed a later statement. The header id (which the on-conflict path preserves) is needed as the FK for every child insert. So: one upsert, one read-back, one batch for all children. The children batch is fully atomic, which is what matters for "re-upload is idempotent" — a failed re-upload leaves the old children intact only if the delete+insert batch fails as a unit (it does).

---

## 5. GET /changelogs (list) — nested items+tags, recommend two-query stitch

**Join-and-group-in-JS vs two-query stitch — recommendation: two-query stitch.**

A single 3-way join (`changelogs ⋈ changelog_items ⋈ item_tags`) fans out to `releases × items × tags` rows, and you then de-dup in JS. With tags that fan-out multiplies. It also makes `LIMIT/OFFSET` over releases impossible in the same statement (the limit would apply to the fanned-out rows). The clean approach:

1. Query the page of **releases** (with `LIMIT/OFFSET`, existing `buildChangelogWhere`).
2. Query **all items+tags for just those release ids** with a single `WHERE changelog_id IN (...)`, joined to tags (small fan-out: items × their own tags only), grouped in JS.

Two round-trips, both index-hit, no cross-product blowup.

```ts
app.get('/', async (c) => {
  const url = new URL(c.req.url)
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10)))
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10))

  const tag = url.searchParams.get('tag')
  const section = url.searchParams.get('section') // canonical section, see filters below

  const { where, binds } = buildChangelogWhere({
    product: url.searchParams.get('product'),
    year: url.searchParams.get('year'),
    month: url.searchParams.get('month'),
    channel: url.searchParams.get('channel') ?? 'release',
  })

  // Build an EXISTS predicate for tag/section so pagination + count both
  // operate on "releases that have >=1 matching item", not on items.
  const existsParts: string[] = []
  const existsBinds: (string | number)[] = []
  if (section) {
    existsParts.push('ci.section = ?')
    existsBinds.push(section)
  }
  if (tag) {
    existsParts.push('EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = ci.id AND it.tag = ?)')
    existsBinds.push(tag)
  }
  const existsClause =
    existsParts.length > 0
      ? `${where ? 'AND' : 'WHERE'} EXISTS (
           SELECT 1 FROM changelog_items ci
           WHERE ci.changelog_id = changelogs.id AND ${existsParts.join(' AND ')}
         )`
      : ''

  const listBinds = [...binds, ...existsBinds]

  const [pageResult, countResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, product, version, released_at, changelog, download_url
       FROM changelogs ${where} ${existsClause}
       ORDER BY released_at DESC, created_at DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...listBinds, limit, offset)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM changelogs ${where} ${existsClause}`)
      .bind(...listBinds)
      .first<{ total: number }>(),
  ])

  const releaseRows = pageResult.results as Array<{
    id: string
    product: string
    version: string
    released_at: string
    changelog: string
    download_url: string | null
  }>

  const items = await fetchItemsForReleases(
    c,
    releaseRows.map((r) => r.id),
  )

  const filterActive = !!(tag || section)
  const entries = releaseRows.map((r) => {
    const its = (items.get(r.id) ?? []).map((it) => ({
      ...it,
      matched: filterActive
        ? (!section || it.section === section) && (!tag || it.tags.includes(tag))
        : undefined,
    }))
    return {
      ...r,
      changelog: cleanChangelog(r.changelog),
      items: its,
      filtered: filterActive || undefined,
    }
  })

  return c.json({ entries, total: countResult?.total ?? 0 })
})
```

Shared item fetch (one query, grouped in JS). Note D1 has no array binding, so the `IN` placeholders are built dynamically:

```ts
import type { Context } from 'hono'

async function fetchItemsForReleases(c: Context<AppEnv>, ids: string[]) {
  const byRelease = new Map<
    string,
    Array<{ id: string; section: string; text: string; sort_order: number; tags: string[] }>
  >()
  if (ids.length === 0) return byRelease

  const placeholders = ids.map(() => '?').join(',')
  const rows = await c.env.DB.prepare(
    `SELECT ci.id, ci.changelog_id, ci.section, ci.text, ci.sort_order,
            it.tag AS tag
     FROM changelog_items ci
     LEFT JOIN item_tags it ON it.item_id = ci.id
     WHERE ci.changelog_id IN (${placeholders})
     ORDER BY ci.changelog_id, ci.sort_order`,
  )
    .bind(...ids)
    .all<{
      id: string
      changelog_id: string
      section: string
      text: string
      sort_order: number
      tag: string | null
    }>()

  const seen = new Map<string, { id: string; section: string; text: string; sort_order: number; tags: string[] }>()
  for (const row of rows.results) {
    let item = seen.get(row.id)
    if (!item) {
      item = { id: row.id, section: row.section, text: row.text, sort_order: row.sort_order, tags: [] }
      seen.set(row.id, item)
      const arr = byRelease.get(row.changelog_id) ?? []
      arr.push(item)
      byRelease.set(row.changelog_id, item ? arr : arr)
    }
    if (row.tag) item.tags.push(row.tag)
  }
  return byRelease
}
```

The `LEFT JOIN` keeps items that have no tags. Items arrive already ordered by `sort_order`; tags accumulate onto the same object. The `matched` flag lets the UI implement **show-only-matching vs show-all**: when a filter is active, render all items but visually dim/collapse the non-`matched` ones (or offer a toggle), so a filtered release still shows full context instead of hiding the surrounding bullets.

---

## 6. NEW filters `?tag=` and `?section=` — semantics recap

Already wired into the list handler above via the `existsClause`. The critical correctness points:

- **The EXISTS lives on the release query and the COUNT query identically** (`listBinds` feeds both). This is what makes "pagination over releases that have a match" correct — the count of pages equals the count of releases returned across pages.
- **`section` filter is an item-level `ci.section = ?`** inside the same EXISTS, so `?tag=android-auto&section=fix` means "releases that have at least one *fix item that is also tagged android-auto*" (both predicates on the *same* item, because they're `AND`ed inside one EXISTS subquery over `ci`). If you instead wanted "release has an android-auto item AND (separately) a fix item," you'd split into two EXISTS — the single-EXISTS form is the more intuitive one and is what I recommend.
- **Items in the response are NOT filtered out** — every item of a matching release is returned, each carrying `matched`. The server does not decide show-only-matching; it hands the UI the flag and lets the user toggle. This preserves the existing "render the whole release" UX.

---

## 7. GET /changelogs/filters — add tag + section universe with counts

Extends the existing date-tree handler. Two extra aggregate queries; the date tree logic is unchanged (still reads the header table, so it keeps working). Tag/section counts here are **counts of distinct releases** that contain a matching item (that's what a filter control wants to preview — "12 releases mention Android Auto"), respecting the channel filter.

```ts
app.get('/filters', async (c) => {
  const url = new URL(c.req.url)
  const channel = url.searchParams.get('channel') ?? 'release'

  const conditions: string[] = []
  if (channel === 'release') {
    conditions.push(
      "version NOT LIKE '%-Beta%' AND version NOT LIKE '%-Alpha%' AND version NOT LIKE '%-RC%'",
    )
  } else if (channel === 'beta') {
    conditions.push("(version LIKE '%-Beta%' OR version LIKE '%-Alpha%' OR version LIKE '%-RC%')")
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const [dateAgg, countResult, tagAgg, sectionAgg] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, product, version,
          CAST(strftime('%Y', released_at) AS INTEGER) as year,
          CAST(strftime('%m', released_at) AS INTEGER) as month
       FROM changelogs ${where}
       ORDER BY released_at DESC`,
    ).all(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM changelogs ${where}`).first<{ total: number }>(),
    // Distinct releases per tag (respect channel via the changelogs join).
    c.env.DB.prepare(
      `SELECT it.tag AS tag, COUNT(DISTINCT cl.id) AS count
       FROM item_tags it
       JOIN changelog_items ci ON ci.id = it.item_id
       JOIN changelogs cl ON cl.id = ci.changelog_id
       ${where.replace(/\bversion\b/g, 'cl.version')}
       GROUP BY it.tag
       ORDER BY count DESC, tag ASC`,
    ).all<{ tag: string; count: number }>(),
    // Distinct releases per section.
    c.env.DB.prepare(
      `SELECT ci.section AS section, COUNT(DISTINCT cl.id) AS count
       FROM changelog_items ci
       JOIN changelogs cl ON cl.id = ci.changelog_id
       ${where.replace(/\bversion\b/g, 'cl.version')}
       GROUP BY ci.section
       ORDER BY count DESC, section ASC`,
    ).all<{ section: string; count: number }>(),
  ])

  // ... existing yearMap build from dateAgg (unchanged) ...

  return c.json({
    years, // unchanged
    total: countResult?.total ?? 0,
    tags: tagAgg.results, // [{ tag, count }]
    sections: sectionAgg.results, // [{ section, count }]
  })
})
```

Small caveat on the `.replace(/\bversion\b/g, 'cl.version')`: the channel WHERE clause only ever references the bare column `version`, so this qualifier substitution is safe. If you prefer to avoid the regex, factor a `channelWhere(alias)` helper that emits `cl.version LIKE ...` directly — cleaner, and I'd do that in the real commit.

---

## 8. GET /resolve and DELETE — keep working, cascade children

**`/resolve` needs no change.** It reads header columns (`released_at`, `created_at`, `changelog`) which still exist. It returns the single entry's blob for the deep-link scroll. Optionally enrich it to also return `items` by calling `fetchItemsForReleases(c, [entry.id])` — one extra query — if you want the deep-linked card to render structured/tagged too. Minimal version:

```ts
app.get('/resolve', async (c) => {
  // ... unchanged position math ...
  const its = await fetchItemsForReleases(c, [entry.id as string])
  return c.json({
    entry: {
      ...entry,
      changelog: cleanChangelog(entry.changelog as string),
      items: its.get(entry.id as string) ?? [],
    },
    page,
  })
})
```

**DELETE must remove children explicitly** (D1 won't cascade in a batch):

```ts
app.delete('/:id', async (c) => {
  if (!hasApiKey(c)) return c.json({ error: 'Unauthorized' }, 401)
  const id = c.req.param('id')

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM item_tags WHERE item_id IN
         (SELECT id FROM changelog_items WHERE changelog_id = ?)`,
    ).bind(id),
    c.env.DB.prepare(`DELETE FROM changelog_items WHERE changelog_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM changelogs WHERE id = ?`).bind(id),
  ])

  return c.json({ ok: true })
})
```

Order matters: tags → items → header, so no orphan rows if anything short-circuits (though `batch()` is atomic anyway).

---

## 9. The SUI uploader field mismatch (item 6 of the ask)

The SUI `upload-changelog.sh` POSTs `addon_name` but this API keys on `product` (`UNIQUE(product, version)`; the WHERE builders and this whole schema reference `product`). **The new HS-Mobile uploader must send `product`, not `addon_name`.** Two ways to handle it:

- **Recommended:** the HS-Mobile port sends the correct field from day one — `{ product: "HearthShelf-Mobile", version, released_at, download_url, items: [...] }`. Since the mobile changelog script is being freshly ported (not a copy of the shipped SUI shell script), just emit `product`. Use a stable product key `HearthShelf-Mobile` (the UI's `displayProduct()` already strips the `HearthShelf-` prefix to show "Mobile").
- **Defensive belt-and-suspenders (optional):** accept a legacy alias in POST so a stray `addon_name` upload doesn't silently 400:

```ts
const product = body.product ?? (body as { addon_name?: string }).addon_name
if (!product) return c.json({ error: 'Missing product' }, 400)
```

I'd ship the recommended path (emit `product`) and skip the alias, since it's pre-release and there's no legacy uploader in this repo to be compatible with.

---

## Summary of what the mobile-side uploader must POST

```json
{
  "product": "HearthShelf-Mobile",
  "version": "0.1.0",
  "released_at": "2026-07-09T00:00:00Z",
  "download_url": "https://play.google.com/store/apps/details?id=...",
  "items": [
    { "section": "feature", "text": "Android Auto now shows a full browse menu" },
    { "section": "fix", "text": "iPhone no longer opens to a black screen", "tags": ["ios"] },
    { "section": "change", "text": "Sleep timer redesign with quiet-hours" }
  ]
}
```

The mobile changelog generator's job is: parse git commit subjects (same prefix rules as SUI — `new:`/`fixes:`/`improved:` → `feature`/`fix`/`change`), strip the verb prefix, and emit one `items[]` entry per commit with `section` set. It does **not** need to compute tags — the server auto-tags — but it *may* pass `tags` for anything the content heuristics would miss. No AI needed.

**Files to change on the Website (for the parent agent):**
- `C:\code\HearthShelf-Website\migrations\0001_changelogs.sql` — replace with the 3-table schema above (D1 is empty, safe to edit in place).
- `C:\code\HearthShelf-Website\functions\api\_shared\helpers.ts` — add `normalizeSection`, `computeTags`, `rebuildChangelogBlob`, `Section` type + `AUTO_TAG_RULES`.
- `C:\code\HearthShelf-Website\functions\api\_shared\types.ts` — add `ChangelogItemRow`, `ChangelogEntryOut`.
- `C:\code\HearthShelf-Website\functions\api\_routes\changelogs.ts` — rewrite POST (structured/batched), GET `/` (nested + tag/section EXISTS filter), GET `/filters` (tag+section universe), GET `/resolve` (optional item enrichment), DELETE (explicit child cascade); add the `fetchItemsForReleases` helper.
- `C:\code\HearthShelf-Website\src\pages\ChangelogPage.tsx` — consume `entry.items[]` + `matched` for the tag/section filter controls (separate frontend sub-problem, not covered here).

One correctness note for whoever wires the frontend: the existing client-side search (`ChangelogPage.tsx` line 458-467) searches `entry.changelog` — because the server still stores the rebuilt blob, that search keeps working unchanged. The new tag/section controls should drive `?tag=`/`?section=` URL params (server-side filter), not client-side, so pagination counts stay correct.