/**
 * Shared chrome for both list detail screens: name, count, total duration,
 * Play all, and the overflow menu.
 *
 * This is where the adapter's reuse legitimately ends - the two detail BODIES
 * are different (an unordered grid vs an ordered list that may hold an episode),
 * but their headers are the same thing, so the header is shared and the bodies
 * are not.
 *
 * Rename and Delete are passed in as optional handlers rather than gated here:
 * collections are permission-gated by ABS while playlists are gated only by
 * ownership, and the caller is the one that knows which applies. An absent
 * handler means the action is not offered at all.
 */
import { Alert, StyleSheet, View } from 'react-native'
import { formatTimestamp } from '@hearthshelf/core'
import type { ListKind } from '@/ui/lists/kind'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function ListDetailHeader({
  kind,
  name,
  count,
  itemNoun,
  totalSeconds,
  onBack,
  onPlayAll,
  onAddBooks,
  onRename,
  onDelete,
}: {
  kind: ListKind
  name: string
  count: number
  itemNoun: string
  totalSeconds: number
  onBack: () => void
  onPlayAll?: () => void
  /** Opens the book picker. Absent when the caller may not edit this list. */
  onAddBooks?: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const hasMenu = Boolean(onAddBooks || onRename || onDelete)

  const openMenu = () => {
    const actions = []
    if (onAddBooks) actions.push({ text: 'Add books', onPress: onAddBooks })
    if (onRename) actions.push({ text: 'Rename', onPress: onRename })
    if (onDelete)
      actions.push({
        text: kind === 'collection' ? 'Delete collection' : 'Delete playlist',
        style: 'destructive' as const,
        onPress: onDelete,
      })
    actions.push({ text: 'Cancel', style: 'cancel' as const })
    Alert.alert(name, undefined, actions)
  }

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <Touchable
          onPress={onBack}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={20} color={colors.text} />
        </Touchable>
        <View style={s.text}>
          <AppText variant="eyebrow" color={colors.accent}>
            {kind === 'collection' ? 'Collection' : 'Playlist'}
          </AppText>
          <AppText variant="title" numberOfLines={2}>
            {name}
          </AppText>
        </View>
        {hasMenu ? (
          <Touchable
            onPress={openMenu}
            style={s.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="More actions"
          >
            <Icon name="more-vert" size={20} color={colors.text} />
          </Touchable>
        ) : (
          <View style={s.iconBtn} />
        )}
      </View>

      <View style={s.metaRow}>
        <AppText variant="caption" color={colors.textMuted}>
          {`${count} ${count === 1 ? itemNoun : itemNoun + 's'}${
            totalSeconds > 0 ? ` · ${formatTimestamp(totalSeconds)}` : ''
          }`}
        </AppText>
        <View style={s.actions}>
          {onAddBooks ? (
            <Touchable
              onPress={onAddBooks}
              style={s.addBooks}
              accessibilityRole="button"
              accessibilityLabel="Add books"
            >
              <Icon name="library-add" size={16} color={colors.text} />
              <AppText variant="label">Add books</AppText>
            </Touchable>
          ) : null}
          {onPlayAll ? (
            <Touchable
              onPress={onPlayAll}
              style={s.playAll}
              accessibilityRole="button"
              accessibilityLabel="Play all"
            >
              <Icon name="play-arrow" size={16} color={colors.onAccent} />
              <AppText variant="label" color={colors.onAccent}>
                Play all
              </AppText>
            </Touchable>
          ) : null}
        </View>
      </View>
    </View>
  )
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    wrap: { gap: spacing.sm, paddingBottom: spacing.md },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    text: { flex: 1, gap: 1 },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    addBooks: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
    },
    playAll: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: c.accent,
    },
  })
}
