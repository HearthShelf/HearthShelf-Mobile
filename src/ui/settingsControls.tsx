/**
 * Shared row/control primitives for the My Settings screen, styled to match
 * the DS "My settings" mock (Row label + right-aligned mono value / segmented
 * control) rather than the WebApp's dense two-column layout - mobile rows
 * stack label+description on the left, control on the right, full-width.
 */
import { useState } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { LinearTransition, FadeIn, FadeOut } from 'react-native-reanimated'
import Slider from '@react-native-community/slider'
import { AppText } from './primitives'
import { Icon, type IconName } from './icons'
import { colors, radius, spacing } from './theme'

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
  return <View style={[styles.group, style]}>{children}</View>
}

export function SettingsLabel({ children }: { children: string }) {
  return (
    <AppText variant="eyebrow" color={colors.textMuted} style={styles.groupLabel}>
      {children}
    </AppText>
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
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <View style={styles.seg}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            android_ripple={{ color: colors.fillStrong }}
            style={({ pressed }) => [
              styles.segItem,
              on && styles.segItemOn,
              pressed && styles.pressed,
            ]}
          >
            <AppText
              variant="caption"
              color={on ? colors.onAccent : colors.textMuted}
              style={on && styles.segTextOn}
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
      <Slider
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={colors.accent}
        maximumTrackTintColor={colors.fillStrong}
        thumbTintColor={colors.accent}
      />
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

const styles = StyleSheet.create({
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
    backgroundColor: colors.fill,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2,
  },
  segItem: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill },
  segItemOn: { backgroundColor: colors.accent },
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
})
