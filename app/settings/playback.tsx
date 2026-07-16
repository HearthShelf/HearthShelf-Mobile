/**
 * Playback panel: speed, skip amounts, progress bar, hearth background, the
 * player-button editor link, and the up-next queue behaviour.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AppText } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  Seg,
  SettingsToggle,
  ChipRow,
  SettingsSlider,
} from '@/ui/settingsControls'
import {
  getSettingsState,
  subscribeSettings,
  setSetting,
  setQueueMode,
  resetSettings,
  restoreSettings,
} from '@/store/settings'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { getLibraries, getLibraryPlaylists } from '@/api/abs'
import type { ABSPlaylist } from '@hearthshelf/core'
import { QUEUE_MODES, QUEUE_MODE_SUB } from '@/player/queue'
import { getQueueState, setQueuePlaylistId, subscribeQueue } from '@/player/queue'

const SPEED_OPTIONS = [0.75, 1, 1.5, 2] as const

export default function PlaybackPanel() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const q = useSyncExternalStore(subscribeQueue, getQueueState)

  const resetSection = (label: string, keys: Parameters<typeof resetSettings>[0]) => {
    const prev = resetSettings(keys)
    haptics.select()
    if (Object.keys(prev).length === 0) {
      showToast(`${label} already at defaults`)
      return
    }
    showToast(`${label} reset`, {
      action: { label: 'Undo', onPress: () => restoreSettings(prev) },
    })
  }
  const [playlists, setPlaylists] = useState<ABSPlaylist[]>([])
  const [playlistLoading, setPlaylistLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (s.queueMode !== 'playlist') return
    setPlaylistLoading(true)
    getLibraries()
      .then((libs) => {
        const libraryId = libs.find((l) => l.mediaType === 'book')?.id ?? libs[0]?.id
        return libraryId ? getLibraryPlaylists(libraryId) : []
      })
      .then((rows) => {
        if (!cancelled) setPlaylists(rows)
      })
      .catch(() => {
        if (!cancelled) setPlaylists([])
      })
      .finally(() => {
        if (!cancelled) setPlaylistLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [s.queueMode])

  return (
    <SettingsPanel>
      <SettingsLabel
        onReset={() =>
          resetSection('Transport', [
            'defaultSpeed',
            'skipForward',
            'skipForwardCustom',
            'skipBack',
            'skipBackCustom',
            'scrubber',
            'playerBg',
            'tapArtworkTogglesPlay',
            'skipHotspots',
            'carMode',
          ])
        }
      >
        Transport
      </SettingsLabel>
      <SettingsGroup>
        <SettingsRow title="Default speed" desc="The rate a fresh book starts at." stacked>
          <ChipRow
            value={s.defaultSpeed as (typeof SPEED_OPTIONS)[number]}
            options={[...SPEED_OPTIONS]}
            onChange={(v) => setSetting('defaultSpeed', v)}
            unit="x"
          />
        </SettingsRow>
        <SettingsRow title="Skip forward" desc="How far the forward button jumps." stacked>
          <SettingsSlider
            value={s.skipForward}
            min={5}
            max={300}
            step={5}
            ticks={[15, 30, 60]}
            onChange={(v) => {
              setSetting('skipForwardCustom', v)
              setSetting('skipForward', v)
            }}
            formatLabel={(v) => `${v}s`}
          />
        </SettingsRow>
        <SettingsRow title="Skip back" desc="How far the back button jumps." stacked>
          <SettingsSlider
            value={s.skipBack}
            min={5}
            max={300}
            step={5}
            ticks={[15, 30, 60]}
            onChange={(v) => {
              setSetting('skipBackCustom', v)
              setSetting('skipBack', v)
            }}
            formatLabel={(v) => `${v}s`}
          />
        </SettingsRow>
        <SettingsRow
          title="Progress bar"
          desc="Scrub against the current chapter, or the whole book."
          control={
            <Seg
              value={s.scrubber}
              onChange={(v) => setSetting('scrubber', v)}
              options={[
                { value: 'chapter', label: 'Chapter' },
                { value: 'book', label: 'Book' },
              ]}
            />
          }
        />
        <SettingsRow
          title="Player background"
          desc="Behind the full-screen player: blurred cover art, a breathing glow in the book's colors, or the hearth artwork."
          stacked
        >
          <Seg
            value={s.playerBg}
            onChange={(v) => setSetting('playerBg', v)}
            fill
            options={[
              { value: 'blurred', label: 'Blurred' },
              { value: 'gradient', label: 'Glow' },
              { value: 'hearth', label: 'Hearth' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          title="Tap artwork to play"
          desc="Tap the cover on the full-screen player to play or pause."
          control={
            <SettingsToggle
              on={s.tapArtworkTogglesPlay}
              onChange={(v) => setSetting('tapArtworkTogglesPlay', v)}
            />
          }
        />
        <SettingsRow
          title="Skip hotspots"
          desc="Double-tap the sides of the artwork to jump back or forward."
          control={
            <SettingsToggle on={s.skipHotspots} onChange={(v) => setSetting('skipHotspots', v)} />
          }
        />
        {s.skipHotspots ? (
          <View style={styles.conflict}>
            <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
              Heads up: the player also swipes sideways to change books, so a stray
              double-tap near the edge can land on a swipe. Turn this off if it fights
              your swipes.
            </AppText>
            <Pressable
              onPress={() => setSetting('skipHotspots', false)}
              hitSlop={6}
              style={({ pressed }) => [styles.conflictBtn, pressed && { opacity: 0.7 }]}
            >
              <AppText variant="caption" color={colors.accent}>
                Turn off
              </AppText>
            </Pressable>
          </View>
        ) : null}
        <SettingsRow
          title="Player buttons"
          desc="Choose which action buttons show on the player, tuck into More, or hide."
          onPress={() => router.push('/settings/player-buttons')}
        />
        <SettingsRow
          title="Car mode"
          desc="Controls whether the native Android Auto / CarPlay surface is available automatically, forced on, or disabled."
          last
          stacked
        >
          <Seg
            value={s.carMode}
            onChange={(v) => setSetting('carMode', v)}
            fill
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Queue</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="When a book ends"
          desc={QUEUE_MODE_SUB[s.queueMode]}
          stacked
          last={s.queueMode === 'off'}
        >
          <Seg
            value={s.queueMode}
            onChange={setQueueMode}
            fill
            options={QUEUE_MODES.map((m) => ({ value: m.v, label: m.label }))}
          />
        </SettingsRow>
        {(s.queueMode === 'manual' || s.queueMode === 'auto') && (
          <SettingsRow
            title={s.queueMode === 'auto' ? 'Auto rules & your queue' : 'Manage your queue'}
            desc={
              s.queueMode === 'auto'
                ? 'Order the auto rules and edit the books you queued by hand.'
                : 'Reorder or remove the books in your queue.'
            }
            onPress={() => router.push('/settings/queue')}
          />
        )}
        {s.queueMode === 'playlist' && (
          <View
            style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm }}
          >
            <AppText variant="caption" color={colors.textMuted}>
              Playlist to follow
            </AppText>
            {playlistLoading ? (
              <AppText variant="caption" color={colors.textMuted}>
                Loading playlists...
              </AppText>
            ) : playlists.length === 0 ? (
              <AppText variant="caption" color={colors.textMuted}>
                No playlists found in this server's first book library.
              </AppText>
            ) : (
              playlists.map((p, i) => (
                <SettingsRow
                  key={p.id}
                  title={p.name}
                  desc={q.playlistId === p.id ? 'Selected for playlist mode.' : undefined}
                  last={i === playlists.length - 1}
                  control={
                    <SettingsToggle
                      on={q.playlistId === p.id}
                      onChange={() => setQueuePlaylistId(q.playlistId === p.id ? null : p.id)}
                    />
                  }
                />
              ))
            )}
          </View>
        )}
      </SettingsGroup>
    </SettingsPanel>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    conflict: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.accentWash,
    },
    conflictBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
  })
