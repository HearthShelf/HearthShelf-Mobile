/**
 * Appearance panel: theme, accent colour, and cover display. Theme + accent flow
 * through the reactive ThemeProvider, so changes re-skin the whole app live.
 */
import { useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  Seg,
  SettingsSlider,
  SettingsToggle,
  AccentSwatchPicker,
} from '@/ui/settingsControls'

export default function AppearancePanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRow
          icon="dark-mode"
          title="Theme"
          desc="Auto follows your device; Dark is home; Light for daytime; OLED goes pure black."
          stacked
        >
          <Seg
            value={s.theme}
            onChange={(v) => setSetting('theme', v)}
            fill
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'oled', label: 'OLED' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          icon="palette"
          title="Accent colour"
          desc="The colour for buttons, progress, and active controls."
          stacked
          last
        >
          <AccentSwatchPicker
            value={s.accentHex}
            onChange={(hex) => setSetting('accentHex', hex)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Covers</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="blur-on"
          title="Cover glow intensity"
          desc="How strongly cover colours bloom behind artwork."
          stacked
        >
          <SettingsSlider
            value={s.glow}
            min={0}
            max={60}
            step={1}
            onChange={(v) => setSetting('glow', v)}
            formatLabel={(v) => `${v}`}
          />
        </SettingsRow>
        <SettingsRow
          icon="crop"
          title="Cover shape"
          desc="How book covers are cropped in lists and the player."
          control={
            <Seg
              value={s.coverAspect}
              onChange={(v) => setSetting('coverAspect', v)}
              options={[
                { value: 'square', label: 'Square' },
                { value: 'portrait', label: 'Portrait' },
              ]}
            />
          }
        />
        <SettingsRow
          icon="blur-on"
          title="Cover glow style"
          desc="Gradient blooms live; Image is the lighter-weight option."
          control={
            <Seg
              value={s.glowMode}
              onChange={(v) => setSetting('glowMode', v)}
              options={[
                { value: 'gradient', label: 'Gradient' },
                { value: 'image', label: 'Image' },
              ]}
            />
          }
        />
      </SettingsGroup>

      <SettingsLabel>Navigation</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="dashboard"
          title="Floating nav bar (test)"
          desc="Swap the bottom bar for a floating icon pill: Home, Now, Library, and More. Stats moves under More. This is a test and lives only on this phone."
          control={
            <SettingsToggle on={s.floatingNav} onChange={(v) => setSetting('floatingNav', v)} />
          }
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}
