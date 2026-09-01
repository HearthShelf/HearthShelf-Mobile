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
import { avatarUrl } from '@/api/abs'
import { getMeId } from '@/api/me'
import { postNote } from '@/api/notes'
import { refreshActiveClub, type ActiveClub } from '@/player/clubSync'
import { AppText, Avatar, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { useBackHandler } from '@/ui/useBackHandler'
import { MAX_FONT_SCALE, fonts, radius, spacing, type Palette } from '@/ui/theme'
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

function ProgressNoteMarkers({
  notes,
  locked,
  duration,
  colors,
  styles,
}: {
  notes: HSNote[]
  locked: HSNoteStub[]
  duration: number
  colors: Palette
  styles: ReturnType<typeof makeStyles>
}) {
  if (duration <= 0) return null

  const markers = [
    ...notes.flatMap((note) =>
      note.timeSec == null ? [] : [{ id: note.id, timeSec: note.timeSec, locked: false }],
    ),
    ...locked.map((stub) => ({ id: stub.id, timeSec: stub.timeSec, locked: true })),
  ]

  return markers.map((marker) => {
    const fraction = Math.max(0, Math.min(1, marker.timeSec / duration))
    return (
      <View
        key={`${marker.locked ? 'locked' : 'visible'}-${marker.id}`}
        style={[
          styles.noteMarker,
          marker.locked && styles.noteMarkerLocked,
          { left: `${fraction * 100}%` as `${number}%` },
        ]}
        accessible
        accessibilityLabel={`${marker.locked ? 'Locked comment unlocks' : 'Comment'} at ${formatTimestamp(marker.timeSec)}`}
      >
        <Icon
          name={icons.chat}
          size={11}
          color={marker.locked ? 'rgba(255,255,255,0.48)' : colors.accent}
        />
      </View>
    )
  })
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

function raceContext(
  members: HSClubMember[],
  meId: string,
  position: number,
  duration: number,
): string {
  if (!meId || duration <= 0) return 'See where everyone is in the book'
  const mine = Math.max(0, Math.min(1, position / duration))
  let ahead = 0
  let behind = 0
  for (const member of members) {
    if (member.userId === meId) continue
    const fraction = progressFraction(member)
    if (fraction == null) continue
    if (fraction > mine + 0.002) ahead++
    else if (fraction < mine - 0.002) behind++
  }
  if (ahead && behind) return `${ahead} ahead · ${behind} behind`
  if (ahead) return `${ahead} ${ahead === 1 ? 'reader' : 'readers'} ahead`
  if (behind) return `Ahead of ${behind} ${behind === 1 ? 'reader' : 'readers'}`
  return 'Reading together here'
}

/** The same avatar progress rail used on the player, exposed for the club room.
 * Tapping it is intentionally the only control: the room expands its richer
 * "Where everyone is" card beneath it. */
export function PlayerClubProgressStrip({
  clubName,
  members,
  memberCount,
  position,
  duration,
  notes = [],
  locked = [],
  onPress,
  expanded,
}: {
  clubName: string
  members: HSClubMember[]
  memberCount: number
  position: number
  duration: number
  notes?: HSNote[]
  locked?: HSNoteStub[]
  onPress: () => void
  expanded: boolean
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const meId = getMeId()
  const pips = useMemo(
    () => racePips(members, meId, position, duration),
    [duration, meId, members, position],
  )
  const raceFill =
    pips.find((pip) => pip.me)?.fraction ??
    (duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0)
  const context = raceContext(members, meId, position, duration)
  return (
    <Touchable
      onPress={onPress}
      style={[styles.surface, styles.quietSurface]}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${clubName} reading progress. ${context}`}
      accessibilityHint="Shows where everyone is"
    >
      <View style={styles.race}>
        <View style={styles.raceHeader}>
          <AppText variant="caption" color="#fff" numberOfLines={1} style={styles.clubName}>
            {clubName}
          </AppText>
          <AppText variant="caption" color="rgba(255,255,255,0.6)">
            {memberCount} {memberCount === 1 ? 'reader' : 'readers'}
          </AppText>
        </View>
        <View style={styles.raceTrack}>
          <View style={styles.raceLine} />
          <View style={[styles.raceFill, { width: `${raceFill * 100}%` as `${number}%` }]} />
          <ProgressNoteMarkers
            notes={notes}
            locked={locked}
            duration={duration}
            colors={colors}
            styles={styles}
          />
          {pips.map((pip) => (
            <View
              key={pip.id}
              style={[
                styles.racePip,
                { left: `${pip.fraction * 100}%` as `${number}%` },
                pip.me && styles.racePipMe,
              ]}
            >
              <Avatar uri={avatarUrl(pip.id)} size={18} name={pip.name} />
            </View>
          ))}
        </View>
        <View style={styles.raceFooter}>
          <AppText variant="caption" color="rgba(255,255,255,0.62)" numberOfLines={1}>
            {context}
          </AppText>
          <View style={{ transform: [{ rotate: expanded ? '0deg' : '180deg' }] }}>
            <Icon name={icons.expandLess} size={18} color="rgba(255,255,255,0.62)" />
          </View>
        </View>
      </View>
    </Touchable>
  )
}

/**
 * A soft orange breathing outline on the club box while there is club activity
 * you have not read.
 *
 * This is the ONLY signal for a whole class of comment. Note-pops fire as
 * playback CROSSES a timestamp, so a comment posted at a point you already
 * passed - or a reply on your own note - has nothing left to trigger it and is
 * otherwise invisible until you happen to open the club.
 *
 * `unreadCount` is exactly the right input and needs no extra plumbing: the
 * server counts only notes you can already READ (unlocked, i.e. at or behind
 * your position) that are newer than your last visit. Locked notes ahead of you
 * are excluded by construction, so the pulse can never hint that discussion
 * exists somewhere you have not reached - the same spoiler rule the rest of the
 * club UI follows.
 *
 * Returns an opacity to drive a highlight overlay. Loops while unread, and
 * settles back to 0 when there is nothing left to announce.
 */
function useUnreadPulse(unreadCount: number): Animated.Value {
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (unreadCount <= 0) {
      // Fade out rather than snapping, so clearing the badge doesn't flicker.
      Animated.timing(pulse, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start()
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.25, duration: 900, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => {
      loop.stop()
    }
  }, [pulse, unreadCount])

  return pulse
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
  const unreadPulse = useUnreadPulse(club.unreadCount)

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

  // The composer's resting bottom edge in window coords, captured while the
  // keyboard is closed. Measuring only at rest means the lift never feeds back
  // into its own measurement - the old measure-per-frame loop re-entered through
  // onLayout and overshot wildly before settling.
  const restingBottom = useRef(0)

  const measureResting = useCallback(() => {
    composerRef.current?.measureInWindow((_x, y, _width, height) => {
      restingBottom.current = y + currentLift.current + height
    })
  }, [])

  useEffect(() => {
    if (!composing) return
    // Measure the resting box before focusing, so the first keyboard event has
    // real geometry to work from instead of a zero default.
    const frame = requestAnimationFrame(() => {
      measureResting()
      inputRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [composing, measureResting])

  const positionAboveKeyboard = useCallback(
    (keyboardTop: number, duration = 180) => {
      // Derived from the keyboard's own reported top edge, not from a re-measure
      // of the moving composer, so this is a single settled target - no bounce.
      const overlap = restingBottom.current + spacing.md - keyboardTop
      const next = Math.max(0, overlap)
      if (Math.abs(next - currentLift.current) < 1) return
      currentLift.current = next
      Animated.timing(keyboardLift, {
        toValue: next,
        duration: Math.max(120, duration),
        // Layout, not transform: an Android transform moves the pixels but
        // leaves hit testing and text-selection handles at the old coordinates.
        useNativeDriver: false,
      }).start()
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
        useNativeDriver: false,
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
  const otherListening = club.members.find(
    (member) => member.listeningNow && member.userId !== meId,
  )
  const progressContext = raceContext(club.members, meId, position, duration)
  const raceFill =
    pips.find((pip) => pip.me)?.fraction ??
    (duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0)

  if (composing) {
    return (
      <Animated.View
        ref={composerRef}
        style={[styles.keyboardAvoider, { marginBottom: keyboardLift }]}
        onLayout={() => {
          // Re-measure the resting geometry only (cheap, and correct when text
          // scale or composer height changes), then re-derive the lift from the
          // keyboard's reported position rather than from the moving composer.
          measureResting()
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
        accessibilityLabel={
          club.unreadCount > 0
            ? `Open ${club.name}. ${club.unreadCount} new ${club.unreadCount === 1 ? 'comment' : 'comments'}.`
            : `Open ${club.name}`
        }
      >
        {/* Breathing outline for unread club activity. pointerEvents none so it
            never intercepts the tap that opens the club. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.unreadPulse,
            note ? styles.unreadPulseComment : styles.unreadPulseQuiet,
            { opacity: unreadPulse },
          ]}
        />
        {note ? (
          <View style={styles.noteRow}>
            <View style={[styles.noteIcon, note.kind === 'locked' && styles.lockedNoteIcon]}>
              {note.kind === 'locked' ? (
                <Icon name={icons.lock} size={17} color={colors.accent} />
              ) : (
                <Avatar uri={avatarUrl(note.note.userId)} size={34} name={note.note.username} />
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
              <ProgressNoteMarkers
                notes={club.notes}
                locked={club.locked}
                duration={duration}
                colors={colors}
                styles={styles}
              />
              {pips.map((pip) => (
                <View
                  key={pip.id}
                  style={[
                    styles.racePip,
                    { left: `${pip.fraction * 100}%` as `${number}%` },
                    pip.me && styles.racePipMe,
                  ]}
                >
                  <Avatar uri={avatarUrl(pip.id)} size={18} name={pip.name} />
                </View>
              ))}
            </View>
            <View style={styles.raceFooter}>
              <View style={styles.listeningCopy}>
                <AppText variant="caption" color="rgba(255,255,255,0.62)" numberOfLines={1}>
                  {otherListening ? `${otherListening.username} is listening now` : progressContext}
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
    // Sits on top of the surface, matching its radius, and only ever draws a
    // border - the box's own contents stay exactly as legible as before.
    unreadPulse: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderWidth: 1.5,
      borderColor: colors.accent,
    },
    unreadPulseQuiet: { borderRadius: radius.card },
    unreadPulseComment: { borderRadius: radius.pill },
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
    noteCopy: { flex: 1, minWidth: 0 },
    noteTitle: { fontSize: 11, lineHeight: 14, fontWeight: '800' },
    noteBody: { marginTop: 3, fontSize: 10, lineHeight: 13 },
    race: { minHeight: 92, paddingHorizontal: spacing.md, paddingTop: 11, paddingBottom: 10 },
    raceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    clubNameRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
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
    noteMarker: {
      position: 'absolute',
      top: 5,
      width: 18,
      height: 18,
      marginLeft: -9,
      zIndex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 9,
      backgroundColor: 'rgba(15,11,10,0.96)',
    },
    noteMarkerLocked: {
      borderColor: 'rgba(255,255,255,0.28)',
      backgroundColor: 'rgba(15,11,10,0.9)',
    },
    racePip: {
      position: 'absolute',
      top: 3,
      width: 22,
      height: 22,
      marginLeft: -11,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2,
      borderWidth: 2,
      borderColor: 'rgba(13,10,9,0.96)',
      borderRadius: 11,
    },
    racePipMe: {
      zIndex: 3,
      borderColor: colors.accent,
      shadowColor: colors.accent,
      shadowOpacity: 0.5,
      shadowRadius: 3,
    },
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
    openClubCopy: { fontWeight: '800' },
    // Stays in flow so it contributes height to its bottom-anchored parent.
    // Going absolute here collapsed the parent to zero height, which put the
    // composer outside its parent's bounds - where Android delivers no touches.
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
