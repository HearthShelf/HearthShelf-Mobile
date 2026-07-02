/**
 * Sleep-timer panel: rewind-on-wake, chapter barrier, and fade behaviour. These
 * seed player/store.ts's sleepBehavior when a fresh session starts.
 */
import { useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
  SettingsSlider,
} from '@/ui/settingsControls'

function fmtRewind(sec: number): string {
  if (sec === 0) return 'Off'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const rem = sec % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}

export default function SleepPanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRow
          title="Rewind on wake"
          desc="Jump back this far when the timer pauses, so you don't lose your place."
          stacked
        >
          <SettingsSlider
            value={s.sleepRewindSec}
            min={0}
            max={120}
            step={5}
            onChange={(v) => setSetting('sleepRewindSec', v)}
            formatLabel={fmtRewind}
          />
        </SettingsRow>
        <SettingsRow
          title="Stay within the chapter"
          desc="When rewinding, don't cross back into the previous chapter."
          control={<SettingsToggle on={s.chapterBarrier} onChange={(v) => setSetting('chapterBarrier', v)} />}
        />
        <SettingsRow
          title="Fade out"
          desc="Gradually lower the volume before the timer pauses."
          control={<SettingsToggle on={s.sleepFade} onChange={(v) => setSetting('sleepFade', v)} />}
          last={!s.sleepFade}
        />
        {s.sleepFade && (
          <SettingsRow title="Fade length" desc="How long the fade-out takes." stacked last>
            <SettingsSlider
              value={s.sleepFadeLen}
              min={5}
              max={60}
              step={5}
              onChange={(v) => setSetting('sleepFadeLen', v)}
              formatLabel={(v) => `${v}s`}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPanel>
  )
}
