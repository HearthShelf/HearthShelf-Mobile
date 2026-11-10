/**
 * Full-screen offline state for screens that are meaningless without the server
 * (Server Admin, and anything else that only reads or writes live server data).
 * The hearth backdrop the sign-in screen uses, a bottom scrim for legibility, a
 * short plain explanation, and the two things the user can actually do: try the
 * connection again, or go back.
 */
import { Image, Pressable, StyleSheet, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnection } from '@/api/ConnectionProvider'
import { AppText, PrimaryButton } from './primitives'
import { Icon, icons } from './icons'
import { radius, spacing } from './theme'
import { useColors } from './ThemeProvider'

const HEARTH_BG = require('../../assets/images/hearth-centered.webp')

export function OfflineSplash({
  title = "You're offline",
  body = 'This needs a connection to your server. Your downloaded books still play.',
  onBack,
  backLabel = 'Go back',
}: {
  title?: string
  body?: string
  onBack?: () => void
  backLabel?: string
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { retry } = useConnection()

  return (
    <View style={styles.root}>
      <Image source={HEARTH_BG} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <LinearGradient
        colors={['transparent', 'rgba(10,9,8,0.45)', 'rgba(10,9,8,0.94)']}
        locations={[0, 0.4, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
        <View style={styles.chip}>
          <Icon name={icons.cloudOff} size={30} color={colors.brandHearth} />
        </View>
        <AppText variant="title" color="#F5EFE6" style={styles.center}>
          {title}
        </AppText>
        <AppText variant="meta" color="rgba(245,239,230,0.75)" style={styles.center}>
          {body}
        </AppText>
        <PrimaryButton label="Try again" icon={icons.retry} onPress={retry} style={styles.cta} />
        {onBack ? (
          <Pressable onPress={onBack} accessibilityRole="button" hitSlop={8} style={styles.back}>
            <AppText variant="meta" color="rgba(245,239,230,0.85)">
              {backLabel}
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0908', justifyContent: 'flex-end' },
  content: { paddingHorizontal: spacing.xl, alignItems: 'center', gap: spacing.md },
  chip: {
    width: 64,
    height: 64,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(245,239,230,0.08)',
  },
  center: { textAlign: 'center' },
  cta: { alignSelf: 'stretch', marginTop: spacing.sm },
  back: { paddingVertical: spacing.sm },
})
