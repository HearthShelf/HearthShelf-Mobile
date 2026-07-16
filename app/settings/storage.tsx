/**
 * Downloads & storage. Top: auto-download preferences and the space cap. Below:
 * the download manager - active downloads with progress + cancel, and finished
 * downloads with size + delete. Download state is device-local (the files live on
 * this device); the auto-download prefs likewise. The "remove when finished"
 * toggle is the one account-synced setting here, so the cleanup choice follows the
 * user across devices.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View, type DimensionValue } from 'react-native'
import {
  getDownloadsState,
  subscribeDownloads,
  setAutoPrefs,
  setMaxBytes,
  cancelDownload,
  deleteDownload,
  downloadItem,
  totalBytes,
  diskSpace,
  type DownloadEntry,
} from '@/player/downloads'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsToggle,
  SettingsSlider,
  ChipRow,
} from '@/ui/settingsControls'
import { AppText, IconButton, ProgressBar, icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const GB = 1024 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** A plain-language failure reason for a failed download, with how far it got so
 *  the user knows a retry resumes rather than restarts from zero. */
function failReason(e: DownloadEntry): string {
  const pct = Math.round((e.progress || 0) * 100)
  const at = pct > 0 && pct < 100 ? ` at ${pct}%` : ''
  const raw = (e.error || '').toLowerCase()
  let why = 'download stopped'
  if (/network|connection|offline|econn|timeout|timed out/.test(raw)) why = 'connection lost'
  else if (/space|disk|storage|enospc/.test(raw)) why = 'ran out of space'
  else if (/token|auth|401|403|unauthor/.test(raw)) why = "server wouldn't allow it"
  else if (/404|not found|410/.test(raw)) why = 'the file is no longer on the server'
  return `Failed - ${why}${at}`
}

export default function StorageScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { byId, maxBytes, auto } = useSyncExternalStore(subscribeDownloads, getDownloadsState)
  const { removeDownloadOnFinish } = useSyncExternalStore(subscribeSettings, getSettingsState)

  const entries = [...byId.values()]
  const active = entries.filter((e) => e.status === 'downloading' || e.status === 'queued')
  const failed = entries.filter((e) => e.status === 'failed')
  const done = entries.filter((e) => e.status === 'done')
  const used = totalBytes()
  const capGb = maxBytes > 0 ? Math.round((maxBytes / GB) * 10) / 10 : 0
  const disk = diskSpace()

  // Delete immediately with an Undo toast (no blocking Alert - D-FINISH). Undo
  // re-downloads the same book; the file is re-fetched if it was already purged.
  const removeDownload = (e: DownloadEntry) => {
    haptics.select()
    void deleteDownload(e.itemId)
    showToast(`Removed ${e.title}`, {
      action: { label: 'Undo', onPress: () => void downloadItem(e.itemId, e.title, e.author) },
    })
  }

  // Retry a failed download - re-runs downloadItem, which restarts the transfer.
  const retryDownload = (e: DownloadEntry) => {
    haptics.select()
    void downloadItem(e.itemId, e.title, e.author)
  }

  return (
    <SettingsPanel>
      <SettingsLabel>Auto-download</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="When you start a book"
          desc="Download it for offline as soon as you begin listening."
          control={
            <SettingsToggle on={auto.onStart} onChange={(v) => setAutoPrefs({ onStart: v })} />
          }
        />
        <SettingsRow
          title="Continue Listening"
          desc="Keep everything you've started downloaded."
          control={
            <SettingsToggle
              on={auto.continueListening}
              onChange={(v) => setAutoPrefs({ continueListening: v })}
            />
          }
        />
        <SettingsRow title="Next in queue" desc="Download this many upcoming books ahead of you." stacked last>
          <ChipRow
            value={auto.queueAhead}
            options={[0, 1, 3, 5]}
            onChange={(v) => setAutoPrefs({ queueAhead: v })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Storage</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="Space used"
          desc={`${formatBytes(used)} across ${done.length} ${done.length === 1 ? 'book' : 'books'}.`}
          control={
            maxBytes > 0 ? (
              <AppText variant="mono" color={colors.textMuted}>
                / {formatBytes(maxBytes)}
              </AppText>
            ) : undefined
          }
        />
        {disk.total > 0 ? (
          <StorageMeter disk={disk} maxBytes={maxBytes} colors={colors} styles={styles} />
        ) : maxBytes > 0 ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <ProgressBar progress={Math.min(1, used / maxBytes)} />
          </View>
        ) : null}
        <SettingsRow
          title="Maximum download space"
          desc={capGb === 0 ? 'No limit - downloads until the device is full.' : `Auto-download pauses at ${capGb} GB.`}
          stacked
        >
          <SettingsSlider
            value={capGb}
            min={0}
            max={64}
            step={1}
            onChange={(v) => setMaxBytes(v * GB)}
            formatLabel={(v) => (v === 0 ? 'Off' : `${v} GB`)}
          />
        </SettingsRow>
        <SettingsRow
          title="Remove when finished"
          desc="Delete a book's download once you finish it, to free up space."
          control={
            <SettingsToggle
              on={removeDownloadOnFinish}
              onChange={(v) => setSetting('removeDownloadOnFinish', v)}
            />
          }
          last
        />
      </SettingsGroup>

      {active.length > 0 ? (
        <>
          <SettingsLabel>Downloading</SettingsLabel>
          <SettingsGroup>
            {active.map((e, i) => (
              <View key={e.itemId} style={styles.dlRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="label" numberOfLines={1}>
                    {e.title}
                  </AppText>
                  <View style={styles.dlProgress}>
                    <ProgressBar progress={e.progress} style={{ flex: 1 }} />
                    <AppText variant="caption" color={colors.textMuted}>
                      {Math.round(e.progress * 100)}%
                    </AppText>
                  </View>
                </View>
                <IconButton name={icons.close} size={20} color={colors.textMuted} onPress={() => void cancelDownload(e.itemId)} />
              </View>
            ))}
          </SettingsGroup>
        </>
      ) : null}

      {failed.length > 0 ? (
        <>
          <SettingsLabel>Failed</SettingsLabel>
          <SettingsGroup>
            {failed.map((e) => (
              <View key={e.itemId} style={styles.dlRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="label" numberOfLines={1}>
                    {e.title}
                  </AppText>
                  <AppText variant="caption" color={colors.destructive} numberOfLines={1}>
                    {failReason(e)}
                  </AppText>
                </View>
                <Pressable
                  style={styles.retryBtn}
                  onPress={() => retryDownload(e)}
                  hitSlop={6}
                >
                  <Icon name={icons.retry} size={14} color={colors.accent} />
                  <AppText variant="caption" color={colors.accent}>
                    Retry
                  </AppText>
                </Pressable>
                <IconButton
                  name={icons.close}
                  size={20}
                  color={colors.textMuted}
                  onPress={() => removeDownload(e)}
                />
              </View>
            ))}
          </SettingsGroup>
        </>
      ) : null}

      <SettingsLabel>Downloaded</SettingsLabel>
      <SettingsGroup>
        {done.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={{ padding: spacing.md }}>
            No downloaded books yet. Download a book to listen offline.
          </AppText>
        ) : (
          done.map((e, i) => (
            <View key={e.itemId} style={styles.dlRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label" numberOfLines={1}>
                  {e.title}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {e.author} · {formatBytes(e.bytes)}
                </AppText>
              </View>
              <IconButton name={icons.close} size={20} color={colors.textMuted} onPress={() => removeDownload(e)} />
            </View>
          ))
        )}
      </SettingsGroup>
    </SettingsPanel>
  )
}

/**
 * A device-wide storage meter: one bar spanning total internal storage, split
 * into HearthShelf downloads (accent), other apps/system (muted fill), and free
 * space (track). A dashed accent overlay on the free segment shows how much of
 * that free space auto-download is still allowed to fill before hitting the cap.
 */
function StorageMeter({
  disk,
  maxBytes,
  colors,
  styles,
}: {
  disk: { total: number; free: number; used: number }
  maxBytes: number
  colors: Palette
  styles: ReturnType<typeof makeStyles>
}) {
  const total = Math.max(1, disk.total)
  const hs = Math.max(0, Math.min(disk.used, total))
  const free = Math.max(0, Math.min(disk.free, total - hs))
  const other = Math.max(0, total - hs - free)
  // Headroom auto-download may still use: the cap minus what's already used,
  // never more than the free space actually on the device. No cap = all of free.
  const allowance =
    maxBytes > 0 ? Math.max(0, Math.min(maxBytes - disk.used, free)) : free
  const pct = (n: number): DimensionValue => `${(n / total) * 100}%`

  // Distinct hues so the segments read apart at a glance: ember for our own
  // downloads, warm gold for everything else on the device, green for free.
  const hsColor = colors.accent
  const otherColor = colors.brandHearth
  const freeColor = colors.success

  return (
    <View style={styles.meter}>
      <View style={styles.meterBar}>
        {other > 0 ? <View style={[styles.seg, { width: pct(other), backgroundColor: otherColor }]} /> : null}
        {hs > 0 ? <View style={[styles.seg, { width: pct(hs), backgroundColor: hsColor }]} /> : null}
        {free > 0 ? (
          <View style={[styles.segFree, { width: pct(free), backgroundColor: freeColor }]}>
            {allowance > 0 ? (
              <View
                style={[
                  styles.segAllowance,
                  { width: `${(allowance / Math.max(1, free)) * 100}%` as DimensionValue, borderColor: colors.accent },
                ]}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.legend}>
        <LegendItem swatch={otherColor} label="Other Apps" value={formatBytes(other)} colors={colors} styles={styles} />
        <LegendItem swatch={hsColor} label="HearthShelf" value={formatBytes(hs)} colors={colors} styles={styles} />
        <LegendItem swatch={freeColor} label="Free" value={formatBytes(free)} colors={colors} styles={styles} />
        {maxBytes > 0 ? (
          <LegendItem dashed label="Allowed" value={formatBytes(allowance)} colors={colors} styles={styles} />
        ) : null}
      </View>
    </View>
  )
}

function LegendItem({
  swatch,
  dashed,
  label,
  value,
  colors,
  styles,
}: {
  swatch?: string
  dashed?: boolean
  label: string
  value: string
  colors: Palette
  styles: ReturnType<typeof makeStyles>
}) {
  return (
    <View style={styles.legendItem}>
      <View
        style={[
          styles.legendSwatch,
          dashed
            ? { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.accent }
            : { backgroundColor: swatch },
        ]}
      />
      <AppText variant="caption" color={colors.textMuted}>
        {label} {value}
      </AppText>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    dlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    dlProgress: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    retryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs / 2,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      backgroundColor: colors.accentWash,
    },
    meter: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
      gap: spacing.sm,
    },
    meterBar: {
      flexDirection: 'row',
      height: 10,
      borderRadius: 5,
      overflow: 'hidden',
      backgroundColor: colors.fill,
    },
    seg: {
      height: '100%',
    },
    segFree: {
      height: '100%',
      justifyContent: 'center',
    },
    segAllowance: {
      height: '100%',
      borderRadius: 4,
      borderWidth: 1,
      borderStyle: 'dashed',
      backgroundColor: colors.accentWash,
    },
    legend: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
    },
    legendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    legendSwatch: {
      width: 10,
      height: 10,
      borderRadius: 3,
    },
  })
