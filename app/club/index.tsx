/**
 * My Book Clubs: the list of clubs the reader belongs to, reached from the More
 * tab (shown there only when they're in at least one). Each row opens the club
 * room. Self-contained like the club room - its own header + tab bar, pushed
 * above the tabs navigator.
 *
 * Hidden behind the clubsEnabled setting: if the reader turned clubs off, this
 * route bounces back rather than showing an empty list.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import type { HSClub } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { getClubs } from '@/api/clubs'
import { coverUrl } from '@/api/abs'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { AppText, Centered, Cover, IconButton, Loading, Screen, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { AppTabBar } from '@/ui/AppTabBar'
import { useContentInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export default function MyClubsScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const contentInset = useContentInset()
  const { clubsEnabled } = useSyncExternalStore(subscribeSettings, getSettingsState)

  const [clubs, setClubs] = useState<HSClub[] | null>(null)

  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      void getClubs().then((res) => {
        if (!cancelled) setClubs(res.enabled ? res.mine : [])
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

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
        <AppText variant="label" style={{ flex: 1, marginHorizontal: spacing.sm }}>
          My Book Clubs
        </AppText>
      </View>

      {!clubsEnabled ? (
        <Centered>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            Book clubs are turned off in Settings.
          </AppText>
        </Centered>
      ) : clubs === null ? (
        <Loading />
      ) : clubs.length === 0 ? (
        <Centered>
          <Icon name={icons.club} size={40} color={colors.textFaint} />
          <AppText variant="title" style={{ marginTop: spacing.sm }}>
            No clubs yet
          </AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            Open a book and start a club to read along with others.
          </AppText>
        </Centered>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: contentInset,
            gap: spacing.sm,
          }}
        >
          {clubs.map((c) => (
            <Touchable
              key={c.id}
              style={styles.row}
              onPress={() => router.push(`/club/${encodeURIComponent(c.id)}`)}
            >
              {c.currentBook ? (
                <Cover
                  uri={coverUrl(c.currentBook.libraryItemId)}
                  itemId={c.currentBook.libraryItemId}
                  size={46}
                  radius={radius.tile}
                  fallback={{
                    hue: coverHue(c.currentBook.libraryItemId),
                    initial: (c.currentBook.title || '?').charAt(0),
                  }}
                />
              ) : (
                <View style={styles.noBook}>
                  <Icon name={icons.club} size={20} color={colors.textMuted} />
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label" numberOfLines={1}>
                  {c.name}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {c.currentBook ? `Reading ${c.currentBook.title || 'a book'}` : 'No current book'}
                </AppText>
              </View>
              <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
            </Touchable>
          ))}
        </ScrollView>
      )}

      <AppTabBar activeName={null} onPressTab={goToTab} />
    </Screen>
  )
}

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
  })
