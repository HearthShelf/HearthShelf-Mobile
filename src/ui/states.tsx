/**
 * Shared loading / empty / error state components, so every screen that fetches
 * shows the same designed states instead of a bare spinner or blank frame
 * (D-STATES). Matches the state boards in docs/redesign/*.html.
 *
 * - <Skeleton>/<SkeletonRow>/<SkeletonTile> — shimmering placeholders for a
 *   loading layout that mirrors the real one.
 * - <EmptyState> — a warm first-run/empty frame: accent-wash icon chip, title,
 *   muted body, optional primary + secondary CTA.
 * - <ErrorState> — a load-failure frame: muted cloud-off chip, message, a
 *   "Try again" button, optional secondary ghost action.
 */
import { useEffect } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { AppText, PrimaryButton } from './primitives'
import { Icon, icons, type IconName } from './icons'
import { MAX_FONT_SCALE, radius, spacing } from './theme'
import { useColors } from './ThemeProvider'

const SHIMMER_MS = 1600

// ---- Skeleton ----

/**
 * A shimmering placeholder block. A pale gradient sweeps left-to-right across a
 * `fill`-colored base on a ~1.6s loop (matches the web `.skel` treatment).
 */
export function Skeleton({
  width,
  height,
  radius: r = 8,
  aspectRatio,
  style,
}: {
  width?: number | `${number}%`
  height?: number
  radius?: number
  aspectRatio?: number
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const x = useSharedValue(-1)
  useEffect(() => {
    x.value = withRepeat(
      withTiming(1, { duration: SHIMMER_MS, easing: Easing.linear }),
      -1,
      false,
    )
  }, [x])
  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: `${x.value * 100}%` }],
  }))
  return (
    <View
      style={[
        { width, height, aspectRatio, borderRadius: r, backgroundColor: colors.fill, overflow: 'hidden' },
        style,
      ]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
        <LinearGradient
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          colors={['transparent', colors.fillStrong, 'transparent']}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  )
}

/** A one-line text-row skeleton (title/subtitle placeholders). */
export function SkeletonRow({
  width = '60%',
  height = 14,
  style,
}: {
  width?: number | `${number}%`
  height?: number
  style?: StyleProp<ViewStyle>
}) {
  return <Skeleton width={width} height={height} radius={height / 2} style={style} />
}

/** A 2:3 cover placeholder for grid/shelf loading layouts. */
export function SkeletonTile({
  width,
  aspectRatio = 2 / 3,
  style,
}: {
  width: number
  aspectRatio?: number
  style?: StyleProp<ViewStyle>
}) {
  return <Skeleton width={width} aspectRatio={aspectRatio} radius={radius.tile} style={style} />
}

// ---- EmptyState ----

/**
 * A centered empty/first-run frame. The icon sits in an accent-wash rounded chip
 * with the icon drawn in brand gold, over a warm title + muted body.
 */
export function EmptyState({
  icon = icons.flame,
  iconColor,
  title,
  body,
  cta,
  onCta,
  secondaryLabel,
  onSecondary,
  style,
}: {
  icon?: IconName
  /** Icon tint; defaults to brand gold to match the mockup's hearth chip. */
  iconColor?: string
  title: string
  body?: string
  /** Primary CTA label; renders a PrimaryButton when both label + handler set. */
  cta?: string
  onCta?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  return (
    <View style={[styles.center, style]}>
      <View style={[styles.chip, { backgroundColor: colors.accentWash }]}>
        <Icon name={icon} size={34} color={iconColor ?? colors.brandHearth} />
      </View>
      <AppText variant="title" style={styles.title}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="meta" color={colors.textMuted} style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {cta && onCta ? <PrimaryButton label={cta} onPress={onCta} style={styles.cta} /> : null}
      {secondaryLabel && onSecondary ? (
        <GhostButton label={secondaryLabel} onPress={onSecondary} />
      ) : null}
    </View>
  )
}

// ---- ErrorState ----

/**
 * A centered load-failure frame: a muted cloud-off chip, the message, a "Try
 * again" primary button, and an optional secondary ghost action.
 */
export function ErrorState({
  icon = icons.cloudOff,
  title = "Couldn't reach your server",
  message,
  retryLabel = 'Try again',
  onRetry,
  secondaryLabel,
  onSecondary,
  style,
}: {
  icon?: IconName
  title?: string
  message?: string
  retryLabel?: string
  onRetry?: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  return (
    <View style={[styles.center, style]}>
      <View style={[styles.chip, { backgroundColor: colors.fill }]}>
        <Icon name={icon} size={32} color={colors.textMuted} />
      </View>
      <AppText variant="title" style={styles.title}>
        {title}
      </AppText>
      {message ? (
        <AppText variant="meta" color={colors.textMuted} style={styles.body}>
          {message}
        </AppText>
      ) : null}
      {onRetry ? (
        <PrimaryButton label={retryLabel} icon={icons.retry} onPress={onRetry} style={styles.cta} />
      ) : null}
      {secondaryLabel && onSecondary ? (
        <GhostButton label={secondaryLabel} onPress={onSecondary} />
      ) : null}
    </View>
  )
}

// ---- GhostButton (local) ----

function GhostButton({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = useColors()
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}
    >
      <AppText variant="meta" color={colors.textMuted} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {label}
      </AppText>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  chip: {
    width: 64,
    height: 64,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: spacing.md, textAlign: 'center' },
  body: { marginTop: spacing.xs, textAlign: 'center', lineHeight: 20 },
  cta: { marginTop: spacing.lg },
  ghost: { marginTop: spacing.xs, paddingVertical: spacing.xs, paddingHorizontal: spacing.md },
})
