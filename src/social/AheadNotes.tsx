/**
 * The "coming up" block for spoiler-gated comments ahead of the reader.
 *
 * Every locked comment gets its own placeholder row - with its replies nested
 * under it, exactly like a real thread - so the shape of the discussion waiting
 * further in is visible. What is NOT shown is the content: the server sends
 * only { id, timeSec, parentId } for a locked note, withholding the body and
 * the author, so the rows draw redacted bars rather than text. There is no
 * client-side hiding here; the words genuinely never reached the device.
 *
 * Rows are ordered by position, so the next conversation is at the top.
 */
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import type { HSNoteStub } from '@hearthshelf/core'
import { formatTimestamp } from '@hearthshelf/core'
import { AppText } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** Threads drawn before the rest collapse into a "+N more" line. */
const MAX_THREADS = 4

interface StubThread {
  stub: HSNoteStub
  replies: HSNoteStub[]
}

/** Group locked stubs into parent threads, nearest position first. */
function buildThreads(stubs: HSNoteStub[]): StubThread[] {
  const byId = new Map<string, StubThread>()
  for (const s of stubs) {
    if (!s.parentId) byId.set(s.id, { stub: s, replies: [] })
  }
  const orphans: StubThread[] = []
  for (const s of stubs) {
    if (!s.parentId) continue
    const parent = byId.get(s.parentId)
    // A reply whose parent is already unlocked (so it has no stub) still
    // deserves a row - it stands on its own rather than vanishing.
    if (parent) parent.replies.push(s)
    else orphans.push({ stub: s, replies: [] })
  }
  return [...byId.values(), ...orphans].sort((a, b) => a.stub.timeSec - b.stub.timeSec)
}

export function AheadNotes({
  count,
  stubs = [],
  position,
}: {
  /** Total comments the server is withholding (hiddenAhead), replies included. */
  count: number
  /** Anonymous placeholders for those comments, when the server sent them. */
  stubs?: HSNoteStub[]
  /** The reader's position, so only genuinely-ahead rows are drawn. */
  position?: number
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const threads = useMemo(() => {
    const pos = position ?? 0
    return buildThreads(stubs.filter((s) => s.timeSec > pos))
  }, [stubs, position])

  if (count <= 0) return null

  const shown = threads.slice(0, MAX_THREADS)
  // Everything the server counted that we did not draw a row for.
  const drawn = shown.reduce((n, t) => n + 1 + t.replies.length, 0)
  const more = Math.max(0, count - drawn)

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <Icon name={icons.lock} size={16} color={colors.textMuted} />
        <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
          {count === 1 ? '1 comment' : `${count} comments`} further in. These unlock as your
          listening progresses.
        </AppText>
      </View>

      {shown.map((thread) => (
        <View key={thread.stub.id} style={styles.thread}>
          <PlaceholderRow stub={thread.stub} styles={styles} colors={colors} />
          {thread.replies.map((reply) => (
            <View key={reply.id} style={styles.replyIndent}>
              <PlaceholderRow stub={reply} isReply styles={styles} colors={colors} />
            </View>
          ))}
        </View>
      ))}

      {more > 0 ? (
        <AppText variant="caption" color={colors.textFaint} style={styles.more}>
          +{more} more further in
        </AppText>
      ) : null}
    </View>
  )
}

/** One redacted comment: where it sits in the book, and bars where text would be. */
function PlaceholderRow({
  stub,
  isReply,
  styles,
  colors,
}: {
  stub: HSNoteStub
  isReply?: boolean
  styles: ReturnType<typeof makeStyles>
  colors: Palette
}) {
  return (
    <View style={styles.row}>
      {/* A blank disc, not an avatar - the server withholds who wrote this. */}
      <View style={[styles.dot, isReply && styles.dotSmall]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="caption" color={colors.textMuted}>
          {isReply ? 'Reply' : `At ${formatTimestamp(stub.timeSec)}`}
        </AppText>
        <View style={styles.bars}>
          <View style={[styles.bar, { width: isReply ? '72%' : '90%' }]} />
          <View style={[styles.bar, { width: isReply ? '44%' : '58%' }]} />
        </View>
      </View>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    block: {
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      gap: spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    thread: { paddingTop: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      opacity: 0.55,
    },
    replyIndent: {
      paddingLeft: spacing.lg,
      paddingTop: spacing.sm,
    },
    dot: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.hairline,
    },
    dotSmall: { width: 16, height: 16, borderRadius: 8 },
    bars: { marginTop: spacing.xs, gap: 6 },
    bar: {
      height: 9,
      borderRadius: radius.pill,
      backgroundColor: colors.hairline,
    },
    more: { paddingTop: spacing.xs },
  })
