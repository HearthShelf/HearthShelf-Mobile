/**
 * Queue editor screen: order the Auto-queue rules and manage the books you
 * queued by hand. Reached from Settings > Player > Queue when the mode is Auto
 * or Manual. Uses NestableScrollContainer so the two draggable lists (rules +
 * manual queue) coexist inside one scroll view without gesture conflicts.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { NestableScrollContainer } from 'react-native-draggable-flatlist'
import { AppText } from '@/ui/primitives'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { AutoRuleList, ManualQueueEditor } from '@/player/QueueEditors'

export default function QueueEditorScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  return (
    <GestureHandlerRootView style={styles.screen}>
      <NestableScrollContainer contentContainerStyle={styles.content}>
        {s.queueMode === 'auto' && (
          <View style={styles.section}>
            <AppText variant="label">Auto rules</AppText>
            <AppText variant="caption" color={colors.textMuted} style={styles.hint}>
              Drag to set priority. The queue fills from the top rule down.
            </AppText>
            <AutoRuleList
              rules={s.queueAutoRules}
              onChange={(r) => setSetting('queueAutoRules', r)}
            />
          </View>
        )}
        <View style={styles.section}>
          <AppText variant="label">
            {s.queueMode === 'auto' ? 'Your queue' : 'Manual queue'}
          </AppText>
          <AppText variant="caption" color={colors.textMuted} style={styles.hint}>
            {s.queueMode === 'auto'
              ? 'Auto picks are shown grayed out. Drag or remove the books you queued by hand.'
              : 'Drag to set the order, or remove a book.'}
          </AppText>
          <ManualQueueEditor mode={s.queueMode === 'auto' ? 'auto' : 'manual'} />
        </View>
      </NestableScrollContainer>
    </GestureHandlerRootView>
  )
}

const makeStyles = (colors: Palette) =>
  ({
    screen: { flex: 1, backgroundColor: colors.base },
    content: { padding: spacing.lg, gap: spacing.xl },
    section: { gap: spacing.xs },
    hint: { marginBottom: spacing.sm },
  }) as const
