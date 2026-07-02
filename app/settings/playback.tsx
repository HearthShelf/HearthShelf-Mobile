/**
 * Playback panel: speed, skip amounts, progress bar, hearth background, the
 * player-button editor link, and the up-next queue behaviour.
 */
import { useSyncExternalStore } from 'react'
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
import {
  getSettingsState,
  subscribeSettings,
  setSetting,
  setQueueMode,
  toggleAutoRule,
} from '@/store/settings'
import { QUEUE_MODES, QUEUE_MODE_SUB, AUTO_RULE_COPY } from '@/player/queue'

const SPEED_OPTIONS = [0.75, 1, 1.5, 2] as const

export default function PlaybackPanel() {
  const router = useRouter()
  const colors = useColors()
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

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
          <SettingsSlider
            value={s.skipForward}
            min={5}
            max={90}
            step={5}
            onChange={(v) => setSetting('skipForward', v)}
            formatLabel={(v) => `${v}s`}
          />
        </SettingsRow>
        <SettingsRow title="Skip back" desc="How far the back button jumps." stacked>
          <SettingsSlider
            value={s.skipBack}
            min={5}
            max={60}
            step={5}
            onChange={(v) => setSetting('skipBack', v)}
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
            options={[
              { value: 'blurred', label: 'Blurred' },
              { value: 'gradient', label: 'Glow' },
              { value: 'hearth', label: 'Hearth' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          title="Player buttons"
          desc="Choose which action buttons show on the player, tuck into More, or hide."
          onPress={() => router.push('/settings/player-buttons')}
          last
        />
      </SettingsGroup>

      <SettingsLabel>Queue</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="When a book ends"
          desc={QUEUE_MODE_SUB[s.queueMode]}
          stacked
          last={s.queueMode !== 'auto'}
        >
          <Seg
            value={s.queueMode}
            onChange={setQueueMode}
            options={QUEUE_MODES.map((m) => ({ value: m.v, label: m.label }))}
          />
        </SettingsRow>
        {s.queueMode === 'auto' && (
          <View style={{ paddingTop: spacing.sm }}>
            <AppText
              variant="caption"
              color={colors.textMuted}
              style={{ marginBottom: spacing.sm, paddingHorizontal: spacing.lg }}
            >
              Auto-queue rules
            </AppText>
            {s.queueAutoRules.map((r, i) => {
              const copy = AUTO_RULE_COPY[r.id]
              return (
                <SettingsRow
                  key={r.id}
                  title={copy.label}
                  desc={copy.desc}
                  last={i === s.queueAutoRules.length - 1}
                  control={<SettingsToggle on={r.on} onChange={() => toggleAutoRule(r.id)} />}
                />
              )
            })}
          </View>
        )}
      </SettingsGroup>
    </SettingsPanel>
  )
}
