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
import { Image, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import type { HSNote, NoteReactionKind } from '@hearthshelf/core'
import { coverHue, formatTimestamp } from '@hearthshelf/core'
import { avatarUrl } from '@/api/abs'
import { AppText, Avatar, IconButton, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export interface ChapterMark {
  title: string
  start: number
  end: number
}

/** "Chapter 3 - 1:02:05" for a timestamped note, or just the timestamp when no
 *  chapter list is available. null for a general (ungated) note. */
export function stampLabel(timeSec: number | null, chapters: ChapterMark[]): string | null {
  if (timeSec == null) return null
  const ch = chapters.find((c) => timeSec >= c.start && timeSec < c.end)
  const ts = formatTimestamp(timeSec)
  return ch?.title ? `${ch.title} · ${ts}` : ts
}

/**
 * How each reaction kind is drawn and described.
 *
 * Keyed loosely rather than by an exhaustive Record<NoteReactionKind, ...>: the
 * server stores any well-formed kind, so a newer client's reaction can reach an
 * older build. Those fall back to a neutral glyph and still show their count,
 * which is the whole point of storing kinds as strings.
 */
const REACTIONS: Record<string, { glyph: string; label: string }> = {
  up: { glyph: '\u{1F44D}', label: 'thumbs up' },
  heart: { glyph: '\u{2764}\u{FE0F}', label: 'heart' },
  laugh: { glyph: '\u{1F602}', label: 'laugh' },
}

export function reactionGlyph(kind: string): string {
  return REACTIONS[kind]?.glyph ?? '\u{2B50}'
}

export function reactionLabel(kind: string): string {
  return REACTIONS[kind]?.label ?? kind
}

/** Escape a username for use inside a RegExp alternation. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A note body with its @mentions picked out. Splits on the exact usernames the
 * server recorded (note.mentions) rather than guessing at "@word", so a name
 * containing a space highlights as one mention and a stray "@" in prose does not.
 *
 * Each mention renders as the person's avatar followed by their name - the
 * avatar stands in for the "@", which is a sigil the picker needed but a reader
 * does not. Tapping opens their profile when the caller supports it.
 */
function NoteBody({ note, onOpenUser }: { note: HSNote; onOpenUser?: (userId: string) => void }) {
  const colors = useColors()
  const styles = useStyles()
  const parts = useMemo(() => {
    const mentions = (note.mentions ?? []).filter((m) => m.username)
    if (mentions.length === 0) return null
    // Longest first so "@ann marie" wins over "@ann".
    const ordered = [...mentions].sort((a, b) => b.username.length - a.username.length)
    const byName = new Map(ordered.map((m) => [m.username.toLowerCase(), m.userId]))
    const pattern = new RegExp(
      `@(?:${ordered.map((m) => escapeRegExp(m.username)).join('|')})`,
      'gi',
    )
    const out: Array<string | { name: string; userId: string }> = []
    let last = 0
    for (const match of note.body.matchAll(pattern)) {
      const at = match.index ?? 0
      if (at > last) out.push(note.body.slice(last, at))
      const name = match[0].slice(1)
      out.push({ name, userId: byName.get(name.toLowerCase()) ?? '' })
      last = at + match[0].length
    }
    if (last < note.body.length) out.push(note.body.slice(last))
    return out
  }, [note.body, note.mentions])

  if (!parts) {
    return (
      <AppText variant="meta" style={{ marginTop: 2 }}>
        {note.body}
      </AppText>
    )
  }
  return (
    <AppText variant="meta" style={{ marginTop: 2 }}>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          // The avatar replaces the "@" sigil - it was only ever there for the
          // picker. Rendered as an inline Image rather than the Avatar view, so
          // it flows inside the text run and wraps with it on both platforms.
          <Text
            key={i}
            style={styles.mention}
            onPress={part.userId && onOpenUser ? () => onOpenUser(part.userId) : undefined}
            suppressHighlighting={!part.userId || !onOpenUser}
          >
            <Image
              source={{ uri: avatarUrl(part.userId) }}
              style={styles.mentionAvatar}
              accessibilityIgnoresInvertColors
            />
            {` ${part.name}`}
          </Text>
        ),
      )}
    </AppText>
  )
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
  onOpenUser,
  onReact,
  onLongPress,
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
  /** Open a reader's profile. Omitted by callers with nowhere to send them. */
  onOpenUser?: (userId: string) => void
  /** Toggle one reaction kind. Omitted where reacting isn't offered. */
  onReact?: (note: HSNote, kind: NoteReactionKind, on: boolean) => void
  /** Long-press this note (opens the caller's action menu). */
  onLongPress?: (note: HSNote) => void
  /** Fires with this note's row layout so the parent can scroll it into view. */
  onLayout?: (e: LayoutChangeEvent) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const mine = note.userId === meId
  const stamp = stampLabel(note.timeSec, chapters)
  const canDelete = (mine || canModerate) && !!onDelete
  return (
    <Pressable
      style={[styles.bubble, isReply && styles.replyBubble, highlighted && styles.highlighted]}
      onLayout={onLayout}
      disabled={!onLongPress}
      onLongPress={() => onLongPress?.(note)}
      delayLongPress={300}
      accessibilityHint={onLongPress ? 'Long press for comment actions' : undefined}
    >
      <Touchable
        disabled={!onOpenUser || !note.userId}
        onPress={() => onOpenUser?.(note.userId)}
        accessibilityRole={onOpenUser ? 'button' : undefined}
        accessibilityLabel={onOpenUser ? `View ${note.username || 'reader'}'s profile` : undefined}
      >
        <Avatar
          uri={avatarUrl(note.userId)}
          size={30}
          name={note.username}
          hue={coverHue(note.userId)}
        />
      </Touchable>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.metaRow}>
          <Touchable
            disabled={!onOpenUser || !note.userId}
            onPress={() => onOpenUser?.(note.userId)}
            accessibilityRole={onOpenUser ? 'button' : undefined}
          >
            <AppText variant="label" color={mine ? colors.accent : colors.text} numberOfLines={1}>
              {note.username || 'Someone'}
            </AppText>
          </Touchable>
          {stamp ? (
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {stamp}
            </AppText>
          ) : null}
          {/* A personal note is only ever the author's own; flag it so they know
              nobody else can see it. A safe note shows early to everyone. */}
          {note.visibility === 'personal' ? (
            <View style={styles.chip}>
              <Icon name={icons.lock} size={11} color={colors.textMuted} />
              <AppText variant="caption" color={colors.textMuted}>
                Only you
              </AppText>
            </View>
          ) : null}
          {note.safe ? (
            <View style={[styles.chip, styles.chipSafe]}>
              <Icon name={icons.shield} size={11} color={colors.accent} />
              <AppText variant="caption" color={colors.accent}>
                Safe
              </AppText>
            </View>
          ) : null}
        </View>
        <NoteBody note={note} onOpenUser={onOpenUser} />
        <View style={styles.actionsRow}>
          {onReply && !isReply ? (
            <Touchable hitSlop={6} onPress={() => onReply(note)}>
              <AppText variant="caption" color={colors.accent}>
                Reply
              </AppText>
            </Touchable>
          ) : null}
          {canDelete ? (
            <IconButton
              name={icons.close}
              size={15}
              color={colors.textFaint}
              onPress={() => onDelete?.(note)}
            />
          ) : null}
        </View>
        {/* Tallies for every kind that has at least one reactor. A kind this
            build has no icon for still shows its count, so a reaction added by
            a newer client is never invisible here. */}
        {note.reactions?.length ? (
          <View style={styles.reactRow}>
            {note.reactions.map((r) => (
              <Touchable
                key={r.kind}
                style={[styles.reactChip, r.mine && styles.reactChipOn]}
                disabled={!onReact}
                onPress={() => onReact?.(note, r.kind, !r.mine)}
                accessibilityRole="button"
                accessibilityState={{ selected: r.mine }}
                accessibilityLabel={`${r.count} ${reactionLabel(r.kind)}${r.mine ? ', including you' : ''}`}
              >
                <AppText variant="caption" color={r.mine ? colors.accent : colors.textMuted}>
                  {reactionGlyph(r.kind)} {r.count}
                </AppText>
              </Touchable>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
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
  onOpenUser,
  onReact,
  onLongPress,
  onNoteLayout,
  newSinceTs,
}: {
  notes: HSNote[]
  chapters?: ChapterMark[]
  meId: string
  canModerate?: boolean
  /** Note id to highlight + report layout for (deep-link from a note-pop). */
  highlightId?: string
  onReply?: (note: HSNote) => void
  onDelete?: (note: HSNote) => void
  /** Open a reader's profile from their name, avatar, or an @mention of them.
   *  Omitted by callers with nowhere to send them. */
  onOpenUser?: (userId: string) => void
  /** Toggle one reaction kind on a note. Omitted where reacting isn't offered. */
  onReact?: (note: HSNote, kind: NoteReactionKind, on: boolean) => void
  /** Long-press a note, for the caller's action menu. */
  onLongPress?: (note: HSNote) => void
  /** Fires the highlighted note's y within the thread so the caller can scroll. */
  onNoteLayout?: (id: string, y: number) => void
  /** When set, a "new since last visit" divider renders before the first
   *  top-level note created after this timestamp. */
  newSinceTs?: number
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

  const colors = useColors()
  // The first top-level note newer than the last-visit cursor gets a divider
  // above it. null when nothing is new (or no cursor supplied).
  const firstNewId =
    newSinceTs != null ? (tops.find((n) => n.createdAt > newSinceTs)?.id ?? null) : null

  return (
    <View>
      {tops.map((n) => {
        const replies = repliesByParent.get(n.id) ?? []
        const showNewDivider = n.id === firstNewId
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
            {showNewDivider ? (
              <View style={newStyles.newRow}>
                <View style={[newStyles.newLine, { backgroundColor: colors.accent }]} />
                <AppText variant="caption" color={colors.accent}>
                  new since last visit
                </AppText>
                <View style={[newStyles.newLine, { backgroundColor: colors.accent }]} />
              </View>
            ) : null}
            <NoteBubble
              note={n}
              chapters={chapters}
              meId={meId}
              canModerate={canModerate}
              highlighted={n.id === highlightId}
              onReply={onReply}
              onDelete={onDelete}
              onOpenUser={onOpenUser}
              onReact={onReact}
              onLongPress={onLongPress}
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
                onOpenUser={onOpenUser}
                onReact={onReact}
                onLongPress={onLongPress}
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
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingVertical: 1,
      paddingHorizontal: spacing.sm,
      borderRadius: 999,
      backgroundColor: colors.fill,
    },
    chipSafe: { backgroundColor: colors.accentWash },
    mention: { color: colors.accent, fontWeight: '600' },
    reactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    reactChip: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.fill,
    },
    reactChipOn: { borderColor: colors.accent, backgroundColor: colors.accentWash },
    // Sized to sit on the text baseline rather than the cap height, so the row
    // does not grow taller than an unmentioned line.
    mentionAvatar: { width: 14, height: 14, borderRadius: 7 },
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

// A subtle "new since last visit" divider between read and unread notes.
const newStyles = StyleSheet.create({
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginVertical: spacing.sm,
  },
  newLine: { flex: 1, height: StyleSheet.hairlineWidth, opacity: 0.6 },
})
