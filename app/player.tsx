/**
 * Full-screen now-playing view. Drives the same player store the compact bar and
 * the car surface read, so transport state stays in sync everywhere.
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  Image,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import type { LayoutChangeEvent } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  getState,
  subscribe,
  togglePlay,
  jumpBy,
  requestSeek,
  skipChapter,
  seekToChapter,
  currentChapter,
  setSleepTimer,
  cancelSleepTimer,
} from '@/player/store'
import type { ChapterMark } from '@/player/store'

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

const SLEEP_MINUTES = [5, 15, 30, 45, 60]

export default function PlayerScreen() {
  const router = useRouter()
  const { nowPlaying, isPlaying, position, sleepTimer } = useSyncExternalStore(subscribe, getState)
  const [showChapters, setShowChapters] = useState(false)
  const [showSleep, setShowSleep] = useState(false)

  // Track width is captured on layout so the scrubber can map touch x -> seconds.
  const trackWidth = useRef(0)
  const duration = nowPlaying?.duration ?? 0

  const seekFromX = (x: number) => {
    if (trackWidth.current <= 0 || duration <= 0) return
    const ratio = Math.min(1, Math.max(0, x / trackWidth.current))
    requestSeek(ratio * duration)
  }

  // Keep the latest seek closure reachable from the stable PanResponder so the
  // handler always sees the current duration without recreating the responder.
  const seekFromXRef = useRef(seekFromX)
  seekFromXRef.current = seekFromX

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => seekFromXRef.current(e.nativeEvent.locationX),
      onPanResponderMove: (e) => seekFromXRef.current(e.nativeEvent.locationX),
    })
  ).current

  if (!nowPlaying) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.bookTitle}>Nothing playing</Text>
        <TouchableOpacity style={styles.retry} onPress={() => router.back()}>
          <Text style={styles.retryText}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  const chapters = nowPlaying.chapters
  const hasChapters = chapters.length > 0
  const chapter = currentChapter()
  const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.topBtn}>v</Text>
        </TouchableOpacity>
        <Text style={styles.topLabel}>Now Playing</Text>
        <View style={styles.topBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {nowPlaying.artworkUrl ? (
          <Image source={{ uri: nowPlaying.artworkUrl }} style={styles.cover} />
        ) : (
          <View style={styles.cover} />
        )}

        <Text style={styles.bookTitle} numberOfLines={2}>
          {nowPlaying.title}
        </Text>
        <Text style={styles.author} numberOfLines={1}>
          {nowPlaying.author}
        </Text>
        {hasChapters && chapter ? (
          <Text style={styles.chapterLabel} numberOfLines={1}>
            {chapter.title}
          </Text>
        ) : null}

        <View
          style={styles.track}
          onLayout={(e: LayoutChangeEvent) => {
            trackWidth.current = e.nativeEvent.layout.width
          }}
          {...pan.panHandlers}
        >
          <View style={styles.trackFill} pointerEvents="none">
            <View style={[styles.trackProgress, { width: `${progress * 100}%` }]} />
          </View>
        </View>
        <View style={styles.times}>
          <Text style={styles.timeText}>{fmt(position)}</Text>
          <Text style={styles.timeText}>{fmt(duration)}</Text>
        </View>

        <View style={styles.transport}>
          {hasChapters ? (
            <TouchableOpacity style={styles.ctrl} onPress={() => skipChapter(-1)}>
              <Text style={styles.ctrlText}>|{'<'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.ctrl} onPress={() => jumpBy(-15)}>
            <Text style={styles.ctrlText}>-15</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.play} onPress={togglePlay}>
            <Text style={styles.playText}>{isPlaying ? 'II' : '>'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ctrl} onPress={() => jumpBy(30)}>
            <Text style={styles.ctrlText}>+30</Text>
          </TouchableOpacity>
          {hasChapters ? (
            <TouchableOpacity style={styles.ctrl} onPress={() => skipChapter(1)}>
              <Text style={styles.ctrlText}>{'>'}|</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.actions}>
          {hasChapters ? (
            <TouchableOpacity style={styles.actionBtn} onPress={() => setShowChapters(true)}>
              <Text style={styles.actionText}>Chapters</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.actionBtn} onPress={() => setShowSleep(true)}>
            <Text style={styles.actionText}>
              {sleepTimer?.kind === 'duration'
                ? `Sleep ${fmt(sleepTimer.remainingSec)}`
                : sleepTimer?.kind === 'endOfChapter'
                  ? 'Sleep end of chapter'
                  : 'Sleep'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {showChapters ? (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Chapters</Text>
              <TouchableOpacity onPress={() => setShowChapters(false)}>
                <Text style={styles.sheetClose}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView>
              {chapters.map((c: ChapterMark, i: number) => {
                const active = chapter === c
                return (
                  <TouchableOpacity
                    key={`${c.start}-${i}`}
                    style={styles.chapterRow}
                    onPress={() => {
                      seekToChapter(c)
                      setShowChapters(false)
                    }}
                  >
                    <Text style={[styles.chapterRowText, active && styles.chapterRowActive]} numberOfLines={1}>
                      {c.title}
                    </Text>
                    <Text style={styles.chapterRowTime}>{fmt(c.start)}</Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>
          </View>
        </View>
      ) : null}

      {showSleep ? (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Sleep timer</Text>
              <TouchableOpacity onPress={() => setShowSleep(false)}>
                <Text style={styles.sheetClose}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView>
              {SLEEP_MINUTES.map((min) => (
                <TouchableOpacity
                  key={min}
                  style={styles.chapterRow}
                  onPress={() => {
                    setSleepTimer({ kind: 'duration', remainingSec: min * 60 })
                    setShowSleep(false)
                  }}
                >
                  <Text style={styles.chapterRowText}>{min} min</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={styles.chapterRow}
                onPress={() => {
                  setSleepTimer({ kind: 'endOfChapter' })
                  setShowSleep(false)
                }}
              >
                <Text style={styles.chapterRowText}>End of chapter</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.chapterRow}
                onPress={() => {
                  cancelSleepTimer()
                  setShowSleep(false)
                }}
              >
                <Text style={[styles.chapterRowText, styles.sleepOff]}>Off</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#14110f' },
  center: { flex: 1, backgroundColor: '#14110f', alignItems: 'center', justifyContent: 'center', gap: 16 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  topBtn: { color: '#d9c9b8', fontSize: 18, fontWeight: '700', width: 28 },
  topLabel: { color: '#a99', fontSize: 13, fontWeight: '600' },
  body: { alignItems: 'center', paddingHorizontal: 24, paddingBottom: 24 },
  cover: {
    width: 260,
    height: 260,
    borderRadius: 12,
    backgroundColor: '#332b25',
    marginTop: 12,
    marginBottom: 24,
  },
  bookTitle: { color: '#f3e9dd', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  author: { color: '#a99', fontSize: 15, marginTop: 6, textAlign: 'center' },
  chapterLabel: { color: '#c4633a', fontSize: 14, fontWeight: '600', marginTop: 10, textAlign: 'center' },
  track: {
    width: '100%',
    height: 28,
    justifyContent: 'center',
    marginTop: 28,
  },
  trackFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#332b25',
    overflow: 'hidden',
  },
  trackProgress: { height: 6, backgroundColor: '#c4633a' },
  times: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  timeText: { color: '#a99', fontSize: 12 },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginTop: 28,
  },
  ctrl: { paddingHorizontal: 10, paddingVertical: 8, minWidth: 44, alignItems: 'center' },
  ctrlText: { color: '#d9c9b8', fontSize: 16, fontWeight: '600' },
  play: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#c4633a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: { color: '#fff', fontSize: 24, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 12, marginTop: 32 },
  actionBtn: {
    backgroundColor: '#221d19',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3a322c',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
  },
  actionText: { color: '#f3e9dd', fontSize: 14, fontWeight: '600' },
  retry: { backgroundColor: '#c4633a', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  retryText: { color: '#fff', fontWeight: '600' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: '#221d19',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3a322c',
    paddingBottom: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3a322c',
  },
  sheetTitle: { color: '#f3e9dd', fontSize: 17, fontWeight: '700' },
  sheetClose: { color: '#c4633a', fontSize: 15, fontWeight: '600' },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#3a322c',
    gap: 12,
  },
  chapterRowText: { color: '#f3e9dd', fontSize: 15, flex: 1 },
  chapterRowActive: { color: '#c4633a', fontWeight: '700' },
  chapterRowTime: { color: '#a99', fontSize: 13 },
  sleepOff: { color: '#a99' },
})
