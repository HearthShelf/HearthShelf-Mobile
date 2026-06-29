import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { getLibraries } from '@/api/abs'
import type { ABSLibrary } from '@hearthshelf/core'

export default function LibrariesScreen() {
  const router = useRouter()
  const [libraries, setLibraries] = useState<ABSLibrary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const libs = await getLibraries()
        if (!cancelled) setLibraries(libs)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>{'< Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Libraries</Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={libraries}
          keyExtractor={(lib) => lib.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => router.push(`/library/${item.id}`)}
            >
              <View style={styles.meta}>
                <Text style={styles.libName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.libType} numberOfLines={1}>
                  {item.mediaType}
                </Text>
              </View>
              <Text style={styles.chevron}>{'>'}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#14110f' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  back: { color: '#c4633a', fontSize: 15, fontWeight: '600' },
  title: { color: '#f3e9dd', fontSize: 22, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: '#221d19',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3a322c',
  },
  meta: { flex: 1 },
  libName: { color: '#f3e9dd', fontSize: 16, fontWeight: '600' },
  libType: { color: '#a99', fontSize: 13, marginTop: 2 },
  chevron: { color: '#a99', fontSize: 18, fontWeight: '600' },
  error: { color: '#e88', textAlign: 'center', paddingHorizontal: 24 },
})
