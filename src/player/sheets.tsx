/**
 * Bottom sheets for the full-screen player: Chapters, Speed, Sleep timer. Each
 * forwards a handle so the player can call `.present()`. They read/drive the
 * shared player store directly. Speed and Sleep are ported from the WebApp's
 * PlayerPopovers.tsx (the real, fleshed-out mobile behavior) rather than the
 * design-system mock, which never got past a bare tap-to-cycle speed control.
 */
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker'
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
  addSleepMinutes,
  type ChapterMark,
} from './store'
import { useBookmarks } from './useBookmarks'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { AppText, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { AppSlider } from '@/ui/AppSlider'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette, type buildShadow } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'
import { uses12HourClock, formatClock } from '@/lib/timeFormat'

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
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const { nowPlaying, position } = useSyncExternalStore(subscribe, getState)
  const active = currentChapter()
  const chapters = nowPlaying?.chapters ?? []

  return (
    <Sheet ref={sheetRef} kicker="Chapters" snapPoints={['70%']}>
      <BottomSheetScrollView>
        {chapters.map((c: ChapterMark, i: number) => {
          const isActive = active === c
          // Completed once we've listened past its end (not merely "before the
          // active chapter", which broke when nothing was active).
          const isDone = !isActive && position >= c.end
          return (
            <Touchable
              key={`${c.start}-${i}`}
              style={styles.row}
              onPress={() => {
                seekToChapter(c)
                sheetRef.current?.dismiss()
              }}
            >
              {isActive ? (
                <Icon name={icons.nowPlaying} size={18} color={colors.accent} />
              ) : isDone ? (
                <Icon name={icons.checkCircle} size={18} color={colors.success} />
              ) : (
                <AppText
                  variant="caption"
                  color={colors.textFaint}
                  style={{ width: 18, textAlign: 'center' }}
                >
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
            </Touchable>
          )
        })}
      </BottomSheetScrollView>
    </Sheet>
  )
})

// ---- Bookmarks ----

export const BookmarksSheet = forwardRef<
  SheetHandle,
  { itemId: string | null; onSeek: (sec: number) => void }
>(function BookmarksSheet({ itemId, onSeek }, ref) {
  const sheetRef = useSheetHandle(ref)
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const { bookmarks, removeBookmark } = useBookmarks(itemId)

  return (
    <Sheet ref={sheetRef} kicker="Bookmarks" snapPoints={['60%']}>
      {bookmarks.length === 0 ? (
        <AppText
          variant="meta"
          color={colors.textMuted}
          style={{ textAlign: 'center', paddingVertical: spacing.xl }}
        >
          No bookmarks yet. Tap the ribbon on the cover to save your spot.
        </AppText>
      ) : (
        <BottomSheetScrollView>
          {bookmarks.map((b) => (
            <Touchable
              key={`${b.time}-${b.createdAt ?? ''}`}
              style={styles.bookmarkRow}
              onPress={() => {
                onSeek(b.time)
                sheetRef.current?.dismiss()
              }}
            >
              <Icon name={icons.bookmarkFilled} size={18} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <AppText variant="meta" numberOfLines={1}>
                  {b.title || formatTimestamp(b.time)}
                </AppText>
                <AppText variant="mono" color={colors.textMuted}>
                  {formatTimestamp(b.time)}
                </AppText>
              </View>
              <Touchable hitSlop={8} onPress={() => removeBookmark(b.time)}>
                <Icon name={icons.close} size={18} color={colors.textMuted} />
              </Touchable>
            </Touchable>
          ))}
        </BottomSheetScrollView>
      )}
    </Sheet>
  )
})

// ---- Speed ----

// The handful of speeds people actually reach for (surveys put the median at
// 1.5x, with 1x and 2x the top single picks). The slider fills in everything
// between.
const SPEED_PRESETS = [0.75, 1, 1.5, 2]

function speedLabel(s: number): string {
  return s.toFixed(2).replace(/\.?0+$/, '') + 'x'
}

export const SpeedSheet = forwardRef<SheetHandle>(function SpeedSheet(_props, ref) {
  const sheetRef = useSheetHandle(ref)
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const { rate } = useSyncExternalStore(subscribe, getState)

  return (
    <Sheet ref={sheetRef} kicker="Playback speed">
      <View style={{ alignItems: 'center', marginBottom: spacing.md }}>
        <AppText variant="hero" style={{ fontFamily: undefined }}>
          {speedLabel(rate)}
        </AppText>
      </View>
      <AppSlider
        min={0.5}
        max={3}
        step={0.05}
        value={rate}
        onChange={setRate}
        ticks={[0.5, 1, 1.5, 2, 3]}
        formatTick={speedLabel}
      />
      <View style={[styles.grid, { marginTop: spacing.lg }]}>
        {SPEED_PRESETS.map((s) => {
          // Widened so a preset still highlights when the slider lands on it
          // (the slider steps by 0.05).
          const on = Math.abs(s - rate) < 0.025
          return (
            <Touchable
              key={s}
              style={[styles.speed, on && styles.speedOn]}
              onPress={() => setRate(s)}
            >
              <AppText variant="label" color={on ? colors.onAccent : colors.text}>
                {speedLabel(s)}
              </AppText>
            </Touchable>
          )
        })}
      </View>
    </Sheet>
  )
})

// ---- Sleep timer ----

type SleepTab = 'duration' | 'chapter' | 'time'

// Preset durations (minutes) for the setup grid. Match the auto-duration presets
// in app/settings/sleep.tsx.
const SLEEP_DURATIONS = [10, 15, 20, 30, 40, 60]
// Add-time buttons shown while a timer is running.
const ADD_MINUTES = [5, 10, 15, 30]

function fmtRewind(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

const clockLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * The running-timer takeover. When a sleep timer is armed the sheet drops the
 * setup UI entirely and shows this: the remaining time large and prominent, the
 * clock time it ends at beneath, quick add-time buttons, and cancel.
 */
function ActiveSleep({
  onDismiss,
  onEditBehavior,
}: {
  onDismiss: () => void
  onEditBehavior: () => void
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const { sleepTimer, sleepBehavior, nowPlaying, position } = useSyncExternalStore(
    subscribe,
    getState,
  )
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const beepOn =
    settings.sleepChime &&
    (settings.sleepBeepAt2min || settings.sleepBeepAt1min || settings.sleepBeepFinal)
  const chapters = nowPlaying?.chapters ?? []

  // Seconds left + the wall-clock time it ends, resolved for every kind.
  const eocSecondsLeft = (() => {
    if (sleepTimer?.kind !== 'endOfChapter') return null
    const target = chapters[sleepTimer.chapterIndex]
    if (!target) return null
    const boundary = sleepTimer.at === 'start' ? target.start : target.end
    return Math.max(0, Math.round(boundary - position))
  })()
  const secondsLeft =
    sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'
      ? sleepTimer.remainingSec
      : (eocSecondsLeft ?? 0)
  const endsAtMs = sleepTimer?.kind === 'clock' ? sleepTimer.atMs : Date.now() + secondsLeft * 1000
  const canAdd = sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'

  const kindLabel =
    sleepTimer?.kind === 'endOfChapter'
      ? `Stops at the ${sleepTimer.at} of this chapter`
      : sleepTimer?.kind === 'clock'
        ? 'Stops at the set time'
        : 'Counting down'

  return (
    <View style={styles.activeWrap}>
      <View style={styles.activeHead}>
        <Icon name={icons.sleep} size={16} color={colors.accent} />
        <AppText variant="caption" color={colors.textMuted}>
          {kindLabel}
        </AppText>
      </View>

      <Text style={styles.bigRemaining} allowFontScaling={false}>
        {formatTimestamp(Math.max(0, Math.round(secondsLeft)))}
      </Text>
      <View style={styles.endsAtRow}>
        <Icon name={icons.schedule} size={15} color={colors.textMuted} />
        <AppText variant="meta" color={colors.textMuted}>
          Ends at{' '}
          <AppText variant="meta" color={colors.text} style={{ fontWeight: '700' }}>
            {clockLabel(endsAtMs)}
          </AppText>
        </AppText>
      </View>

      {canAdd && (
        <>
          <AppText
            variant="caption"
            color={colors.textMuted}
            style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}
          >
            Add more time
          </AppText>
          <View style={[styles.grid, { alignSelf: 'stretch' }]}>
            {ADD_MINUTES.map((m) => (
              <Touchable key={m} style={styles.addBtn} onPress={() => addSleepMinutes(m)}>
                <AppText variant="label" color={colors.text}>
                  +{m}m
                </AppText>
              </Touchable>
            ))}
          </View>
        </>
      )}

      <Touchable style={[styles.behaviorNote, { alignSelf: 'stretch' }]} onPress={onEditBehavior}>
        <Icon name={icons.tune} size={16} color={colors.textMuted} />
        <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
          {sleepBehavior.rewindSec > 0
            ? `Rewinds ${fmtRewind(sleepBehavior.rewindSec)}`
            : 'No rewind'}
          {sleepBehavior.fade ? ` · fades over ${sleepBehavior.fadeLen}s` : ' · no fade'}
          {beepOn ? ' · beeps before ending' : ''}
        </AppText>
        <AppText variant="caption" color={colors.accent}>
          Edit
        </AppText>
      </Touchable>

      <Touchable
        style={styles.cancelSleep}
        onPress={() => {
          cancelSleepTimer()
          onDismiss()
        }}
      >
        <Icon name={icons.close} size={18} color={colors.text} />
        <AppText variant="label" color={colors.text}>
          Cancel timer
        </AppText>
      </Touchable>
    </View>
  )
}

/** The setup UI shown when no timer is armed: pick a duration / chapter / clock
 *  time, then press Start. Nothing arms until Start is pressed. */
function SleepSetup({
  onDismiss,
  onEditBehavior,
}: {
  onDismiss: () => void
  onEditBehavior: () => void
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const { sleepBehavior, nowPlaying, position } = useSyncExternalStore(subscribe, getState)
  const chapters = nowPlaying?.chapters ?? []
  const hasChapters = chapters.length > 0

  const [tab, setTab] = useState<SleepTab>('duration')
  // Staged (not yet armed) selections per tab.
  const [durationMin, setDurationMin] = useState(30)
  const [chapAt, setChapAt] = useState<'start' | 'end'>('end')
  const [chapIdx, setChapIdx] = useState<number | null>(null)
  const [clock, setClock] = useState(() => {
    const d = new Date(Date.now() + 30 * 60000)
    d.setMinutes(Math.round(d.getMinutes() / 5) * 5, 0, 0)
    return { h: d.getHours(), m: d.getMinutes() }
  })

  // Only chapter boundaries ahead of the current position are valid stop points;
  // arming one already behind us would fire instantly.
  const isFuture = (idx: number, at: 'start' | 'end') => {
    const c = chapters[idx]
    if (!c) return false
    return (at === 'start' ? c.start : c.end) > position
  }
  const effectiveChapIdx =
    chapIdx != null && isFuture(chapIdx, chapAt)
      ? chapIdx
      : chapters.findIndex((_, i) => isFuture(i, chapAt))

  const start = () => {
    if (tab === 'duration') {
      setSleepTimer({
        kind: 'duration',
        remainingSec: durationMin * 60,
        totalSec: durationMin * 60,
      })
    } else if (tab === 'chapter') {
      if (effectiveChapIdx < 0) return
      setSleepTimer({ kind: 'endOfChapter', chapterIndex: effectiveChapIdx, at: chapAt })
    } else {
      const now = new Date()
      const target = new Date()
      target.setHours(clock.h, clock.m, 0, 0)
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
      const remainingSec = Math.round((target.getTime() - now.getTime()) / 1000)
      setSleepTimer({
        kind: 'clock',
        remainingSec,
        totalSec: remainingSec,
        atMs: target.getTime(),
      })
    }
    onDismiss()
  }

  const startDisabled = tab === 'chapter' && effectiveChapIdx < 0
  const startLabel =
    tab === 'duration'
      ? `Start ${durationMin} min timer`
      : tab === 'time'
        ? `Stop at ${clockLabel(clockPreviewMs(clock))}`
        : effectiveChapIdx >= 0
          ? `Stop at chapter ${chapAt}`
          : 'No chapter ahead'

  const tabs: SleepTab[] = hasChapters ? ['duration', 'chapter', 'time'] : ['duration', 'time']

  return (
    // Keyed by tab so switching modes remounts the body: gorhom's dynamic sizing
    // grows to fit new content but won't shrink on its own, so a fresh onLayout
    // (from the remount) is what lets the sheet shrink back to a shorter tab's
    // natural height (Duration/Time after Chapter).
    <View key={tab} style={{ paddingBottom: spacing.md }}>
      <View style={styles.segFull}>
        {tabs.map((t) => (
          <Touchable
            key={t}
            style={[styles.seg, tab === t && styles.segOn]}
            onPress={() => setTab(t)}
          >
            <AppText
              variant="label"
              color={tab === t ? colors.accent : colors.textMuted}
              style={{ textTransform: 'capitalize' }}
            >
              {t}
            </AppText>
          </Touchable>
        ))}
      </View>

      {tab === 'duration' && (
        <View>
          <View style={{ alignItems: 'center', marginBottom: spacing.md }}>
            <Text style={styles.bigDuration} allowFontScaling={false}>
              {durationMin} min
            </Text>
          </View>
          <AppSlider
            min={1}
            max={120}
            step={1}
            value={durationMin}
            onChange={setDurationMin}
            ticks={[1, 30, 60, 90, 120]}
            formatTick={(v) => `${v}m`}
          />
          <View style={[styles.grid, { marginTop: spacing.lg }]}>
            {SLEEP_DURATIONS.map((m) => {
              const on = durationMin === m
              return (
                <Touchable
                  key={m}
                  style={[styles.speed, on && styles.speedOn]}
                  onPress={() => setDurationMin(m)}
                >
                  <AppText variant="label" color={on ? colors.onAccent : colors.text}>
                    {m}m
                  </AppText>
                </Touchable>
              )
            })}
          </View>
        </View>
      )}

      {tab === 'chapter' && hasChapters && (
        <View>
          <View style={styles.segFull}>
            {(['start', 'end'] as const).map((at) => (
              <Touchable
                key={at}
                style={[styles.seg, chapAt === at && styles.segOn]}
                onPress={() => {
                  setChapAt(at)
                  setChapIdx(null)
                }}
              >
                <AppText variant="label" color={chapAt === at ? colors.accent : colors.textMuted}>
                  Chapter {at}
                </AppText>
              </Touchable>
            ))}
          </View>
          <AppText variant="caption" color={colors.textMuted} style={{ marginBottom: spacing.sm }}>
            Stop at the {chapAt} of
          </AppText>
          {/* Capped internal scroll: bounds the dynamic-sizing measurement so a
              long chapter list scrolls here instead of stretching the sheet. */}
          <BottomSheetScrollView style={styles.chapterList} showsVerticalScrollIndicator={false}>
            {chapters.map((c, i) =>
              isFuture(i, chapAt) ? (
                <Touchable key={i} style={styles.chapterRow} onPress={() => setChapIdx(i)}>
                  <Icon
                    name={effectiveChapIdx === i ? icons.checkCircle : icons.sleep}
                    size={18}
                    color={effectiveChapIdx === i ? colors.accent : colors.textFaint}
                  />
                  <AppText
                    variant="meta"
                    color={effectiveChapIdx === i ? colors.accent : colors.text}
                    numberOfLines={1}
                    style={{ flex: 1 }}
                  >
                    {c.title}
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    {formatTimestamp(chapAt === 'start' ? c.start : c.end)}
                  </AppText>
                </Touchable>
              ) : null,
            )}
          </BottomSheetScrollView>
        </View>
      )}

      {tab === 'time' && <ClockPicker clock={clock} onChange={setClock} />}

      <Touchable style={styles.behaviorNote} onPress={onEditBehavior}>
        <Icon name={icons.tune} size={16} color={colors.textMuted} />
        <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
          {sleepBehavior.rewindSec > 0
            ? `Rewinds ${fmtRewind(sleepBehavior.rewindSec)}`
            : 'No rewind'}
          {sleepBehavior.fade ? ` · fades over ${sleepBehavior.fadeLen}s` : ' · no fade'}
        </AppText>
        <AppText variant="caption" color={colors.accent}>
          Edit
        </AppText>
      </Touchable>

      <Touchable
        style={[styles.startBtn, startDisabled && { opacity: 0.4 }]}
        onPress={startDisabled ? undefined : start}
        disabled={startDisabled}
      >
        <Icon name={icons.sleep} size={18} color={colors.onAccent} />
        <AppText variant="label" color={colors.onAccent}>
          {startLabel}
        </AppText>
      </Touchable>
    </View>
  )
}

/** The "time" tab's clock control: a tappable pill showing the staged stop time
 *  that opens the OS time picker, matching the settings sleep panel. */
function ClockPicker({
  clock,
  onChange,
}: {
  clock: { h: number; m: number }
  onChange: (c: { h: number; m: number }) => void
}) {
  const { colors } = useTheme()
  const [open, setOpen] = useState(false)
  const date = new Date()
  date.setHours(clock.h, clock.m, 0, 0)

  const onPicked = (e: DateTimePickerEvent, picked?: Date) => {
    // Android fires 'dismissed' on cancel; only commit a real 'set'.
    setOpen(false)
    if (e.type === 'set' && picked) onChange({ h: picked.getHours(), m: picked.getMinutes() })
  }

  return (
    <View style={{ alignItems: 'center' }}>
      <Touchable
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.xl,
          borderRadius: radius.card,
          backgroundColor: colors.fill,
          borderWidth: 1,
          borderColor: colors.border,
        }}
        onPress={() => setOpen(true)}
      >
        <Icon name={icons.schedule} size={20} color={colors.textMuted} />
        <Text style={{ fontSize: 32, fontWeight: '800', color: colors.accent }}>
          {formatClock(clock.h, clock.m)}
        </Text>
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
    </View>
  )
}

// Preview the wall-clock ms for a picked {h, m}, rolling to tomorrow if past.
function clockPreviewMs(clock: { h: number; m: number }): number {
  const now = new Date()
  const target = new Date()
  target.setHours(clock.h, clock.m, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime()
}

export const SleepSheet = forwardRef<SheetHandle, { onEditBehavior: () => void }>(
  function SleepSheet({ onEditBehavior }, ref) {
    const sheetRef = useSheetHandle(ref)
    const { sleepTimer } = useSyncExternalStore(subscribe, getState)
    const active = sleepTimer !== null

    return (
      // Dynamic sizing so each mode gets its own natural height (Duration and
      // Time are compact; Chapter is taller). The chapter list is the one thing
      // that could grow unbounded, so it lives in a maxHeight-capped internal
      // scroll (see SleepSetup) - that keeps the dynamic measurement bounded and
      // the tray closable without stretching Duration/Time into a huge sheet.
      <Sheet ref={sheetRef} kicker={active ? 'Sleep timer' : 'Set a sleep timer'}>
        {active ? (
          <ActiveSleep
            onDismiss={() => sheetRef.current?.dismiss()}
            onEditBehavior={onEditBehavior}
          />
        ) : (
          <SleepSetup
            onDismiss={() => sheetRef.current?.dismiss()}
            onEditBehavior={onEditBehavior}
          />
        )}
      </Sheet>
    )
  },
)

const makeStyles = (colors: Palette, shadow: ReturnType<typeof buildShadow>) =>
  StyleSheet.create({
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
    segFull: {
      flexDirection: 'row',
      gap: 4,
      backgroundColor: colors.fill,
      borderRadius: radius.card,
      padding: 4,
      marginBottom: spacing.lg,
    },
    seg: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.row,
    },
    segOn: { backgroundColor: colors.accentWash },
    // Caps the chapter list so it scrolls internally rather than stretching the
    // dynamically-sized sheet to fit all chapters.
    chapterList: { maxHeight: 280 },
    chapterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    bookmarkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    behaviorNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.row,
      backgroundColor: colors.fill,
    },
    // The accent Start button that arms a staged timer (idle setup).
    startBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginTop: spacing.lg,
      paddingVertical: spacing.md + 2,
      borderRadius: radius.card,
      backgroundColor: colors.accent,
      ...shadow.accentGlow,
    },
    // The staged duration, shown large above the slider in the setup UI.
    bigDuration: {
      fontSize: 40,
      fontWeight: '800',
      color: colors.accent,
      fontVariant: ['tabular-nums'],
    },
    // ---- Running-timer takeover ----
    activeWrap: { paddingBottom: spacing.md, alignItems: 'center' },
    activeHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    bigRemaining: {
      fontSize: 68,
      fontWeight: '800',
      color: colors.accent,
      fontVariant: ['tabular-nums'],
      letterSpacing: -1,
    },
    endsAtRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    addBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    // Full-width subtle cancel across the bottom when a timer is running.
    cancelSleep: {
      flexDirection: 'row',
      alignSelf: 'stretch',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginTop: spacing.lg,
      paddingVertical: spacing.md + 2,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
  })
