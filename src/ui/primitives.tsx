/**
 * Reusable themed building blocks. All visual surfaces in the app compose from
 * these so colors/radii/spacing come from src/ui/theme.ts rather than per-screen
 * hardcoded hex. Bottom sheets use @gorhom/bottom-sheet (see Sheet below).
 */
import { forwardRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetModalProps,
} from '@gorhom/bottom-sheet'
import { Icon, icons, type IconName } from './icons'
import { TypesetCover } from './TypesetCover'
import { colors, radius, spacing, type as typeScale } from './theme'

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
  return (
    <SafeAreaView style={[styles.screen, style]} edges={edges}>
      {children}
    </SafeAreaView>
  )
}

export function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>
}

// ---- Text ----

type TextVariant = keyof typeof typeScale
export function AppText({
  children,
  variant = 'body',
  color = colors.text,
  numberOfLines,
  style,
}: {
  children: React.ReactNode
  variant?: TextVariant
  color?: string
  numberOfLines?: number
  style?: StyleProp<TextStyle>
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[typeScale[variant], { color }, style]}>
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
  disabled,
  style,
  hitSlop,
  rippleColor = colors.fillStrong,
}: {
  children: React.ReactNode
  onPress?: () => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  hitSlop?: number
  rippleColor?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      android_ripple={{ color: rippleColor }}
      style={({ pressed }) => [style, pressed && styles.touchablePressed, disabled && styles.touchableDisabled]}
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
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  )
}

// ---- IconButton ----

export function IconButton({
  name,
  onPress,
  size = 24,
  color = colors.text,
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
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      style={({ pressed }) => [pressed && styles.pressed, style]}
    >
      <Icon name={name} size={size} color={color} />
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
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed, style]}
    >
      {icon ? <Icon name={icon} size={18} color={colors.onAccent} /> : null}
      <Text style={styles.primaryBtnText}>{label}</Text>
    </Pressable>
  )
}

// ---- SectionHeader ----

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <AppText variant="title">{title}</AppText>
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
}: {
  uri?: string
  size?: number
  width?: number
  aspectRatio?: number
  radius?: number
  /** Shown when there's no uri or the image fails to load. Real artwork wins. */
  fallback?: CoverFallback
  style?: StyleProp<ImageStyle>
}) {
  const [failed, setFailed] = useState(false)
  const w = size ?? width
  const dims: ImageStyle = size ? { width: size, height: size } : { width: w, aspectRatio }

  const hasUri = !!uri
  if (!hasUri || failed) {
    if (fallback) {
      return (
        <TypesetCover
          hue={fallback.hue}
          initial={fallback.initial}
          kicker={fallback.kicker}
          title={fallback.title}
          radius={r}
          style={[dims as StyleProp<ViewStyle>, style as StyleProp<ViewStyle>]}
        />
      )
    }
    // No uri (e.g. mid server-switch) and no fallback: a plain placeholder, not
    // an <Image source={{ uri: '' }}> which warns "uri should not be empty".
    return <View style={[styles.cover, dims, { borderRadius: r }, style as StyleProp<ViewStyle>]} />
  }

  return (
    <Image
      source={{ uri }}
      onError={() => setFailed(true)}
      style={[styles.cover, dims, { borderRadius: r }, style]}
    />
  )
}

// ---- ProgressBar ----

export function ProgressBar({
  progress,
  height = 4,
  color = colors.accent,
  track = colors.fillStrong,
  style,
}: {
  progress: number // 0..1
  height?: number
  color?: string
  track?: string
  style?: StyleProp<ViewStyle>
}) {
  const pct = Math.max(0, Math.min(1, progress)) * 100
  return (
    <View style={[{ height, borderRadius: height, backgroundColor: track }, style]}>
      <View
        style={{
          height,
          width: `${pct}%`,
          borderRadius: height,
          backgroundColor: color,
        }}
      />
    </View>
  )
}

// ---- Loading / inline ----

export function Loading({ label }: { label?: string }) {
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
    /** How this modal behaves when presented over another (default 'replace').
     *  Use 'push' to layer a sub-sheet on top of its opener. */
    stackBehavior?: BottomSheetModalProps['stackBehavior']
    onDismiss?: () => void
  }
>(function Sheet({ children, title, kicker, snapPoints, stackBehavior, onDismiss }, ref) {
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
        <View style={styles.sheetBody}>
          {header}
          {children}
        </View>
      )}
    </BottomSheetModal>
  )
})

export { icons }

const styles = StyleSheet.create({
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
  cover: { backgroundColor: colors.highest },
  sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  sheetHeader: { gap: 2, marginBottom: spacing.md },
})
