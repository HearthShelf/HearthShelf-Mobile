/**
 * One row of a playlist: position, cover, title, source line, play control.
 *
 * THE TWO SHAPES. ABS's Playlist.toOldJSONExpanded() emits book entries as
 * `{libraryItemId, libraryItem}` and episode entries as
 * `{libraryItemId, libraryItem, episodeId, episode}` (Playlist.js:347). On an
 * episode entry the sibling `libraryItem` is the PODCAST, and it is minified.
 *
 * So `episode` is the discriminator - not `episodeId != null`, because both keys
 * are ABSENT on a book entry rather than null. Reading the row off `libraryItem`
 * regardless is the bug that makes every episode in a playlist display its
 * show's name; ABS's own client branches the same way we do here
 * (client/components/tables/playlist/ItemTableRow.vue:100). The resolution
 * itself lives in @hearthshelf/core so all three clients agree.
 *
 * No drag handle. ABS stores playlist order and reordering is a real feature,
 * but it is not implemented here, and a handle wired to nothing is worse than
 * no handle at all.
 */
import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  coverHue,
  coverInitial,
  formatTimestamp,
  resolvePlaylistEntry,
  type ResolvedPlaylistEntry,
} from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, Touchable } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export const PlaylistRow = memo(function PlaylistRow({
  entry,
  position,
  onOpen,
  onPlay,
  onLongPress,
}: {
  entry: ResolvedPlaylistEntry
  /** Display-only, derived from array index - ABS owns the real order. */
  position: number
  onOpen: () => void
  onPlay?: () => void
  onLongPress?: () => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)

  return (
    <Touchable
      onPress={onOpen}
      onLongPress={onLongPress}
      style={s.row}
      accessibilityRole="button"
      accessibilityLabel={`${position}. ${entry.title}, ${entry.source}`}
      accessibilityHint={onLongPress ? 'Long press to remove from this playlist' : undefined}
    >
      <AppText variant="mono" color={colors.textFaint} style={s.pos}>
        {String(position)}
      </AppText>
      <Cover
        uri={coverUrl(entry.libraryItemId)}
        width={44}
        aspectRatio={1}
        fallback={{ hue: coverHue(entry.libraryItemId), initial: coverInitial(entry.title) }}
      />
      <View style={s.meta}>
        <AppText variant="label" numberOfLines={1}>
          {entry.title}
        </AppText>
        <View style={s.sourceRow}>
          {entry.isEpisode ? (
            <View style={s.epTag}>
              <Icon name="podcasts" size={11} color={colors.accent} />
              <AppText variant="caption" color={colors.accent}>
                Episode
              </AppText>
            </View>
          ) : null}
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1} style={s.grow}>
            {entry.source}
          </AppText>
        </View>
      </View>
      {entry.seconds > 0 ? (
        <AppText variant="caption" color={colors.textFaint}>
          {formatTimestamp(entry.seconds)}
        </AppText>
      ) : null}
      {onPlay ? (
        <Touchable
          onPress={onPlay}
          style={s.play}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Play ${entry.title}`}
        >
          <Icon name="play-arrow" size={18} color={colors.text} />
        </Touchable>
      ) : null}
    </Touchable>
  )
})

function makeStyles(c: Palette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    pos: { minWidth: 20, textAlign: 'right' },
    meta: { flex: 1, gap: 1 },
    grow: { flexShrink: 1 },
    sourceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    epTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
      borderRadius: radius.pill,
      backgroundColor: c.accentTile,
    },
    play: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
    },
  })
}

export { resolvePlaylistEntry }
export type { ResolvedPlaylistEntry }
