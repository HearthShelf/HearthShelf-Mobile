/**
 * Queue editor screen: order the Auto-queue rules and manage the books you
 * queued by hand. Reached from Settings > Player > Queue when the mode is Auto
 * or Manual. Uses NestableScrollContainer so the two draggable lists (rules +
 * manual queue) coexist inside one scroll view without gesture conflicts.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { NestableScrollContainer } from 'react-native-draggable-flatlist'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { AutoRuleList, ManualQueueEditor } from '@/player/QueueEditors'
import {
  getDismissalsState,
  subscribeDismissals,
  hydrateDismissals,
  labelFor,
  restore,
} from '@/store/dismissals'
import { showToast } from '@/ui/Toast'

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
        <HiddenFromShelves />
      </NestableScrollContainer>
    </GestureHandlerRootView>
  )
}

// The user's "not right now" dismissals, with a Restore button each. Restoring
// brings a series/book back to the Auto queue + Continue-* shelves.
function HiddenFromShelves() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const d = useSyncExternalStore(subscribeDismissals, getDismissalsState)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void hydrateDismissals()
  }, [])

  const rows: { kind: 'series' | 'item'; id: string }[] = [
    ...d.seriesIds.map((id) => ({ kind: 'series' as const, id })),
    ...d.itemIds.map((id) => ({ kind: 'item' as const, id })),
  ]
  if (rows.length === 0) return null

  const onRestore = async (kind: 'series' | 'item', id: string) => {
    setBusy(id)
    try {
      await restore(kind, id)
      showToast('Restored')
    } catch {
      showToast('Could not restore')
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={styles.section}>
      <AppText variant="label">Hidden from shelves</AppText>
      <AppText variant="caption" color={colors.textMuted} style={styles.hint}>
        Series and books you hid from your Auto queue and Continue shelves. Restore to bring them
        back.
      </AppText>
      {rows.map((r) => (
        <View key={`${r.kind}:${r.id}`} style={styles.hiddenRow}>
          <Icon
            name={r.kind === 'series' ? icons.library : icons.book}
            size={18}
            color={colors.textMuted}
          />
          <AppText variant="body" style={{ flex: 1 }} numberOfLines={1}>
            {labelFor(r.id) ?? (r.kind === 'series' ? 'Hidden series' : 'Hidden book')}
          </AppText>
          <Touchable
            style={styles.restoreBtn}
            onPress={() => void onRestore(r.kind, r.id)}
            disabled={busy === r.id}
          >
            <AppText variant="caption" color={colors.accent}>
              Restore
            </AppText>
          </Touchable>
        </View>
      ))}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  ({
    screen: { flex: 1, backgroundColor: colors.base },
    content: { padding: spacing.lg, gap: spacing.xl },
    section: { gap: spacing.xs },
    hint: { marginBottom: spacing.sm },
    hiddenRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    restoreBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
  }) as const
