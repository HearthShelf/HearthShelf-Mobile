/**
 * Sleep-timer panel: rewind-on-wake, chapter barrier, and fade behaviour. These
 * seed player/store.ts's sleepBehavior when a fresh session starts.
 */
import { useState, useSyncExternalStore } from 'react'
import { Platform, View } from 'react-native'
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { getSettingsState, subscribeSettings, setSetting, type BeepSound } from '@/store/settings'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
  SettingsSlider,
  Seg,
  ChipRow,
  SettingsLabel,
} from '@/ui/settingsControls'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'
import { uses12HourClock, parseHHMM, toHHMM, formatHHMM } from '@/lib/timeFormat'

function fmtRewind(sec: number): string {
  if (sec === 0) return 'Off'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const rem = sec % 60
  return rem ? `${m}m ${rem}s` : `${m}m`
}

// Preset auto-duration lengths in minutes, shared with the sleep slider grid.
const AUTO_DURATIONS = [10, 15, 20, 30, 40, 60] as const

// The warning-beep tones, in picker order. Labels stay short for the segmented
// control; keep in step with BeepSound in @hearthshelf/core.
const BEEP_SOUNDS: { value: BeepSound; label: string }[] = [
  { value: 'chime', label: 'Chime' },
  { value: 'marimba', label: 'Marimba' },
  { value: 'beep', label: 'Beep' },
  { value: 'bell', label: 'Bell' },
]

/** A multi-select pill row: each cue toggles on/off independently (unlike the
 *  single-select Seg). Used to pick which warning beeps fire. */
function CueChips({
  cues,
}: {
  cues: {
    key: 'sleepBeepAt2min' | 'sleepBeepAt1min' | 'sleepBeepFinal'
    label: string
    on: boolean
  }[]
}) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {cues.map((c) => (
        <Touchable
          key={c.key}
          onPress={() => setSetting(c.key, !c.on)}
          style={{
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderRadius: radius.pill,
            backgroundColor: c.on ? colors.accent : colors.fill,
          }}
        >
          <AppText variant="label" color={c.on ? colors.onAccent : colors.text}>
            {c.label}
          </AppText>
        </Touchable>
      ))}
    </View>
  )
}

/** A tappable time pill that opens the OS clock picker and stores back "HH:MM".
 *  Displays in the system's 12h/24h format. */
function TimeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const { h, m } = parseHHMM(value)
  const date = new Date()
  date.setHours(h, m, 0, 0)

  const onPicked = (e: DateTimePickerEvent, picked?: Date) => {
    // Android fires 'dismissed' on cancel; only commit a real 'set'.
    setOpen(false)
    if (e.type === 'set' && picked) onChange(toHHMM(picked.getHours(), picked.getMinutes()))
  }

  return (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.xs,
          paddingVertical: spacing.md,
          borderRadius: radius.card,
          backgroundColor: colors.fill,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Icon name={icons.schedule} size={16} color={colors.textMuted} />
        <AppText variant="label" color={colors.text}>
          {formatHHMM(value)}
        </AppText>
      </Touchable>
      {open && (
        <DateTimePicker
          value={date}
          mode="time"
          is24Hour={!uses12HourClock()}
          display={Platform.OS === 'ios' ? 'spinner' : 'clock'}
          onChange={onPicked}
        />
      )}
    </>
  )
}

export default function SleepPanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const colors = useColors()

  return (
    <SettingsPanel>
      <View>
        <SettingsLabel>General</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            title="Auto rewind"
            desc="Jump back this far when the timer ends, so you don't lose your place."
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
            control={
              <SettingsToggle
                on={s.chapterBarrier}
                onChange={(v) => setSetting('chapterBarrier', v)}
              />
            }
          />
        </SettingsGroup>

        <SettingsGroup style={{ marginTop: spacing.lg }}>
          <SettingsRow
            title="Fade out"
            desc="Gradually lower the volume before the timer pauses."
            control={
              <SettingsToggle on={s.sleepFade} onChange={(v) => setSetting('sleepFade', v)} />
            }
          />
          {s.sleepFade && (
            <SettingsRow title="Fade length" desc="How long the fade-out takes." stacked>
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

        <SettingsGroup style={{ marginTop: spacing.lg }}>
          <SettingsRow
            title="Warning beeps"
            desc="Play a soft beep before the timer ends, so you get a heads-up before the audio goes quiet."
            control={
              <SettingsToggle on={s.sleepChime} onChange={(v) => setSetting('sleepChime', v)} />
            }
            last={!s.sleepChime}
          />
          {s.sleepChime && (
            <>
              <SettingsRow title="When to beep" desc="Pick the warnings you want." stacked>
                <CueChips
                  cues={[
                    { key: 'sleepBeepAt2min', label: '2 min left', on: s.sleepBeepAt2min },
                    { key: 'sleepBeepAt1min', label: '1 min left', on: s.sleepBeepAt1min },
                    { key: 'sleepBeepFinal', label: 'At the end', on: s.sleepBeepFinal },
                  ]}
                />
              </SettingsRow>
              <SettingsRow title="Beep sound" desc="Which tone plays." stacked>
                <Seg
                  fill
                  value={s.sleepBeepSound}
                  onChange={(v) => setSetting('sleepBeepSound', v)}
                  options={BEEP_SOUNDS}
                />
              </SettingsRow>
              <SettingsRow title="Beep volume" desc="How loud the beep is." stacked last>
                <SettingsSlider
                  value={s.sleepBeepVolume}
                  min={0}
                  max={100}
                  step={5}
                  onChange={(v) => setSetting('sleepBeepVolume', v)}
                  formatLabel={(v) => `${v}%`}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>

        <SettingsGroup style={{ marginTop: spacing.lg }}>
          <SettingsRow
            title="Shake to extend"
            desc="Shake your phone while the timer runs to add more time. Pauses itself after several shakes in a row (e.g. carrying your phone on a walk) and never extends past 3 hours."
            control={
              <SettingsToggle
                on={s.sleepShakeExtend}
                onChange={(v) => setSetting('sleepShakeExtend', v)}
              />
            }
            last={!s.sleepShakeExtend}
          />
          {s.sleepShakeExtend && (
            <SettingsRow title="Time added per shake" desc="How much each shake adds." stacked last>
              <SettingsSlider
                value={s.sleepShakeMinutes}
                min={1}
                max={30}
                step={1}
                onChange={(v) => setSetting('sleepShakeMinutes', v)}
                formatLabel={(v) => `${v} min`}
              />
            </SettingsRow>
          )}
        </SettingsGroup>
      </View>

      <View>
        <SettingsLabel>Auto timer</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            title="Auto sleep timer"
            desc="Start a timer automatically when you press play during quiet hours."
            control={
              <SettingsToggle on={s.autoSleep} onChange={(v) => setSetting('autoSleep', v)} />
            }
            last={!s.autoSleep}
          />
          {s.autoSleep && (
            <>
              <SettingsRow title="Quiet hours" desc="When auto sleep should kick in." stacked>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <TimeField
                    value={s.autoSleepStart}
                    onChange={(v) => setSetting('autoSleepStart', v)}
                  />
                  <AppText variant="label" color={colors.textMuted}>
                    to
                  </AppText>
                  <TimeField
                    value={s.autoSleepEnd}
                    onChange={(v) => setSetting('autoSleepEnd', v)}
                  />
                </View>
              </SettingsRow>
              <SettingsRow
                title="Auto duration"
                desc="Timer length auto sleep starts with."
                stacked
                last
              >
                <ChipRow
                  value={s.autoSleepDur}
                  options={[...AUTO_DURATIONS]}
                  onChange={(v) => setSetting('autoSleepDur', v)}
                  unit="m"
                />
                <SettingsSlider
                  value={s.autoSleepDur}
                  min={5}
                  max={120}
                  step={5}
                  onChange={(v) => setSetting('autoSleepDur', v)}
                  formatLabel={(v) => `${v}m`}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      </View>
    </SettingsPanel>
  )
}
