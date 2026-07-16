/**
 * My Book Clubs: the list of clubs the reader belongs to, reached from the More
 * tab (shown there only when they're in at least one). Each row opens the club
 * room. Self-contained like the club room - its own header + tab bar, pushed
 * above the tabs navigator.
 *
 * Each row shows the club's current book, its member count, and an unread-notes
 * badge (fetched per club from the room endpoint's unreadCount, which is a plain
 * read - it does not advance the read cursor). A "New club" header action starts
 * a bookless club from a name.
 *
 * Hidden behind the clubsEnabled setting: if the reader turned clubs off, this
 * route bounces back rather than showing an empty list.
 */
import { forwardRef, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import type { HSClub } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { getClubs, getClub, createClub } from '@/api/clubs'
import { coverUrl } from '@/api/abs'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import {
  AppText,
  Cover,
  IconButton,
  PrimaryButton,
  Screen,
  Sheet,
  type SheetRef,
  Touchable,
} from '@/ui/primitives'
import { BottomSheetTextInput } from '@gorhom/bottom-sheet'
import { Icon, icons } from '@/ui/icons'
import { AppTabBar, tabFromParam } from '@/ui/AppTabBar'
import { EmptyState, Skeleton, SkeletonRow } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { useContentInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export default function MyClubsScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const contentInset = useContentInset()
  const { from } = useLocalSearchParams<{ from?: string }>()
  const active = tabFromParam(from, 'home')
  const { clubsEnabled } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const newClubRef = useRef<SheetRef>(null)

  const [clubs, setClubs] = useState<HSClub[] | null>(null)
  // Per-club unread counts, filled in after the list loads (best-effort).
  const [unread, setUnread] = useState<Record<string, number>>({})

  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      void getClubs().then((res) => {
        if (cancelled) return
        const mine = res.enabled ? res.mine : []
        setClubs(mine)
        // Fetch each club's unread count in parallel. getClub() without a
        // bookId/position is a plain read and does NOT advance the read cursor
        // (that's a separate markClubRead PUT the room fires), so this is safe.
        void Promise.all(
          mine.map((c) =>
            getClub(c.id)
              .then((d) => [c.id, d?.unreadCount ?? 0] as const)
              .catch(() => [c.id, 0] as const),
          ),
        ).then((pairs) => {
          if (!cancelled) setUnread(Object.fromEntries(pairs))
        })
      })
      return () => {
        cancelled = true
      }
    }, []),
  )

  const goToTab = (name: string) => {
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  const createNewClub = async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    haptics.success()
    const club = await createClub(trimmed)
    newClubRef.current?.dismiss()
    if (club) {
      showToast(`Created ${club.name}`)
      router.push(`/club/${encodeURIComponent(club.id)}?from=${active}`)
    } else {
      showToast('Could not create club')
    }
  }

  return (
    <>
      <Screen>
        <View style={styles.header}>
          <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
          <AppText variant="label" style={{ flex: 1, marginHorizontal: spacing.sm }}>
            My Book Clubs
          </AppText>
          {clubsEnabled && (clubs?.length ?? 0) > 0 ? (
            <IconButton
              name={icons.add}
              onPress={() => newClubRef.current?.present()}
              style={styles.headerBtn}
            />
          ) : null}
        </View>

        {!clubsEnabled ? (
          <EmptyState
            icon={icons.club}
            iconColor={colors.textMuted}
            title="Book clubs are off"
            body="Turn book clubs on in Settings to read along with others."
          />
        ) : clubs === null ? (
          <ClubsSkeleton styles={styles} />
        ) : clubs.length === 0 ? (
          <EmptyState
            icon={icons.club}
            title="No clubs yet"
            body="Start a club to read along with others, or open a book and start one from there."
            cta="New club"
            onCta={() => newClubRef.current?.present()}
          />
        ) : (
          <ScrollView
            contentContainerStyle={{
              padding: spacing.lg,
              paddingBottom: contentInset,
              gap: spacing.sm,
            }}
          >
            {clubs.map((c) => (
              <ClubRow
                key={c.id}
                club={c}
                unread={unread[c.id] ?? 0}
                styles={styles}
                colors={colors}
                onPress={() => router.push(`/club/${encodeURIComponent(c.id)}?from=${active}`)}
              />
            ))}
          </ScrollView>
        )}

        <NewClubSheet ref={newClubRef} onCreate={createNewClub} styles={styles} colors={colors} />
      </Screen>
      <AppTabBar activeName={active} onPressTab={goToTab} />
    </>
  )
}

function ClubRow({
  club,
  unread,
  styles,
  colors,
  onPress,
}: {
  club: HSClub
  unread: number
  styles: Styles
  colors: Palette
  onPress: () => void
}) {
  const members = `${club.memberCount} ${club.memberCount === 1 ? 'member' : 'members'}`
  const bookLine = club.currentBook
    ? `Reading ${club.currentBook.title || 'a book'}`
    : 'No current book'
  return (
    <Touchable style={styles.row} onPress={onPress}>
      {club.currentBook ? (
        <Cover
          uri={coverUrl(club.currentBook.libraryItemId)}
          itemId={club.currentBook.libraryItemId}
          size={46}
          radius={radius.tile}
          fallback={{
            hue: coverHue(club.currentBook.libraryItemId),
            initial: (club.currentBook.title || '?').charAt(0),
          }}
        />
      ) : (
        <View style={styles.noBook}>
          <Icon name={icons.club} size={20} color={colors.textMuted} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label" numberOfLines={1}>
          {club.name}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {bookLine}
        </AppText>
        <AppText variant="caption" color={colors.textFaint} numberOfLines={1}>
          {members}
        </AppText>
      </View>
      {unread > 0 ? (
        <View style={styles.unreadBadge}>
          <AppText variant="caption" color={colors.onAccent} style={styles.unreadText}>
            {unread > 99 ? '99+' : unread}
          </AppText>
        </View>
      ) : (
        <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
      )}
    </Touchable>
  )
}

const NewClubSheet = forwardRef<
  SheetRef,
  { onCreate: (name: string) => void; styles: Styles; colors: Palette }
>(function NewClubSheet({ onCreate, styles, colors }, ref) {
  const [name, setName] = useState('')
  return (
    <Sheet ref={ref} title="New club">
      <AppText variant="caption" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
        Name your club. You can pick a book to read together once it's created.
      </AppText>
      <BottomSheetTextInput
        placeholder="Club name"
        placeholderTextColor={colors.textFaint}
        value={name}
        onChangeText={setName}
        style={styles.nameInput}
        autoFocus
      />
      <PrimaryButton
        label="Create club"
        icon={icons.add}
        onPress={() => {
          onCreate(name)
          setName('')
        }}
        style={{ marginTop: spacing.md }}
      />
    </Sheet>
  )
})

function ClubsSkeleton({ styles }: { styles: Styles }) {
  return (
    <View style={{ padding: spacing.lg, gap: spacing.sm }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={46} height={46} radius={radius.tile} />
          <View style={{ flex: 1, gap: 6 }}>
            <SkeletonRow width={'60%'} height={15} />
            <SkeletonRow width={'40%'} height={12} />
          </View>
        </View>
      ))}
    </View>
  )
}

type Styles = ReturnType<typeof makeStyles>

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    headerBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    noBook: {
      width: 46,
      height: 46,
      borderRadius: radius.tile,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadBadge: {
      minWidth: 22,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: 11,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadText: { fontSize: 11, fontWeight: '700' },
    nameInput: {
      backgroundColor: colors.fill,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: colors.text,
      fontSize: 16,
    },
  })
