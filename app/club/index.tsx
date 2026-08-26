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
import {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { coverHue } from '@hearthshelf/core'
import {
  getClubs,
  getClub,
  createClub,
  setClubMembership,
  type ClubSummary,
  type ClubVisibility,
} from '@/api/clubs'
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
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet'
import { Icon, icons } from '@/ui/icons'
import { AppTabBar, tabFromParam, useGoToTab } from '@/ui/AppTabBar'
import { EmptyState, Skeleton, SkeletonRow } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { useContentInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const QUIET_AFTER_MS = 30 * 24 * 60 * 60 * 1000

export default function MyClubsScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const contentInset = useContentInset()
  const { from } = useLocalSearchParams<{ from?: string }>()
  const active = tabFromParam(from, 'home')
  const { clubsEnabled } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const newClubRef = useRef<SheetRef>(null)

  const [clubs, setClubs] = useState<ClubSummary[] | null>(null)
  const [joinable, setJoinable] = useState<ClubSummary[]>([])
  // Per-club unread counts, filled in after the list loads (best-effort).
  const [unread, setUnread] = useState<Record<string, number>>({})

  const load = useCallback(() => {
    let cancelled = false
    void getClubs(undefined, true).then((res) => {
      if (cancelled) return
      const mine = res.enabled ? res.mine : []
      setClubs(mine)
      setJoinable(res.enabled ? res.joinable : [])
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
  }, [])

  useFocusEffect(useCallback(() => load(), [load]))

  const goToTab = useGoToTab()

  const createNewClub = async (name: string, visibility: ClubVisibility) => {
    const trimmed = name.trim()
    if (!trimmed) return
    haptics.success()
    const club = await createClub(trimmed, undefined, visibility)
    newClubRef.current?.dismiss()
    if (club) {
      showToast(`Created ${club.name}`)
      router.push(`/club/${encodeURIComponent(club.id)}?from=${active}`)
    } else {
      showToast('Could not create club')
    }
  }

  const joinPublicClub = async (club: ClubSummary) => {
    const joined = await setClubMembership(club.id, true)
    if (!joined) {
      showToast('Could not join club')
      return
    }
    haptics.success()
    newClubRef.current?.dismiss()
    showToast(`Joined ${club.name}`)
    router.push(`/club/${encodeURIComponent(club.id)}?from=${active}`)
  }

  // Open a public club WITHOUT joining. The room renders its preview: books,
  // members and progress, with every comment blurred behind a Join prompt.
  const previewPublicClub = (club: ClubSummary) => {
    newClubRef.current?.dismiss()
    router.push(`/club/${encodeURIComponent(club.id)}?from=${active}`)
  }

  const needsYou = clubs?.filter((club) => (unread[club.id] ?? 0) > 0) ?? []
  const quietCutoff = Date.now() - QUIET_AFTER_MS
  const quiet = clubs?.filter((club) => (club.lastActivityAt ?? club.createdAt) < quietCutoff) ?? []
  const quietIds = new Set(quiet.map((club) => club.id))
  const activeClubs = clubs?.filter((club) => !quietIds.has(club.id)) ?? []

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
        <View style={{ flex: 1, marginHorizontal: spacing.sm }}>
          <AppText variant="label">My Book Clubs</AppText>
          {clubs ? (
            <AppText variant="caption" color={colors.textMuted}>
              {clubs.length} {clubs.length === 1 ? 'club' : 'clubs'} · {needsYou.length} need you
            </AppText>
          ) : null}
        </View>
        {clubsEnabled ? (
          <IconButton
            name={icons.add}
            onPress={() => newClubRef.current?.present()}
            style={styles.headerBtn}
            accessibilityLabel="Join or create a book club"
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
          body="Join a public club on this server, or create one of your own."
          cta="Join or create"
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
          {needsYou.length > 0 ? (
            <ClubSection title="Needs you" accent styles={styles}>
              {needsYou.map((c) => (
                <ClubRow
                  key={`needs-${c.id}`}
                  club={c}
                  unread={unread[c.id] ?? 0}
                  styles={styles}
                  colors={colors}
                  compact
                  onPress={() => router.push(`/club/${encodeURIComponent(c.id)}?from=${active}`)}
                />
              ))}
            </ClubSection>
          ) : null}
          {activeClubs.length > 0 ? (
            <ClubSection title="Your clubs" styles={styles}>
              {activeClubs.map((c) => (
                <ClubRow
                  key={c.id}
                  club={c}
                  unread={unread[c.id] ?? 0}
                  styles={styles}
                  colors={colors}
                  onPress={() => router.push(`/club/${encodeURIComponent(c.id)}?from=${active}`)}
                />
              ))}
            </ClubSection>
          ) : null}
          {quiet.length > 0 ? (
            <ClubSection title="Quiet for a while" quiet styles={styles}>
              {quiet.map((c) => (
                <ClubRow
                  key={c.id}
                  club={c}
                  unread={unread[c.id] ?? 0}
                  styles={styles}
                  colors={colors}
                  quiet
                  onPress={() => router.push(`/club/${encodeURIComponent(c.id)}?from=${active}`)}
                />
              ))}
            </ClubSection>
          ) : null}
        </ScrollView>
      )}

      <NewClubSheet
        ref={newClubRef}
        joinable={joinable}
        onJoin={joinPublicClub}
        onPreview={previewPublicClub}
        onCreate={createNewClub}
        styles={styles}
        colors={colors}
      />
    </Screen>
  )
}

function ClubSection({
  title,
  accent,
  quiet,
  styles,
  children,
}: {
  title: string
  accent?: boolean
  quiet?: boolean
  styles: Styles
  children: ReactNode
}) {
  return (
    <View style={[styles.section, quiet && styles.quietSection]}>
      <AppText variant="eyebrow" style={[styles.sectionTitle, accent && styles.sectionTitleAccent]}>
        {title}
      </AppText>
      <View style={{ gap: spacing.sm }}>{children}</View>
    </View>
  )
}

function ClubRow({
  club,
  unread,
  styles,
  colors,
  compact,
  quiet,
  onPress,
}: {
  club: ClubSummary
  unread: number
  styles: Styles
  colors: Palette
  compact?: boolean
  quiet?: boolean
  onPress: () => void
}) {
  const members = `${club.memberCount} ${club.memberCount === 1 ? 'member' : 'members'}`
  const bookLine = club.currentBook
    ? `Reading ${club.currentBook.title || 'a book'}`
    : 'No current book'
  return (
    <Touchable
      style={[styles.row, compact && styles.compactRow, quiet && styles.quietRow]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${club.name}, ${members}`}
    >
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
          {members} · {club.isOpen ? 'Public' : 'Closed'}
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
  {
    joinable: ClubSummary[]
    onJoin: (club: ClubSummary) => void
    onPreview: (club: ClubSummary) => void
    onCreate: (name: string, visibility: ClubVisibility) => void
    styles: Styles
    colors: Palette
  }
>(function NewClubSheet({ joinable, onJoin, onPreview, onCreate, styles, colors }, ref) {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ClubVisibility>('closed')
  return (
    <Sheet ref={ref} title="Join or create" snapPoints={['85%']}>
      <BottomSheetScrollView contentContainerStyle={styles.sheetScroll}>
        {joinable.length > 0 ? (
          <View style={styles.joinSection}>
            <AppText variant="eyebrow" color={colors.textMuted}>
              Public clubs
            </AppText>
            {joinable.map((club) => (
              <View key={club.id} style={styles.joinRow}>
                {/* Tapping the row looks inside first - a public club shows its
                    books and members to anyone, with the discussion withheld. */}
                <Touchable
                  style={{ flex: 1, minWidth: 0 }}
                  onPress={() => onPreview(club)}
                  accessibilityRole="button"
                  accessibilityLabel={`Look inside ${club.name}`}
                >
                  <AppText variant="label" numberOfLines={1}>
                    {club.name}
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                    {club.currentBook?.title ?? 'Choosing a first book'} · {club.memberCount}{' '}
                    {club.memberCount === 1 ? 'member' : 'members'}
                  </AppText>
                </Touchable>
                <Touchable
                  style={styles.joinButton}
                  onPress={() => onJoin(club)}
                  accessibilityRole="button"
                  accessibilityLabel={`Join ${club.name}`}
                >
                  <AppText variant="caption" color={colors.onAccent}>
                    Join
                  </AppText>
                </Touchable>
              </View>
            ))}
          </View>
        ) : (
          <AppText variant="caption" color={colors.textMuted} style={styles.noPublicClubs}>
            No public clubs are looking for members right now.
          </AppText>
        )}
        <View style={styles.sheetDivider} />
        <AppText variant="eyebrow" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
          Create a club
        </AppText>
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
        <View style={styles.visibilityChoices}>
          {(['closed', 'public'] as const).map((choice) => {
            const selected = visibility === choice
            return (
              <Touchable
                key={choice}
                style={[styles.visibilityChoice, selected && styles.visibilityChoiceOn]}
                onPress={() => setVisibility(choice)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
              >
                <Icon
                  name={choice === 'closed' ? icons.lock : icons.club}
                  size={18}
                  color={selected ? colors.accent : colors.textMuted}
                />
                <View style={{ flex: 1 }}>
                  <AppText variant="label">{choice === 'closed' ? 'Closed' : 'Public'}</AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    {choice === 'closed'
                      ? 'Invite-only. Only members can see the club room.'
                      : 'Anyone on this server can find and join.'}
                  </AppText>
                </View>
              </Touchable>
            )
          })}
        </View>
        <PrimaryButton
          label="Create club"
          icon={icons.add}
          onPress={() => {
            onCreate(name, visibility)
            setName('')
            setVisibility('closed')
          }}
          style={{ marginTop: spacing.md }}
        />
      </BottomSheetScrollView>
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
    compactRow: {
      paddingVertical: spacing.sm,
    },
    quietRow: {
      opacity: 0.62,
      backgroundColor: 'transparent',
    },
    section: {
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    quietSection: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
      paddingTop: spacing.md,
    },
    sectionTitle: {
      color: colors.textMuted,
      marginBottom: spacing.xs,
    },
    sectionTitleAccent: {
      color: colors.accent,
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
    joinSection: {
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    sheetScroll: {
      paddingBottom: spacing.xxl,
    },
    joinRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs,
    },
    joinButton: {
      minWidth: 56,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    noPublicClubs: {
      marginBottom: spacing.md,
    },
    sheetDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.hairline,
      marginBottom: spacing.md,
    },
    visibilityChoices: {
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    visibilityChoice: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
    },
    visibilityChoiceOn: {
      borderColor: colors.accent,
      backgroundColor: colors.accentWash,
    },
  })
