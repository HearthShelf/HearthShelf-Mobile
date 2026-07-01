/**
 * Bottom sheets for the full-screen player: Chapters, Speed, Sleep timer. Each
 * forwards a handle so the player can call `.present()`. They read/drive the
 * shared player store directly. Speed and Sleep are ported from the WebApp's
 * PlayerPopovers.tsx (the real, fleshed-out mobile behavior) rather than the
 * design-system mock, which never got past a bare tap-to-cycle speed control.
 */
import { forwardRef, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import Slider from '@react-native-community/slider'
import { formatTimestamp } from '@hearthshelf/core'
import {
  getState,
  subscribe,
  seekToChapter,
  currentChapter,
  setRate,
  setSleepTimer,
  cancelSleepTimer,
  setSleepBehavior,
  addSleepMinutes,
  type ChapterMark,
} from './store'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
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
              {isActive ? (
                <Icon name={icons.nowPlaying} size={18} color={colors.accent} />
              ) : i < (chapters.findIndex((c2) => c2 === active) ?? -1) ? (
                <Icon name={icons.check} size={16} color={colors.textFaint} />
              ) : (
                <AppText variant="caption" color={colors.textFaint} style={{ width: 18, textAlign: 'center' }}>
                  {i + 1}
                </AppText>
              )}
              <AppText
                variant="meta"
                color={isActive ? colors.accent : colors.text}
                numberOfLines={1}
                style={{ flex: 1 }}
              >
                {c.title}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {formatTimestamp(c.end - c.start)}
              </AppText>
            </Pressable>
          )
        })}
      </BottomSheetScrollView>
    </Sheet>
  )
})

// ---- Speed ----

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

function speedLabel(s: number): string {
  return s.toFixed(2).replace(/\.?0+$/, '') + '×'
}

export const SpeedSheet = forwardRef<SheetHandle>(function SpeedSheet(_props, ref) {
  const sheetRef = useSheetHandle(ref)
  const { rate } = useSyncExternalStore(subscribe, getState)

  return (
    <Sheet ref={sheetRef} title="Playback speed">
      <View style={{ alignItems: 'center', marginBottom: spacing.md }}>
        <AppText variant="hero" style={{ fontFamily: undefined }}>
          {speedLabel(rate)}
        </AppText>
      </View>
      <Slider
        minimumValue={0.5}
        maximumValue={3}
        step={0.05}
        value={rate}
        onValueChange={(v) => setRate(Number(v.toFixed(2)))}
        minimumTrackTintColor={colors.accent}
        maximumTrackTintColor={colors.fillStrong}
        thumbTintColor={colors.accent}
      />
      <View style={styles.sliderTicks}>
        <AppText variant="caption" color={colors.textMuted}>0.5×</AppText>
        <AppText variant="caption" color={colors.textMuted}>1×</AppText>
        <AppText variant="caption" color={colors.textMuted}>2×</AppText>
        <AppText variant="caption" color={colors.textMuted}>3×</AppText>
      </View>
      <View style={[styles.grid, { marginTop: spacing.lg }]}>
        {SPEED_PRESETS.map((s) => {
          const on = Math.abs(s - rate) < 0.001
          return (
            <Pressable
              key={s}
              style={[styles.speed, on && styles.speedOn]}
              onPress={() => setRate(s)}
            >
              <AppText variant="label" color={on ? colors.onAccent : colors.text}>
                {s}×
              </AppText>
            </Pressable>
          )
        })}
      </View>
    </Sheet>
  )
})

// ---- Sleep timer ----

type SleepTab = 'duration' | 'chapter' | 'time'

const SLEEP_DURATIONS = [5, 15, 30, 45, 60, 90]

function fmtRewind(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

export const SleepSheet = forwardRef<SheetHandle>(function SleepSheet(_props, ref) {
  const sheetRef = useSheetHandle(ref)
  const { sleepTimer, sleepBehavior, nowPlaying, position } = useSyncExternalStore(
    subscribe,
    getState
  )
  const [tab, setTab] = useState<SleepTab>(sleepTimer?.kind === 'endOfChapter' ? 'chapter' : 'duration')
  const [clockInput, setClockInput] = useState('')

  const chapters = nowPlaying?.chapters ?? []
  const curIdx = Math.max(
    0,
    chapters.findIndex((c) => position >= c.start && position < c.end)
  )
  const targetIdx = sleepTimer?.kind === 'endOfChapter' ? sleepTimer.chapterIndex : curIdx
  const targetAt = sleepTimer?.kind === 'endOfChapter' ? sleepTimer.at : 'end'

  const active = sleepTimer !== null
  const sleeping = sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'
  const endsAtLabel =
    sleepTimer?.kind === 'clock'
      ? new Date(sleepTimer.atMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : sleepTimer?.kind === 'endOfChapter'
        ? `ch ${sleepTimer.chapterIndex + 1} ${sleepTimer.at}`
        : sleeping
          ? new Date(Date.now() + (sleepTimer?.remainingSec ?? 0) * 1000).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })
          : ''

  const pickDuration = (mins: number) => {
    setSleepTimer({ kind: 'duration', remainingSec: mins * 60 })
  }
  const pickChapter = (idx: number, at: 'start' | 'end') => {
    setSleepTimer({ kind: 'endOfChapter', chapterIndex: idx, at })
  }
  const pickClock = (hhmm: string) => {
    if (!hhmm) return
    const [h, m] = hhmm.split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(m)) return
    const now = new Date()
    const target = new Date()
    target.setHours(h, m, 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    const remainingSec = Math.round((target.getTime() - now.getTime()) / 1000)
    setSleepTimer({ kind: 'clock', remainingSec, atMs: target.getTime() })
  }

  return (
    <Sheet ref={sheetRef} title="Sleep timer" snapPoints={['82%']}>
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.segFull}>
          {(['duration', 'chapter', 'time'] as SleepTab[]).map((t) => (
            <Pressable
              key={t}
              style={[styles.seg, tab === t && styles.segOn]}
              onPress={() => setTab(t)}
            >
              <AppText
                variant="label"
                color={tab === t ? colors.text : colors.textMuted}
                style={{ textTransform: 'capitalize' }}
              >
                {t}
              </AppText>
            </Pressable>
          ))}
        </View>

        {tab === 'duration' && (
          <View style={styles.grid}>
            {SLEEP_DURATIONS.map((m) => {
              const on = sleeping && sleepTimer?.kind === 'duration' && Math.abs(sleepTimer.remainingSec - m * 60) < 30
              return (
                <Pressable
                  key={m}
                  style={[styles.speed, on && styles.speedOn]}
                  onPress={() => pickDuration(m)}
                >
                  <AppText variant="label" color={on ? colors.onAccent : colors.text}>
                    {m}m
                  </AppText>
                </Pressable>
              )
            })}
          </View>
        )}

        {tab === 'chapter' && chapters.length > 0 && (
          <View>
            <AppText variant="caption" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
              Stop at
            </AppText>
            <BottomSheetScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: spacing.md }}>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                {chapters.map((c, i) =>
                  i >= curIdx ? (
                    <Pressable
                      key={i}
                      style={[styles.chapterChip, targetIdx === i && styles.speedOn]}
                      onPress={() => pickChapter(i, targetAt)}
                    >
                      <AppText
                        variant="caption"
                        color={targetIdx === i ? colors.onAccent : colors.text}
                        numberOfLines={1}
                      >
                        {c.title}
                      </AppText>
                    </Pressable>
                  ) : null
                )}
              </View>
            </BottomSheetScrollView>
            <View style={styles.segFull}>
              <Pressable
                style={[styles.seg, sleepTimer?.kind === 'endOfChapter' && targetAt === 'start' && styles.segOn]}
                onPress={() => pickChapter(targetIdx, 'start')}
              >
                <AppText variant="label">Chapter start</AppText>
              </Pressable>
              <Pressable
                style={[styles.seg, sleepTimer?.kind === 'endOfChapter' && targetAt === 'end' && styles.segOn]}
                onPress={() => pickChapter(targetIdx, 'end')}
              >
                <AppText variant="label">Chapter end</AppText>
              </Pressable>
            </View>
          </View>
        )}

        {tab === 'time' && (
          <View>
            <TextInput
              style={styles.input}
              placeholder="HH:MM (24h)"
              placeholderTextColor={colors.textFaint}
              value={clockInput}
              onChangeText={setClockInput}
              onSubmitEditing={() => pickClock(clockInput)}
            />
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: spacing.sm }}>
              Playback stops at the clock time you pick.
            </AppText>
          </View>
        )}

        <View style={styles.divider} />
        <AppText variant="eyebrow" style={{ marginBottom: spacing.sm }}>
          When it stops
        </AppText>

        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <AppText variant="body">Rewind when it stops</AppText>
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
              {sleepBehavior.rewindSec > 0
                ? `Backs up ${fmtRewind(sleepBehavior.rewindSec)} so you pick up with context`
                : 'Resumes exactly where it stopped'}
            </AppText>
          </View>
          <AppText variant="mono" color={sleepBehavior.rewindSec > 0 ? colors.text : colors.textMuted}>
            {sleepBehavior.rewindSec > 0 ? fmtRewind(sleepBehavior.rewindSec) : 'Off'}
          </AppText>
        </View>
        <Slider
          minimumValue={0}
          maximumValue={300}
          step={5}
          value={sleepBehavior.rewindSec}
          onValueChange={(v) => setSleepBehavior({ rewindSec: v })}
          minimumTrackTintColor={colors.accent}
          maximumTrackTintColor={colors.fillStrong}
          thumbTintColor={colors.accent}
        />
        {sleepBehavior.rewindSec > 0 && (
          <Pressable
            style={[styles.row, { paddingLeft: spacing.md }]}
            onPress={() => setSleepBehavior({ chapterBarrier: !sleepBehavior.chapterBarrier })}
          >
            <View style={{ flex: 1 }}>
              <AppText variant="body">Keep within chapter</AppText>
              <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                Don't rewind past the chapter start
              </AppText>
            </View>
            <Toggle on={sleepBehavior.chapterBarrier} />
          </Pressable>
        )}

        <Pressable
          style={[styles.row, { marginTop: spacing.sm }]}
          onPress={() => setSleepBehavior({ fade: !sleepBehavior.fade })}
        >
          <View style={{ flex: 1 }}>
            <AppText variant="body">Fade volume out</AppText>
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
              {sleepBehavior.fade ? `Eases down over ${sleepBehavior.fadeLen}s` : 'Stops abruptly'}
            </AppText>
          </View>
          <Toggle on={sleepBehavior.fade} />
        </Pressable>
        {sleepBehavior.fade && (
          <View style={[styles.row, { gap: spacing.sm }]}>
            <Icon name={icons.schedule} size={18} color={colors.textMuted} />
            <Slider
              style={{ flex: 1 }}
              minimumValue={3}
              maximumValue={60}
              step={1}
              value={sleepBehavior.fadeLen}
              onValueChange={(v) => setSleepBehavior({ fadeLen: v })}
              minimumTrackTintColor={colors.accent}
              maximumTrackTintColor={colors.fillStrong}
              thumbTintColor={colors.accent}
            />
            <AppText variant="mono" color={colors.textMuted}>
              {sleepBehavior.fadeLen}s
            </AppText>
          </View>
        )}

        {active && (
          <>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Icon name={icons.schedule} size={17} color={colors.textMuted} />
              <AppText variant="meta" style={{ flex: 1, marginLeft: spacing.sm }}>
                Stops at <AppText variant="meta" color={colors.text}>{endsAtLabel}</AppText>
                {sleepTimer && (sleepTimer.kind === 'duration' || sleepTimer.kind === 'clock') ? (
                  <AppText variant="meta" color={colors.textMuted}>
                    {' '}
                    · in {formatTimestamp(sleepTimer.remainingSec)}
                  </AppText>
                ) : null}
              </AppText>
            </View>
            <View style={[styles.row, { justifyContent: 'flex-end', gap: spacing.sm }]}>
              {sleeping && (
                <Pressable style={styles.ghostBtn} onPress={() => addSleepMinutes(5)}>
                  <Icon name={icons.checkCircle} size={16} color={colors.text} />
                  <AppText variant="caption">5 min</AppText>
                </Pressable>
              )}
              <Pressable
                style={styles.ghostBtn}
                onPress={() => {
                  cancelSleepTimer()
                  sheetRef.current?.dismiss()
                }}
              >
                <Icon name={icons.close} size={16} color={colors.text} />
                <AppText variant="caption">Cancel</AppText>
              </Pressable>
            </View>
          </>
        )}
      </BottomSheetScrollView>
    </Sheet>
  )
})

function Toggle({ on }: { on: boolean }) {
  return (
    <View style={[styles.toggleTrack, on && styles.toggleTrackOn]}>
      <View style={[styles.toggleKnob, on && styles.toggleKnobOn]} />
    </View>
  )
}

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
  sliderTicks: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  segFull: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: colors.fill,
    borderRadius: radius.card,
    padding: 4,
    marginBottom: spacing.lg,
  },
  seg: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.row },
  segOn: { backgroundColor: colors.card },
  chapterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    maxWidth: 180,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderRadius: radius.row,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 16,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginVertical: spacing.lg },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
  },
  toggleTrack: {
    width: 46,
    height: 27,
    borderRadius: 999,
    backgroundColor: colors.elevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  toggleTrackOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleKnob: {
    width: 21,
    height: 21,
    borderRadius: 11,
    backgroundColor: '#fff',
    marginLeft: 3,
  },
  toggleKnobOn: { marginLeft: 22 },
})
