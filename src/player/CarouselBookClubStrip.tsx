import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import type { HSClubMember } from '@hearthshelf/core'
import { avatarUrl } from '@/api/abs'
import { getMeId } from '@/api/me'
import { AppText, Avatar } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

interface ReaderPip {
  userId: string
  username: string
  fraction: number
  me: boolean
}

function readersOnBook(members: HSClubMember[], itemId: string, meId: string): ReaderPip[] {
  const readers = members.flatMap<ReaderPip>((member) => {
    const currentTime = member.currentTime ?? 0
    const duration = member.duration ?? 0
    if (duration <= 0 || member.isFinished === true) return []

    // Reach identifies the furthest club book this member is currently working
    // through. On older/no-db responses it can be absent, so a real non-zero
    // progress row remains a safe fallback.
    const isOnThisBook = member.reach
      ? member.reach.libraryItemId === itemId && !member.reach.isFinished
      : currentTime > 0
    if (!isOnThisBook) return []

    return [
      {
        userId: member.userId,
        username: member.username,
        fraction: Math.max(0, Math.min(1, currentTime / duration)),
        me: !!meId && member.userId === meId,
      },
    ]
  })
  readers.sort((a, b) => a.fraction - b.fraction)
  return readers.slice(-6)
}

/** Informational overlay for a non-live carousel cover. A club book always
 *  carries its club name; once focused detail confirms readers on this book,
 *  the compact label expands into their avatar progress race. */
export function CarouselBookClubStrip({
  clubName,
  itemId,
  members,
}: {
  clubName: string
  itemId: string
  members?: HSClubMember[]
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const readers = useMemo(() => readersOnBook(members ?? [], itemId, getMeId()), [itemId, members])

  if (!readers.length) {
    return (
      <View
        pointerEvents="none"
        accessible
        accessibilityLabel={`${clubName} book club`}
        style={styles.namePill}
      >
        <Icon name={icons.club} size={15} color={colors.accent} />
        <AppText variant="caption" color="#fff" numberOfLines={1} style={styles.clubName}>
          {clubName}
        </AppText>
      </View>
    )
  }

  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`${clubName}. ${readers.length} ${readers.length === 1 ? 'reader' : 'readers'} on this book`}
      style={styles.racePanel}
    >
      <View style={styles.header}>
        <View style={styles.nameRow}>
          <Icon name={icons.club} size={15} color={colors.accent} />
          <AppText variant="caption" color="#fff" numberOfLines={1} style={styles.clubName}>
            {clubName}
          </AppText>
        </View>
        <AppText variant="caption" color="rgba(255,255,255,0.62)">
          {readers.length} {readers.length === 1 ? 'reader' : 'readers'} here
        </AppText>
      </View>
      <View style={styles.track}>
        <View style={styles.trackLine} />
        {readers.map((reader) => (
          <View
            key={reader.userId}
            style={[
              styles.pip,
              { left: `${reader.fraction * 100}%` as `${number}%` },
              reader.me && styles.myPip,
            ]}
          >
            <Avatar uri={avatarUrl(reader.userId)} size={18} name={reader.username} />
          </View>
        ))}
      </View>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    namePill: {
      position: 'absolute',
      left: 10,
      bottom: 10,
      maxWidth: '78%',
      minHeight: 36,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,242,228,0.16)',
      borderRadius: radius.pill,
      backgroundColor: 'rgba(15,11,10,0.86)',
    },
    racePanel: {
      position: 'absolute',
      right: 10,
      bottom: 10,
      left: 10,
      minHeight: 66,
      paddingHorizontal: spacing.md,
      paddingTop: 9,
      paddingBottom: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,242,228,0.16)',
      borderRadius: radius.card,
      backgroundColor: 'rgba(15,11,10,0.86)',
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    nameRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    clubName: { flexShrink: 1, fontWeight: '800' },
    track: { height: 27, marginHorizontal: 11, marginTop: 3, position: 'relative' },
    trackLine: {
      position: 'absolute',
      top: 12,
      right: 0,
      left: 0,
      height: 3,
      borderRadius: 3,
      backgroundColor: 'rgba(255,255,255,0.18)',
    },
    pip: {
      position: 'absolute',
      top: 2,
      width: 22,
      height: 22,
      marginLeft: -11,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'rgba(13,10,9,0.96)',
      borderRadius: 11,
    },
    myPip: {
      zIndex: 2,
      borderColor: colors.accent,
      shadowColor: colors.accent,
      shadowOpacity: 0.5,
      shadowRadius: 3,
    },
  })
