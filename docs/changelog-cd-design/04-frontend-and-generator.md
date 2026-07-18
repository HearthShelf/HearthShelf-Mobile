I have full context. Here is the implementation-ready design for my sub-problem.

---

# HearthShelf-Mobile changelog: structured items (frontend + bash)

## Schema recap this assumes (owned by the sibling sub-problem, stated so the code lines up)

The POST payload becomes `{ product, version, released_at, download_url, items: [{ section, text, tags[] }] }`. The API stores items in a child table and `GET /changelogs` returns each entry with an `items` array; `GET /changelogs/filters` additionally returns a flat `tags` list; both `GET /` and `/filters` gain a `tag` (comma-separated, OR-match) and `section` filter. My TSX and bash below are written to that contract. `section` is one of `feature | fix | change | docs | breaking | other`; the card renders it with the same four color buckets the old `detectKind` used.

---

## PART 1 — `src/pages/ChangelogPage.tsx`

### 1a. Types (replace the `ChangelogEntry` block, lines 26-33)

```tsx
type ItemSection = 'feature' | 'fix' | 'change' | 'docs' | 'breaking' | 'other'

interface ChangelogItem {
  section: ItemSection
  text: string
  tags: string[]
}

interface ChangelogEntry {
  id: string
  product: string
  version: string
  released_at: string
  download_url: string | null
  items: ChangelogItem[]
  // `changelog` kept optional only for a legacy blob fallback (see renderer)
  changelog?: string | null
}
```

Extend `FiltersResponse` (after `YearInfo`, near line 61) with the tag facet:

```tsx
interface TagFacet {
  tag: string
  label: string
  count: number
}

interface FiltersResponse {
  years: YearInfo[]
  tags: TagFacet[]
  total: number
}
```

### 1b. Section presentation map — replace `detectKind` / `renderMarkdown` (lines 129-185)

`detectKind` parsed verbs at render time. That job now belongs to the generator (it knows the commit prefix authoritatively). The frontend only maps the stored `section` to a color/label, and formats inline emphasis. Drop `renderMarkdown`, drop the `DOMPurify` and `dangerouslySetInnerHTML` usage entirely (remove the `import DOMPurify` on line 3) — plain React is safer and we no longer inject HTML.

```tsx
const SECTION_META: Record<ItemSection, { label: string; color: string }> = {
  breaking: { label: 'BREAKING', color: 'rgb(220,41,38)' },
  feature: { label: 'ADDED', color: 'rgb(74,222,128)' },
  fix: { label: 'FIXED', color: 'rgb(251,191,36)' },
  change: { label: 'CHANGED', color: 'rgb(96,165,250)' },
  removed: { label: 'REMOVED', color: 'rgb(220,41,38)' }, // reserved; generator emits change
  docs: { label: 'DOCS', color: 'rgb(148,163,184)' },
  other: { label: 'NOTE', color: 'rgb(148,163,184)' },
} as Record<string, { label: string; color: string }>

const SECTION_ORDER: ItemSection[] = ['breaking', 'feature', 'fix', 'change', 'docs', 'other']

/** Friendly tag label: "android-auto" -> "Android Auto", "ios" -> "iOS". */
function tagLabel(tag: string): string {
  if (tag === 'ios') return 'iOS'
  if (tag === 'aa' || tag === 'android-auto') return 'Android Auto'
  return tag.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

/**
 * Minimal inline formatter: **bold** and [text](url). Returns React nodes, never
 * raw HTML — no sanitizer needed because we never dangerouslySetInnerHTML.
 */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      nodes.push(<strong key={key++}>{m[1]}</strong>)
    } else {
      nodes.push(
        <a
          key={key++}
          href={m[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          {m[2]}
        </a>,
      )
    }
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
```

### 1c. New URL params + derived state (inside the component, alongside lines 227-233)

```tsx
const activeTags = (searchParams.get('tag') ?? '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)
const activeSection = (searchParams.get('section') as ItemSection | null) ?? null
```

Update `hasFilters` (line 469) and `totalActiveCount` (line 494) to include them:

```tsx
const hasFilters =
  activeYear !== null ||
  channel !== 'release' ||
  query.length > 0 ||
  activeTags.length > 0 ||
  activeSection !== null

const totalActiveCount =
  (channel !== 'release' ? 1 : 0) +
  (activeYear !== null ? (activeMonth !== null ? 2 : 1) : 0) +
  (query.length > 0 ? 1 : 0) +
  activeTags.length +
  (activeSection !== null ? 1 : 0)
```

### 1d. Wire tag/section into fetches

**Entries fetch** (lines 272-296) — add to the `params` builder, keep the `[searchParams]` dep:

```tsx
if (activeTags.length > 0) params.set('tag', activeTags.join(','))
if (activeSection) params.set('section', activeSection)
```

**Filters fetch** (lines 243-269) — the tag facet is channel-scoped like the date tree, so key it on channel too (`filtersLoadedForKey` already keys on `channel`; no change to the key). `result.tags` now comes back on the same response.

### 1e. Tag/section param setters (near the other `useCallback`s, ~line 451)

```tsx
const toggleTag = useCallback(
  (tag: string) => {
    const next = new Set(activeTags)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    const joined = Array.from(next).join(',')
    updateParams({ tag: joined.length > 0 ? joined : null })
  },
  [activeTags, updateParams],
)

const setSection = useCallback(
  (section: ItemSection | null) => {
    updateParams({ section })
  },
  [updateParams],
)
```

`updateParams` already deletes on `null` and resets the page — no change needed there. `clearAllFilters` already wipes the whole query string, so it covers `tag`/`section` for free.

### 1f. Search now scans item text (replace `visibleEntries`, lines 458-467)

Server-side `tag`/`section` filtering already narrows the result set; the client search stays as the fast in-page refinement, now over structured text:

```tsx
const visibleEntries = query
  ? entries.filter((e) => {
      const q = query.toLowerCase()
      return (
        e.product.toLowerCase().includes(q) ||
        e.version.toLowerCase().includes(q) ||
        e.items.some(
          (it) => it.text.toLowerCase().includes(q) || it.tags.some((t) => t.includes(q)),
        )
      )
    })
  : entries
```

`countChanges` (lines 123-127) becomes `entry.items.length` at the call site (line 899): `const changeCount = entry.items.length` — delete the old `countChanges` helper.

### 1g. Tag + Section filter control (new sidebar section — insert before the `{/* Date Tree */}` block, ~line 551)

Matches the existing Channel/Time-range panel styling exactly.

```tsx
{/* Section filter */}
<div className="border-b border-border px-4 py-3">
  <div className="mb-2 flex items-center gap-2">
    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
      Type
    </span>
    {activeSection !== null && (
      <span className="min-w-[18px] rounded-full bg-primary px-1.5 py-px text-center text-[10px] font-bold text-primary-foreground">
        1
      </span>
    )}
  </div>
  <div className="flex flex-wrap gap-1.5">
    {SECTION_ORDER.map((s) => {
      const active = activeSection === s
      const meta = SECTION_META[s]
      return (
        <button
          key={s}
          onClick={() => setSection(active ? null : s)}
          className={cn(
            'cursor-pointer rounded-md border px-2 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors',
            active ? 'border-transparent text-background' : 'border-border bg-transparent',
          )}
          style={active ? { background: meta.color } : { color: meta.color }}
        >
          {meta.label}
        </button>
      )
    })}
  </div>
</div>

{/* Tag filter */}
{(filters?.tags?.length ?? 0) > 0 && (
  <div className="border-b border-border px-4 py-3">
    <div className="mb-2 flex items-center gap-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        Tags
      </span>
      {activeTags.length > 0 && (
        <span className="min-w-[18px] rounded-full bg-primary px-1.5 py-px text-center text-[10px] font-bold text-primary-foreground">
          {activeTags.length}
        </span>
      )}
    </div>
    <div className="flex flex-wrap gap-1.5">
      {filters!.tags.map((t) => {
        const active = activeTags.includes(t.tag)
        return (
          <button
            key={t.tag}
            onClick={() => toggleTag(t.tag)}
            className={cn(
              'flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
              active
                ? 'border-primary bg-primary/15 font-medium text-primary'
                : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Tag className="h-3 w-3" />
            {tagLabel(t.tag)}
            <span className="text-[10px] tabular-nums opacity-70">{t.count}</span>
          </button>
        )
      })}
    </div>
  </div>
)}
```

Add `Tag` to the lucide import (line 6-19). Also add active-filter removal chips next to the existing ones (after the `query` chip, ~line 846):

```tsx
{activeSection && (
  <Badge
    variant="secondary"
    className="cursor-pointer gap-1 pl-2.5 pr-1.5"
    onClick={() => setSection(null)}
  >
    {SECTION_META[activeSection].label}
    <X className="h-3 w-3" />
  </Badge>
)}
{activeTags.map((t) => (
  <Badge
    key={t}
    variant="secondary"
    className="cursor-pointer gap-1 pl-2.5 pr-1.5"
    onClick={() => toggleTag(t)}
  >
    {tagLabel(t)}
    <X className="h-3 w-3" />
  </Badge>
))}
```

### 1h. Card body — structured items with the chosen tag UX (replace the `dangerouslySetInnerHTML` block, lines 972-982)

**Decided UX:** the server already restricts *which releases* appear when a tag/section is active. Within a shown card, matching lines render at full strength and non-matching lines dim to `opacity-40` (kept visible, not hidden — a release card that fully hid its non-matching lines reads as "this whole release was about X," which is misleading). Items are grouped by section in `SECTION_ORDER`, each line carries its color badge and its own tag chips (clickable to add that tag to the filter).

```tsx
{/* Card body — structured items */}
{entry.items.length > 0 ? (
  <div className="space-y-4">
    {SECTION_ORDER.map((section) => {
      const rows = entry.items.filter((it) => it.section === section)
      if (rows.length === 0) return null
      const meta = SECTION_META[section]
      return (
        <div key={section}>
          <ul className="space-y-1.5">
            {rows.map((it, i) => {
              const matches =
                (activeSection === null || activeSection === it.section) &&
                (activeTags.length === 0 || activeTags.some((t) => it.tags.includes(t)))
              return (
                <li
                  key={i}
                  className={cn(
                    'flex flex-wrap items-start gap-x-3 gap-y-1 text-sm leading-relaxed transition-opacity',
                    !matches && hasFilters && 'opacity-40',
                  )}
                >
                  <span
                    className="mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-center text-[10px] font-bold uppercase tracking-widest"
                    style={{ background: 'var(--muted)', color: meta.color, minWidth: 62 }}
                  >
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 text-foreground">{renderInline(it.text)}</span>
                  {it.tags.length > 0 && (
                    <span className="flex flex-wrap items-center gap-1">
                      {it.tags.map((t) => (
                        <button
                          key={t}
                          onClick={() => toggleTag(t)}
                          className={cn(
                            'cursor-pointer rounded-full border px-1.5 py-px text-[10px] transition-colors',
                            activeTags.includes(t)
                              ? 'border-primary bg-primary/15 text-primary'
                              : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {tagLabel(t)}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )
    })}
  </div>
) : (
  entry.changelog && (
    <p className="text-sm text-muted-foreground">{entry.changelog}</p>
  )
)}
```

Channel tabs, date-tree sidebar, pagination, deep-link/copy-link, scroll-to-top, and the `resolve` flow are all untouched — they operate on entries/versions, not on the body, so they keep working. The `resolve` response shape only needs `items` added alongside `changelog` (already covered by the optional field). This removes the last `dangerouslySetInnerHTML` in the file; delete `import DOMPurify from 'dompurify'`.

---

## PART 2 — bash generator + uploader

**Recommendation: option (b), one script emitting JSON.** Reasons that decide it: (1) round-tripping markdown back into items (option a) re-parses text you already categorized once — every regex change has to stay in sync in two places; (2) the SUI markdown carries emoji section headers (`### 🐛 Fixes`) that a re-parser would have to strip and re-map, and tags never survive into markdown at all, so option (a) literally cannot recover them; (3) with structured items as the source of truth, `CHANGELOG.md` is a trivial render *from* the items, not a parse *target*. So: git log → items JSON (authoritative) → both the API payload and `CHANGELOG.md` derive from it.

Put both files in `C:/code/HearthShelf-Mobile/.github/scripts/`.

### 2a. `changelog-items.sh` — git log → structured items JSON

Reuses the SUI categorize regex set (condensed) but emits `{section,text,tags}` per commit and derives tags from content. Tags come from two sources: **explicit trailing markers** the committer writes (`[android-auto]`, `#ios`) and **content keyword inference** (so existing commit style needs no change). `jq` is preinstalled on `ubuntu-latest`.

```bash
#!/usr/bin/env bash
# Emit a structured changelog for one release as JSON:
#   { product, version, released_at, download_url, items:[{section,text,tags[]}] }
# on stdout. Categorization mirrors the commit-prefix conventions; tags are
# derived from explicit [tag]/#tag markers plus content keyword inference.
#
# Env:
#   PRODUCT           product key stored on the website (default HearthShelf-Mobile)
#   VERSION           release version, no leading v (default: derived from GITHUB_REF_NAME)
#   DOWNLOAD_URL      optional store/download link
#   GITHUB_REF_NAME   tag name on tag push (e.g. v0.1.0)
set -euo pipefail

PRODUCT="${PRODUCT:-HearthShelf-Mobile}"
REF_NAME="${GITHUB_REF_NAME:-$(git describe --tags --abbrev=0 2>/dev/null || echo '')}"
VERSION="${VERSION:-${REF_NAME#v}}"
DOWNLOAD_URL="${DOWNLOAD_URL:-}"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- Commit range: prev tag .. this tag; first-ever tag => whole history ---
THIS_REF="${REF_NAME:-HEAD}"
PREV_TAG="$(git describe --tags --abbrev=0 "${THIS_REF}^" 2>/dev/null || echo '')"
if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${THIS_REF}"
else
  RANGE="$THIS_REF"   # no previous tag: all reachable commits
fi

# --- section: map a commit subject to a section slug ---
categorize() {
  local m="$1" low; low="$(printf '%s' "$m" | tr '[:upper:]' '[:lower:]')"
  case "$m" in
    breaking:*|BREAKING:*) echo breaking; return;;
    docs:*|documentation:*) echo docs; return;;
  esac
  case "$low" in
    feat:*|feature:*|new:*|enhancement:*) echo feature; return;;
    fix:*|fixes:*|bug:*|bugfix:*) echo fix; return;;
    chore:*|refactor:*|style:*|perf:*|improved:*) echo change; return;;
  esac
  # natural-language leading verbs
  if [[ "$low" =~ ^(fix|fixes|fixed|fixing|silence|suppress|protect|protects|ensure|ensures|guard|guards)([[:space:]:\-]) ]]; then echo fix; return; fi
  if [[ "$low" =~ ^(add|adds|added|adding|new|implement|implements|implemented|integrate|integrates|integrated|register|registers|monitor|track|respect)([[:space:]:\-]) ]]; then echo feature; return; fi
  if [[ "$low" =~ ^(improve|improves|improved|enhance|enhances|update|updates|refactor|refactors|cleanup|clean[[:space:]]up|reorganize|simplify|migrate|migrates|move|moves|moved|remove|removes|removed|delete|deletes|switch|replace|replaces|bundle)([[:space:]:\-]) ]]; then echo change; return; fi
  echo other
}

# --- clean: strip the leading verb/prefix so the line reads as a change ---
clean_subject() {
  local m="$1"
  m="$(printf '%s' "$m" | sed -E 's/^(feat|feature|fix|fixes|bug|bugfix|chore|refactor|style|perf|docs|documentation|breaking|new|enhancement|improved):[[:space:]]+//I')"
  m="$(printf '%s' "$m" | sed -E 's/^(Fixes|Fixed|Fixing|Fix|Adds|Added|Adding|Add|Implements|Implemented|Implement|Improves|Improved|Improving|Improve|Enhances|Enhanced|Enhance|Updates|Updated|Update|Refactors|Refactored|Refactor|Cleanup|Removes|Removed|Remove|Deletes|Deleted|Delete|Integrates|Integrated|Integrate|Registers|Registered|Register|Silence|Suppress|Protects|Protect|Ensures|Ensure|Guards|Guard|Switches|Switch|Replaces|Replace|Moves|Moved|Move|Migrates|Migrated|Migrate)[[:space:]:\-]+//I')"
  # drop explicit trailing tag markers from the display text
  m="$(printf '%s' "$m" | sed -E 's/[[:space:]]*(\[[a-zA-Z0-9_/-]+\]|#[a-zA-Z0-9_/-]+)+[[:space:]]*$//')"
  m="$(printf '%s' "$m" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  # capitalize first letter
  printf '%s' "$m" | sed -E 's/^(.)/\U\1/'
}

# --- tags: explicit markers + content keyword inference; echo one per line ---
extract_tags() {
  local m="$1" low; low="$(printf '%s' "$m" | tr '[:upper:]' '[:lower:]')"
  {
    # explicit [tag] and #tag markers, normalized to lowercase slugs
    printf '%s\n' "$m" | grep -oE '(\[[a-zA-Z0-9_/-]+\]|#[a-zA-Z0-9_/-]+)' \
      | tr -d '[]#' | tr '[:upper:]' '[:lower:]'
    # content inference
    case "$low" in
      *"android auto"*|*androidauto*|*" auto "*|*carplay*) echo android-auto;; esac
    case "$low" in *ios*|*iphone*|*ipad*|*apple*|*testflight*) echo ios;; esac
    case "$low" in *android*) echo android;; esac
    case "$low" in *offline*|*download*) echo offline;; esac
    case "$low" in *sleep\ timer*|*sleep-timer*) echo sleep-timer;; esac
  } | sed -E 's#^aa$#android-auto#' | sort -u | grep -v '^$' || true
}

# --- build items JSON array ---
ITEMS='[]'
while IFS= read -r subject; do
  [ -z "$subject" ] && continue
  section="$(categorize "$subject")"
  text="$(clean_subject "$subject")"
  [ -z "$text" ] && continue
  tags_json="$(extract_tags "$subject" | jq -R . | jq -sc .)"
  ITEMS="$(jq -c \
    --arg section "$section" --arg text "$text" --argjson tags "$tags_json" \
    '. += [{section:$section, text:$text, tags:$tags}]' <<<"$ITEMS")"
done < <(git log "$RANGE" --no-merges --pretty='%s')

jq -n \
  --arg product "$PRODUCT" \
  --arg version "$VERSION" \
  --arg released_at "$RELEASED_AT" \
  --arg download_url "$DOWNLOAD_URL" \
  --argjson items "$ITEMS" \
  '{product:$product, version:$version, released_at:$released_at,
    download_url:(if $download_url=="" then null else $download_url end),
    items:$items}'
```

Three load-bearing details: `git log "$RANGE"` with a bare `$THIS_REF` (no `..`) walks *all reachable commits* which is exactly the correct first-tag fallback; process substitution (not a pipe) keeps the loop in the current shell so `$ITEMS` survives; and the pretty format is **`--pretty='%s'`, never `--pretty=format:'%s'`**.

That last one shipped as `format:` originally and was a real bug. `format:` omits the trailing newline after the last line, and `read` returns non-zero on an unterminated final line — so bash silently dropped the *oldest* commit of every range. It went unnoticed for two releases (0.0.3 published 134 of 135 items) until a single-commit release produced zero items and the API rejected the payload outright: `Missing required fields: product, version, released_at, items[]`. The loop also carries `|| [ -n "$subject" ]` so a regression here can't re-introduce the silent drop.

### 2b. `upload-changelog.sh` — POST the JSON

```bash
#!/usr/bin/env bash
# POST the structured changelog for the current tag to the HearthShelf website.
# Renders CHANGELOG.md from the same items as a side effect.
set -euo pipefail

API_URL="${CHANGELOG_API_URL:-https://hearthshelf.com/api/v1/changelogs}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${CHANGELOG_API_KEY:-}" ]; then
  echo "SKIP: CHANGELOG_API_KEY not set" >&2; exit 0
fi
if [ -n "${GITHUB_REF:-}" ] && [[ ! "$GITHUB_REF" =~ ^refs/tags/ ]]; then
  echo "SKIP: not a tag push ($GITHUB_REF)" >&2; exit 0
fi

PAYLOAD="$("$SCRIPT_DIR/changelog-items.sh")"
COUNT="$(jq '.items | length' <<<"$PAYLOAD")"
VERSION="$(jq -r '.version' <<<"$PAYLOAD")"
echo "Uploading $COUNT items for version $VERSION" >&2

# Render CHANGELOG.md from the same structured items (committed/attached elsewhere).
{
  echo "# HearthShelf Mobile $VERSION"
  echo
  for section in breaking feature fix change docs other; do
    label="$(jq -r --arg s "$section" '
      {breaking:"### Breaking Changes",feature:"### Features",fix:"### Fixes",
       change:"### Changes",docs:"### Documentation",other:"### Other"}[$s]' <<<'{}')"
    rows="$(jq -r --arg s "$section" '.items[]|select(.section==$s)|
      "- " + .text + (if (.tags|length)>0 then " (" + (.tags|join(", ")) + ")" else "" end)' \
      <<<"$PAYLOAD")"
    [ -n "$rows" ] && { echo "$label"; echo; echo "$rows"; echo; }
  done
} > CHANGELOG.md

HTTP_CODE="$(curl -sS -o /tmp/cl-resp.json -w '%{http_code}' \
  --connect-timeout 10 --max-time 30 -X POST "$API_URL" \
  -H "Authorization: Bearer $CHANGELOG_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD")" || { echo "curl failed" >&2; exit 0; }

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "SUCCESS ($HTTP_CODE): $(cat /tmp/cl-resp.json)"
else
  echo "ERROR ($HTTP_CODE): $(cat /tmp/cl-resp.json)" >&2; exit 1
fi
```

Note the field fix versus SUI: this POSTs `product` (not `addon_name`) and nests `items`, matching the website API. No `.addon-release.yml`, no AI, no `cleanChangelog` scaffolding to strip because we never emit the "This Release"/`## Version` headings the cleaner was written to remove.

### 2c. Workflow — new `.github/workflows/changelog.yml` (runs on tag push)

```yaml
name: Publish changelog
on:
  push:
    tags: ['v*']

jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # full history + tags so PREV..TAG resolves
          submodules: false
      - name: Publish structured changelog to hearthshelf.com
        env:
          CHANGELOG_API_KEY: ${{ secrets.CHANGELOG_API_KEY }}
          CHANGELOG_API_URL: https://hearthshelf.com/api/v1/changelogs
          PRODUCT: HearthShelf-Mobile
          DOWNLOAD_URL: https://play.google.com/store/apps/details?id=com.hearthshelf.mobile
          # GITHUB_REF / GITHUB_REF_NAME are provided automatically
        run: |
          chmod +x .github/scripts/changelog-items.sh .github/scripts/upload-changelog.sh
          .github/scripts/upload-changelog.sh
```

`fetch-depth: 0` is required — the default shallow checkout has neither the previous tag nor the commits between tags, so the range would be empty.

---

## On Part A (version source of truth) — the piece that touches CI, flagged for the sibling/parent

Directly relevant to my scripts: `VERSION` is derived from `GITHUB_REF_NAME` (`v0.1.0` → `0.1.0`), so the **tag is already the version source of truth for the changelog**. For the *signed build* to match without a manual file bump, `app.config.js:54` (`version: '0.0.1'`) should read the tag: `version: process.env.EXPO_APP_VERSION || '0.0.1'`, and `build-android-release.yml` should stamp `EXPO_APP_VERSION=${GITHUB_REF_NAME#v}` on tag-triggered runs (same shape as the existing `EXPO_ANDROID_VERSION_CODE=run_number` stamp). That keeps `runtimeVersion: { policy: 'appVersion' }` correct (OTA keyed to the tag) with zero manual edits. I did not modify those files — noting it because the answer to the user's A question is "no manual bump needed, make `version` env-driven from the tag," and it must line up with the `PRODUCT`/`VERSION` contract my uploader uses.

---

## Files (all absolute; none written)

- Frontend to edit: `C:\code\HearthShelf-Website\src\pages\ChangelogPage.tsx`
- New bash: `C:\code\HearthShelf-Mobile\.github\scripts\changelog-items.sh`, `C:\code\HearthShelf-Mobile\.github\scripts\upload-changelog.sh`
- New workflow: `C:\code\HearthShelf-Mobile\.github\workflows\changelog.yml`
- Version-source change (Part A, for sibling): `C:\code\HearthShelf-Mobile\app.config.js:54` + `C:\code\HearthShelf-Mobile\.github\workflows\build-android-release.yml`

Key contract my two parts share with the API/schema sub-problem: POST body `{ product, version, released_at, download_url, items:[{section,text,tags[]}] }`; `GET /changelogs` returns `entries[].items`; `GET /changelogs/filters` returns `tags:[{tag,label,count}]`; both accept `tag` (comma = OR) and `section` query params. `section ∈ {feature,fix,change,docs,breaking,other}`. Product key: `HearthShelf-Mobile`.