/**
 * Compact transport bar for the phone, so playback (play/pause + 15/30 skip) is
 * testable without a car. Reads the same player store the car drives.
 */
import { useSyncExternalStore } from 'react'
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useRouter } from 'expo-router'
import { getState, subscribe, togglePlay, jumpBy } from './store'

function fmt(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

export function NowPlayingBar() {
  const router = useRouter()
  const { nowPlaying, isPlaying, position } = useSyncExternalStore(subscribe, getState)
  if (!nowPlaying) return null

  return (
    <View style={styles.bar}>
      <TouchableOpacity style={styles.tap} onPress={() => router.push('/player')}>
        {nowPlaying.artworkUrl ? (
          <Image source={{ uri: nowPlaying.artworkUrl }} style={styles.cover} />
        ) : (
          <View style={styles.cover} />
        )}
        <View style={styles.meta}>
          <Text style={styles.title} numberOfLines={1}>
            {nowPlaying.title}
          </Text>
          <Text style={styles.time}>
            {fmt(position)} / {fmt(nowPlaying.duration)}
          </Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={styles.ctrl} onPress={() => jumpBy(-15)}>
        <Text style={styles.ctrlText}>-15</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.play} onPress={togglePlay}>
        <Text style={styles.playText}>{isPlaying ? 'II' : '>'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.ctrl} onPress={() => jumpBy(30)}>
        <Text style={styles.ctrlText}>+30</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#221d19',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#3a322c',
  },
  tap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  cover: { width: 44, height: 44, borderRadius: 5, backgroundColor: '#332b25' },
  meta: { flex: 1, minWidth: 0 },
  title: { color: '#f3e9dd', fontSize: 14, fontWeight: '600' },
  time: { color: '#a99', fontSize: 12, marginTop: 2 },
  ctrl: { paddingHorizontal: 8, paddingVertical: 6 },
  ctrlText: { color: '#d9c9b8', fontSize: 13, fontWeight: '600' },
  play: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#c4633a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playText: { color: '#fff', fontSize: 16, fontWeight: '700' },
})
