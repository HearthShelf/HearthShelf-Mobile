/**
 * Renders a flat note list as a threaded chat: top-level notes with their
 * one-level replies nested underneath. Each note shows the author's avatar +
 * name, an optional 'Chapter X - H:MM:SS' timestamp label, the body, and (for
 * the reader's own notes, or when onDelete is provided by a moderator) a delete
 * affordance. Pure presentation - all data + gating decisions are the caller's.
 *
 * Shared by the public NotesSheet and the Book Club room so both render chat the
 * same way.
 */
import { useMemo } from 'react'
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import type { HSNote } from '@hearthshelf/core'
import { coverHue, formatTimestamp } from '@hearthshelf/core'
import { avatarUrl } from '@/api/abs'
import { AppText, Avatar, IconButton, Touchable } from '@/ui/primitives'
import { icons } from '@/ui/icons'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export interface ChapterMark {
  title: string
  start: number
  end: number
}

/** "Chapter 3 - 1:02:05" for a timestamped note, or just the timestamp when no
 *  chapter list is available. null for a general (ungated) note. */
function stampLabel(timeSec: number | null, chapters: ChapterMark[]): string | null {
  if (timeSec == null) return null
  const ch = chapters.find((c) => timeSec >= c.start && timeSec < c.end)
  const ts = formatTimestamp(timeSec)
  return ch?.title ? `${ch.title} · ${ts}` : ts
}

function NoteBubble({
  note,
  chapters,
  meId,
  isReply,
  canModerate,
  highlighted,
  onReply,
  onDelete,
  onLayout,
}: {
  note: HSNote
  chapters: ChapterMark[]
  meId: string
  isReply?: boolean
  /** Club owner / admin may delete any note; otherwise only own notes. */
  canModerate?: boolean
  /** Deep-linked note to visually flag (from a note-pop notification tap). */
  highlighted?: boolean
  onReply?: (note: HSNote) => void
  onDelete?: (note: HSNote) => void
  /** Fires with this note's row layout so the parent can scroll it into view. */
  onLayout?: (e: LayoutChangeEvent) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const mine = note.userId === meId
  const stamp = stampLabel(note.timeSec, chapters)
  const canDelete = (mine || canModerate) && !!onDelete
  return (
    <View style={[styles.bubble, isReply && styles.replyBubble, highlighted && styles.highlighted]} onLayout={onLayout}>
      <Avatar uri={avatarUrl(note.userId)} size={30} name={note.username} hue={coverHue(note.userId)} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.metaRow}>
          <AppText variant="label" color={mine ? colors.accent : colors.text} numberOfLines={1}>
            {note.username || 'Someone'}
          </AppText>
          {stamp ? (
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {stamp}
            </AppText>
          ) : null}
        </View>
        <AppText variant="meta" style={{ marginTop: 2 }}>
          {note.body}
        </AppText>
        <View style={styles.actionsRow}>
          {onReply && !isReply ? (
            <Touchable hitSlop={6} onPress={() => onReply(note)}>
              <AppText variant="caption" color={colors.accent}>
                Reply
              </AppText>
            </Touchable>
          ) : null}
          {canDelete ? (
            <IconButton name={icons.close} size={15} color={colors.textFaint} onPress={() => onDelete?.(note)} />
          ) : null}
        </View>
      </View>
    </View>
  )
}

export function NoteThread({
  notes,
  chapters = [],
  meId,
  canModerate,
  highlightId,
  onReply,
  onDelete,
  onNoteLayout,
}: {
  notes: HSNote[]
  chapters?: ChapterMark[]
  meId: string
  canModerate?: boolean
  /** Note id to highlight + report layout for (deep-link from a note-pop). */
  highlightId?: string
  onReply?: (note: HSNote) => void
  onDelete?: (note: HSNote) => void
  /** Fires the highlighted note's y within the thread so the caller can scroll. */
  onNoteLayout?: (id: string, y: number) => void
}) {
  // Group replies under their parents; keep top-level notes in createdAt order.
  const { tops, repliesByParent } = useMemo(() => {
    const tops: HSNote[] = []
    const repliesByParent = new Map<string, HSNote[]>()
    for (const n of notes) {
      if (n.parentId) {
        const arr = repliesByParent.get(n.parentId) ?? []
        arr.push(n)
        repliesByParent.set(n.parentId, arr)
      } else {
        tops.push(n)
      }
    }
    tops.sort((a, b) => a.createdAt - b.createdAt)
    for (const arr of repliesByParent.values()) arr.sort((a, b) => a.createdAt - b.createdAt)
    return { tops, repliesByParent }
  }, [notes])

  return (
    <View>
      {tops.map((n) => {
        const replies = repliesByParent.get(n.id) ?? []
        // Report this group's y when the deep-linked note is this note or one of
        // its replies, so the caller scrolls the thread to it.
        const groupHoldsTarget =
          !!highlightId && (n.id === highlightId || replies.some((r) => r.id === highlightId))
        return (
          <View
            key={n.id}
            onLayout={
              groupHoldsTarget && onNoteLayout
                ? (e) => onNoteLayout(highlightId!, e.nativeEvent.layout.y)
                : undefined
            }
          >
            <NoteBubble
              note={n}
              chapters={chapters}
              meId={meId}
              canModerate={canModerate}
              highlighted={n.id === highlightId}
              onReply={onReply}
              onDelete={onDelete}
            />
            {replies.map((r) => (
              <NoteBubble
                key={r.id}
                note={r}
                chapters={chapters}
                meId={meId}
                isReply
                canModerate={canModerate}
                highlighted={r.id === highlightId}
                onDelete={onDelete}
              />
            ))}
          </View>
        )
      })}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    bubble: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    replyBubble: {
      marginLeft: spacing.xl,
      borderBottomWidth: 0,
      paddingVertical: spacing.sm,
    },
    highlighted: {
      backgroundColor: colors.accentWash,
      borderRadius: 8,
      paddingHorizontal: spacing.sm,
    },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    actionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.xs,
    },
  })

function useStyles() {
  const colors = useColors()
  return useMemo(() => makeStyles(colors), [colors])
}
