import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Keyboard,
  Platform,
  StyleSheet,
  TextInput,
  View,
  type KeyboardEvent,
} from 'react-native'
import { formatTimestamp } from '@hearthshelf/core'
import type { HSClubMember, HSNote, HSNoteStub } from '@hearthshelf/core'
import { getMeId } from '@/api/me'
import { postNote } from '@/api/notes'
import { refreshActiveClub, type ActiveClub } from '@/player/clubSync'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { useBackHandler } from '@/ui/useBackHandler'
import { MAX_FONT_SCALE, fonts, radius, spacing, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

const RECENT_WINDOW_SEC = 5 * 60
const UPCOMING_WINDOW_SEC = 2 * 60
const MAX_RACE_PIPS = 5
const PIP_COLORS = ['#bba097', '#85a59a', '#c0a869', '#9e88a8', '#8b665e'] as const

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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0].charAt(0)
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : ''
  return `${first}${last}`.toUpperCase()
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
  const composerRef = useRef<View>(null)
  const keyboardLift = useRef(new Animated.Value(0)).current
  const currentLift = useRef(0)
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

  const positionAboveKeyboard = useCallback(
    (keyboardTop: number, duration = 180) => {
      requestAnimationFrame(() => {
        composerRef.current?.measureInWindow((_x, y, _width, height) => {
          // measureInWindow includes the current transform. Add the current lift
          // back to recover the composer's resting artwork position, then move
          // only by the actual overlap. This stays correct when font/display
          // scale changes while the keyboard is already open.
          const restingY = y + currentLift.current
          const restingBottom = restingY + height
          const desired = Math.max(0, restingBottom + spacing.md - keyboardTop)
          const capped = Math.min(desired, Math.max(0, restingY - spacing.md))
          currentLift.current = capped
          Animated.timing(keyboardLift, {
            toValue: capped,
            duration: Math.max(120, duration),
            useNativeDriver: true,
          }).start()
        })
      })
    },
    [keyboardLift],
  )

  useEffect(() => {
    if (!composing) return
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const shown = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      positionAboveKeyboard(event.endCoordinates.screenY, event.duration)
    })
    const hidden = Keyboard.addListener(hideEvent, (event: KeyboardEvent) => {
      currentLift.current = 0
      Animated.timing(keyboardLift, {
        toValue: 0,
        duration: Math.max(120, event.duration),
        useNativeDriver: true,
      }).start()
    })
    return () => {
      shown.remove()
      hidden.remove()
      keyboardLift.stopAnimation()
      keyboardLift.setValue(0)
      currentLift.current = 0
    }
  }, [composing, keyboardLift, positionAboveKeyboard])

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
  const raceFill =
    pips.find((pip) => pip.me)?.fraction ??
    (duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0)

  if (composing) {
    return (
      <Animated.View
        ref={composerRef}
        style={[
          styles.keyboardAvoider,
          { transform: [{ translateY: Animated.multiply(keyboardLift, -1) }] },
        ]}
        onLayout={() => {
          const metrics = Keyboard.metrics()
          if (metrics) positionAboveKeyboard(metrics.screenY)
        }}
      >
        <View style={[styles.surface, styles.composer]} accessibilityLabel="Add a club comment">
          <View style={styles.inlineStamp}>
            <AppText variant="caption" color="rgba(255,255,255,0.62)">
              Comment at
            </AppText>
            <AppText variant="mono" color="#fff" style={styles.stampTime}>
              {formatTimestamp(frozenPosition)}
            </AppText>
            <AppText variant="caption" color="rgba(255,255,255,0.62)">
              ·
            </AppText>
            <AppText
              variant="caption"
              color="rgba(255,255,255,0.62)"
              numberOfLines={1}
              style={styles.clubStamp}
            >
              {club.name}
            </AppText>
          </View>
          <TextInput
            ref={inputRef}
            value={body}
            onChangeText={setBody}
            placeholder="Say something…"
            placeholderTextColor="rgba(255,255,255,0.42)"
            multiline
            maxLength={500}
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
                <AppText
                  variant="caption"
                  color={!safe ? colors.onAccent : 'rgba(255,255,255,0.62)'}
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
                <AppText
                  variant="caption"
                  color={safe ? colors.onAccent : 'rgba(255,255,255,0.62)'}
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
                <AppText variant="caption" color="#fff" style={styles.actionText}>
                  Cancel
                </AppText>
              </Touchable>
              <Touchable
                onPress={() => void submit()}
                disabled={!body.trim() || submitting}
                style={[
                  styles.postButton,
                  (!body.trim() || submitting) && styles.postButtonDisabled,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Post comment"
              >
                <AppText
                  variant="caption"
                  color={!body.trim() || submitting ? 'rgba(255,255,255,0.42)' : colors.onAccent}
                  style={styles.actionText}
                >
                  {submitting ? 'Posting…' : 'Post'}
                </AppText>
              </Touchable>
            </View>
          </View>
        </View>
      </Animated.View>
    )
  }

  return (
    <View style={styles.row}>
      <Touchable
        onPress={onOpenClub}
        style={[styles.surface, note ? styles.commentSurface : styles.quietSurface]}
        accessibilityRole="button"
        accessibilityLabel={`Open ${club.name}`}
      >
        {note ? (
          <View style={styles.noteRow}>
            <View style={[styles.noteIcon, note.kind === 'locked' && styles.lockedNoteIcon]}>
              {note.kind === 'locked' ? (
                <Icon name={icons.lock} size={17} color={colors.accent} />
              ) : (
                <AppText variant="caption" color="#fff" style={styles.noteInitials}>
                  {initials(note.note.username)}
                </AppText>
              )}
            </View>
            <View style={styles.noteCopy}>
              <AppText variant="caption" color="#fff" numberOfLines={1} style={styles.noteTitle}>
                {note.kind === 'locked'
                  ? `A club note unlocks ${nearbyTiming(note.deltaSec)}`
                  : `${note.note.username} · ${nearbyTiming(note.deltaSec)}`}
              </AppText>
              <AppText
                variant="caption"
                color="rgba(255,255,255,0.62)"
                numberOfLines={1}
                style={styles.noteBody}
              >
                {note.kind === 'locked'
                  ? 'Its text stays hidden until you reach it.'
                  : note.note.body}
              </AppText>
            </View>
            <Icon name={icons.chevronRight} size={20} color="rgba(255,255,255,0.55)" />
          </View>
        ) : (
          <View style={styles.race}>
            <View style={styles.raceHeader}>
              <View style={styles.clubNameRow}>
                <View style={styles.liveDot} />
                <AppText variant="caption" color="#fff" numberOfLines={1} style={styles.clubName}>
                  {club.name}
                </AppText>
              </View>
              <AppText variant="caption" color="rgba(255,255,255,0.6)">
                {club.memberCount} {club.memberCount === 1 ? 'reader' : 'readers'}
              </AppText>
            </View>
            <View style={styles.raceTrack}>
              <View style={styles.raceLine} />
              <View style={[styles.raceFill, { width: `${raceFill * 100}%` as `${number}%` }]} />
              {pips.map((pip, index) => (
                <View
                  key={pip.id}
                  style={[
                    styles.racePip,
                    {
                      left: `${pip.fraction * 100}%` as `${number}%`,
                      backgroundColor: pip.me
                        ? colors.accent
                        : PIP_COLORS[index % PIP_COLORS.length],
                    },
                    pip.me && styles.racePipMe,
                  ]}
                >
                  <AppText
                    variant="caption"
                    color={pip.me ? colors.onAccent : '#17100d'}
                    style={styles.racePipText}
                  >
                    {pip.me ? 'You' : initials(pip.name)}
                  </AppText>
                </View>
              ))}
            </View>
            <View style={styles.raceFooter}>
              <View style={styles.listeningCopy}>
                {listening && <View style={styles.listeningDot} />}
                <AppText variant="caption" color="rgba(255,255,255,0.62)" numberOfLines={1}>
                  {listening
                    ? `${listening.userId === meId ? 'You are' : `${listening.username} is`} listening now`
                    : 'See where everyone is in the book'}
                </AppText>
              </View>
              <AppText variant="caption" color={colors.accent} style={styles.openClubCopy}>
                Club ›
              </AppText>
            </View>
          </View>
        )}
      </Touchable>
      <Touchable
        onPress={openComposer}
        style={styles.composeButton}
        accessibilityRole="button"
        accessibilityLabel={`Add a comment to ${club.name}`}
      >
        <Icon name={icons.commentAdd} size={22} color={colors.onAccent} />
      </Touchable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    surface: {
      backgroundColor: 'rgba(15,11,10,0.86)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,242,228,0.16)',
      borderRadius: radius.card,
      shadowColor: '#000',
      shadowOpacity: 0.34,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 8 },
      elevation: 8,
    },
    quietSurface: { flex: 1, minHeight: 92, justifyContent: 'center', overflow: 'hidden' },
    commentSurface: {
      flex: 1,
      minHeight: 70,
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: radius.pill,
    },
    composeButton: {
      width: 48,
      height: 48,
      flexShrink: 0,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
      shadowColor: '#000',
      shadowOpacity: 0.34,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 8 },
      elevation: 9,
    },
    noteRow: {
      minHeight: 70,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingHorizontal: 10,
      paddingVertical: 9,
    },
    noteIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#657f77',
    },
    lockedNoteIcon: { backgroundColor: 'rgba(239,118,84,0.13)' },
    noteInitials: { fontSize: 9, lineHeight: 11, fontWeight: '900' },
    noteCopy: { flex: 1, minWidth: 0 },
    noteTitle: { fontSize: 11, lineHeight: 14, fontWeight: '800' },
    noteBody: { marginTop: 3, fontSize: 10, lineHeight: 13 },
    race: { minHeight: 92, paddingHorizontal: spacing.md, paddingTop: 11, paddingBottom: 10 },
    raceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    clubNameRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7 },
    liveDot: {
      width: 7,
      height: 7,
      flexShrink: 0,
      borderRadius: 4,
      backgroundColor: colors.accent,
      shadowColor: colors.accent,
      shadowOpacity: 0.5,
      shadowRadius: 4,
    },
    clubName: { flex: 1, minWidth: 0, fontWeight: '800' },
    raceTrack: { height: 28, marginTop: 6, marginBottom: 4, position: 'relative' },
    raceLine: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 13,
      height: 3,
      borderRadius: 4,
      backgroundColor: 'rgba(255,255,255,0.16)',
    },
    raceFill: {
      position: 'absolute',
      left: 0,
      top: 13,
      height: 3,
      borderRadius: 4,
      backgroundColor: 'rgba(255,255,255,0.6)',
    },
    racePip: {
      position: 'absolute',
      top: 3,
      width: 22,
      height: 22,
      marginLeft: -11,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'rgba(13,10,9,0.96)',
      borderRadius: 11,
    },
    racePipMe: {
      zIndex: 3,
      shadowColor: colors.accent,
      shadowOpacity: 0.5,
      shadowRadius: 3,
    },
    racePipText: { fontSize: 7, lineHeight: 8, fontWeight: '900' },
    raceFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    listeningCopy: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    listeningDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#8fb39c' },
    openClubCopy: { fontWeight: '800' },
    keyboardAvoider: { width: '100%', overflow: 'visible' },
    composer: {
      width: '100%',
      padding: 10,
      borderColor: 'rgba(255,242,228,0.18)',
      backgroundColor: 'rgba(15,11,10,0.92)',
    },
    inlineStamp: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
    stampTime: { fontSize: 11, lineHeight: 13, fontWeight: '700' },
    clubStamp: { flex: 1, minWidth: 0 },
    input: {
      minHeight: 58,
      maxHeight: 76,
      marginVertical: spacing.sm,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.13)',
      backgroundColor: 'rgba(255,255,255,0.05)',
      color: '#fff',
      fontSize: 16,
      lineHeight: 22,
      fontFamily: fonts.sans,
      paddingHorizontal: 10,
      paddingVertical: 9,
      textAlignVertical: 'top',
    },
    composerFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
    },
    visibilityToggle: {
      flexDirection: 'row',
      gap: 3,
      padding: 3,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(255,255,255,0.06)',
    },
    visibilityOption: {
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
      borderRadius: radius.pill,
    },
    visibilityOptionActive: { backgroundColor: colors.accent },
    visibilityText: { fontSize: 10, fontWeight: '800' },
    composerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    cancelButton: {
      minHeight: 44,
      minWidth: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      backgroundColor: 'rgba(255,255,255,0.07)',
    },
    postButton: {
      minHeight: 44,
      minWidth: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    postButtonDisabled: { backgroundColor: 'rgba(255,255,255,0.08)' },
    actionText: { fontSize: 10, fontWeight: '900' },
  })
