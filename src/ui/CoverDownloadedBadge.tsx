/**
 * A small badge in the bottom-right corner of a book cover showing its offline
 * state: an accent check when the book is downloaded, or a red "!" when a
 * download stopped partway (failed, or interrupted by the app being closed) and
 * the book cannot play offline yet. Shown on the Library and Home covers so you
 * can spot at a glance which books are on the device.
 *
 * Subscribes to the downloads store itself (like CoverDownloadOverlay) so it
 * stays live when a download finishes - callers only pass the item id. It hides
 * itself while a download is still in flight, since the progress ring overlay is
 * already communicating that state.
 */
import { useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import FontAwesome from '@expo/vector-icons/FontAwesome'
import { subscribeDownloads, getDownloadsState } from '@/player/downloads'
import { Icon, icons } from './icons'
import { useColors } from './ThemeProvider'

export function CoverDownloadedBadge({ itemId, size = 22 }: { itemId: string; size?: number }) {
  const colors = useColors()
  const status = useSyncExternalStore(
    subscribeDownloads,
    () => getDownloadsState().byId.get(itemId)?.status,
  )
  if (status !== 'done' && status !== 'failed') return null
  const incomplete = status === 'failed'

  const inset = Math.max(3, Math.round(size * 0.28))
  return (
    <View
      style={[
        styles.badge,
        {
          right: inset,
          bottom: inset,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: incomplete ? colors.destructive : colors.accent,
          borderColor: colors.scaffold,
        },
      ]}
      pointerEvents="none"
      accessible
      accessibilityLabel={incomplete ? 'Download incomplete' : 'Downloaded'}
    >
      {incomplete ? (
        <Icon name={icons.downloadIncomplete} size={size * 0.62} color="#fff" />
      ) : (
        <FontAwesome name="check" size={size * 0.5} color={colors.onAccent} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
})
