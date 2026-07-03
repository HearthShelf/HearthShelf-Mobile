/**
 * Header status pill for the player: shows at a glance whether your listening has
 * reached the server, and taps to push it now.
 *
 * Three steady states (no flicker on background syncs):
 *  - green  cloud-done:  server reachable and everything is synced.
 *  - orange cloud-queue: listening/position not yet on the server, but reachable
 *                        (a scrub-while-paused, or listened-time mid-sync).
 *  - red    cloud-off:   can't reach the server (offline or a failed sync).
 *
 * Tap = push the current position + listened-time to the server now.
 */
import { useSyncExternalStore } from 'react'
import { Pressable } from 'react-native'
import { Icon, icons, type IconName } from '@/ui/icons'
import { useColors } from '@/ui/ThemeProvider'
import { useConnection } from '@/api/ConnectionProvider'
import { getSyncState, subscribeSyncState } from './syncState'
import { forceSyncNow } from './playback'
import { haptics } from '@/ui/haptics'

export function SyncStatusIcon() {
  const colors = useColors()
  const { status: conn } = useConnection()
  const sync = useSyncExternalStore(subscribeSyncState, getSyncState)

  if (sync.status === 'idle') return null

  const offline = conn.phase === 'offline' || sync.status === 'failed'
  const pending = sync.status === 'pending'

  const { name, color }: { name: IconName; color: string } = offline
    ? { name: icons.cloudOff, color: colors.destructive }
    : pending
      ? { name: icons.cloudQueue, color: colors.accent }
      : { name: icons.cloudDone, color: colors.success }

  return (
    <Pressable
      onPress={() => {
        haptics.select()
        void forceSyncNow()
      }}
      hitSlop={10}
      accessibilityLabel="Sync listening now"
    >
      <Icon name={name} size={22} color={color} />
    </Pressable>
  )
}
