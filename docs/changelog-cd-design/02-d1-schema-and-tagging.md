I now have everything I need: the exact section vocabulary (`feature`, `fix`, `change`, `docs`, `breaking`, plus an `other` fallback), the existing render-time `detectKind` mapping (added/fixed/changed/removed), the channel `LIKE`-based logic, and the current single-blob schema. Here is the complete design for my sub-problem.

---

# D1 Schema Evolution + Tagging Engine — Implementation-Ready Design

## 0. Verified grounding (what the existing code dictates)

- Generator's canonical **sections**: `feature | fix | change | docs | breaking | other` (`generate-changelog.sh:250-282`). This is the vocabulary the payload carries.
- Render-time `detectKind` (`ChangelogPage.tsx:130`) collapses to display kinds `added / fixed / changed / removed` by re-parsing verb prefixes. **The enhancement moves that knowledge into stored data** so it's authoritative, not re-derived.
- Channel is derived from `version LIKE '%-Beta%' / '%-Alpha%' / '%-RC%'` (`changelogs.ts:89`, `helpers.ts:40`). The new schema must keep `version` on the header row so this keeps working untouched.
- Current PK is `nanoid()` TEXT, `UNIQUE(product, version)`, upsert on conflict (`changelogs.ts:33`). We preserve that shape for the header.
- **D1 remote is empty (zero rows). No data migration exists or is needed.**

---

## 1. NEW D1 SCHEMA

### Decisions (with the weigh-off)

**Header + child items: YES — split.** A `changelog_releases` header (one row per product+version, carrying everything the channel/date-tree/resolve queries need) plus a `changelog_items` child. The date-tree (`/filters`), channel filter, and `/resolve` page math all operate at *release* granularity — they must stay release-scoped, so keeping a header row is not just convenient, it's required for those three endpoints to keep working with near-identical SQL.

**Tags representation: JOIN TABLE, not a TEXT/JSON column.** This is the load-bearing choice, so here's the actual weigh-off:

| | TEXT/JSON column on item (`tags` = `'["ios","player"]'`) | `changelog_item_tags(item_id, tag)` join table |
|---|---|---|
| "show all android-auto items" | `WHERE tags LIKE '%"android-auto"%'` — no index help, full scan, and `LIKE '%player%'` false-matches `sleep-player` etc. `json_each` works but can't be indexed in D1 without a generated-column dance. | `WHERE t.tag = ?` on an indexed column — sargable, exact, fast. |
| Filter by 2 tags (AND) | Nested `LIKE … AND LIKE …`, ugly, unindexed. | `GROUP BY … HAVING COUNT(DISTINCT tag) = 2`, indexed. |
| Distinct tag list for the filter UI | Parse JSON in app code across all rows. | `SELECT DISTINCT tag … ORDER BY tag` — one indexed query. |
| Write cost | 1 UPDATE. | N inserts (N ≈ 0-3 per item). Trivial at changelog volume. |
| SQLite fit | JSON1 is present but D1 discourages hot-path `json_each` scans. | Textbook relational, textbook index. |

**Recommendation: the join table.** The primary requirement is literally "filter show-all-AA-items" and "sort by tag" over potentially large changelogs — that is exactly what an indexed join column does and exactly what a JSON `LIKE` scan does badly. Tag cardinality is tiny (a dozen), so the join table stays small.

**Additive `0002` vs replace `0001`: REPLACE `0001`.** D1 is empty and this is pre-release (breaking changes explicitly allowed per `CLAUDE.local.md`). An additive migration that alters a table it's about to obsolete is pure noise in the migration history. Rewrite `0001_changelogs.sql` in place to the new shape. The old `changelogs` table is dropped in the same file so a fresh `wrangler d1 migrations apply` on any environment lands cleanly. (If you'd already applied `0001` to a *shared* remote you couldn't reset, you'd go additive — but this remote is empty, so replace is correct and cleaner.)

**Keep the denormalized blob? KEEP one rendered `changelog` markdown column on the header — but as a generated cache, not the source of truth.** Weigh-off:

- *Drop entirely (items-only):* every list render must `JOIN` items and reassemble markdown; client-side search (`ChangelogPage.tsx:458`, which greps `e.changelog`) breaks and must be rebuilt against items.
- *Keep a rendered blob alongside items:* the `GET /` list endpoint can still return `changelog` for cheap card rendering and the existing search-over-blob keeps working **unchanged**, while the new structured `/items` endpoint powers section/tag filtering. Storage cost is negligible.

**Recommendation: keep it, denormalized.** Store both: `items` are authoritative and structured; `changelog` is a rendered convenience blob the server assembles from the items at upload time. Belt-and-suspenders that lets the existing page keep working on day one while the structured UI is built on top. The server owns assembly, so they can never drift (the client never writes the blob).

### Migration SQL — replace `migrations/0001_changelogs.sql` entirely

```sql
-- HearthShelf changelog store.
-- One RELEASE header per (product, version); many structured ITEMS per release;
-- many TAGS per item. `changelog` on the header is a server-rendered markdown
-- cache assembled from items at upload time (never client-authored) so the
-- existing list/search UI keeps working while structured filtering is built on
-- top of the item + tag tables.
-- Pre-release: D1 is empty, so we drop the old single-blob table outright.
DROP TABLE IF EXISTS changelogs;
DROP TABLE IF EXISTS changelog_item_tags;
DROP TABLE IF EXISTS changelog_items;
DROP TABLE IF EXISTS changelog_releases;

-- ---------------------------------------------------------------------------
-- Release header: one row per (product, version). Carries everything the
-- channel filter, date-tree, and /resolve page math need at release grain.
-- ---------------------------------------------------------------------------
CREATE TABLE changelog_releases (
  id           TEXT PRIMARY KEY,               -- nanoid()
  product      TEXT NOT NULL,                  -- stable slug, e.g. 'HearthShelf-Mobile'
  version      TEXT NOT NULL,                  -- '0.1.0', '0.2.0-Beta1' (channel via LIKE)
  released_at  TEXT NOT NULL,                  -- ISO8601; drives date tree + ordering
  download_url TEXT,
  changelog    TEXT NOT NULL DEFAULT '',       -- server-rendered markdown cache of items
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(product, version)
);

-- Ordering + date-tree scans (matches existing ORDER BY released_at DESC, created_at DESC).
CREATE INDEX idx_releases_released_at
  ON changelog_releases(released_at DESC, created_at DESC);
-- Product-scoped queries (list filter, /resolve position count).
CREATE INDEX idx_releases_product
  ON changelog_releases(product, released_at DESC);

-- ---------------------------------------------------------------------------
-- Structured line items: one row per changelog bullet. `section` is the
-- generator's canonical category (authoritative, no longer re-parsed at render).
-- ---------------------------------------------------------------------------
CREATE TABLE changelog_items (
  id         TEXT PRIMARY KEY,                 -- nanoid()
  release_id TEXT NOT NULL
             REFERENCES changelog_releases(id) ON DELETE CASCADE,
  section    TEXT NOT NULL,                    -- feature|fix|change|docs|breaking|other
  text       TEXT NOT NULL,                    -- the bullet body, verb-prefix already cleaned
  sort_order INTEGER NOT NULL DEFAULT 0,       -- preserves generator emission order
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Fetch + order all items for a release (card render).
CREATE INDEX idx_items_release
  ON changelog_items(release_id, sort_order);
-- Filter/sort by section across releases.
CREATE INDEX idx_items_section
  ON changelog_items(section);

-- ---------------------------------------------------------------------------
-- Item tags: exact, indexed, multi-valued. One row per (item, tag).
-- Tags are lowercase kebab slugs from the server-side rules engine (+explicit).
-- ---------------------------------------------------------------------------
CREATE TABLE changelog_item_tags (
  item_id TEXT NOT NULL
          REFERENCES changelog_items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,                       -- 'android-auto', 'ios', 'player', ...
  PRIMARY KEY (item_id, tag)                   -- dedupe explicit+auto overlap for free
);

-- "show all items tagged android-auto" + distinct-tag list for the filter UI.
CREATE INDEX idx_item_tags_tag
  ON changelog_item_tags(tag, item_id);
```

Notes that matter:
- `ON DELETE CASCADE` means the existing `DELETE /changelogs/:id` (now delete-a-release) wipes items and tags in one statement — **but D1/SQLite requires `PRAGMA foreign_keys = ON` per connection**, which D1 does *not* guarantee. Safer: keep the cascade declared for intent, and have the DELETE handler explicitly delete children first (three statements in a `batch()`), so it works regardless of the FK pragma. State this in the API handler, don't rely on cascade.
- `PRIMARY KEY (item_id, tag)` on the tag table makes explicit+auto tag merges idempotent: inserting the same tag twice is a no-op conflict, so the engine can blindly union both sets and `INSERT OR IGNORE`.
- The composite `idx_item_tags_tag(tag, item_id)` is a covering index for both "which items have tag X" and "list distinct tags".

---

## 2. THE TAGGING ENGINE

### Where: **SERVER-SIDE, at insert time (Hono).** Recommended and here's why it wins concretely:

- **Rules live in one place, re-runnable.** A future re-tag ("we added a `carplay` tag, re-scan history") is one server loop over stored `text`, not re-running a bash generator across N repos' git history. The bash generator can't even *see* other products' items.
- **The generator already runs per-repo in CI**; putting product-specific audiobook rules there means every repo that uploads must carry the same rule table. Centralizing on the website (which is the single consumer) is DRY.
- **The payload already carries `text` and `section`.** The server has everything it needs. The generator's *only* job re: tags is to pass through any *explicit* overrides the human wrote — it doesn't run rules.

So: **generator emits `section` + `text` (+ any explicit tags it parsed); server runs the auto-rules and unions them with the explicit set.**

### The rules map (hardcoded module, e.g. `functions/api/_shared/tagRules.ts`)

Each rule: a `tag` slug + a case-insensitive keyword/regex matched against item `text`. Ordered, all-matching (an item can get several tags). Kept deliberately small — ~10 rules — to avoid over-tagging noise.

```ts
// functions/api/_shared/tagRules.ts
// Auto-tag rules for HearthShelf changelog line items. Matched case-insensitively
// against the item's text. An item may receive multiple tags. Keep this list
// short and tasteful — over-tagging makes the filter useless.
//
// Slugs are lowercase kebab-case and are the stable public tag vocabulary.
export interface TagRule {
  tag: string
  // Word-boundary regex, case-insensitive. Use \b to avoid substring false hits.
  match: RegExp
}

export const TAG_RULES: TagRule[] = [
  // --- Platform / surface -------------------------------------------------
  { tag: 'android-auto', match: /\bandroid auto\b|\bhead unit\b/i },
  { tag: 'carplay',      match: /\bcarplay\b/i },
  { tag: 'ios',          match: /\b(ios|iphone|ipad|apple|testflight|app store)\b/i },
  { tag: 'android',      match: /\b(android|google play|\.aab\b|apk)\b/i },

  // --- Feature areas (audiobook app) --------------------------------------
  { tag: 'offline',      match: /\boffline\b/i },
  { tag: 'downloads',    match: /\bdownload(s|ed|ing)?\b/i },
  { tag: 'sleep-timer',  match: /\bsleep(\s|-)?timer\b|\bsleep mode\b/i },
  { tag: 'player',       match: /\b(player|playback|now playing|mini[- ]?player|scrubb|chapter)\b/i },
  { tag: 'sync',         match: /\b(sync(ed|ing|s)?|progress sync|resume position)\b/i },
  { tag: 'sign-in',      match: /\b(sign[- ]?in|sign[- ]?up|log[- ]?in|auth(entication)?|clerk)\b/i },
  { tag: 'series',       match: /\bseries\b/i },
]
```

Design intent baked in:
- **`android-auto` matches BEFORE generic `android`** — but since all rules run and both can apply, note that "Android Auto" text will get **both** `android-auto` and (via `\bandroid\b`) `android`. Decide: either accept the pair (Auto items also show under the broad android filter — arguably correct), or make the `android` rule negative-lookahead `android(?! auto)`. **Recommendation: keep both.** An Android Auto fix *is* an Android fix; the finer tag co-exists. If you dislike it, change `android` to `/\bandroid\b(?!\s+auto)|\bgoogle play\b|\.aab\b|apk/i`.
- `carplay` and `ios` both fire on a CarPlay item — again, correct (CarPlay is iOS).
- Regexes use `\b` boundaries so `downloads` doesn't match `reloads`, `sync` doesn't match `syntax`, `series` doesn't match inside random words.

### Explicit override in the commit/changelog line

**Syntax: trailing bracket tags `[aa]` and/or hashtags `#ios` at the END of the bullet text.** Both accepted; both stripped from the displayed text before storage. Design:

- **Bracket form** `[tag]` — supports a short-alias table so a human can type `[AA]` and get `android-auto`. Case-insensitive.
- **Hashtag form** `#tag` — the literal slug, `#sleep-timer`. (Bracket is friendlier for aliases; hashtag for exact slugs.)
- Both may appear, space-separated, only in a trailing run: `Fix chapter skip on the head unit [AA] #player`.

Alias table (so humans don't have to remember exact slugs):

```ts
// Short human aliases -> canonical tag slug. Applied to explicit [..] / #.. tokens only.
export const TAG_ALIASES: Record<string, string> = {
  aa: 'android-auto',
  auto: 'android-auto',
  cp: 'carplay',
  apple: 'ios',
  iphone: 'ios',
  dl: 'downloads',
  sleep: 'sleep-timer',
}
```

Parse + merge function (server-side, called per item):

```ts
// functions/api/_shared/tagging.ts
import { TAG_RULES } from './tagRules'
import { TAG_ALIASES } from './tagRules'

const TRAILING_TOKEN = /(?:\s+(?:\[[a-z0-9-]+\]|#[a-z0-9-]+))+\s*$/i
const ONE_TOKEN = /\[([a-z0-9-]+)\]|#([a-z0-9-]+)/gi

function slug(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9-]/g, '')
  return TAG_ALIASES[s] ?? s
}

/**
 * Parse trailing explicit tags off a bullet, returning the cleaned display text
 * plus the explicit tag set. Explicit tags are authoritative user intent.
 * Only a trailing run of tokens is consumed, so "[beta] note" mid-sentence is left alone.
 */
export function extractExplicitTags(text: string): { text: string; tags: string[] } {
  const m = text.match(TRAILING_TOKEN)
  if (!m) return { text: text.trim(), tags: [] }
  const tags = new Set<string>()
  let tok
  while ((tok = ONE_TOKEN.exec(m[0])) !== null) {
    const t = slug(tok[1] ?? tok[2] ?? '')
    if (t) tags.add(t)
  }
  return { text: text.slice(0, m.index).trim(), tags: [...tags] }
}

/** Auto rules on cleaned text. */
export function autoTags(text: string): string[] {
  const tags = new Set<string>()
  for (const rule of TAG_RULES) if (rule.match.test(text)) tags.add(rule.tag)
  return [...tags]
}

/**
 * Full pipeline for one item: strip explicit tokens, run auto-rules on the
 * CLEAN text, union explicit (authoritative) on top. Payload-supplied `tags`
 * (from the generator) are treated as explicit too.
 */
export function resolveItemTags(
  rawText: string,
  payloadTags: string[] = [],
): { text: string; tags: string[] } {
  const { text, tags: explicit } = extractExplicitTags(rawText)
  const union = new Set<string>([...explicit, ...payloadTags.map((t) => slug(t)), ...autoTags(text)])
  return { text, tags: [...union] }
}
```

**Merge semantics: explicit ∪ auto, deduped.** Explicit tags never *suppress* auto (union, not override). If you want a suppression escape hatch (rare), a `#!ios` "negate" token could remove `ios` from the auto set — I'd **defer that**; union is enough and the `PRIMARY KEY(item_id, tag)` makes dedupe free. Auto-rules always run on the **cleaned** text (after trailing tokens stripped) so an explicit `[AA]` at the end never confuses a keyword rule.

---

## 3. UPLOAD PAYLOAD SHAPE

`section` travels as structured data (the generator already computed it — no server re-parse). `tags?` is optional per item and carries *explicit* tags the generator parsed or a human hand-authored; **the server runs auto-rules on top**.

```jsonc
// POST /api/v1/changelogs   (Bearer CHANGELOG_API_KEY)
{
  "product": "HearthShelf-Mobile",     // stable slug
  "version": "0.1.0",                  // channel derived via LIKE, unchanged
  "released_at": "2026-07-09T00:00:00Z",
  "download_url": "https://play.google.com/store/apps/details?id=...",  // optional
  "items": [
    { "section": "feature", "text": "Add a full browse menu to Android Auto" },
    { "section": "fix",     "text": "Fix chapter skip on the head unit",
      "tags": ["player"] },                 // explicit hint; server adds android-auto
    { "section": "fix",     "text": "iPhone no longer opens to a black screen" },
    { "section": "change",  "text": "Sleep timer now warns you before it stops" },
    { "section": "change",  "text": "Downloads survive going offline [offline]" }
  ]
}
```

Server insert flow (in `changelogs.ts` POST handler), described not written:
1. Auth (`hasApiKey`) + validate `product/version/released_at/items[]` non-empty.
2. Upsert `changelog_releases` on `(product, version)` conflict (same pattern as today).
3. On upsert, **delete existing children for that release_id** (re-upload = full replace of items — matches today's blob-overwrite semantics), via `batch()`.
4. For each item, in payload order: `resolveItemTags(item.text, item.tags)` → gives clean `text` + unioned `tags`; insert `changelog_items(id, release_id, section, clean_text, sort_order=index)`; `INSERT OR IGNORE` each tag into `changelog_item_tags`.
5. **Assemble the denormalized `changelog` markdown cache** from the items (group by section in the generator's canonical order — Breaking, Features, Fixes, Changes, Docs, Other — emit `### Heading` + `- text` lines, matching what `cleanChangelog`/`renderMarkdown` already expect) and write it to `changelog_releases.changelog`. This keeps the existing `GET /` list card and client-side search working with **zero frontend changes on day one**.
6. Do the whole thing in a `c.env.DB.batch([...])` so a partial upload can't leave orphaned items.

Backward-compat shim (optional, tasteful): if an old-style payload arrives with a `changelog` blob and **no** `items`, accept it — split the blob into bullets, infer `section` per line with the same verb map `detectKind` uses, and run it through the same pipeline. Lets the reference `upload-changelog.sh` work before the generator is upgraded. **Recommend building the shim** since the SUI `upload-changelog.sh` still sends a blob (and, per the task, sends `addon_name` not `product` — the shim is also where you'd map that field).

---

## 4. Data migration & the blob decision — final statements

- **No data migration.** Remote D1 is empty (zero rows), so `0001` is rewritten in place; `wrangler d1 migrations apply` on a clean DB produces the new schema directly. Nothing to backfill.
- **Keep the blob, denormalized and server-owned.** `changelog_releases.changelog` is a rendered cache assembled from items at upload time; items are the source of truth. This is the recommended middle path over both "items-only" (breaks existing search + forces an immediate frontend rewrite) and "blob-only" (defeats the entire enhancement). The client never writes it, so it cannot drift.

---

## Endpoints this schema enables (for the API/frontend sub-tasks that follow)

Not my sub-problem to implement, but the schema is shaped to make these one indexed query each:
- `GET /changelogs` — unchanged; still returns header rows incl. rendered `changelog` blob (channel/date/product filters untouched).
- `GET /changelogs/tags` — `SELECT tag, COUNT(*) FROM changelog_item_tags GROUP BY tag ORDER BY tag` → filter UI vocabulary.
- `GET /changelogs/items?section=fix&tag=android-auto&product=HearthShelf-Mobile` — join `items`→`item_tags`→`releases`, filter by indexed `section` and `tag`, sort by `section`/`released_at`. This is the "filter and sort large changelogs by section and tag" payoff.
- `/filters` and `/resolve` — **unchanged**, still release-grained against `changelog_releases`.

**Files referenced (all absolute):**
- `C:\code\HearthShelf-Website\migrations\0001_changelogs.sql` — replace with the SQL above.
- `C:\code\HearthShelf-Website\functions\api\_shared\tagRules.ts` — new (rules + aliases).
- `C:\code\HearthShelf-Website\functions\api\_shared\tagging.ts` — new (extract/auto/resolve).
- `C:\code\HearthShelf-Website\functions\api\_routes\changelogs.ts` — POST handler reworked to items+tags+batch; DELETE deletes children explicitly (don't rely on FK cascade); GET keeps returning the blob.
- `C:\code\HearthShelf-Website\functions\api\_shared\helpers.ts` — `cleanChangelog`/`buildChangelogWhere` stay; add a section-grouped markdown assembler for the blob cache.