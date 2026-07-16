/**
 * Shared row/control primitives for the My Settings screen, styled to match
 * the DS "My settings" mock (Row label + right-aligned mono value / segmented
 * control) rather than the WebApp's dense two-column layout - mobile rows
 * stack label+description on the left, control on the right, full-width.
 */
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { LinearTransition, FadeIn, FadeOut } from 'react-native-reanimated'
import { AppSlider } from '@/ui/AppSlider'
import { AppText } from './primitives'
import { Icon, type IconName } from './icons'
import { radius, spacing, type Palette } from './theme'
import { useColors } from './ThemeProvider'
import { haptics } from './haptics'

// ---- SettingsPanel: scroll container for a drill-down settings screen ----

/** Standard scroll wrapper for a settings detail screen (under the native header
 *  from app/settings/_layout.tsx). Consistent padding + gap between groups. */
export function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <ScrollView contentContainerStyle={panelStyles.content}>{children}</ScrollView>
}

const panelStyles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
})

// ---- SectionAccordion: a top-level My Settings section (Appearance, Listening, ...) ----

export function SectionAccordion({
  icon,
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  icon: IconName
  title: string
  subtitle?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const colors = useColors()
  const styles = useStyles()
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Animated.View layout={LinearTransition.duration(220)} style={styles.accordion}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.accordionHead, pressed && styles.pressed]}
      >
        <View style={styles.accordionIconTile}>
          <Icon name={icon} size={20} color={colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="label">{title}</AppText>
          {subtitle ? (
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 1 }}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        <Animated.View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon name="expand-more" size={24} color={colors.textMuted} />
        </Animated.View>
      </Pressable>
      {open ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={styles.accordionBody}
        >
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  )
}

// ---- SettingsGroup: a card wrapping a set of SettingsRows ----

export function SettingsGroup({
  children,
  style,
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const styles = useStyles()
  return <View style={[styles.group, style]}>{children}</View>
}

export function SettingsLabel({
  children,
  onReset,
}: {
  children: string
  /** When set, a small "Reset" affordance rides the end of the label row and
   *  fires this (the screen applies the reset + shows an Undo toast). */
  onReset?: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  if (!onReset) {
    return (
      <AppText variant="eyebrow" color={colors.textMuted} style={styles.groupLabel}>
        {children}
      </AppText>
    )
  }
  return (
    <View style={styles.labelRow}>
      <AppText variant="eyebrow" color={colors.textMuted} style={{ flex: 1 }}>
        {children}
      </AppText>
      <Pressable onPress={onReset} hitSlop={8} style={({ pressed }) => pressed && styles.pressed}>
        <View style={styles.resetChip}>
          <Icon name="refresh" size={13} color={colors.textMuted} />
          <AppText variant="caption" color={colors.textMuted}>
            Reset
          </AppText>
        </View>
      </Pressable>
    </View>
  )
}

// ---- SettingsRow: icon + title/desc + trailing control ----

export function SettingsRow({
  icon,
  title,
  desc,
  control,
  onPress,
  last,
  stacked,
  danger,
  children,
}: {
  icon?: IconName
  title: string
  desc?: string
  control?: React.ReactNode
  onPress?: () => void
  last?: boolean
  /** Puts `children` (e.g. a slider) below the row instead of a trailing control. */
  stacked?: boolean
  /** Tints icon/title destructive red (e.g. Sign out). */
  danger?: boolean
  children?: React.ReactNode
}) {
  const colors = useColors()
  const styles = useStyles()
  const tint = danger ? colors.destructive : colors.text
  const content = (
    <>
      <View style={[styles.row, !last && styles.rowDivider]}>
        {icon ? (
          <Icon name={icon} size={22} color={danger ? colors.destructive : colors.textMuted} />
        ) : null}
        <View style={{ flex: 1 }}>
          <AppText variant="body" color={tint}>
            {title}
          </AppText>
          {desc ? (
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
              {desc}
            </AppText>
          ) : null}
        </View>
        {control}
        {onPress && !danger ? (
          <Icon name="chevron-right" size={22} color={colors.textMuted} />
        ) : null}
      </View>
      {stacked && children ? (
        <View style={[styles.stackedChild, !last && styles.rowDivider]}>{children}</View>
      ) : null}
    </>
  )

  if (!onPress) return content
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      {content}
    </Pressable>
  )
}

// ---- Segmented control ----

export function Seg<T extends string>({
  value,
  onChange,
  options,
  fill,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  /** Stretches to the full row width with equal-width segments. Use when `Seg` is
   *  the sole control on its own row (e.g. a `stacked` SettingsRow); leave off when
   *  it sits inline next to a label, where it should hug its content instead. */
  fill?: boolean
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <View style={[styles.seg, fill && styles.segFill]}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            android_ripple={{ color: colors.fillStrong }}
            style={({ pressed }) => [
              styles.segItem,
              fill && styles.segItemFill,
              on && styles.segItemOn,
              pressed && styles.pressed,
            ]}
          >
            <AppText
              variant="caption"
              color={on ? colors.onAccent : colors.textMuted}
              style={[styles.segText, on && styles.segTextOn]}
            >
              {o.label}
            </AppText>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---- Toggle ----

export function SettingsToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const styles = useStyles()
  return (
    <Pressable
      onPress={() => onChange(!on)}
      hitSlop={8}
      style={({ pressed }) => [
        styles.toggleTrack,
        on && styles.toggleTrackOn,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.toggleKnob, on && styles.toggleKnobOn]} />
    </Pressable>
  )
}

// ---- Inline slider with a mono value readout ----

export function SettingsSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  formatLabel,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  formatLabel: (v: number) => string
}) {
  const colors = useColors()
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <AppText variant="mono" color={colors.textMuted}>
          {formatLabel(min)}
        </AppText>
        <AppText variant="mono" color={colors.accent}>
          {formatLabel(value)}
        </AppText>
        <AppText variant="mono" color={colors.textMuted}>
          {formatLabel(max)}
        </AppText>
      </View>
      <AppSlider min={min} max={max} step={step} value={value} onChange={onChange} />
    </View>
  )
}

// ---- Value chip presets (e.g. skip amounts, speed) ----

export function ChipRow<T extends number>({
  value,
  options,
  onChange,
  unit = '',
}: {
  value: T
  options: T[]
  onChange: (v: T) => void
  unit?: string
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {options.map((o) => {
        const on = o === value
        return (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            android_ripple={{ color: colors.fillStrong }}
            style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
          >
            <AppText variant="label" color={on ? colors.onAccent : colors.text}>
              {o}
              {unit}
            </AppText>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---- Accent colour swatch picker ----

/** The accent presets, matching the web/WebApp palette. */
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Ember', hex: '#ea9648' },
  { name: 'Hearth', hex: '#e0654a' },
  { name: 'Cinder', hex: '#c4463a' },
  { name: 'Amber', hex: '#e8b54a' },
  { name: 'Sage', hex: '#7fa86b' },
  { name: 'Tide', hex: '#4f9db0' },
  { name: 'Dusk', hex: '#5e76c4' },
  { name: 'Plum', hex: '#9b6fb8' },
  { name: 'Rose', hex: '#d2689a' },
  { name: 'Slate', hex: '#6b7280' },
]

/** A wrapping grid of accent swatches; the selected one gets a ring. Fires a
 *  selection tick on pick. */
export function AccentSwatchPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (hex: string) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <View style={styles.swatchRow}>
      {ACCENT_PRESETS.map((p) => {
        const on = p.hex.toLowerCase() === value.toLowerCase()
        return (
          <Pressable
            key={p.hex}
            onPress={() => {
              haptics.select()
              onChange(p.hex)
            }}
            hitSlop={4}
            style={({ pressed }) => [
              styles.swatch,
              { backgroundColor: p.hex, borderColor: on ? colors.text : 'transparent' },
              pressed && styles.pressed,
            ]}
          />
        )
      })}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  accordion: {
    backgroundColor: colors.high,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  accordionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  accordionIconTile: {
    width: 38,
    height: 38,
    borderRadius: radius.tile,
    backgroundColor: colors.accentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accordionBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.lg,
  },
  group: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  groupLabel: { paddingHorizontal: spacing.xs, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  resetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  stackedChild: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  pressed: { opacity: 0.65 },
  seg: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: colors.fill,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  segFill: { alignSelf: 'stretch' },
  segItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
  segItemFill: { flex: 1 },
  segItemOn: { backgroundColor: colors.accent },
  segText: { textAlign: 'center' },
  segTextOn: { fontWeight: '700' },
  toggleTrack: {
    width: 46,
    height: 27,
    borderRadius: 999,
    backgroundColor: colors.elevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  toggleTrackOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleKnob: { width: 21, height: 21, borderRadius: 11, backgroundColor: '#fff', marginLeft: 3 },
  toggleKnobOn: { marginLeft: 22 },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
  },
  chipOn: { backgroundColor: colors.accent },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2.5 },
  })

// Hook: the memoized stylesheet for the active palette.
function useStyles() {
  const colors = useColors()
  return useMemo(() => makeStyles(colors), [colors])
}
