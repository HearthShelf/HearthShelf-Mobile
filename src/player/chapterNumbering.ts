/**
 * Smart chapter numbering for the chapters tray.
 *
 * Books are inconsistent about chapter titles:
 *  - Some already number every chapter ("1. The Ducks", "2. ...") - we must NOT
 *    double-number those; the title already carries it.
 *  - Some name chapters plainly ("The Ducks", "Mostly Dead") - a leading number
 *    genuinely helps you keep your place, so we compute one.
 *  - Either kind is usually preceded by front matter (Intro, Credits, Recap,
 *    Prologue...) that isn't "Chapter N" and shouldn't be counted - the first
 *    real chapter should read as 1, not 3.
 *
 * `numberChapters(titles)` returns a parallel array of display labels: the
 * original title when the book self-numbers or the row is front matter, and
 * "N. Title" for real chapters in a book that doesn't number its own.
 */

// Front-matter / non-chapter titles that should never get a chapter number. We
// match the FIRST word (or the whole short title) so "Prologue: A Beginning"
// still counts as front matter but "Introducing Kate" (a real chapter) does not.
const FRONT_MATTER = new Set([
  'intro',
  'introduction',
  'credits',
  'opening',
  'recap',
  'prologue',
  'prolog',
  'epilogue',
  'foreword',
  'forward',
  'preface',
  'afterword',
  'acknowledgments',
  'acknowledgements',
  'dedication',
  'appendix',
  'glossary',
  'notes',
  'author',
  'about',
  'preview',
  'excerpt',
  'bonus',
  'interlude',
  'map',
  'cast',
  'characters',
  'contents',
])

/** A leading number the title carries itself: "12", "12.", "12 -", "12:",
 *  "Chapter 12", "Ch. 12". Captures the number so we can reject 4-digit years. */
const SELF_NUMBER_RE = /^\s*(?:chapter|chap\.?|ch\.?)?\s*(\d{1,4})\b\s*[.:)\-–—]?/i

/** True when the title starts with its own chapter number (not a year). A bare
 *  4-digit leading number is treated as a year ("1984", "2003") and does NOT
 *  count as self-numbering, to avoid the year false-positive. A number preceded
 *  by an explicit "Chapter"/"Ch" word always counts, even if 4 digits. */
export function hasOwnNumber(title: string): boolean {
  const m = SELF_NUMBER_RE.exec(title)
  if (!m) return false
  const hadWord = /^\s*(?:chapter|chap\.?|ch\.?)\b/i.test(title)
  if (hadWord) return true
  // Bare leading number: reject a 4-digit year-like value.
  return m[1].length < 4
}

/** True when the title is front matter (Intro, Credits, Prologue, ...). */
export function isFrontMatter(title: string): boolean {
  const first = title
    .trim()
    .toLowerCase()
    .replace(/^[^a-z]+/, '') // strip leading punctuation/space
    .split(/[\s:.\-–—]+/)[0]
  return FRONT_MATTER.has(first)
}

/**
 * Given the ordered chapter titles, return display labels. When the book already
 * numbers a meaningful share of its chapters, every label is the raw title
 * (never double-numbered). Otherwise real (non-front-matter) chapters get a
 * running "N. Title" starting at 1, and front matter keeps its plain title.
 */
export function numberChapters(titles: string[]): string[] {
  // Consider only the chapters that aren't front matter when deciding whether the
  // book self-numbers - a "Credits" intro shouldn't sway the vote.
  const realTitles = titles.filter((t) => !isFrontMatter(t))
  const selfNumbered = realTitles.filter(hasOwnNumber).length
  // If a third or more of the real chapters carry their own number, treat the
  // whole book as self-numbered and leave titles untouched.
  const bookSelfNumbers = realTitles.length > 0 && selfNumbered / realTitles.length >= 0.34

  if (bookSelfNumbers) return titles.slice()

  let n = 0
  return titles.map((t) => {
    if (isFrontMatter(t)) return t
    n += 1
    return `${n}. ${t}`
  })
}
