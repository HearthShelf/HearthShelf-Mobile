/**
 * Player settings as an in-context bottom sheet, opened from the player's More
 * tray so you can tweak speed / skips / progress bar / background without
 * tabbing away to Settings. It renders the same transport controls the full
 * Player settings screen (app/settings/playback.tsx) shows, bound to the same
 * settings store, so the two stay in lockstep. Queue/playlist stay on the full
 * screen (Queue has its own top-level surface).
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { useRouter } from 'expo-router'
import {
  getSettingsState,
  subscribeSettings,
  setSetting,
  resetSettings,
  restoreSettings,
} from '@/store/settings'
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  Seg,
  SettingsToggle,
  ChipRow,
  SettingsSlider,
} from '@/ui/settingsControls'
import { AppText, Sheet, Touchable, type SheetRef } from '@/ui/primitives'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import type { SheetHandle } from './sheets'

const SPEED_OPTIONS = [0.75, 1, 1.5, 2] as const

export const PlayerSettingsSheet = forwardRef<SheetHandle>(function PlayerSettingsSheet(_props, ref) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const router = useRouter()
  const sheetRef = useRef<SheetRef>(null)
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }))

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
    <Sheet ref={sheetRef} title="Player settings" snapPoints={['85%']} stackBehavior="push">
      <BottomSheetScrollView contentContainerStyle={styles.body}>
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
            desc="Behind the full-screen player."
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
            desc="Tap the cover to play or pause."
            control={
              <SettingsToggle
                on={s.tapArtworkTogglesPlay}
                onChange={(v) => setSetting('tapArtworkTogglesPlay', v)}
              />
            }
          />
          <SettingsRow
            title="Skip hotspots"
            desc="Double-tap the sides of the artwork to jump."
            control={
              <SettingsToggle on={s.skipHotspots} onChange={(v) => setSetting('skipHotspots', v)} />
            }
            last
          />
        </SettingsGroup>

        <Touchable
          style={styles.footnote}
          onPress={() => {
            sheetRef.current?.dismiss()
            router.push('/settings/playback')
          }}
        >
          <AppText variant="caption" color={colors.textMuted}>
            Buttons, queue, sleep, and more in the full Player settings screen
          </AppText>
          <AppText variant="caption" color={colors.accent}>
            {' '}
            Open →
          </AppText>
        </Touchable>
      </BottomSheetScrollView>
    </Sheet>
  )
})

const makeStyles = (_colors: Palette) =>
  StyleSheet.create({
    body: { paddingBottom: spacing.xxl, gap: spacing.md },
    footnote: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      paddingHorizontal: spacing.xs,
      paddingTop: spacing.sm,
    },
  })
