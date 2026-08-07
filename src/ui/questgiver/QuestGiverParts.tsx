/**
 * The small building blocks of the QuestGiver flow: a big tappable choice, a
 * labelled weight slider, and the progress indicator.
 *
 * These are deliberately mobile-only. The engine and the pick-resolution logic
 * are shared through @hearthshelf/core; the rendering is not - three renderers
 * for three platforms is the intended shape, and the spec is what holds their
 * behaviour together.
 */
import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import { AppText, Touchable } from '@/ui/primitives'
import { AppSlider } from '@/ui/AppSlider'
import { Icon, type IconName } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** A full-width option card - the answer to a one-question step. */
export const QgChoice = memo(function QgChoice({
  icon,
  title,
  desc,
  tag,
  on,
  onPress,
}: {
  icon: IconName
  title: string
  desc: string
  tag?: string
  on: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <Touchable
      onPress={onPress}
      style={[s.choice, on && s.choiceOn]}
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityHint={desc}
    >
      <View style={[s.choiceIcon, on && s.choiceIconOn]}>
        <Icon name={icon} size={20} color={on ? colors.onAccent : colors.textMuted} />
      </View>
      <View style={s.choiceBody}>
        <View style={s.choiceTitleRow}>
          <AppText variant="label" style={s.choiceTitle}>
            {title}
          </AppText>
          {tag ? (
            <View style={s.tag}>
              <AppText variant="caption" color={colors.accent}>
                {tag}
              </AppText>
            </View>
          ) : null}
        </View>
        <AppText variant="meta" color={colors.textMuted}>
          {desc}
        </AppText>
      </View>
      {on ? <Icon name="check-circle" size={20} color={colors.accent} /> : null}
    </Touchable>
  )
})

/** One genre's weight. 0 means "skip it" - the engine drops zero-weight genres. */
export const QgWeightRow = memo(function QgWeightRow({
  label,
  sub,
  value,
  onChange,
}: {
  label: string
  sub: string
  value: number
  onChange: (v: number) => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.weightRow}>
      <View style={s.weightHead}>
        <View style={s.weightLabels}>
          <AppText variant="label">{label}</AppText>
          <AppText variant="caption" color={colors.textFaint}>
            {sub}
          </AppText>
        </View>
        <AppText variant="label" color={value > 0 ? colors.accent : colors.textFaint}>
          {String(value)}
        </AppText>
      </View>
      <AppSlider value={value} min={0} max={10} step={1} onChange={onChange} />
    </View>
  )
})

/** Progress through the four questions. */
export function QgSteps({
  step,
  total,
  labels,
}: {
  step: number
  total: number
  labels: string[]
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.steps}>
      <View style={s.dots}>
        {Array.from({ length: total }, (_, i) => (
          <View key={i} style={[s.dot, i === step && s.dotOn, i < step && s.dotDone]} />
        ))}
      </View>
      <AppText variant="caption" color={colors.textFaint}>
        {`Step ${step + 1} of ${total} · ${labels[step] ?? ''}`}
      </AppText>
    </View>
  )
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
    },
    choiceOn: { borderColor: c.accent, backgroundColor: c.accentWash },
    choiceIcon: {
      width: 40,
      height: 40,
      borderRadius: radius.row,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.elevated,
    },
    choiceIconOn: { backgroundColor: c.accent },
    choiceBody: { flex: 1, gap: 2 },
    choiceTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    choiceTitle: { flexShrink: 1 },
    tag: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: c.accentTile,
    },
    weightRow: { gap: spacing.xs, paddingVertical: spacing.xs },
    weightHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    weightLabels: { flex: 1, gap: 1 },
    steps: { gap: spacing.xs, alignItems: 'center' },
    dots: { flexDirection: 'row', gap: spacing.xs },
    dot: { width: 24, height: 4, borderRadius: 2, backgroundColor: c.border },
    dotOn: { backgroundColor: c.accent },
    dotDone: { backgroundColor: c.accentTile },
  })
}
