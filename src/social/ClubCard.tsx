/**
 * Book Club card on the book detail page. Shows the clubs the reader is in whose
 * current book is this item, plus open clubs they can join for this item, and a
 * "Create a club" affordance seeded with this book. Hides itself entirely when
 * clubs are disabled on the server (older server or admin kill-switch).
 *
 * Tapping a club opens its room (app/club/[id]). Joining states plainly that
 * members see your progress in the club's books.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { HSClub } from '@hearthshelf/core'
import { getClubs, createClub, setClubMembership } from '@/api/clubs'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function ClubCard({
  libraryItemId,
  onToast,
}: {
  libraryItemId: string
  onToast?: (message: string) => void
}) {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [enabled, setEnabled] = useState(true)
  const [mine, setMine] = useState<HSClub[]>([])
  const [joinable, setJoinable] = useState<HSClub[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await getClubs(libraryItemId)
    setEnabled(res.enabled)
    setMine(res.mine)
    setJoinable(res.joinable)
  }, [libraryItemId])

  useEffect(() => {
    void load()
  }, [load])

  const openClub = (id: string) => {
    router.push(`/club/${encodeURIComponent(id)}`)
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
    const club = await createClub(trimmed, libraryItemId)
    setBusy(false)
    if (club) {
      setName('')
      setCreating(false)
      onToast?.(`Created ${club.name}`)
      openClub(club.id)
    } else {
      onToast?.('Could not create club')
    }
  }

  // Hidden entirely when clubs are off and the reader isn't in one for this book.
  if (!enabled && mine.length === 0 && joinable.length === 0) return null

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Icon name={icons.club} size={20} color={colors.accent} />
        <AppText variant="title" style={{ flex: 1 }}>
          Book Club
        </AppText>
      </View>

      {mine.map((c) => (
        <Touchable key={c.id} style={styles.clubRow} onPress={() => openClub(c.id)}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label" numberOfLines={1}>
              {c.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'} · reading this now
            </AppText>
          </View>
          <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
        </Touchable>
      ))}

      {joinable.map((c) => (
        <View key={c.id} style={styles.clubRow}>
          <Touchable style={{ flex: 1, minWidth: 0 }} onPress={() => openClub(c.id)}>
            <AppText variant="label" numberOfLines={1}>
              {c.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'} · open to join
            </AppText>
          </Touchable>
          <Touchable style={styles.joinBtn} disabled={busy} onPress={() => void join(c)}>
            <AppText variant="label" color={colors.onAccent}>
              Join
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
            <Touchable
              style={[styles.joinBtn, (!name.trim() || busy) && { opacity: 0.5 }]}
              disabled={!name.trim() || busy}
              onPress={() => void create()}
            >
              <AppText variant="label" color={colors.onAccent}>
                Create
              </AppText>
            </Touchable>
          </View>
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

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl, gap: spacing.sm },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
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
    joinBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    createRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
