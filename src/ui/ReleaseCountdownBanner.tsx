/**
 * Home countdown banner: "X days until <book>" for followed books whose release
 * is within the user's countdown window (settings: notifyCountdownWindowDays,
 * default 14). Renders nothing when nothing qualifies. Tapping opens the upcoming
 * book page. Reads the shared subscriptions store + Core's bannerSubscriptions so
 * it stays in step with the Notifications screen with no extra fetch.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { bannerSubscriptions, countdownLabel, coverHue } from '@hearthshelf/core'
import { getSubscriptionsState, subscribeSubscriptions } from '@/player/subscriptions'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { AppText, Cover, Touchable, icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

export function ReleaseCountdownBanner() {
  const router = useRouter()
  const { subscriptions } = useSyncExternalStore(subscribeSubscriptions, getSubscriptionsState)
  const { notifyCountdownWindowDays } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const styles = useStyles()
  const { colors } = useTheme()

  // Re-derive on any relevant change. Date.now() at render is fine here (banner
  // is not a hot path); Core does the pure filtering/sorting.
  const upcoming = useMemo(
    () =>
      bannerSubscriptions(
        subscriptions,
        { countdownWindowDays: notifyCountdownWindowDays },
        Date.now(),
      ),
    [subscriptions, notifyCountdownWindowDays],
  )

  if (upcoming.length === 0) return null
  const soonest = upcoming[0]
  const label = countdownLabel(soonest, Date.now())
  const extra = upcoming.length - 1

  return (
    <Touchable
      style={styles.banner}
      onPress={() =>
        router.push(
          soonest.asin ? `/upcoming/${encodeURIComponent(soonest.asin)}` : '/settings/notifications',
        )
      }
    >
      <Cover
        uri={soonest.coverArtUrl}
        size={48}
        radius={8}
        fallback={{
          hue: coverHue(soonest.asin ?? soonest.id),
          initial: soonest.title.charAt(0).toUpperCase(),
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.eyebrowRow}>
          <Icon name={icons.newRelease} size={14} color={colors.accent} />
          <AppText variant="eyebrow" color={colors.accent}>
            {label === 'Out today' ? 'Out today' : `${label} until release`}
          </AppText>
        </View>
        <AppText variant="label" numberOfLines={1} style={{ marginTop: 2 }}>
          {soonest.title}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {extra > 0
            ? `and ${extra} more on the way`
            : (soonest.author ?? soonest.seriesTitle ?? 'Coming soon')}
        </AppText>
      </View>
      <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
    </Touchable>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.accentWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
    },
    eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  })

function useStyles() {
  const { colors } = useTheme()
  return useMemo(() => makeStyles(colors), [colors])
}
