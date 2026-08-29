/**
 * Public notes sheet for a book: the unlocked note thread (with one level of
 * replies), a redacted placeholder block for the spoiler-gated comments ahead
 * of the reader, and a composer for a general (ungated) note. Shared by the
 * book detail page and the player's Notes/Club sheet.
 *
 * Spoiler safety is the server's job: GET /hs/notes returns only unlocked notes
 * plus a hiddenAhead count. This sheet re-gates optimistically with core's
 * gateNotes as position advances between fetches, but never invents note bodies.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSyncExternalStore } from 'react'
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import type { HSNote, HSNoteStub } from '@hearthshelf/core'
import { gateNotes } from '@hearthshelf/core'
import { getNotes, postNote, deleteNote } from '@/api/notes'
import { getMeId } from '@/api/me'
import { AppText, Avatar, IconButton, Sheet, Touchable, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { avatarUrl } from '@/api/abs'
import { coverHue } from '@hearthshelf/core'
import { NoteThread } from './NoteThread'
import { AheadNotes } from './AheadNotes'
import { VisibilityToggle, SafeSwitch } from './NoteComposerControls'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import {
  getSettingsState,
  subscribeSettings,
  setSetting,
  type NoteDefaultVisibility,
} from '@/store/settings'
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
  const [lockedStubs, setLockedStubs] = useState<HSNoteStub[]>([])
  const [enabled, setEnabled] = useState(true)
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<HSNote | null>(null)
  const [busy, setBusy] = useState(false)

  // Composer visibility defaults to the remembered Public/Personal choice; Safe
  // always starts OFF (a deliberate per-note opt-in).
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const [visibility, setVisibility] = useState<NoteDefaultVisibility>(
    settings.noteDefaultVisibility,
  )
  const [safe, setSafe] = useState(false)
  // Adopt the remembered default whenever it changes and we're not mid-edit.
  useEffect(() => {
    if (!body) setVisibility(settings.noteDefaultVisibility)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.noteDefaultVisibility])

  const load = useCallback(async () => {
    if (!libraryItemId) return
    const res = await getNotes({ libraryItemId, position, finished })
    setEnabled(res.enabled)
    setNotes(res.notes)
    setHiddenAhead(res.hiddenAhead)
    setLockedStubs(res.locked)
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
    // A reply inherits its parent's gate + visibility; a top-level composer posts
    // a general (ungated) note - timestamped notes come from the player composer.
    const isReply = !!replyTo
    const created = await postNote({
      libraryItemId,
      parentId: replyTo?.id ?? '',
      timeSec: null,
      visibility: isReply ? undefined : visibility,
      safe: isReply ? false : safe,
      body: text,
    })
    setBusy(false)
    if (created) {
      // Remember the Public/Personal choice for next time (top-level only).
      if (!isReply) setSetting('noteDefaultVisibility', visibility)
      setBody('')
      setReplyTo(null)
      setSafe(false)
      await load()
    } else {
      onToast?.('Could not post note')
    }
  }

  const remove = async (note: HSNote) => {
    haptics.warn()
    const ok = await deleteNote(note.id)
    if (ok) {
      setNotes((list) =>
        list ? list.filter((n) => n.id !== note.id && n.parentId !== note.id) : list,
      )
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
            // Only claim emptiness when nothing is gated either - otherwise the
            // AheadNotes block below is the real (locked) state of this book.
            gated.hiddenAhead === 0 ? (
              <AppText variant="meta" color={colors.textMuted} style={styles.empty}>
                No notes yet. Be the first to leave one.
              </AppText>
            ) : null
          ) : (
            <NoteThread
              notes={gated.visible}
              meId={meId}
              onReply={(n) => setReplyTo(n)}
              onDelete={remove}
            />
          )}
          <AheadNotes count={gated.hiddenAhead} stubs={lockedStubs} position={position} />
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
              <View style={{ flex: 1 }}>
                <AppText variant="caption" color={colors.accent} numberOfLines={1}>
                  Replying to {replyTo.username}
                </AppText>
                {/* Quote the comment itself, so it is clear which one this
                    answers (HS-MOBILEAPP-17). */}
                <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
                  {replyTo.body}
                </AppText>
              </View>
              <IconButton
                name={icons.close}
                size={16}
                color={colors.textMuted}
                onPress={() => setReplyTo(null)}
                accessibilityLabel="Cancel reply"
              />
            </View>
          ) : null}
          {!replyTo ? <VisibilityToggle value={visibility} onChange={setVisibility} /> : null}
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
          {!replyTo ? <SafeSwitch on={safe} onChange={setSafe} /> : null}
        </View>
      ) : null}
    </Sheet>
  )
})

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    empty: { textAlign: 'center', paddingVertical: spacing.xl },
    composer: { paddingTop: spacing.sm, gap: spacing.sm },
    // Tinted so it reads as the comment being answered, not a stray caption.
    replyBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.accentWash,
      borderRadius: radius.row,
      paddingVertical: spacing.sm,
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
