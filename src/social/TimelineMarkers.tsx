/**
 * Timeline note markers for the player seek bar. A thin strip sitting just above
 * the scrubber pill, aligned to whole-book fraction (0..1):
 *
 *  - Passed (unlocked) notes render as small avatar dots at their position; tap
 *    to open the notes sheet.
 *  - Ahead (locked stub) notes render as thin anonymous ticks - author withheld;
 *    tap for a teaser toast only, never content.
 *
 * Markers are pre-clustered by core's clusterTimelineMarkers, so within ~1% of
 * the duration they collapse into one marker with a count. Each has a generous
 * hitSlop so the small dots stay tappable. Not shown in car/immersive mode.
 */
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import type { TimelineMarker } from '@hearthshelf/core'
import { avatarUrl } from '@/api/abs'
import { coverHue } from '@hearthshelf/core'
import { Avatar, Touchable } from '@/ui/primitives'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const STRIP_HEIGHT = 18

export function TimelineMarkers({
  markers,
  onOpenNote,
  onAheadTeaser,
}: {
  markers: TimelineMarker[]
  /** Tap a passed marker -> open the notes sheet at that timestamp. */
  onOpenNote: (timeSec: number) => void
  /** Tap an ahead marker -> a teaser toast (never note content). */
  onAheadTeaser: (timeSec: number) => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  if (markers.length === 0) return null

  return (
    <View style={styles.strip} pointerEvents="box-none">
      {markers.map((m, i) => {
        const first = m.items[0]
        const ahead = m.kind === 'stub'
        return (
          <Touchable
            key={`${first.id}-${i}`}
            hitSlop={12}
            style={[styles.marker, { left: `${m.fraction * 100}%` }]}
            onPress={() =>
              ahead ? onAheadTeaser(first.timeSec) : onOpenNote(first.timeSec)
            }
          >
            {ahead ? (
              <View style={styles.tick} />
            ) : (
              <Avatar
                uri={first.userId ? avatarUrl(first.userId) : undefined}
                size={16}
                name={first.username ?? '?'}
                hue={coverHue(first.userId ?? first.id)}
              />
            )}
            {m.count > 1 ? <View style={styles.countDot} /> : null}
          </Touchable>
        )
      })}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    strip: {
      height: STRIP_HEIGHT,
      marginBottom: spacing.xs,
      justifyContent: 'center',
    },
    marker: {
      position: 'absolute',
      // Center the marker on its fraction point.
      marginLeft: -8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tick: {
      width: 2,
      height: 12,
      borderRadius: 1,
      backgroundColor: colors.textFaint,
    },
    // A small accent pip on clustered markers signaling more than one note.
    countDot: {
      position: 'absolute',
      top: -2,
      right: -2,
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
    },
  })
