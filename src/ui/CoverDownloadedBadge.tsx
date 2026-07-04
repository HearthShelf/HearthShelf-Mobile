/**
 * A small accent-colored check in the bottom-right corner of a book cover,
 * marking it as downloaded for offline. Shown on the Library and Home covers so
 * you can spot at a glance which books are already on the device.
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
import { useColors } from './ThemeProvider'

export function CoverDownloadedBadge({ itemId, size = 22 }: { itemId: string; size?: number }) {
  const colors = useColors()
  const status = useSyncExternalStore(
    subscribeDownloads,
    () => getDownloadsState().byId.get(itemId)?.status,
  )
  if (status !== 'done') return null

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
          backgroundColor: colors.accent,
          borderColor: colors.scaffold,
        },
      ]}
      pointerEvents="none"
    >
      <FontAwesome name="check" size={size * 0.5} color={colors.onAccent} />
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
