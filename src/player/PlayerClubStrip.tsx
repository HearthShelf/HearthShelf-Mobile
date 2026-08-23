import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, StyleSheet, TextInput, View } from 'react-native'
import { formatTimestamp } from '@hearthshelf/core'
import type { HSClubMember, HSNote, HSNoteStub } from '@hearthshelf/core'
import { getMeId } from '@/api/me'
import { postNote } from '@/api/notes'
import { refreshActiveClub, type ActiveClub } from '@/player/clubSync'
import { AppText, Avatar, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { useBackHandler } from '@/ui/useBackHandler'
import { MAX_FONT_SCALE, radius, spacing, withAlpha, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

const RECENT_WINDOW_SEC = 5 * 60
const UPCOMING_WINDOW_SEC = 2 * 60
const MAX_RACE_PIPS = 5

type NearbyNote =
  | { kind: 'visible'; note: HSNote; deltaSec: number }
  | { kind: 'locked'; stub: HSNoteStub; deltaSec: number }

interface RacePip {
  id: string
  name: string
  fraction: number
  me: boolean
}

function nearbyNote(notes: HSNote[], locked: HSNoteStub[], position: number): NearbyNote | null {
  const candidates: NearbyNote[] = []
  for (const note of notes) {
    if (note.parentId || note.timeSec == null) continue
    const deltaSec = note.timeSec - position
    if (deltaSec >= -RECENT_WINDOW_SEC && deltaSec <= UPCOMING_WINDOW_SEC) {
      candidates.push({ kind: 'visible', note, deltaSec })
    }
  }
  for (const stub of locked) {
    const deltaSec = stub.timeSec - position
    if (deltaSec >= 0 && deltaSec <= UPCOMING_WINDOW_SEC) {
      candidates.push({ kind: 'locked', stub, deltaSec })
    }
  }
  candidates.sort((a, b) => {
    const distance = Math.abs(a.deltaSec) - Math.abs(b.deltaSec)
    if (distance !== 0) return distance
    // At an equal distance, show content the server has already unlocked.
    return a.kind === 'visible' ? -1 : 1
  })
  return candidates[0] ?? null
}

function progressFraction(member: HSClubMember): number | null {
  if (member.isFinished) return 1
  if (member.currentTime == null || member.duration == null || member.duration <= 0) return null
  return Math.max(0, Math.min(1, member.currentTime / member.duration))
}

function racePips(
  members: HSClubMember[],
  meId: string,
  position: number,
  duration: number,
): RacePip[] {
  const pips = members.flatMap<RacePip>((member) => {
    const serverFraction = progressFraction(member)
    const isMe = !!meId && member.userId === meId
    const fraction =
      isMe && duration > 0 ? Math.max(0, Math.min(1, position / duration)) : serverFraction
    if (fraction == null) return []
    return [
      {
        id: member.userId,
        name: member.username,
        fraction,
        me: isMe,
      },
    ]
  })
  pips.sort((a, b) => a.fraction - b.fraction)
  if (pips.length <= MAX_RACE_PIPS) return pips

  const visible = pips.slice(-MAX_RACE_PIPS)
  const me = pips.find((pip) => pip.me)
  if (me && !visible.some((pip) => pip.id === me.id)) visible[0] = me
  return visible.sort((a, b) => a.fraction - b.fraction)
}

function nearbyTiming(deltaSec: number): string {
  const seconds = Math.round(Math.abs(deltaSec))
  if (seconds < 30) return deltaSec > 0 ? 'coming up' : 'just unlocked'
  const minutes = Math.max(1, Math.round(seconds / 60))
  return deltaSec > 0 ? `in ${minutes} min` : `${minutes} min behind`
}

export function PlayerClubStrip({
  club,
  itemId,
  position,
  duration,
  onOpenClub,
  onToast,
  onComposingChange,
}: {
  club: ActiveClub
  itemId: string
  position: number
  duration: number
  onOpenClub: () => void
  onToast: (message: string) => void
  onComposingChange?: (open: boolean) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const inputRef = useRef<TextInput>(null)
  const [composing, setComposing] = useState(false)
  const [body, setBody] = useState('')
  const [safe, setSafe] = useState(false)
  const [frozenPosition, setFrozenPosition] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [optimisticNote, setOptimisticNote] = useState<HSNote | null>(null)

  useEffect(() => {
    setComposing(false)
    setBody('')
    setSafe(false)
    setOptimisticNote(null)
  }, [club.id, itemId])

  useEffect(() => {
    onComposingChange?.(composing)
  }, [composing, onComposingChange])
  useEffect(
    () => () => {
      onComposingChange?.(false)
    },
    [onComposingChange],
  )

  useEffect(() => {
    if (!composing) return
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [composing])

  const closeComposer = useCallback(() => {
    Keyboard.dismiss()
    setComposing(false)
  }, [])
  useBackHandler(
    useCallback(() => {
      if (!composing) return false
      closeComposer()
      return true
    }, [closeComposer, composing]),
    composing,
  )

  const openComposer = useCallback(() => {
    haptics.select()
    setFrozenPosition(Math.max(0, Math.round(position)))
    setComposing(true)
  }, [position])

  const submit = useCallback(async () => {
    const text = body.trim()
    if (!text || submitting) return
    setSubmitting(true)
    const created = await postNote({
      libraryItemId: itemId,
      clubId: club.id,
      timeSec: frozenPosition,
      safe,
      body: text,
    })
    setSubmitting(false)
    if (!created) {
      onToast('Could not add the comment')
      return
    }
    setOptimisticNote(created)
    setBody('')
    closeComposer()
    haptics.success()
    onToast('Comment added')
    refreshActiveClub()
  }, [body, club.id, closeComposer, frozenPosition, itemId, onToast, safe, submitting])

  const note = useMemo(() => {
    if (optimisticNote) {
      const deltaSec = (optimisticNote.timeSec ?? position) - position
      if (deltaSec >= -RECENT_WINDOW_SEC && deltaSec <= UPCOMING_WINDOW_SEC) {
        return { kind: 'visible', note: optimisticNote, deltaSec } satisfies NearbyNote
      }
    }
    return nearbyNote(club.notes, club.locked, position)
  }, [club.locked, club.notes, optimisticNote, position])
  const meId = getMeId()
  const pips = useMemo(
    () => racePips(club.members, meId, position, duration),
    [club.members, duration, meId, position],
  )
  const listening = club.members.find((member) => member.listeningNow)

  if (composing) {
    return (
      <View style={[styles.surface, styles.composer]} accessibilityLabel="Add a club comment">
        <View style={styles.composerHeader}>
          <View style={styles.composerTitle}>
            <Icon name={icons.edit} size={15} color={colors.accent} />
            <AppText variant="label" color="#fff" numberOfLines={1} style={styles.flexText}>
              {club.name}
            </AppText>
          </View>
          <AppText variant="mono" color="rgba(255,255,255,0.62)">
            {formatTimestamp(frozenPosition)}
          </AppText>
        </View>
        <TextInput
          ref={inputRef}
          value={body}
          onChangeText={setBody}
          placeholder="Leave a comment at this moment…"
          placeholderTextColor="rgba(255,255,255,0.46)"
          multiline
          maxLength={2000}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={styles.input}
          selectionColor={colors.accent}
          accessibilityLabel="Club comment"
        />
        <View style={styles.composerFooter}>
          <View style={styles.visibilityToggle} accessibilityRole="radiogroup">
            <Touchable
              onPress={() => setSafe(false)}
              style={[styles.visibilityOption, !safe && styles.visibilityOptionActive]}
              accessibilityRole="radio"
              accessibilityLabel="Hidden until this point"
              accessibilityState={{ checked: !safe }}
            >
              <Icon name={icons.lock} size={14} color={!safe ? colors.onAccent : '#fff'} />
              <AppText
                variant="caption"
                color={!safe ? colors.onAccent : 'rgba(255,255,255,0.8)'}
                style={styles.visibilityText}
              >
                Hidden
              </AppText>
            </Touchable>
            <Touchable
              onPress={() => setSafe(true)}
              style={[styles.visibilityOption, safe && styles.visibilityOptionActive]}
              accessibilityRole="radio"
              accessibilityLabel="Visible now and spoiler free"
              accessibilityState={{ checked: safe }}
            >
              <Icon name={icons.visible} size={14} color={safe ? colors.onAccent : '#fff'} />
              <AppText
                variant="caption"
                color={safe ? colors.onAccent : 'rgba(255,255,255,0.8)'}
                style={styles.visibilityText}
              >
                Visible
              </AppText>
            </Touchable>
          </View>
          <View style={styles.composerActions}>
            <Touchable
              onPress={closeComposer}
              style={styles.cancelButton}
              accessibilityRole="button"
              accessibilityLabel="Cancel comment"
            >
              <AppText variant="caption" color="rgba(255,255,255,0.78)">
                Cancel
              </AppText>
            </Touchable>
            <Touchable
              onPress={() => void submit()}
              disabled={!body.trim() || submitting}
              style={styles.postButton}
              accessibilityRole="button"
              accessibilityLabel="Post comment"
            >
              <Icon name={icons.send} size={17} color={colors.onAccent} />
              <AppText variant="caption" color={colors.onAccent} style={styles.postText}>
                {submitting ? 'Posting…' : 'Post'}
              </AppText>
            </Touchable>
          </View>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.row}>
      <Touchable
        onPress={onOpenClub}
        style={[styles.surface, styles.stateSurface]}
        accessibilityRole="button"
        accessibilityLabel={`Open ${club.name}`}
      >
        {note ? (
          <View style={styles.noteRow}>
            <View style={styles.noteIcon}>
              <Icon
                name={note.kind === 'locked' ? icons.lock : icons.chat}
                size={19}
                color={note.kind === 'locked' ? 'rgba(255,255,255,0.75)' : colors.accent}
              />
            </View>
            <View style={styles.noteCopy}>
              <AppText variant="caption" color="rgba(255,255,255,0.62)" numberOfLines={1}>
                {note.kind === 'locked'
                  ? `${club.name} · ${nearbyTiming(note.deltaSec)}`
                  : `${note.note.username} · ${nearbyTiming(note.deltaSec)}`}
              </AppText>
              <AppText variant="label" color="#fff" numberOfLines={2} style={styles.noteBody}>
                {note.kind === 'locked'
                  ? 'A club comment unlocks when you reach it.'
                  : note.note.body}
              </AppText>
            </View>
            <Icon name={icons.chevronRight} size={20} color="rgba(255,255,255,0.55)" />
          </View>
        ) : (
          <View style={styles.race}>
            <View style={styles.raceHeader}>
              <View style={styles.clubNameRow}>
                <Icon name={icons.club} size={17} color={colors.accent} />
                <AppText variant="label" color="#fff" numberOfLines={1} style={styles.flexText}>
                  {club.name}
                </AppText>
              </View>
              <AppText variant="caption" color="rgba(255,255,255,0.6)">
                {club.memberCount} {club.memberCount === 1 ? 'member' : 'members'}
              </AppText>
            </View>
            {pips.length ? (
              <View style={styles.raceTrack}>
                <View style={styles.raceLine} />
                {pips.map((pip) => (
                  <View
                    key={pip.id}
                    style={[
                      styles.racePip,
                      { left: `${pip.fraction * 100}%` as `${number}%` },
                      pip.me && styles.racePipMe,
                    ]}
                  >
                    <Avatar
                      size={26}
                      name={pip.me ? 'You' : pip.name}
                      hue={pip.me ? colors.accent : undefined}
                    />
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.emptyRace}>
                <View style={styles.emptyRaceFill} />
              </View>
            )}
            <View style={styles.raceFooter}>
              <AppText variant="caption" color="rgba(255,255,255,0.62)" numberOfLines={1}>
                {listening
                  ? `${listening.userId === meId ? 'You are' : `${listening.username} is`} listening now`
                  : 'See where everyone is in the book'}
              </AppText>
              {pips.some((pip) => pip.me) && (
                <AppText variant="caption" color={colors.accent} style={styles.youLabel}>
                  You
                </AppText>
              )}
            </View>
          </View>
        )}
      </Touchable>
      <Touchable
        onPress={openComposer}
        style={[styles.surface, styles.composeButton]}
        accessibilityRole="button"
        accessibilityLabel={`Add a comment to ${club.name}`}
      >
        <Icon name={icons.edit} size={22} color="#fff" />
      </Touchable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm },
    surface: {
      backgroundColor: 'rgba(17,14,12,0.9)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.16)',
      borderRadius: radius.card,
      shadowColor: '#000',
      shadowOpacity: 0.32,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 8,
    },
    stateSurface: { flex: 1, minHeight: 76, justifyContent: 'center', overflow: 'hidden' },
    composeButton: { width: 52, minHeight: 76, alignItems: 'center', justifyContent: 'center' },
    noteRow: {
      minHeight: 76,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    noteIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    noteCopy: { flex: 1, minWidth: 0, gap: 2 },
    noteBody: { lineHeight: 18 },
    race: { minHeight: 88, paddingHorizontal: spacing.md, paddingVertical: 10 },
    raceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    clubNameRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
    flexText: { flex: 1, minWidth: 0 },
    raceTrack: { height: 30, marginHorizontal: 13, marginTop: 6, position: 'relative' },
    raceLine: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 13,
      height: 3,
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.18)',
    },
    racePip: { position: 'absolute', top: 1, marginLeft: -13 },
    racePipMe: {
      borderRadius: 15,
      borderWidth: 2,
      borderColor: '#fff',
      padding: 1,
      top: -1,
      marginLeft: -15,
    },
    emptyRace: {
      height: 3,
      marginTop: 18,
      marginHorizontal: 3,
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.12)',
      overflow: 'hidden',
    },
    emptyRaceFill: { width: '32%', height: 3, backgroundColor: withAlpha(colors.accent, 0.7) },
    raceFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      marginTop: 2,
    },
    youLabel: { fontWeight: '700' },
    composer: { minHeight: 172, padding: spacing.md, gap: spacing.sm },
    composerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    composerTitle: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginRight: spacing.sm,
    },
    input: {
      minHeight: 68,
      maxHeight: 96,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.18)',
      backgroundColor: 'rgba(255,255,255,0.08)',
      color: '#fff',
      fontSize: 16,
      lineHeight: 21,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      textAlignVertical: 'top',
    },
    composerFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    visibilityToggle: {
      flexDirection: 'row',
      padding: 2,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(255,255,255,0.08)',
    },
    visibilityOption: {
      minHeight: 36,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingHorizontal: 9,
      borderRadius: radius.pill,
    },
    visibilityOptionActive: { backgroundColor: colors.accent },
    visibilityText: { fontWeight: '700' },
    composerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    cancelButton: {
      minHeight: 40,
      minWidth: 54,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    postButton: {
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    postText: { fontWeight: '800' },
  })
