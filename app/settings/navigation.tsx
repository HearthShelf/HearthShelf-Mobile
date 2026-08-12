/**
 * Bottom navigation editor. One draggable list split by three section headers -
 * Bottom bar (the pinned icons), More menu (everything one tap further away),
 * and Hidden. Long-press anywhere on a row to drag it across a header and change
 * where it lives, or within a section to reorder. Each row also has a Quick Hide
 * eye button that toggles it straight to/from Hidden without a drag.
 *
 * Same single-flat-list trick as the player buttons editor: header sentinels and
 * destination rows share one list, and on drag end we walk the new order,
 * tracking which header each destination fell under, and rebuild navItems from
 * that. The bar is capped (MAX_BAR_ITEMS); an overflowing drop spills into the
 * menu rather than being dropped, so nothing becomes unreachable.
 *
 * The More button itself is not in this list - it's a fixed trailing slot on the
 * bar, so the menu can never be stranded behind a bar the user emptied.
 *
 * Reached from My Settings > Navigation. Device-scoped, like the other nav
 * preferences: the arrangement belongs to the screen it's laid out on.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useConnection } from '@/api/ConnectionProvider'
import { getSettingsState, setNavItems, subscribeSettings } from '@/store/settings'
import {
  NAV_ITEMS,
  MAX_BAR_ITEMS,
  type NavItemKey,
  type NavItemPref,
  type NavPlacement,
} from '@/ui/navItems'
import { AppText } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const SECTIONS: { placement: NavPlacement; title: string; hint: string }[] = [
  { placement: 'bar', title: 'Bottom bar', hint: 'Pinned next to the More button' },
  { placement: 'menu', title: 'More menu', hint: 'One tap away, under More' },
  { placement: 'hidden', title: 'Hidden', hint: 'Not shown anywhere' },
]

/** One entry in the flat draggable list: a section header, or a destination. */
type ListItem = { type: 'header'; placement: NavPlacement } | { type: 'item'; item: NavItemPref }

const ITEM_KEY = (i: ListItem) =>
  i.type === 'header' ? `header:${i.placement}` : `item:${i.item.key}`

/** Build the flat list: each section's header followed by its rows, in order. */
function toListItems(items: NavItemPref[]): ListItem[] {
  const list: ListItem[] = []
  for (const sec of SECTIONS) {
    list.push({ type: 'header', placement: sec.placement })
    for (const it of items.filter((x) => x.placement === sec.placement)) {
      list.push({ type: 'item', item: it })
    }
  }
  return list
}

/**
 * Walk the dragged order top-to-bottom, assigning each destination to the most
 * recent header above it. Overflow past the bar cap spills into the menu
 * (keeping relative order) rather than being silently dropped.
 */
function fromListItems(list: ListItem[]): NavItemPref[] {
  let current: NavPlacement = 'bar'
  let barCount = 0
  const result: NavItemPref[] = []
  for (const it of list) {
    if (it.type === 'header') {
      current = it.placement
      continue
    }
    let placement = current
    if (placement === 'bar') {
      if (barCount >= MAX_BAR_ITEMS) placement = 'menu'
      else barCount++
    }
    result.push({ key: it.item.key, placement })
  }
  return result
}

/** True if two arrangements are the same keys, in the same order, in the same
 *  places - used to tell an outside change from our own write coming back. */
function sameArrangement(a: NavItemPref[], b: NavItemPref[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x.key === b[i].key && x.placement === b[i].placement)
}

/** How many rows currently sit under a given section header. */
function countInPlacement(list: ListItem[], placement: NavPlacement): number {
  let current: NavPlacement | null = null
  let n = 0
  for (const it of list) {
    if (it.type === 'header') current = it.placement
    else if (current === placement) n++
  }
  return n
}

export default function NavigationScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const { activeRole } = useConnection()

  // Admin-only destinations are not shown to everyone else, and are left
  // untouched in the saved arrangement rather than being edited out of it.
  const visible = useMemo(
    () => s.navItems.filter((it) => !NAV_ITEMS[it.key]?.adminOnly || activeRole === 'admin'),
    [s.navItems, activeRole],
  )
  const hiddenByRole = useMemo(
    () => s.navItems.filter((it) => NAV_ITEMS[it.key]?.adminOnly && activeRole !== 'admin'),
    [s.navItems, activeRole],
  )

  // The list is driven from local state, not straight off the store. Feeding the
  // store back in during a drop swapped `data` out from under the list while it
  // was still settling: the gesture could be stranded (rows stop responding
  // until you navigate away) and a re-ordered header could blank until the next
  // touch forced a repaint. Now the drop result renders immediately and the
  // store is written alongside it; the store only re-seeds this state when it
  // changes from elsewhere (sync, or the Quick Hide button).
  const [listItems, setListItems] = useState<ListItem[]>(() => toListItems(visible))
  const savedRef = useRef<NavItemPref[]>(visible)
  useEffect(() => {
    if (sameArrangement(savedRef.current, visible)) return
    savedRef.current = visible
    setListItems(toListItems(visible))
  }, [visible])

  // Counted off the list being rendered, so the "n/5" badge and the section a
  // row lands in always agree - reading it off the store lagged by a frame.
  const barCount = countInPlacement(listItems, 'bar')

  const commit = (data: ListItem[]) => {
    const next = fromListItems(data)
    // Re-derive the list from the normalized result so a drop past the bar cap
    // shows where the row actually went, in the same frame as the drop.
    const normalized = toListItems(next)
    savedRef.current = next
    setListItems(normalized)
    setNavItems([...next, ...hiddenByRole])
  }

  return (
    <GestureHandlerRootView style={styles.screen}>
      <AppText variant="caption" color={colors.textFaint} style={styles.dragHint}>
        Hold a shortcut and drag it under a heading to move it, or tap the eye to quick hide. The
        More button always stays on the bar.
      </AppText>

      <DraggableFlatList
        data={listItems}
        keyExtractor={ITEM_KEY}
        contentContainerStyle={styles.listContent}
        onDragEnd={({ data }) => commit(data)}
        renderItem={(params: RenderItemParams<ListItem>) =>
          params.item.type === 'header' ? (
            <SectionHeader placement={params.item.placement} barCount={barCount} />
          ) : (
            <NavRow {...params} />
          )
        }
      />
    </GestureHandlerRootView>
  )
}

function SectionHeader({ placement, barCount }: { placement: NavPlacement; barCount: number }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sec = SECTIONS.find((x) => x.placement === placement)!
  const atCap = placement === 'bar' && barCount >= MAX_BAR_ITEMS
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleRow}>
        <AppText variant="eyebrow" color={colors.textMuted}>
          {sec.title}
        </AppText>
        {placement === 'bar' ? (
          <AppText variant="caption" color={atCap ? colors.accent : colors.textFaint}>
            {barCount}/{MAX_BAR_ITEMS}
          </AppText>
        ) : null}
      </View>
      <AppText variant="caption" color={colors.textFaint} style={{ marginTop: 1 }}>
        {sec.hint}
      </AppText>
    </View>
  )
}

function NavRow({ item, drag, isActive }: RenderItemParams<ListItem>) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  if (item.type !== 'item') return null
  const meta = NAV_ITEMS[item.item.key]
  if (!meta) return null
  const hidden = item.item.placement === 'hidden'
  return (
    <Pressable
      onLongPress={drag}
      delayLongPress={150}
      style={[styles.row, isActive && styles.rowDragging]}
    >
      <Icon name={icons.dragHandle} size={22} color={colors.textMuted} />
      <Icon name={icons[meta.icon]} size={20} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <AppText variant="meta">{meta.label}</AppText>
      </View>
      <Pressable onPress={() => toggleHidden(item.item.key)} hitSlop={8} style={styles.hideBtn}>
        <Icon name={hidden ? icons.hidden : icons.visible} size={20} color={colors.textMuted} />
      </Pressable>
    </Pressable>
  )
}

/** Quick Hide: toggle one destination between Hidden and the More menu. */
function toggleHidden(key: NavItemKey): void {
  const s = getSettingsState()
  setNavItems(
    s.navItems.map((it) => {
      if (it.key !== key) return it
      return { ...it, placement: it.placement === 'hidden' ? 'menu' : 'hidden' }
    }),
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    screen: { flex: 1 },
    dragHint: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, marginBottom: spacing.sm },
    listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
    sectionHeader: {
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
    },
    sectionTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.row,
      marginBottom: spacing.xs,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    rowDragging: { backgroundColor: colors.high, borderColor: colors.accent },
    hideBtn: { padding: spacing.xs },
  })
