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
import { StyleSheet, TextInput, View } from 'react-native'
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
import { AppText, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { AppSlider } from '@/ui/AppSlider'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette, type buildShadow } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

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

const SLEEP_DURATIONS = [5, 15, 30, 45, 60, 90]

function fmtRewind(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

export const SleepSheet = forwardRef<SheetHandle, { onEditBehavior: () => void }>(
  function SleepSheet({ onEditBehavior }, ref) {
    const sheetRef = useSheetHandle(ref)
    const { colors, shadow } = useTheme()
    const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
    const { sleepTimer, sleepBehavior, nowPlaying, position } = useSyncExternalStore(
      subscribe,
      getState,
    )
    const [tab, setTab] = useState<SleepTab>(
      sleepTimer?.kind === 'endOfChapter' ? 'chapter' : 'duration',
    )
    const [clockInput, setClockInput] = useState('')

    const chapters = nowPlaying?.chapters ?? []
    // Current chapter; when scrubbed past the last boundary, clamp to the last
    // chapter (not 0, which would offer already-finished chapters as targets).
    const foundIdx = chapters.findIndex((c) => position >= c.start && position < c.end)
    const curIdx = foundIdx >= 0 ? foundIdx : Math.max(0, chapters.length - 1)
    const targetIdx = sleepTimer?.kind === 'endOfChapter' ? sleepTimer.chapterIndex : curIdx
    const targetAt = sleepTimer?.kind === 'endOfChapter' ? sleepTimer.at : 'end'

    const active = sleepTimer !== null
    const sleeping = sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'

    // Seconds until an end-of-chapter timer fires (its boundary minus where we are).
    const eocSecondsLeft = (() => {
      if (sleepTimer?.kind !== 'endOfChapter') return null
      const target = chapters[sleepTimer.chapterIndex]
      if (!target) return null
      const boundary = sleepTimer.at === 'start' ? target.start : target.end
      return Math.max(0, Math.round(boundary - position))
    })()

    const clockLabel = (ms: number) =>
      new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

    // "Stops at <clock time>" for every kind - end-of-chapter now resolves to a
    // real wall-clock time instead of the opaque "EOC" / "ch N end".
    const endsAtLabel =
      sleepTimer?.kind === 'clock'
        ? clockLabel(sleepTimer.atMs)
        : sleepTimer?.kind === 'endOfChapter'
          ? eocSecondsLeft != null
            ? clockLabel(Date.now() + eocSecondsLeft * 1000)
            : `ch ${sleepTimer.chapterIndex + 1} ${sleepTimer.at}`
          : sleeping
            ? clockLabel(Date.now() + (sleepTimer?.remainingSec ?? 0) * 1000)
            : ''
    // Remaining countdown shown next to it, for any active timer.
    const remainingLabel =
      sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'
        ? formatTimestamp(sleepTimer.remainingSec)
        : eocSecondsLeft != null
          ? formatTimestamp(eocSecondsLeft)
          : null

    const pickDuration = (mins: number) => {
      setSleepTimer({ kind: 'duration', remainingSec: mins * 60, totalSec: mins * 60 })
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
      setSleepTimer({ kind: 'clock', remainingSec, totalSec: remainingSec, atMs: target.getTime() })
    }

    return (
      <Sheet ref={sheetRef} kicker="Sleep timer">
        <View style={{ paddingBottom: spacing.md }}>
          <View style={styles.segFull}>
            {(['duration', 'chapter', 'time'] as SleepTab[]).map((t) => (
              <Touchable
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
              </Touchable>
            ))}
          </View>

          {tab === 'duration' && (
            <View style={styles.grid}>
              {SLEEP_DURATIONS.map((m) => {
                // Match on the picked total, not remainingSec (which ticks down and
                // would drift the highlight off the chosen preset).
                const on = sleepTimer?.kind === 'duration' && sleepTimer.totalSec === m * 60
                return (
                  <Touchable
                    key={m}
                    style={[styles.speed, on && styles.speedOn]}
                    onPress={() => pickDuration(m)}
                  >
                    <AppText variant="label" color={on ? colors.onAccent : colors.text}>
                      {m}m
                    </AppText>
                  </Touchable>
                )
              })}
            </View>
          )}

          {tab === 'chapter' && chapters.length > 0 && (
            <View>
              <View style={styles.segFull}>
                <Touchable
                  style={[styles.seg, targetAt === 'start' && styles.segOn]}
                  onPress={() => pickChapter(targetIdx, 'start')}
                >
                  <AppText
                    variant="label"
                    color={targetAt === 'start' ? colors.text : colors.textMuted}
                  >
                    Chapter start
                  </AppText>
                </Touchable>
                <Touchable
                  style={[styles.seg, targetAt === 'end' && styles.segOn]}
                  onPress={() => pickChapter(targetIdx, 'end')}
                >
                  <AppText
                    variant="label"
                    color={targetAt === 'end' ? colors.text : colors.textMuted}
                  >
                    Chapter end
                  </AppText>
                </Touchable>
              </View>
              <AppText
                variant="caption"
                color={colors.textMuted}
                style={{ marginBottom: spacing.sm }}
              >
                Stop at the {targetAt} of
              </AppText>
              <BottomSheetScrollView style={styles.chapterList}>
                {chapters.map((c, i) =>
                  i >= curIdx ? (
                    <Touchable
                      key={i}
                      style={styles.chapterRow}
                      onPress={() => pickChapter(i, targetAt)}
                    >
                      <Icon
                        name={targetIdx === i ? icons.checkCircle : icons.sleep}
                        size={18}
                        color={targetIdx === i ? colors.accent : colors.textFaint}
                      />
                      <AppText
                        variant="meta"
                        color={targetIdx === i ? colors.accent : colors.text}
                        numberOfLines={1}
                        style={{ flex: 1 }}
                      >
                        {c.title}
                      </AppText>
                      <AppText variant="caption" color={colors.textMuted}>
                        {formatTimestamp(targetAt === 'start' ? c.start : c.end)}
                      </AppText>
                    </Touchable>
                  ) : null,
                )}
              </BottomSheetScrollView>
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

          {active && (
            <>
              <View style={styles.divider} />
              <View style={[styles.row, { borderBottomWidth: 0 }]}>
                <Icon name={icons.schedule} size={17} color={colors.accent} />
                <AppText variant="meta" style={{ flex: 1, marginLeft: spacing.sm }}>
                  Stops at{' '}
                  <AppText variant="meta" color={colors.text}>
                    {endsAtLabel}
                  </AppText>
                  {remainingLabel ? (
                    <AppText variant="meta" color={colors.textMuted}>
                      {' '}
                      · in {remainingLabel}
                    </AppText>
                  ) : null}
                </AppText>
                {sleeping && (
                  <Touchable style={styles.ghostBtn} onPress={() => addSleepMinutes(5)}>
                    <Icon name={icons.add} size={16} color={colors.text} />
                    <AppText variant="caption">5 min</AppText>
                  </Touchable>
                )}
              </View>
              <Touchable
                style={styles.cancelSleep}
                onPress={() => {
                  cancelSleepTimer()
                  sheetRef.current?.dismiss()
                }}
              >
                <Icon name={icons.close} size={18} color={colors.onAccent} />
                <AppText variant="label" color={colors.onAccent}>
                  Cancel sleep timer
                </AppText>
              </Touchable>
            </>
          )}
        </View>
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
  seg: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.row },
  segOn: { backgroundColor: colors.card },
  chapterList: { maxHeight: 220 },
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
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderRadius: radius.row,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 16,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
    marginVertical: spacing.lg,
  },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
  },
  // Full-width destructive-ish cancel across the bottom when a timer is running.
  cancelSleep: {
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
})
