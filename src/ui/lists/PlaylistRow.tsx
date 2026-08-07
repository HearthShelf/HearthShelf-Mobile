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
 * (client/components/tables/playlist/ItemTableRow.vue:100).
 *
 * No drag handle. ABS stores playlist order and reordering is a real feature,
 * but it is not implemented here, and a handle wired to nothing is worse than
 * no handle at all.
 */
import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import { coverHue, coverInitial, formatTimestamp, type ABSPlaylistItem } from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, Touchable } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** What a row actually renders, after resolving which of the two shapes it is. */
export interface ResolvedPlaylistEntry {
  isEpisode: boolean
  title: string
  /** Author for a book; the podcast's name for an episode. */
  source: string
  seconds: number
  /** Artwork always comes from the library item - an episode has none of its own. */
  coverId: string
  libraryItemId: string
  episodeId?: string
}

/**
 * Resolve a raw ABS playlist item into what the row shows. Exported so the
 * screen (and tests) can reason about the two shapes in one place.
 */
export function resolvePlaylistEntry(item: ABSPlaylistItem): ResolvedPlaylistEntry {
  const libraryItem = item.libraryItem
  if (item.episode) {
    return {
      isEpisode: true,
      title: item.episode.title || 'Untitled episode',
      // libraryItem is the podcast here, and minified - its metadata title is
      // the show's name, which is exactly what an episode row wants as source.
      source: libraryItem?.media?.metadata?.title ?? 'Podcast',
      seconds: item.episode.duration ?? 0,
      coverId: item.libraryItemId,
      libraryItemId: item.libraryItemId,
      episodeId: item.episodeId,
    }
  }
  return {
    isEpisode: false,
    title: libraryItem?.media?.metadata?.title ?? 'Untitled',
    source: libraryItem?.media?.metadata?.authorName ?? '',
    seconds: libraryItem?.media?.duration ?? 0,
    coverId: item.libraryItemId,
    libraryItemId: item.libraryItemId,
  }
}

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
        uri={coverUrl(entry.coverId)}
        width={44}
        aspectRatio={1}
        fallback={{ hue: coverHue(entry.coverId), initial: coverInitial(entry.title) }}
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
