/**
 * "Is this book done?" - the client's answer, and where the user's settings meet
 * the pure rules in @hearthshelf/core.
 *
 * Two callers, deliberately given different evidence:
 *
 *  - endOfListenVerdict() runs when a listen ENDS (switching books, stopping).
 *    The player is still loaded, so it has chapter marks and can use the full
 *    chapter-aware rules - the trailing credits/bloopers run, the "stopped two
 *    seconds from the end of the last real chapter" case.
 *
 *  - sweepVerdict() runs later, over saved progress rows. Those carry no chapter
 *    data, so only the flat time buffer applies. It exists because a pause is
 *    not a decision: someone who pauses 40s from the end and opens a different
 *    book tomorrow never passes through the close path with that book loaded,
 *    and without this their book sits at 99% forever.
 *
 * Both only ever conclude "finished" - evaluateCompletion is a floor, never a
 * ceiling, so nothing here can un-finish a book.
 */
import { evaluateCompletion, type CompletionChapter } from '@hearthshelf/core'
import { getSettingsState } from '@/store/settings'

/** The user's finish settings as core thresholds. `finishBufferSec` 0 disables
 *  the time rule; the chapter rules still apply where chapters are known. */
function thresholds() {
  const s = getSettingsState()
  return {
    timeRemainingSec: Math.max(0, s.finishBufferSec ?? 0),
    lastChapterIsEndMatter: s.finishSkipEndMatter !== false,
  }
}

/** True when the user has turned the whole feature off (no buffer, no end-matter
 *  rule). Lets callers skip the work entirely. */
export function finishBufferDisabled(): boolean {
  const s = getSettingsState()
  return (s.finishBufferSec ?? 0) <= 0 && s.finishSkipEndMatter === false
}

/**
 * Verdict at the end of a listen, with chapters available. `ended` means the
 * engine genuinely reached end-of-media, which is finished regardless of
 * settings - that is a fact, not a preference.
 */
export function endOfListenVerdict(input: {
  currentTime: number
  duration: number
  chapters?: CompletionChapter[]
  ended?: boolean
}): { isFinished: boolean; reason: string | null } {
  if (!input.ended && finishBufferDisabled()) return { isFinished: false, reason: null }
  const r = evaluateCompletion({ ...input, thresholds: thresholds() })
  return { isFinished: r.isFinished, reason: r.reason }
}

/**
 * Verdict for a saved progress row (no chapters). Time buffer only.
 *
 * Requires a real position: a row at 0 is "never started", and a 3-minute book
 * would otherwise qualify from its first second on a 300s buffer.
 */
export function sweepVerdict(row: {
  currentTime: number
  duration: number
  isFinished: boolean
}): boolean {
  if (row.isFinished) return false
  if (!(row.duration > 0) || !(row.currentTime > 0)) return false
  const buffer = Math.max(0, getSettingsState().finishBufferSec ?? 0)
  if (buffer <= 0) return false
  // Never let the buffer swallow a whole short book: the listener must be past
  // the halfway mark before "nearly at the end" means anything.
  if (row.currentTime < row.duration / 2) return false
  return evaluateCompletion({
    currentTime: row.currentTime,
    duration: row.duration,
    thresholds: { timeRemainingSec: buffer },
  }).isFinished
}
