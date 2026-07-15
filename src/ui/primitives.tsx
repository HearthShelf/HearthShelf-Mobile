/**
 * Reusable themed building blocks. All visual surfaces in the app compose from
 * these so colors/radii/spacing come from src/ui/theme.ts rather than per-screen
 * hardcoded hex. Bottom sheets use @gorhom/bottom-sheet (see Sheet below).
 */
import { forwardRef, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetModalProps,
} from '@gorhom/bottom-sheet'
import { localCoverFor, subscribeDownloads } from '@/player/downloads'
import { CoverDownloadOverlay } from './CoverDownloadOverlay'
import { CoverDownloadedBadge } from './CoverDownloadedBadge'
import { Icon, icons, type IconName } from './icons'
import { TypesetCover } from './TypesetCover'
import { MAX_FONT_SCALE, radius, spacing, type as typeScale, type Palette } from './theme'
import { useColors, useTheme } from './ThemeProvider'

// ---- Screen ----

export function Screen({
  children,
  style,
  edges = ['top'],
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  edges?: ('top' | 'bottom' | 'left' | 'right')[]
}) {
  const styles = useStyles()
  return (
    <SafeAreaView style={[styles.screen, style]} edges={edges}>
      {children}
    </SafeAreaView>
  )
}

export function Centered({ children }: { children: React.ReactNode }) {
  const styles = useStyles()
  return <View style={styles.centered}>{children}</View>
}

// ---- Text ----

type TextVariant = keyof typeof typeScale
export function AppText({
  children,
  variant = 'body',
  color,
  numberOfLines,
  style,
  maxFontSizeMultiplier = MAX_FONT_SCALE,
}: {
  children: React.ReactNode
  variant?: TextVariant
  color?: string
  numberOfLines?: number
  style?: StyleProp<TextStyle>
  /** Override the app-wide font-scale ceiling (e.g. 1 to opt out of scaling for
   *  a fixed-size glyph, or a larger value for a hero line with room to grow). */
  maxFontSizeMultiplier?: number
}) {
  const colors = useColors()
  return (
    <Text
      numberOfLines={numberOfLines}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typeScale[variant], { color: color ?? colors.text }, style]}
    >
      {children}
    </Text>
  )
}

// ---- Card / Row ----

export function Card({
  children,
  style,
  onPress,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  onPress?: () => void
}) {
  const styles = useStyles()
  const content = <View style={[styles.card, style]}>{children}</View>
  if (!onPress) return content
  return (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
      {content}
    </Pressable>
  )
}

export function Row({
  children,
  onPress,
  style,
}: {
  children: React.ReactNode
  onPress?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const styles = useStyles()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, style]}
    >
      {children}
    </Pressable>
  )
}

// ---- Touchable ----

/**
 * A Pressable with built-in press feedback so every tap is acknowledged
 * immediately: an Android ripple plus a pressed opacity/scale dim (also covers
 * iOS, where there's no ripple). Use this instead of a bare <Pressable> for any
 * tappable surface - chips, rows, list items, tray options - so a tap never feels
 * unregistered while the action catches up.
 */
export function Touchable({
  children,
  onPress,
  onLongPress,
  disabled,
  style,
  hitSlop,
  rippleColor,
}: {
  children: React.ReactNode
  onPress?: () => void
  onLongPress?: () => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  hitSlop?: number
  rippleColor?: string
}) {
  const colors = useColors()
  const styles = useStyles()
  const ripple = rippleColor ?? colors.fillStrong
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={hitSlop}
      android_ripple={{ color: ripple }}
      style={({ pressed }) => [
        style,
        pressed && styles.touchablePressed,
        disabled && styles.touchableDisabled,
      ]}
    >
      {children}
    </Pressable>
  )
}

// ---- Chip / Pill ----

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string
  active?: boolean
  onPress?: () => void
}) {
  const styles = useStyles()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.pressed]}
    >
      <Text
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[styles.chipText, active && styles.chipTextActive]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

// ---- IconButton ----

export function IconButton({
  name,
  onPress,
  size = 24,
  color,
  hitSlop = 10,
  style,
}: {
  name: IconName
  onPress?: () => void
  size?: number
  color?: string
  hitSlop?: number
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      style={({ pressed }) => [pressed && styles.pressed, style]}
    >
      <Icon name={name} size={size} color={color ?? colors.text} />
    </Pressable>
  )
}

// ---- Primary button ----

export function PrimaryButton({
  label,
  onPress,
  icon,
  style,
}: {
  label: string
  onPress?: () => void
  icon?: IconName
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed, style]}
    >
      {icon ? <Icon name={icon} size={18} color={colors.onAccent} /> : null}
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.primaryBtnText}>
        {label}
      </Text>
    </Pressable>
  )
}

// ---- SectionHeader ----

export function SectionHeader({
  title,
  icon,
  action,
  onPress,
}: {
  title: string
  icon?: IconName
  action?: React.ReactNode
  /** When set, the whole title area (icon + text) is tappable. */
  onPress?: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const titleRow = (
    <View style={styles.sectionTitleRow}>
      {icon ? <Icon name={icon} size={20} color={colors.accent} /> : null}
      <AppText variant="title">{title}</AppText>
    </View>
  )
  return (
    <View style={styles.sectionHeader}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          hitSlop={8}
          style={({ pressed }) => [styles.sectionTitleTap, pressed && styles.pressed]}
        >
          {titleRow}
        </Pressable>
      ) : (
        titleRow
      )}
      {action}
    </View>
  )
}

// ---- Cover ----

/** Typeset-fallback content for a cover, when real artwork is missing/fails. */
export type CoverFallback = { hue: string; initial: string; kicker?: string; title?: string }

export function Cover({
  uri,
  size,
  width,
  aspectRatio = 1,
  radius: r = radius.tile,
  fallback,
  style,
  itemId,
  showDownloadBadge,
}: {
  uri?: string
  size?: number
  width?: number
  aspectRatio?: number
  radius?: number
  /** Shown when there's no uri or the image fails to load. Real artwork wins. */
  fallback?: CoverFallback
  style?: StyleProp<ImageStyle>
  /** When set, an in-flight download of this item dims the cover and draws a
   *  progress ring on top. Pass it anywhere a book's own cover is shown. */
  itemId?: string
  /** Show a small accent check in the corner when this item is downloaded.
   *  Opt-in (Library + Home covers) so it doesn't clutter every cover. */
  showDownloadBadge?: boolean
}) {
  const styles = useStyles()
  const [failed, setFailed] = useState(false)
  const [measured, setMeasured] = useState(0)
  const w = size ?? width
  const dims: ImageStyle = size ? { width: size, height: size } : { width: w, aspectRatio }

  // Prefer a downloaded book's saved cover, so covers show offline (and skip a
  // network round-trip online). Re-resolves when a download completes.
  const localCover = useSyncExternalStore(subscribeDownloads, () =>
    itemId ? localCoverFor(itemId) : null,
  )
  const src = localCover ?? uri
  // A changed source (download completed, or a recycled row rebinds a new item)
  // deserves a fresh load attempt - clear any prior failure.
  useEffect(() => setFailed(false), [src])

  // The overlay needs a pixel size to scale its ring. Use the known width when
  // we have one, otherwise fall back to the measured layout width (for callers
  // that size the cover via flex/style rather than an explicit width).
  const coverSize = size ?? width ?? measured
  const overlay = itemId ? (
    <>
      <CoverDownloadOverlay itemId={itemId} size={coverSize} radius={r} />
      {showDownloadBadge ? (
        <CoverDownloadedBadge
          itemId={itemId}
          size={coverSize > 0 ? Math.max(14, Math.min(24, coverSize * 0.2)) : 20}
        />
      ) : null}
    </>
  ) : null
  const onLayout = itemId
    ? (e: LayoutChangeEvent) => setMeasured(e.nativeEvent.layout.width)
    : undefined

  const hasUri = !!src
  if (!hasUri || failed) {
    const body = fallback ? (
      <TypesetCover
        hue={fallback.hue}
        initial={fallback.initial}
        kicker={fallback.kicker}
        title={fallback.title}
        radius={r}
        style={[dims as StyleProp<ViewStyle>, style as StyleProp<ViewStyle>]}
      />
    ) : (
      // No uri (e.g. mid server-switch) and no fallback: a plain placeholder, not
      // an <Image source={{ uri: '' }}> which warns "uri should not be empty".
      <View style={[styles.cover, dims, { borderRadius: r }, style as StyleProp<ViewStyle>]} />
    )
    if (!overlay) return body
    return (
      <View style={dims as StyleProp<ViewStyle>} onLayout={onLayout}>
        {body}
        {overlay}
      </View>
    )
  }

  const image = (
    <Image
      source={{ uri: src }}
      onError={() => setFailed(true)}
      style={[styles.cover, dims, { borderRadius: r }, style]}
    />
  )
  if (!overlay) return image
  return (
    <View style={dims as StyleProp<ViewStyle>} onLayout={onLayout}>
      {image}
      {overlay}
    </View>
  )
}

// ---- Avatar ----

/** Up to two initials from a person's name (e.g. "Adam Verner" -> "AV"). */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0].charAt(0)
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : ''
  return (first + last).toUpperCase()
}

/**
 * Round person avatar (authors/narrators). Tries the photo `uri`; if it's
 * missing or fails to load, shows centered initials on a hued circle. Unlike a
 * <Cover> fallback (a book-cover treatment with a corner-bleed initial), this is
 * sized and centered for a small round chip.
 */
export function Avatar({
  uri,
  size,
  name,
  hue,
}: {
  uri?: string
  size: number
  name: string
  hue: string
}) {
  const colors = useColors()
  const styles = useStyles()
  const [failed, setFailed] = useState(false)
  if (!uri || failed) {
    return (
      <View
        style={[
          styles.avatarFallback,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: hue },
        ]}
      >
        <Text allowFontScaling={false} style={[styles.avatarInitials, { fontSize: size * 0.36 }]}>
          {initialsOf(name)}
        </Text>
      </View>
    )
  }
  return (
    <Image
      source={{ uri }}
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.fill }}
    />
  )
}

// ---- ProgressBar ----

export function ProgressBar({
  progress,
  height = 4,
  color,
  track,
  style,
}: {
  progress: number // 0..1
  height?: number
  color?: string
  track?: string
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const clamped = Math.max(0, Math.min(1, progress))
  // The fill eases toward each new value (and fills from zero on mount), so
  // progress reads as flowing time instead of snapping into place.
  const fill = useSharedValue(0)
  useEffect(() => {
    fill.value = withTiming(clamped, { duration: 400, easing: Easing.out(Easing.cubic) })
  }, [clamped, fill])
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }))
  return (
    <View
      style={[{ height, borderRadius: height, backgroundColor: track ?? colors.fillStrong }, style]}
    >
      <Animated.View
        style={[
          { height, borderRadius: height, backgroundColor: color ?? colors.accent },
          fillStyle,
        ]}
      />
    </View>
  )
}

// ---- Loading / inline ----

export function Loading({ label }: { label?: string }) {
  const colors = useColors()
  return (
    <Centered>
      <ActivityIndicator color={colors.accent} />
      {label ? (
        <AppText variant="meta" color={colors.textMuted} style={{ marginTop: spacing.md }}>
          {label}
        </AppText>
      ) : null}
    </Centered>
  )
}

// ---- Sheet (bottom-sheet modal) ----

export type SheetRef = BottomSheetModal

/**
 * Themed bottom sheet. Forward a ref and call `ref.current?.present()` /
 * `.dismiss()` to open/close. `snapPoints` accepts e.g. ['50%', '85%'].
 */
export const Sheet = forwardRef<
  BottomSheetModal,
  {
    children: React.ReactNode
    title?: string
    kicker?: string
    snapPoints?: BottomSheetModalProps['snapPoints']
    /** Caps a dynamic-sizing sheet's height (ignored when snapPoints is set).
     *  Needed when a child scroll view's maxHeight can't bound the measured
     *  content on its own - the sheet stops growing past this. */
    maxDynamicContentSize?: BottomSheetModalProps['maxDynamicContentSize']
    /** How this modal behaves when presented over another (default 'replace').
     *  Use 'push' to layer a sub-sheet on top of its opener. */
    stackBehavior?: BottomSheetModalProps['stackBehavior']
    onDismiss?: () => void
  }
>(function Sheet(
  { children, title, kicker, snapPoints, maxDynamicContentSize, stackBehavior, onDismiss },
  ref,
) {
  const colors = useColors()
  const styles = useStyles()
  const header = (kicker || title) && (
    <View style={styles.sheetHeader}>
      {kicker ? (
        <AppText variant="caption" color={colors.textMuted}>
          {kicker.toUpperCase()}
        </AppText>
      ) : null}
      {title ? <AppText variant="title">{title}</AppText> : null}
    </View>
  )
  // No snapPoints -> dynamic sizing, which must measure a BottomSheetView. With
  // snapPoints the sheet has a fixed height and the child (often a
  // BottomSheetScrollView) manages its own scroll, so a plain View is correct
  // there - wrapping scroll content in BottomSheetView would break scrolling.
  const dynamic = !snapPoints
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={dynamic}
      maxDynamicContentSize={dynamic ? maxDynamicContentSize : undefined}
      stackBehavior={stackBehavior}
      onDismiss={onDismiss}
      handleIndicatorStyle={{ backgroundColor: colors.textFaint }}
      backgroundStyle={{ backgroundColor: colors.sheet }}
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.55} />
      )}
    >
      {dynamic ? (
        <BottomSheetView style={styles.sheetBody}>
          {header}
          {children}
        </BottomSheetView>
      ) : (
        // Fixed-height sheet: fill it so a flex child (e.g. a queue FlatList)
        // gets a bounded height and can actually lay out / scroll. The dynamic
        // branch above must NOT flex - it measures its content instead.
        <View style={[styles.sheetBody, { flex: 1 }]}>
          {header}
          {children}
        </View>
      )}
    </BottomSheetModal>
  )
})

export { icons }

const makeStyles = (colors: Palette, shadow: ReturnType<typeof useTheme>['shadow']) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.scaffold },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xl,
      backgroundColor: colors.scaffold,
    },
    card: {
      backgroundColor: colors.high,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.lg,
      ...shadow.card,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.high,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    pressed: { opacity: 0.6 },
    touchablePressed: { opacity: 0.55 },
    touchableDisabled: { opacity: 0.4 },
    chip: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
    chipActive: { backgroundColor: colors.accentTile },
    chipText: { ...typeScale.label, color: colors.textMuted },
    chipTextActive: { color: colors.text },
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: colors.accent,
      borderRadius: radius.card,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.md,
    },
    primaryBtnText: { ...typeScale.label, color: colors.onAccent },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      marginBottom: spacing.md,
    },
    sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    sectionTitleTap: { flexDirection: 'row', alignItems: 'center' },
    cover: { backgroundColor: colors.highest },
    avatarFallback: { alignItems: 'center', justifyContent: 'center' },
    avatarInitials: { color: colors.onAccent, fontWeight: '700', letterSpacing: 0.3 },
    sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
    sheetHeader: { gap: 2, marginBottom: spacing.md },
  })

// Hooks: the memoized stylesheet + palette for the active theme.
function useStyles() {
  const { colors, shadow } = useTheme()
  return useMemo(() => makeStyles(colors, shadow), [colors, shadow])
}
