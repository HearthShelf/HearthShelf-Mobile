/**
 * Downloads & storage. Top: auto-download preferences and the space cap. Below:
 * the download manager - active downloads with progress + cancel, and finished
 * downloads with size + delete. All state comes from the shared downloads store
 * (device-local; downloads aren't synced across devices).
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Alert, StyleSheet, View } from 'react-native'
import {
  getDownloadsState,
  subscribeDownloads,
  setAutoPrefs,
  setMaxBytes,
  cancelDownload,
  deleteDownload,
  totalBytes,
  type DownloadEntry,
} from '@/player/downloads'
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
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const GB = 1024 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export default function StorageScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { byId, maxBytes, auto } = useSyncExternalStore(subscribeDownloads, getDownloadsState)

  const entries = [...byId.values()]
  const active = entries.filter((e) => e.status === 'downloading' || e.status === 'queued')
  const failed = entries.filter((e) => e.status === 'failed')
  const done = entries.filter((e) => e.status === 'done')
  const used = totalBytes()
  const capGb = maxBytes > 0 ? Math.round((maxBytes / GB) * 10) / 10 : 0

  const confirmDelete = (e: DownloadEntry) =>
    Alert.alert('Remove download', `Delete the downloaded copy of "${e.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void deleteDownload(e.itemId) },
    ])

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
        {maxBytes > 0 ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <ProgressBar progress={Math.min(1, used / maxBytes)} />
          </View>
        ) : null}
        <SettingsRow
          title="Maximum download space"
          desc={capGb === 0 ? 'No limit - downloads until the device is full.' : `Auto-download pauses at ${capGb} GB.`}
          stacked
          last
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
              <SettingsRow
                key={e.itemId}
                title={e.title}
                desc="Download didn't finish. Tap to remove."
                onPress={() => void deleteDownload(e.itemId)}
              />
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
              <IconButton name={icons.close} size={20} color={colors.textMuted} onPress={() => confirmDelete(e)} />
            </View>
          ))
        )}
      </SettingsGroup>
    </SettingsPanel>
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
  })
