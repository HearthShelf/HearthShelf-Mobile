/**
 * Active book clubs on the home screen. Shows the clubs the reader is in (with a
 * current book) as a compact horizontal row, each opening the club room. Renders
 * nothing when the reader has no clubs or has turned the feature off - so it's
 * safe to always mount on Home.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import type { HSClub } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { getClubs } from '@/api/clubs'
import { coverUrl } from '@/api/abs'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { AppText, Cover, SectionHeader, Touchable } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function HomeClubShelf() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { clubsEnabled } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const [clubs, setClubs] = useState<HSClub[]>([])

  useFocusEffect(
    useCallback(() => {
      if (!clubsEnabled) {
        setClubs([])
        return
      }
      let cancelled = false
      void getClubs().then((res) => {
        if (!cancelled) setClubs(res.enabled ? res.mine : [])
      })
      return () => {
        cancelled = true
      }
    }, [clubsEnabled]),
  )

  if (!clubsEnabled || clubs.length === 0) return null

  return (
    <View>
      <SectionHeader
        title="Your book clubs"
        onPress={() => router.push('/club?from=home')}
        action={
          <Touchable hitSlop={8} onPress={() => router.push('/club?from=home')}>
            <AppText variant="caption" color={colors.accent}>
              See all
            </AppText>
          </Touchable>
        }
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {clubs.map((c) => (
          <Touchable
            key={c.id}
            style={styles.card}
            onPress={() => router.push(`/club/${encodeURIComponent(c.id)}?from=home`)}
          >
            <Cover
              uri={c.currentBook ? coverUrl(c.currentBook.libraryItemId) : undefined}
              itemId={c.currentBook?.libraryItemId}
              width={96}
              aspectRatio={1}
              radius={radius.card}
              fallback={{
                hue: coverHue(c.currentBook?.libraryItemId ?? c.id),
                initial: (c.name || '?').charAt(0).toUpperCase(),
                title: c.name,
              }}
            />
            <AppText variant="caption" numberOfLines={1} style={{ marginTop: spacing.xs }}>
              {c.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {c.currentBook?.title || 'No current book'}
            </AppText>
          </Touchable>
        ))}
      </ScrollView>
    </View>
  )
}

const makeStyles = (_colors: Palette) =>
  StyleSheet.create({
    row: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
    card: { width: 96 },
  })
