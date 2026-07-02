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
          desc="Dark is home; Light for daytime; OLED goes pure black."
          stacked
        >
          <Seg
            value={s.theme}
            onChange={(v) => setSetting('theme', v)}
            options={[
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
          <AccentSwatchPicker value={s.accentHex} onChange={(hex) => setSetting('accentHex', hex)} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Covers</SettingsLabel>
      <SettingsGroup>
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
          last
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
    </SettingsPanel>
  )
}
