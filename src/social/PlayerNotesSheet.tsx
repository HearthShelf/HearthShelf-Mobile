/**
 * The player's Notes/Club sheet. Opened from the reserved 'notes' player action
 * and from tapping a passed timeline marker on the seek bar. Two sections:
 *
 *  - Notes: the playing book's public notes, position-gated, with a composer
 *    that stamps the current playback position.
 *  - Club: if the reader is in a club whose current book is the playing book,
 *    its chat, also position-stamped.
 *
 * Spoiler gating is the server's; this sheet re-gates cached notes optimistically
 * (gateNotes) as position advances. Composing stamps the live player position.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import type { HSClub, HSNote } from '@hearthshelf/core'
import { gateNotes, formatTimestamp } from '@hearthshelf/core'
import { getNotes, postNote, deleteNote } from '@/api/notes'
import { getClubs } from '@/api/clubs'
import { getMeId } from '@/api/me'
import { getState as getPlayerState, subscribe as subscribePlayer } from '@/player/store'
import { NoteThread, type ChapterMark } from './NoteThread'
import { VisibilityToggle, SafeSwitch } from './NoteComposerControls'
import { AppText, IconButton, Sheet, Touchable, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import {
  getSettingsState,
  subscribeSettings,
  setSetting,
  type NoteDefaultVisibility,
} from '@/store/settings'
import { useSyncExternalStore } from 'react'
import { useRouter } from 'expo-router'
import type { SheetHandle } from '@/player/sheets'

type Tab = 'notes' | 'club'

export interface PlayerNotesSheetHandle extends SheetHandle {
  /** Open and scroll to a specific timestamped note (from a scrubber marker). */
  presentAt: (timeSec: number) => void
}

export const PlayerNotesSheet = forwardRef<
  PlayerNotesSheetHandle,
  { onToast?: (message: string) => void }
>(function PlayerNotesSheet({ onToast }, ref) {
  const sheetRef = useRef<SheetRef>(null)
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const meId = getMeId()

  const player = useSyncExternalStore(subscribePlayer, getPlayerState)
  const itemId = player.nowPlaying?.itemId ?? null
  const position = player.position
  const chapters: ChapterMark[] = player.nowPlaying?.chapters ?? []

  const [tab, setTab] = useState<Tab>('notes')
  const [notes, setNotes] = useState<HSNote[] | null>(null)
  const [hiddenAhead, setHiddenAhead] = useState(0)
  const [enabled, setEnabled] = useState(true)
  const [club, setClub] = useState<HSClub | null>(null)
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<HSNote | null>(null)
  const [busy, setBusy] = useState(false)

  // Composer visibility (general tab only) + the spoiler-safe opt-in.
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const [visibility, setVisibility] = useState<NoteDefaultVisibility>(settings.noteDefaultVisibility)
  const [safe, setSafe] = useState(false)
  useEffect(() => {
    if (!body) setVisibility(settings.noteDefaultVisibility)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.noteDefaultVisibility])

  // Resolve whether the playing book has a club the reader is in (its current
  // book being this item), so the Club tab shows only when relevant.
  useEffect(() => {
    if (!itemId) {
      setClub(null)
      return
    }
    let cancelled = false
    getClubs(itemId)
      .then((res) => {
        if (cancelled) return
        const mine = res.mine.find((c) => c.currentBook?.libraryItemId === itemId)
        setClub(mine ?? null)
      })
      .catch(() => setClub(null))
    return () => {
      cancelled = true
    }
  }, [itemId])

  const load = useCallback(async () => {
    if (!itemId) return
    const clubId = tab === 'club' ? club?.id : ''
    const res = await getNotes({ libraryItemId: itemId, clubId, position })
    setEnabled(res.enabled)
    setNotes(res.notes)
    setHiddenAhead(res.hiddenAhead)
  }, [itemId, tab, club?.id, position])

  useImperativeHandle(ref, () => ({
    present: () => {
      void load()
      sheetRef.current?.present()
    },
    presentAt: () => {
      // The list is short; presenting scrolled-to-note is best-effort. We just
      // open the sheet; the crossed note is near the current position anyway.
      void load()
      sheetRef.current?.present()
    },
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  // Refetch when the tab changes or position advances past a 30s bucket.
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, club?.id, Math.floor(position / 30)])

  const gated = useMemo(() => {
    if (!notes) return { visible: [] as HSNote[], hiddenAhead }
    const finished = false
    const g = gateNotes(notes, position, meId, finished)
    return { visible: g.visible, hiddenAhead: Math.max(hiddenAhead, g.hiddenAhead) }
  }, [notes, position, meId, hiddenAhead])

  const submit = async () => {
    const text = body.trim()
    if (!text || !itemId || busy) return
    setBusy(true)
    haptics.success()
    const isReply = !!replyTo
    const isClub = tab === 'club'
    const created = await postNote({
      libraryItemId: itemId,
      clubId: isClub ? club?.id : '',
      parentId: replyTo?.id ?? '',
      // Stamp the live position for a top-level note; a reply inherits its gate.
      timeSec: isReply ? null : Math.round(position),
      // Club posts are forced 'club' server-side; only send visibility on the
      // general tab's top-level notes. Safe rides on every top-level post.
      visibility: isClub || isReply ? undefined : visibility,
      safe: isReply ? false : safe,
      body: text,
    })
    setBusy(false)
    if (created) {
      if (!isClub && !isReply) setSetting('noteDefaultVisibility', visibility)
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
    if (ok) await load()
    else onToast?.('Could not delete note')
  }

  const isClubOwner = tab === 'club' && !!club && club.createdBy === meId

  return (
    <Sheet ref={sheetRef} title="Notes" snapPoints={['85%']}>
      {club ? (
        <View style={styles.segFull}>
          {(['notes', 'club'] as Tab[]).map((t) => (
            <Touchable key={t} style={[styles.seg, tab === t && styles.segOn]} onPress={() => setTab(t)}>
              <AppText variant="label" color={tab === t ? colors.text : colors.textMuted}>
                {t === 'notes' ? 'Everyone' : club.name}
              </AppText>
            </Touchable>
          ))}
        </View>
      ) : null}

      {tab === 'club' && club ? (
        <Touchable style={styles.openRoom} onPress={() => router.push(`/club/${encodeURIComponent(club.id)}`)}>
          <Icon name={icons.club} size={16} color={colors.accent} />
          <AppText variant="caption" color={colors.accent} style={{ flex: 1 }}>
            Open the full club room
          </AppText>
          <Icon name={icons.chevronRight} size={16} color={colors.accent} />
        </Touchable>
      ) : null}

      {!enabled ? (
        <AppText variant="meta" color={colors.textMuted} style={styles.empty}>
          Notes are turned off on this server.
        </AppText>
      ) : notes === null ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : (
        <BottomSheetScrollView contentContainerStyle={{ paddingBottom: spacing.lg }}>
          {gated.visible.length === 0 ? (
            <AppText variant="meta" color={colors.textMuted} style={styles.empty}>
              No notes here yet. Leave one at your spot.
            </AppText>
          ) : (
            <NoteThread
              notes={gated.visible}
              chapters={chapters}
              meId={meId}
              canModerate={isClubOwner}
              onReply={(n) => setReplyTo(n)}
              onDelete={remove}
            />
          )}
          {gated.hiddenAhead > 0 ? (
            <View style={styles.teaser}>
              <Icon name={icons.notes} size={16} color={colors.textMuted} />
              <AppText variant="caption" color={colors.textMuted}>
                {gated.hiddenAhead} ahead of you. Keep listening to unlock them.
              </AppText>
            </View>
          ) : null}
        </BottomSheetScrollView>
      )}

      {enabled ? (
        <View style={styles.composer}>
          {replyTo ? (
            <View style={styles.replyBanner}>
              <AppText variant="caption" color={colors.textMuted} numberOfLines={1} style={{ flex: 1 }}>
                Replying to {replyTo.username}
              </AppText>
              <IconButton name={icons.close} size={16} color={colors.textMuted} onPress={() => setReplyTo(null)} />
            </View>
          ) : null}
          {!replyTo && tab === 'notes' ? (
            <VisibilityToggle value={visibility} onChange={setVisibility} />
          ) : null}
          <View style={styles.composerRow}>
            <TextInput
              style={styles.input}
              placeholder={replyTo ? 'Write a reply…' : `Note at ${formatTimestamp(position)}…`}
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
    segFull: {
      flexDirection: 'row',
      gap: 4,
      backgroundColor: colors.fill,
      borderRadius: radius.card,
      padding: 4,
      marginBottom: spacing.md,
    },
    seg: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.row },
    segOn: { backgroundColor: colors.card },
    openRoom: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.row,
      backgroundColor: colors.accentWash,
      marginBottom: spacing.sm,
    },
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
    replyBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
