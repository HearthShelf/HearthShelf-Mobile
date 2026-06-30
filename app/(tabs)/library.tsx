import { useEffect, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { ABSLibrary } from '@hearthshelf/core'
import { getLibraries } from '@/api/abs'
import {
  AppText,
  Centered,
  IconButton,
  Loading,
  Row,
  Screen,
  SectionHeader,
  icons,
} from '@/ui/primitives'
import { colors, spacing } from '@/ui/theme'

export default function LibraryListScreen() {
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
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionHeader title="Libraries" />
        <IconButton
          name={icons.search}
          onPress={() => router.push('/search')}
          style={{ marginRight: spacing.lg }}
        />
      </View>
      {loading ? (
        <Loading />
      ) : error ? (
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      ) : (
        <FlatList
          data={libraries}
          keyExtractor={(lib) => lib.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140, gap: spacing.md }}
          renderItem={({ item }) => (
            <Row onPress={() => router.push(`/library/${item.id}`)}>
              <View style={{ flex: 1 }}>
                <AppText variant="label" numberOfLines={1}>
                  {item.name}
                </AppText>
                <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
                  {item.mediaType}
                </AppText>
              </View>
              <IconButton name={icons.chevronRight} color={colors.textMuted} />
            </Row>
          )}
        />
      )}
    </Screen>
  )
}
