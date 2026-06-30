/**
 * Bottom sheets for the full-screen player: Chapters, Speed, Sleep timer. Each
 * forwards a handle so the player can call `.present()`. They read/drive the
 * shared player store directly.
 */
import { forwardRef, useImperativeHandle, useRef, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { formatTimestamp } from '@hearthshelf/core'
import {
  getState,
  subscribe,
  seekToChapter,
  currentChapter,
  setRate,
  setSleepTimer,
  cancelSleepTimer,
  type ChapterMark,
} from './store'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import { colors, radius, spacing } from '@/ui/theme'

export interface SheetHandle {
  present: () => void
  dismiss: () => void
}

function useSheetHandle(ref: React.Ref<SheetHandle>) {
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }))
  return sheetRef
}

// ---- Chapters ----

export const ChaptersSheet = forwardRef<SheetHandle>(function ChaptersSheet(_props, ref) {
  const sheetRef = useSheetHandle(ref)
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const active = currentChapter()
  const chapters = nowPlaying?.chapters ?? []

  return (
    <Sheet ref={sheetRef} title="Chapters" snapPoints={['70%']}>
      <BottomSheetScrollView>
        {chapters.map((c: ChapterMark, i: number) => {
          const isActive = active === c
          return (
            <Pressable
              key={`${c.start}-${i}`}
              style={styles.row}
              onPress={() => {
                seekToChapter(c)
                sheetRef.current?.dismiss()
              }}
            >
              <AppText
                variant="meta"
                color={isActive ? colors.accent : colors.text}
                numberOfLines={1}
                style={{ flex: 1 }}
              >
                {c.title}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {formatTimestamp(c.start)}
              </AppText>
            </Pressable>
          )
        })}
      </BottomSheetScrollView>
    </Sheet>
  )
})

// ---- Speed ----

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export const SpeedSheet = forwardRef<SheetHandle>(function SpeedSheet(_props, ref) {
  const sheetRef = useSheetHandle(ref)
  const { rate } = useSyncExternalStore(subscribe, getState)

  return (
    <Sheet ref={sheetRef} title="Playback speed">
      <View style={styles.grid}>
        {SPEEDS.map((s) => {
          const on = Math.abs(s - rate) < 0.001
          return (
            <Pressable
              key={s}
              style={[styles.speed, on && styles.speedOn]}
              onPress={() => setRate(s)}
            >
              <AppText variant="label" color={on ? colors.onAccent : colors.text}>
                {s}x
              </AppText>
            </Pressable>
          )
        })}
      </View>
    </Sheet>
  )
})

// ---- Sleep timer ----

const SLEEP_MINUTES = [5, 15, 30, 45, 60]

export const SleepSheet = forwardRef<SheetHandle>(function SleepSheet(_props, ref) {
  const sheetRef = useSheetHandle(ref)
  const { sleepTimer } = useSyncExternalStore(subscribe, getState)
  const close = () => sheetRef.current?.dismiss()

  return (
    <Sheet ref={sheetRef} title="Sleep timer">
      <View style={{ gap: spacing.sm }}>
        {SLEEP_MINUTES.map((min) => {
          const on = sleepTimer?.kind === 'duration'
          return (
            <Pressable
              key={min}
              style={styles.row}
              onPress={() => {
                setSleepTimer({ kind: 'duration', remainingSec: min * 60 })
                close()
              }}
            >
              <AppText variant="meta">{min} minutes</AppText>
              {on && sleepTimer?.kind === 'duration' ? (
                <AppText variant="caption" color={colors.accent}>
                  {formatTimestamp(sleepTimer.remainingSec)} left
                </AppText>
              ) : null}
            </Pressable>
          )
        })}
        <Pressable
          style={styles.row}
          onPress={() => {
            setSleepTimer({ kind: 'endOfChapter' })
            close()
          }}
        >
          <AppText
            variant="meta"
            color={sleepTimer?.kind === 'endOfChapter' ? colors.accent : colors.text}
          >
            End of chapter
          </AppText>
        </Pressable>
        <Pressable
          style={styles.row}
          onPress={() => {
            cancelSleepTimer()
            close()
          }}
        >
          <AppText variant="meta" color={colors.textMuted}>
            Off
          </AppText>
        </Pressable>
      </View>
    </Sheet>
  )
})

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  speed: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    minWidth: 64,
    alignItems: 'center',
  },
  speedOn: { backgroundColor: colors.accent },
})
