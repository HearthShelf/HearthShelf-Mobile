/**
 * Explains when the Auto queue rebuilds. Shown on the queue editor screen in
 * Auto mode, and written to answer the question people actually arrive with:
 * "I started a new series and the rest of it isn't in my queue yet."
 *
 * The triggers lead (starting a book rebuilds after a couple of minutes of real
 * playback - see player/recompute.ts); the nightly job is framed as the catch-up
 * it actually is, so nobody waits overnight for something already in motion.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import {
  AUTO_QUEUE_TRIGGERS,
  AUTO_QUEUE_NIGHTLY_NOTE,
  formatNextRebuild,
  formatQueueUpdated,
} from '@hearthshelf/core'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { getQueueStatus, recomputeServerQueue, type QueueStatus } from '@/api/queue'
import { setQueueItems, setQueueManual, setQueuePlaylistId } from '@/player/queue'
import { showToast } from '@/ui/Toast'

export function AutoQueueInfo() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<QueueStatus | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await getQueueStatus())
    } catch {
      // Offline / not connected: the panel just omits the timings.
    }
  }, [])

  // Only fetch once the user opens the panel, and refresh each minute it stays
  // open so the countdown doesn't go stale while they read it.
  useEffect(() => {
    if (!open) return
    void load()
    const id = setInterval(() => void load(), 60_000)
    return () => clearInterval(id)
  }, [open, load])

  const updated = formatQueueUpdated(status?.updatedAt ?? null)
  const next = formatNextRebuild(status?.nextRebuildAt ?? null)

  const refreshNow = async () => {
    if (busy) return
    setBusy(true)
    try {
      const server = await recomputeServerQueue()
      // Adopt without re-pushing (bump=false), same as a pull - see recompute.ts.
      setQueueItems(server.items, false)
      setQueueManual(server.manual, false)
      setQueuePlaylistId(server.playlistId, false)
      await load()
      showToast('Queue refreshed')
    } catch {
      showToast('Could not refresh')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.card}>
      <Touchable
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide queue update details' : 'Show queue update details'}
      >
        <Icon name={icons.info} size={18} color={colors.textMuted} />
        <AppText variant="body" style={{ flex: 1 }}>
          When does my queue update?
        </AppText>
        <Icon
          name={open ? icons.expandLess : icons.chevronDown}
          size={18}
          color={colors.textMuted}
        />
      </Touchable>

      {open && (
        <View style={styles.body}>
          {updated ? (
            <AppText variant="caption" color={colors.textMuted}>
              Your queue last changed {updated}.
            </AppText>
          ) : null}

          <AppText variant="caption">Your Auto queue rebuilds when:</AppText>
          {AUTO_QUEUE_TRIGGERS.map((t: string) => (
            <View key={t} style={styles.bulletRow}>
              <AppText variant="caption" color={colors.textMuted}>
                {'•'}
              </AppText>
              <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
                {t}
              </AppText>
            </View>
          ))}

          <AppText variant="caption" color={colors.textMuted}>
            {AUTO_QUEUE_NIGHTLY_NOTE}
            {next ? ` Next catch-up ${next}.` : ''}
          </AppText>

          <Touchable
            style={styles.refreshBtn}
            onPress={() => void refreshNow()}
            disabled={busy}
            accessibilityRole="button"
          >
            <Icon name={icons.retry} size={16} color={colors.accent} />
            <AppText variant="caption" color={colors.accent}>
              {busy ? 'Refreshing...' : 'Refresh now'}
            </AppText>
          </Touchable>
        </View>
      )}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  ({
    card: {
      backgroundColor: colors.fill,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.xs,
    },
    body: { gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.xs },
    bulletRow: { flexDirection: 'row', gap: spacing.sm, paddingLeft: spacing.xs },
    refreshBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.base,
    },
  }) as const
