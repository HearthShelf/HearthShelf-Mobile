/**
 * Public notes sheet for a book: the unlocked note thread (with one level of
 * replies), a "notes ahead" teaser for spoiler-gated notes, and a composer for a
 * general (ungated) note. Shared by the book detail page and the player's
 * Notes/Club sheet.
 *
 * Spoiler safety is the server's job: GET /hs/notes returns only unlocked notes
 * plus a hiddenAhead count. This sheet re-gates optimistically with core's
 * gateNotes as position advances between fetches, but never invents note bodies.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import type { HSNote } from '@hearthshelf/core'
import { gateNotes } from '@hearthshelf/core'
import { getNotes, postNote, deleteNote } from '@/api/notes'
import { getMeId } from '@/api/me'
import { AppText, Avatar, IconButton, Sheet, Touchable, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { avatarUrl } from '@/api/abs'
import { coverHue } from '@hearthshelf/core'
import { NoteThread } from './NoteThread'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import type { SheetHandle } from '@/player/sheets'

export interface NotesSheetProps {
  libraryItemId: string | null
  /** The reader's position in the book, for the spoiler gate. */
  position: number
  /** True bypasses gating (the reader finished the book). */
  finished?: boolean
  onToast?: (message: string) => void
}

export const NotesSheet = forwardRef<SheetHandle, NotesSheetProps>(function NotesSheet(
  { libraryItemId, position, finished, onToast },
  ref,
) {
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => {
      void load()
      sheetRef.current?.present()
    },
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const meId = getMeId()

  const [notes, setNotes] = useState<HSNote[] | null>(null)
  const [hiddenAhead, setHiddenAhead] = useState(0)
  const [enabled, setEnabled] = useState(true)
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<HSNote | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!libraryItemId) return
    const res = await getNotes({ libraryItemId, position, finished })
    setEnabled(res.enabled)
    setNotes(res.notes)
    setHiddenAhead(res.hiddenAhead)
  }, [libraryItemId, position, finished])

  useEffect(() => {
    // Refresh when the caller's position moves enough to unlock something.
    if (notes && notes.length >= 0) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(position / 30)])

  // Optimistic re-gate of what we already hold as position advances.
  const gated = useMemo(() => {
    if (!notes) return { visible: [] as HSNote[], hiddenAhead }
    const g = gateNotes(notes, position, meId, finished ?? false)
    return { visible: g.visible, hiddenAhead: Math.max(hiddenAhead, g.hiddenAhead) }
  }, [notes, position, meId, finished, hiddenAhead])

  const submit = async () => {
    const text = body.trim()
    if (!text || !libraryItemId || busy) return
    setBusy(true)
    haptics.success()
    // A reply inherits its parent's gate; a top-level composer posts a general
    // (ungated) note - timestamped notes come from the player composer.
    const created = await postNote({
      libraryItemId,
      parentId: replyTo?.id ?? '',
      timeSec: null,
      body: text,
    })
    setBusy(false)
    if (created) {
      setBody('')
      setReplyTo(null)
      await load()
    } else {
      onToast?.('Could not post note')
    }
  }

  const remove = async (note: HSNote) => {
    haptics.warn()
    const ok = await deleteNote(note.id)
    if (ok) {
      setNotes((list) => (list ? list.filter((n) => n.id !== note.id && n.parentId !== note.id) : list))
      onToast?.('Note deleted')
    } else {
      onToast?.('Could not delete note')
    }
  }

  return (
    <Sheet ref={sheetRef} title="Notes" snapPoints={['85%']}>
      {!enabled ? (
        <AppText variant="meta" color={colors.textMuted} style={styles.empty}>
          Notes are turned off on this server.
        </AppText>
      ) : notes === null ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : (
        <BottomSheetScrollView contentContainerStyle={{ paddingBottom: spacing.xxl }}>
          {gated.visible.length === 0 ? (
            <AppText variant="meta" color={colors.textMuted} style={styles.empty}>
              No notes yet. Be the first to leave one.
            </AppText>
          ) : (
            <NoteThread
              notes={gated.visible}
              meId={meId}
              onReply={(n) => setReplyTo(n)}
              onDelete={remove}
            />
          )}
          {gated.hiddenAhead > 0 ? (
            <View style={styles.teaser}>
              <Icon name={icons.notes} size={16} color={colors.textMuted} />
              <AppText variant="caption" color={colors.textMuted}>
                {gated.hiddenAhead} {gated.hiddenAhead === 1 ? 'note is' : 'notes are'} ahead of you.
                Keep listening to unlock them.
              </AppText>
            </View>
          ) : null}
        </BottomSheetScrollView>
      )}

      {enabled ? (
        <View style={styles.composer}>
          {replyTo ? (
            <View style={styles.replyBanner}>
              <Avatar
                uri={avatarUrl(replyTo.userId)}
                size={20}
                name={replyTo.username}
                hue={coverHue(replyTo.userId)}
              />
              <AppText variant="caption" color={colors.textMuted} numberOfLines={1} style={{ flex: 1 }}>
                Replying to {replyTo.username}
              </AppText>
              <IconButton name={icons.close} size={16} color={colors.textMuted} onPress={() => setReplyTo(null)} />
            </View>
          ) : null}
          <View style={styles.composerRow}>
            <TextInput
              style={styles.input}
              placeholder={replyTo ? 'Write a reply…' : 'Leave a note about this book…'}
              placeholderTextColor={colors.textFaint}
              value={body}
              onChangeText={setBody}
              multiline
              maxLength={2000}
            />
            <Touchable
              style={[styles.sendBtn, (!body.trim() || busy) && { opacity: 0.5 }]}
              disabled={!body.trim() || busy}
              onPress={() => void submit()}
            >
              <Icon name={icons.send} size={18} color={colors.onAccent} />
            </Touchable>
          </View>
        </View>
      ) : null}
    </Sheet>
  )
})

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    empty: { textAlign: 'center', paddingVertical: spacing.xl },
    teaser: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
    },
    composer: { paddingTop: spacing.sm, gap: spacing.sm },
    replyBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    input: {
      flex: 1,
      maxHeight: 120,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: colors.text,
      fontSize: 15,
    },
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
  })
