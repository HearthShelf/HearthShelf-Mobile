/**
 * Home's edit mode: the home screen with all the covers stripped away, leaving
 * just the section headers as draggable rows. Entered from the pencil in the
 * Home header or by long-pressing any section header, and exited with Done.
 *
 * Editing IS the home screen - not a separate settings page - so the order you
 * arrange is literally the order you're looking at. Each row carries its
 * section's real icon and label, an eye to toggle visibility, and a drag handle.
 * Hidden sections stay in the list (dimmed) rather than moving to a separate
 * bucket, so turning one back on doesn't lose its place.
 *
 * The "More picks for you" row also carries a stepper for how many taste-derived
 * shelves it may spawn (0 turns the block off just like the eye does).
 *
 * The arrangement writes to the settings store on every drop/toggle, so it syncs
 * across devices like every other preference. Reset puts the canonical order back.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import type { HomeSectionId, HomeSectionPref } from '@hearthshelf/core'
import {
  DEFAULT_HOME_SECTIONS,
  DEFAULT_REC_SHELF_COUNT,
  MAX_REC_SHELF_COUNT,
} from '@hearthshelf/core'
import {
  getSettingsState,
  setHomeSections,
  setSetting,
  subscribeSettings,
  toggleHomeSection,
} from '@/store/settings'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons, type IconName } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** How each section presents itself in the editor: its Home icon + label, and a
 *  one-line reminder of what the band actually shows. */
export const HOME_SECTION_META: Record<
  HomeSectionId,
  { label: string; icon: IconName; hint: string }
> = {
  dashboard: {
    label: 'Up next & streak',
    icon: icons.queue,
    hint: 'Your queue peek and listening streak',
  },
  'release-countdown': {
    label: 'Coming soon',
    icon: icons.schedule,
    hint: 'Countdown for books you follow',
  },
  'book-club': { label: 'Your book clubs', icon: icons.club, hint: 'What your clubs are reading' },
  'continue-listening': {
    label: 'Continue Listening',
    icon: icons.recent,
    hint: 'Books you have started',
  },
  'continue-series': {
    label: 'Continue Series',
    icon: icons.book,
    hint: 'The next book in series you are reading',
  },
  questgiver: {
    label: 'Picked by QuestGiver',
    icon: icons.sparkle,
    hint: 'Your latest QuestGiver picks',
  },
  recommended: {
    label: 'Recommended for you',
    icon: icons.sparkle,
    hint: 'Best matches from your whole library',
  },
  'recommended-picks': {
    label: 'More picks for you',
    icon: icons.sparkle,
    hint: 'Rows built from your favorite genres, authors and narrators',
  },
  'series-next': {
    label: 'Finish the series',
    icon: icons.book,
    hint: 'Unplayed books in series you have started',
  },
  recent: {
    label: 'Back to your library',
    icon: icons.library,
    hint: 'Books you own but have not started',
  },
  'recently-added': {
    label: 'Recently Added',
    icon: icons.add,
    hint: 'The newest books on your server',
  },
}

export function HomeSectionsEditor({ onDone }: { onDone: () => void }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { homeSections, homeRecShelfCount } = useSyncExternalStore(
    subscribeSettings,
    getSettingsState,
  )
  const hiddenCount = homeSections.filter((s) => !s.on).length

  return (
    <GestureHandlerRootView style={styles.screen}>
      <View style={styles.bar}>
        <View style={{ flex: 1 }}>
          <AppText variant="label">Arrange your home</AppText>
          <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 1 }}>
            {hiddenCount > 0 ? `${hiddenCount} hidden` : 'Drag to reorder, tap the eye to hide'}
          </AppText>
        </View>
        <Touchable
          onPress={() => {
            haptics.confirm()
            setHomeSections(DEFAULT_HOME_SECTIONS)
            setSetting('homeRecShelfCount', DEFAULT_REC_SHELF_COUNT)
          }}
          style={styles.resetBtn}
        >
          <AppText variant="caption" color={colors.textMuted}>
            Reset
          </AppText>
        </Touchable>
        <Touchable onPress={onDone} style={styles.doneBtn}>
          <Icon name={icons.check} size={17} color={colors.onAccent} />
          <AppText variant="label" color={colors.onAccent}>
            Done
          </AppText>
        </Touchable>
      </View>

      <DraggableFlatList
        data={homeSections}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.listContent}
        onDragEnd={({ data }) => {
          haptics.select()
          setHomeSections(data)
        }}
        renderItem={(params: RenderItemParams<HomeSectionPref>) => (
          <SectionRow {...params} recShelfCount={homeRecShelfCount} />
        )}
      />
    </GestureHandlerRootView>
  )
}

function SectionRow({
  item,
  drag,
  isActive,
  recShelfCount,
}: RenderItemParams<HomeSectionPref> & { recShelfCount: number }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const meta = HOME_SECTION_META[item.id]
  // The picks block's count stepper doubles as an off switch, so a 0 count reads
  // as hidden here even though the eye is still on.
  const off = !item.on || (item.id === 'recommended-picks' && recShelfCount === 0)
  return (
    <Pressable
      onLongPress={drag}
      delayLongPress={150}
      style={[styles.row, isActive && styles.rowDragging, off && styles.rowOff]}
    >
      <View style={styles.rowMain}>
        <Icon name={icons.dragHandle} size={22} color={colors.textMuted} />
        <Icon name={meta.icon} size={20} color={off ? colors.textFaint : colors.accent} />
        <View style={{ flex: 1 }}>
          <AppText variant="meta" color={off ? colors.textMuted : colors.text}>
            {meta.label}
          </AppText>
          <AppText variant="caption" color={colors.textFaint} style={{ marginTop: 1 }}>
            {meta.hint}
          </AppText>
        </View>
        <Pressable
          onPress={() => {
            haptics.select()
            toggleHomeSection(item.id)
          }}
          hitSlop={8}
          style={styles.eyeBtn}
        >
          <Icon
            name={item.on ? icons.visible : icons.hidden}
            size={20}
            color={item.on ? colors.textMuted : colors.textFaint}
          />
        </Pressable>
      </View>

      {item.id === 'recommended-picks' ? (
        <RecCountStepper count={recShelfCount} disabled={!item.on} />
      ) : null}
    </Pressable>
  )
}

/** Stepper for how many taste-derived rows the picks block may spawn (0-8). */
function RecCountStepper({ count, disabled }: { count: number; disabled: boolean }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const step = (delta: number) => {
    const next = Math.max(0, Math.min(MAX_REC_SHELF_COUNT, count + delta))
    if (next === count) return
    haptics.select()
    setSetting('homeRecShelfCount', next)
  }
  return (
    <View style={[styles.stepper, disabled && styles.stepperOff]}>
      <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
        {count === 0 ? 'No extra rows' : `Up to ${count} row${count === 1 ? '' : 's'}`}
      </AppText>
      <Touchable
        onPress={() => step(-1)}
        disabled={disabled || count === 0}
        hitSlop={6}
        style={styles.stepBtn}
      >
        <Icon name={icons.minus} size={18} color={count === 0 ? colors.textFaint : colors.text} />
      </Touchable>
      <AppText variant="mono" style={styles.stepCount}>
        {count}
      </AppText>
      <Touchable
        onPress={() => step(1)}
        disabled={disabled || count === MAX_REC_SHELF_COUNT}
        hitSlop={6}
        style={styles.stepBtn}
      >
        <Icon
          name={icons.add}
          size={18}
          color={count === MAX_REC_SHELF_COUNT ? colors.textFaint : colors.text}
        />
      </Touchable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1 },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    resetBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    doneBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.md + 2,
      paddingVertical: 7,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
    row: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.row,
      marginBottom: spacing.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    rowMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rowDragging: { backgroundColor: colors.high, borderColor: colors.accent },
    rowOff: { opacity: 0.55 },
    eyeBtn: { padding: spacing.xs },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    stepperOff: { opacity: 0.5 },
    stepBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.fill,
    },
    stepCount: { minWidth: 18, textAlign: 'center', fontWeight: '700' },
  })
