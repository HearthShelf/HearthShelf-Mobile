/**
 * Book Club card on the book detail page. Splits the reader's clubs into ones
 * already reading THIS book (open the room) and their other clubs (owner can add
 * this book: set it as the current book now, or queue it up next). Also lists
 * open clubs reading this book that the reader can join, and a compact
 * create-a-club affordance seeded with this book.
 *
 * Hidden entirely when the reader turned clubs off (clubsEnabled) or the server
 * has clubs disabled and the reader isn't already in one for this book.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import type { HSClub } from '@hearthshelf/core'
import {
  getClubs,
  createClub,
  setClubMembership,
  setClubCurrentBook,
  enqueueClubBook,
  removeClubQueued,
  type ClubVisibility,
} from '@/api/clubs'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { getMeId } from '@/api/me'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function ClubCard({
  libraryItemId,
  onToast,
  from = 'library',
}: {
  libraryItemId: string
  onToast?: (message: string) => void
  /** Owning tab, forwarded to the club room so it keeps the right tab lit. */
  from?: string
}) {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { clubsEnabled } = useSyncExternalStore(subscribeSettings, getSettingsState)

  const [enabled, setEnabled] = useState(true)
  const [mine, setMine] = useState<HSClub[]>([])
  const [joinable, setJoinable] = useState<HSClub[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ClubVisibility>('closed')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await getClubs(libraryItemId)
    setEnabled(res.enabled)
    setMine(res.mine)
    setJoinable(res.joinable)
  }, [libraryItemId])

  // Refresh whenever the book page regains focus - so a club just created (or a
  // book just added to one) is reflected without needing to re-open the page.
  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )
  useEffect(() => {
    void load()
  }, [load])

  const openClub = (id: string) => {
    router.push(`/club/${encodeURIComponent(id)}?from=${from}`)
  }

  const join = async (club: HSClub) => {
    if (busy) return
    setBusy(true)
    haptics.mode()
    const ok = await setClubMembership(club.id, true)
    setBusy(false)
    if (ok) {
      onToast?.(`Joined ${club.name}`)
      openClub(club.id)
    } else {
      onToast?.('Could not join')
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    haptics.success()
    const club = await createClub(trimmed, libraryItemId, visibility)
    setBusy(false)
    if (club) {
      setName('')
      setVisibility('closed')
      setCreating(false)
      onToast?.(`Created ${club.name}`)
      openClub(club.id)
    } else {
      onToast?.('Could not create club')
    }
  }

  const setCurrent = async (club: HSClub) => {
    if (busy) return
    setBusy(true)
    haptics.success()
    const ok = await setClubCurrentBook(club.id, libraryItemId)
    setBusy(false)
    if (ok) {
      onToast?.(`Now reading in ${club.name}`)
      void load()
    } else {
      onToast?.('Could not set the book')
    }
  }

  const enqueue = async (club: HSClub) => {
    if (busy) return
    setBusy(true)
    haptics.mode()
    const ok = await enqueueClubBook(club.id, libraryItemId)
    setBusy(false)
    if (ok) {
      onToast?.(`Queued in ${club.name}`)
      void load()
    } else {
      onToast?.('Could not queue the book')
    }
  }

  const dequeue = async (club: HSClub) => {
    if (busy) return
    setBusy(true)
    haptics.mode()
    const ok = await removeClubQueued(club.id, libraryItemId)
    setBusy(false)
    if (ok) {
      onToast?.(`Removed from ${club.name}`)
      void load()
    } else {
      onToast?.('Could not remove the book')
    }
  }

  // The reader opted out locally: hide the whole surface.
  if (!clubsEnabled) return null

  // Clubs already reading THIS book (the card's "reading this now" rows) vs the
  // reader's other clubs (candidates to add this book to). The server's `mine`
  // is every club the reader is in, unfiltered by book, so we split here.
  const meId = getMeId()
  const readingThis = mine.filter((c) => c.currentBook?.libraryItemId === libraryItemId)
  const queuedThis = mine.filter(
    (c) =>
      c.currentBook?.libraryItemId !== libraryItemId && c.queuedItemIds?.includes(libraryItemId),
  )
  const otherClubs = mine.filter(
    (c) =>
      c.currentBook?.libraryItemId !== libraryItemId && !c.queuedItemIds?.includes(libraryItemId),
  )
  // Only the owner can set/queue a book. If we don't know our id yet, show the
  // controls (the server still gates the write) rather than hiding a real option.
  const ownedOther = otherClubs.filter((c) => !meId || c.createdBy === meId)

  // Nothing to show and can't create: hide (older server / clubs off server-side).
  if (!enabled && readingThis.length === 0 && joinable.length === 0) return null

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Icon name={icons.club} size={20} color={colors.accent} />
        <AppText variant="title" style={{ flex: 1 }}>
          Book Club
        </AppText>
      </View>

      {readingThis.map((c) => (
        <Touchable key={c.id} style={styles.clubRow} onPress={() => openClub(c.id)}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label" numberOfLines={1}>
              {c.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {memberLabel(c)} · reading this now
            </AppText>
          </View>
          <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
        </Touchable>
      ))}

      {queuedThis.map((c) => {
        const canRemove = !meId || c.createdBy === meId
        return (
          <View key={c.id} style={styles.clubRow}>
            <Touchable style={{ flex: 1, minWidth: 0 }} onPress={() => openClub(c.id)}>
              <AppText variant="label" numberOfLines={1}>
                {c.name}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {memberLabel(c)} · in up next
              </AppText>
            </Touchable>
            {canRemove ? (
              <Touchable
                style={styles.ghostBtn}
                disabled={busy}
                onPress={() => void dequeue(c)}
                accessibilityRole="button"
                accessibilityState={{ selected: true }}
                accessibilityLabel={`Remove this book from ${c.name} up next`}
              >
                <Icon name={icons.check} size={15} color={colors.accent} />
                <AppText variant="caption" color={colors.accent}>
                  Added
                </AppText>
              </Touchable>
            ) : (
              <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
            )}
          </View>
        )
      })}

      {joinable.map((c) => (
        <View key={c.id} style={styles.clubRow}>
          <Touchable style={{ flex: 1, minWidth: 0 }} onPress={() => openClub(c.id)}>
            <AppText variant="label" numberOfLines={1}>
              {c.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {memberLabel(c)} · open to join
            </AppText>
          </Touchable>
          <Touchable style={styles.pillBtn} disabled={busy} onPress={() => void join(c)}>
            <AppText variant="label" color={colors.onAccent}>
              Join
            </AppText>
          </Touchable>
        </View>
      ))}

      {/* Owner: add this book to a club you already run - set it as the current
          read now, or queue it up next. */}
      {ownedOther.map((c) => (
        <View key={c.id} style={styles.clubRow}>
          <Touchable style={{ flex: 1, minWidth: 0 }} onPress={() => openClub(c.id)}>
            <AppText variant="label" numberOfLines={1}>
              {c.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {c.currentBook ? 'Add this book' : 'No current book'}
            </AppText>
          </Touchable>
          <Touchable style={styles.ghostBtn} disabled={busy} onPress={() => void enqueue(c)}>
            <Icon name={icons.add} size={15} color={colors.accent} />
            <AppText variant="caption" color={colors.accent}>
              Queue
            </AppText>
          </Touchable>
          <Touchable style={styles.pillBtn} disabled={busy} onPress={() => void setCurrent(c)}>
            <AppText variant="label" color={colors.onAccent}>
              Read now
            </AppText>
          </Touchable>
        </View>
      ))}

      {enabled ? (
        creating ? (
          <View style={styles.createRow}>
            <TextInput
              style={styles.input}
              placeholder="Club name…"
              placeholderTextColor={colors.textFaint}
              value={name}
              onChangeText={setName}
              autoFocus
              maxLength={80}
              onSubmitEditing={() => void create()}
            />
            <View style={styles.visibilityRow}>
              {(['closed', 'public'] as const).map((choice) => (
                <Touchable
                  key={choice}
                  style={[styles.visibilityChip, visibility === choice && styles.visibilityChipOn]}
                  onPress={() => setVisibility(choice)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: visibility === choice }}
                >
                  <Icon
                    name={choice === 'closed' ? icons.lock : icons.club}
                    size={14}
                    color={visibility === choice ? colors.accent : colors.textMuted}
                  />
                  <AppText variant="caption">{choice === 'closed' ? 'Closed' : 'Public'}</AppText>
                </Touchable>
              ))}
            </View>
            <Touchable
              style={[styles.pillBtn, (!name.trim() || busy) && { opacity: 0.5 }]}
              disabled={!name.trim() || busy}
              onPress={() => void create()}
            >
              <AppText variant="label" color={colors.onAccent}>
                Create
              </AppText>
            </Touchable>
          </View>
        ) : mine.length > 0 ? (
          // Already in clubs: a compact chip, not the big dashed panel.
          <Touchable style={styles.createChip} onPress={() => setCreating(true)}>
            <Icon name={icons.add} size={16} color={colors.accent} />
            <AppText variant="caption" color={colors.accent}>
              New club
            </AppText>
          </Touchable>
        ) : (
          <Touchable style={styles.createStart} onPress={() => setCreating(true)}>
            <Icon name={icons.add} size={18} color={colors.accent} />
            <AppText variant="label" color={colors.accent}>
              Start a club with this book
            </AppText>
          </Touchable>
        )
      ) : null}
    </View>
  )
}

function memberLabel(c: HSClub): string {
  return `${c.memberCount} ${c.memberCount === 1 ? 'member' : 'members'}`
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl, gap: spacing.sm },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.xs,
    },
    clubRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    pillBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    ghostBtn: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
    },
    createRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
    visibilityRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      width: '100%',
    },
    visibilityChip: {
      minHeight: 44,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    visibilityChipOn: {
      borderColor: colors.accent,
      backgroundColor: colors.accentWash,
    },
    input: {
      flex: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: colors.text,
      fontSize: 15,
    },
    createChip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    createStart: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderStyle: 'dashed',
    },
  })
