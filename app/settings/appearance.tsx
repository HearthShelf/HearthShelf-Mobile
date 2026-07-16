/**
 * Appearance & feel panel: theme, accent colour, cover display, and haptics -
 * Haptics folded in here (D-CONSIST) rather than a separate screen for two
 * segments. Theme + accent flow through the reactive ThemeProvider, so changes
 * re-skin the whole app live.
 */
import { useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting, resetSettings, restoreSettings } from '@/store/settings'
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
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'

export default function AppearancePanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  // Reset a family of keys to defaults, with an Undo toast (D-ACTIONS).
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

  return (
    <SettingsPanel>
      <SettingsLabel
        onReset={() => resetSection('Theme & accent', ['theme', 'accentHex'])}
      >
        Theme & accent
      </SettingsLabel>
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
          last={!s.floatingNav}
        />
        {s.floatingNav ? (
          <SettingsRow
            icon="swap-vert"
            title="Floating nav layout"
            desc="Horizontal centers the pill along the bottom. Vertical stacks it in the bottom-right and drops the mini player down beside it."
            control={
              <Seg
                value={s.floatingNavOrientation}
                onChange={(v) => setSetting('floatingNavOrientation', v)}
                options={[
                  { value: 'horizontal', label: 'Horizontal' },
                  { value: 'vertical', label: 'Vertical' },
                ]}
              />
            }
            last
          />
        ) : null}
      </SettingsGroup>

      <SettingsLabel
        onReset={() => resetSection('Haptics', ['haptics', 'hapticIntensity'])}
      >
        Feel
      </SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="vibration"
          title="Feedback"
          desc="How much of the app taps back on this device."
          stacked
          last={s.haptics === 'off'}
        >
          <Seg
            value={s.haptics}
            onChange={(v) => setSetting('haptics', v)}
            fill
            options={[
              { value: 'off', label: 'Off' },
              { value: 'minimal', label: 'Minimal' },
              { value: 'all', label: 'All' },
            ]}
          />
        </SettingsRow>
        {s.haptics !== 'off' && (
          <SettingsRow title="Intensity" desc="How firm each tap feels." stacked last>
            <Seg
              value={s.hapticIntensity}
              onChange={(v) => setSetting('hapticIntensity', v)}
              fill
              options={[
                { value: 'light', label: 'Light' },
                { value: 'medium', label: 'Medium' },
              ]}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPanel>
  )
}
