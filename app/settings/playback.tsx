/**
 * Playback panel: speed, skip amounts, progress bar, hearth background, the
 * player-button editor link, and the up-next queue behaviour.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { AppText } from '@/ui/primitives'
import { spacing } from '@/ui/theme'
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
import { getSettingsState, subscribeSettings, setSetting, setQueueMode } from '@/store/settings'
import { getLibraries, getLibraryPlaylists } from '@/api/abs'
import type { ABSPlaylist } from '@hearthshelf/core'
import { QUEUE_MODES, QUEUE_MODE_SUB } from '@/player/queue'
import { getQueueState, setQueuePlaylistId, subscribeQueue } from '@/player/queue'

const SPEED_OPTIONS = [0.75, 1, 1.5, 2] as const

export default function PlaybackPanel() {
  const router = useRouter()
  const colors = useColors()
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const q = useSyncExternalStore(subscribeQueue, getQueueState)
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
          <ChipRow
            value={s.skipForward}
            options={[15, 30, 60]}
            onChange={(v) => {
              setSetting('skipForwardCustom', v)
              setSetting('skipForward', v)
            }}
            unit="s"
          />
          <SettingsSlider
            value={s.skipForward}
            min={5}
            max={300}
            step={5}
            onChange={(v) => {
              setSetting('skipForwardCustom', v)
              setSetting('skipForward', v)
            }}
            formatLabel={(v) => `${v}s`}
          />
        </SettingsRow>
        <SettingsRow title="Skip back" desc="How far the back button jumps." stacked>
          <ChipRow
            value={s.skipBack}
            options={[10, 15, 30]}
            onChange={(v) => {
              setSetting('skipBackCustom', v)
              setSetting('skipBack', v)
            }}
            unit="s"
          />
          <SettingsSlider
            value={s.skipBack}
            min={5}
            max={300}
            step={5}
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
        <SettingsRow
          title="Swipe between books"
          desc="Turn the player cover into a swipeable deck of your up-next queue. Swipe to browse, tap play on a book to switch. (Turns off skip hotspots while on.)"
          control={
            <SettingsToggle
              on={s.carouselPlayer}
              onChange={(v) => setSetting('carouselPlayer', v)}
            />
          }
        />
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
