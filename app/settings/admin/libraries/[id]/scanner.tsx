/** Which metadata source wins when they disagree. Books only. */
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { DEFAULT_METADATA_PRECEDENCE, METADATA_SOURCES } from '@hearthshelf/core'
import { patchLibrarySettings, type LibraryDraftState } from '@/admin/LibraryDraft'
import { LibraryDraftScreen } from '@/admin/LibraryDraftScreen'
import { Icon, icons } from '@/ui/icons'
import { AppText, IconButton } from '@/ui/primitives'
import { SettingsLabel } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'

export default function LibraryScannerScreen() {
  return <LibraryDraftScreen>{(state) => <Scanner state={state} />}</LibraryDraftScreen>
}

function Scanner({ state }: { state: LibraryDraftState }) {
  const colors = useColors()
  const bottomInset = useContentInset()
  // Local so a drop renders at once. Feeding the store back in mid-drop can strand
  // the gesture, and nothing else changes this list while the screen is open.
  const [order, setOrder] = useState(state.draft.settings.metadataPrecedence)

  function commit(next: string[]) {
    setOrder(next)
    patchLibrarySettings({ metadataPrecedence: next })
  }

  function move(from: number, to: number) {
    const next = [...order]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    commit(next)
  }

  return (
    <GestureHandlerRootView style={styles.screen}>
      <View style={styles.top}>
        <SettingsLabel onReset={() => commit([...DEFAULT_METADATA_PRECEDENCE])}>
          Order of sources
        </SettingsLabel>
        <AppText variant="caption" color={colors.textFaint}>
          When sources disagree, the one higher up wins. Hold a row to drag it.
        </AppText>
      </View>
      <DraggableFlatList
        data={order}
        keyExtractor={(id) => id}
        contentContainerStyle={[styles.list, { paddingBottom: bottomInset }]}
        onDragEnd={({ data }) => commit(data)}
        renderItem={(params) => <SourceRow {...params} order={order} onMove={move} />}
      />
    </GestureHandlerRootView>
  )
}

function SourceRow({
  item,
  drag,
  isActive,
  order,
  onMove,
}: RenderItemParams<string> & {
  order: string[]
  onMove: (from: number, to: number) => void
}) {
  const colors = useColors()
  const index = order.indexOf(item)
  const isFirst = index === 0
  const isLast = index === order.length - 1
  const name = METADATA_SOURCES.find((s) => s.id === item)?.name ?? item
  return (
    <Pressable
      onLongPress={drag}
      delayLongPress={150}
      style={[styles.row, { backgroundColor: isActive ? colors.fillStrong : colors.fill }]}
    >
      <Icon name={icons.dragHandle} size={22} color={colors.textMuted} />
      <AppText variant="meta" color={colors.textMuted}>
        {index + 1}
      </AppText>
      <AppText variant="meta" style={{ flex: 1 }}>
        {name}
      </AppText>
      <IconButton
        name={icons.arrowUpward}
        size={20}
        color={isFirst ? colors.textFaint : colors.textMuted}
        onPress={isFirst ? undefined : () => onMove(index, index - 1)}
        accessibilityLabel={`Move ${name} up`}
      />
      <IconButton
        name="arrow-downward"
        size={20}
        color={isLast ? colors.textFaint : colors.textMuted}
        onPress={isLast ? undefined : () => onMove(index, index + 1)}
        accessibilityLabel={`Move ${name} down`}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { padding: spacing.lg, paddingBottom: spacing.sm, gap: spacing.xs },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.row,
  },
})
