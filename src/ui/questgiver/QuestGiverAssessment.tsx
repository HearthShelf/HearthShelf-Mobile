/**
 * "Would I like this?" - the contextual fit check on book and series screens.
 *
 * Judges the target against the listener's own library, deliberately excluding
 * the target itself (and, for a series, every book in it) so the verdict is not
 * circular. AI-powered whenever the server has an AI provider configured;
 * qgAssess degrades to the deterministic match when AI is unavailable or errors,
 * and the footer says which engine actually answered.
 *
 * Unlike the web apps this expands inline rather than opening a modal: the
 * answer is short, and a sheet would bury it behind another tap.
 */
import { useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import {
  qgAssessmentContext,
  type ABSLibraryItem,
  type ABSMediaProgress,
  type QgAssessment,
  type QgAssessmentTarget,
} from '@hearthshelf/core'
import { getAllLibraryItems } from '@/api/abs'
import { qgAssess } from '@/api/questgiver'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const verdictLabels: Record<QgAssessment['verdict'], string> = {
  strong: 'Very likely',
  good: 'Likely',
  mixed: 'Maybe',
  unlikely: 'Probably not',
  unknown: 'Not enough history',
}

export function QuestGiverAssessment({
  libraryId,
  target,
  progressById,
}: {
  libraryId: string | null | undefined
  target: QgAssessmentTarget
  /** Read-only: the shared progress store hands out a ReadonlyMap. */
  progressById: ReadonlyMap<string, ABSMediaProgress>
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const [loading, setLoading] = useState(false)
  const [assessment, setAssessment] = useState<QgAssessment | null>(null)
  const [failed, setFailed] = useState(false)

  const assess = async () => {
    if (loading || assessment || !libraryId) return
    haptics.select()
    setLoading(true)
    setFailed(false)
    try {
      const items: ABSLibraryItem[] = await getAllLibraryItems(libraryId)
      setAssessment(await qgAssess(qgAssessmentContext(target, items, progressById)))
    } catch {
      // The library fetch is the only step that can fail outright - qgAssess
      // always resolves, falling back to the heuristic.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  // A verdict colour that reads the same in every theme: warm for a good match,
  // amber when it is uncertain, muted red when it is not a fit.
  const verdictColor = !assessment
    ? colors.accent
    : assessment.verdict === 'strong' || assessment.verdict === 'good'
      ? colors.success
      : assessment.verdict === 'unlikely'
        ? colors.destructive
        : colors.accent

  if (!libraryId) return null

  return (
    <View style={s.section}>
      <AppText variant="eyebrow" color={colors.textMuted}>
        Fit check
      </AppText>

      {!assessment && !loading ? (
        <Touchable
          style={s.trigger}
          onPress={() => void assess()}
          accessibilityRole="button"
          accessibilityLabel="Would I like this?"
        >
          <Icon name={icons.sparkle} size={18} color={colors.accent} />
          <AppText style={{ color: colors.accent, fontWeight: '600' }}>
            {failed ? 'Try again' : 'Would I like this?'}
          </AppText>
        </Touchable>
      ) : null}

      {loading ? (
        <View style={s.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.accent} />
          <AppText variant="caption" color={colors.textMuted}>
            Comparing this with your listening history...
          </AppText>
        </View>
      ) : null}

      {assessment ? (
        <View style={s.result} accessibilityLiveRegion="polite">
          <View style={s.verdictRow}>
            <View style={[s.verdictIcon, { backgroundColor: colors.fill }]}>
              <Icon
                name={assessment.verdict === 'unknown' ? icons.tune : icons.sparkle}
                size={20}
                color={verdictColor}
              />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={{ color: verdictColor, fontWeight: '700', fontSize: 17 }}>
                {verdictLabels[assessment.verdict]}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {assessment.confidence} confidence
              </AppText>
            </View>
          </View>

          <AppText style={{ marginTop: spacing.md, lineHeight: 22 }}>{assessment.summary}</AppText>

          {assessment.reasons.map((reason) => (
            <View key={reason} style={s.reason}>
              <AppText color={colors.textMuted}>{'•'}</AppText>
              <AppText
                variant="caption"
                color={colors.textMuted}
                style={{ flex: 1, lineHeight: 20 }}
              >
                {reason}
              </AppText>
            </View>
          ))}

          {assessment.caution ? (
            <AppText variant="caption" color={colors.textMuted} style={s.caution}>
              {assessment.caution}
            </AppText>
          ) : null}

          <View style={s.engine}>
            <Icon
              name={assessment.engine === 'ai' ? icons.sparkle : icons.tune}
              size={14}
              color={colors.textFaint}
            />
            <AppText variant="caption" color={colors.textFaint}>
              {assessment.engine === 'ai' ? 'Assessed by AI' : 'Matched from your history'}
            </AppText>
          </View>
        </View>
      ) : null}
    </View>
  )
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    section: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    trigger: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      alignSelf: 'flex-start',
      marginTop: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.fill,
    },
    loading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.md,
    },
    result: { marginTop: spacing.md },
    verdictRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    verdictIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    reason: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
    caution: {
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.row,
      backgroundColor: colors.fill,
    },
    engine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.md,
    },
  })
}
