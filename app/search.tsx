import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FlatList, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem, HSAudibleSearchResult } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { getLibraries, searchLibrary, itemAuthor, itemTitle } from '@/api/abs'
import { searchAudible } from '@/api/absAudible'
import { getRmabEnabled } from '@/api/absRmab'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  Loading,
  Screen,
  Touchable,
  icons,
} from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { NotOwnedSheet } from '@/ui/NotOwnedSheet'
import { AppTabBar } from '@/ui/AppTabBar'
import { DUR } from '@/ui/motion'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'

const COLS = 3
const GUTTER = spacing.lg

export default function SearchScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { width } = useWindowDimensions()
  const contentInset = useContentInset()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ABSLibraryItem[]>([])
  const [external, setExternal] = useState<HSAudibleSearchResult[]>([])
  const [rmabEnabled, setRmabEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const externalOn = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().searchExternalSources,
  )
  const sheetRef = useRef<BottomSheetModal>(null)
  const [selected, setSelected] = useState<HSAudibleSearchResult | null>(null)

  const tileWidth = (width - GUTTER * 2 - GUTTER * (COLS - 1)) / COLS
  const goToTab = (name: string) => {
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  const libraryIdRef = useRef<string | null>(null)
  async function resolveLibraryId(): Promise<string | null> {
    if (libraryIdRef.current) return libraryIdRef.current
    const libs = await getLibraries()
    const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
    libraryIdRef.current = lib?.id ?? null
    return libraryIdRef.current
  }

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setResults([])
      setExternal([])
      setSearched(false)
      setLoading(false)
      return
    }
    setLoading(true)
    let owned: ABSLibraryItem[] = []
    try {
      const libraryId = await resolveLibraryId()
      if (!libraryId) {
        setResults([])
        return
      }
      owned = await searchLibrary(libraryId, trimmed)
      setResults(owned)
    } catch {
      setResults([])
    } finally {
      setSearched(true)
      setLoading(false)
    }

    // External (Audible) discovery. Best-effort and gated by the synced setting;
    // read live from the store so it reflects a mid-session toggle. Deduped
    // against owned results so a book you already have never shows twice.
    if (!getSettingsState().searchExternalSources) {
      setExternal([])
      return
    }
    try {
      const [res, rmab] = await Promise.all([searchAudible(trimmed), getRmabEnabled()])
      const ownedKeys = new Set(
        owned.map((it) => (itemTitle(it) + '|' + itemAuthor(it)).toLowerCase()),
      )
      setRmabEnabled(rmab)
      setExternal(
        res.results.filter((r) => !ownedKeys.has((r.title + '|' + r.author).toLowerCase())),
      )
    } catch {
      setExternal([])
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), 350)
    return () => clearTimeout(handle)
  }, [query, runSearch])

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <View style={styles.searchBox}>
          <IconButton name={icons.search} size={20} color={colors.textMuted} />
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Search books"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus
          />
        </View>
      </View>

      {loading ? (
        <Loading />
      ) : searched && results.length === 0 && external.length === 0 ? (
        <Centered>
          <AppText variant="meta" color={colors.textMuted}>
            No results
          </AppText>
        </Centered>
      ) : (
        <Animated.View entering={FadeIn.duration(DUR.base)} style={{ flex: 1 }}>
          <FlatList
            data={results}
            keyExtractor={(it) => it.id}
            numColumns={COLS}
            columnWrapperStyle={COLS > 1 ? { gap: GUTTER } : undefined}
            contentContainerStyle={{
              padding: GUTTER,
              paddingBottom: contentInset,
              gap: spacing.xs,
            }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => <BookTile item={item} width={tileWidth} />}
            ListFooterComponent={
              externalOn && external.length > 0 ? (
                <View style={styles.extSection}>
                  <AppText variant="meta" color={colors.textMuted} style={styles.extHead}>
                    Not in your library · {external.length}
                  </AppText>
                  {external.map((b) => (
                    <ExternalRow
                      key={b.asin}
                      book={b}
                      rmabEnabled={rmabEnabled}
                      onPress={() => {
                        setSelected(b)
                        sheetRef.current?.present()
                      }}
                    />
                  ))}
                </View>
              ) : null
            }
          />
        </Animated.View>
      )}

      <NotOwnedSheet
        ref={sheetRef}
        book={selected}
        rmabEnabled={rmabEnabled}
        onDismiss={() => setSelected(null)}
      />

      <AppTabBar activeName={null} onPressTab={goToTab} />
    </Screen>
  )
}

// One Audible search result that isn't in the library. Tapping opens the shared
// request/buy sheet. Request label when the request backend is connected,
// otherwise a "Not in library" tag that still opens the buy-on-Audible path.
function ExternalRow({
  book,
  rmabEnabled,
  onPress,
}: {
  book: HSAudibleSearchResult
  rmabEnabled: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sub = [book.author, book.narrator].filter(Boolean).join(' · ')
  return (
    <Touchable onPress={onPress} style={styles.extRow}>
      <Cover
        uri={book.coverArtUrl}
        size={56}
        radius={radius.tile}
        fallback={{
          hue: coverHue(book.asin),
          initial: (book.title || '?').charAt(0).toUpperCase(),
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label" numberOfLines={1} color={colors.textMuted}>
          {book.title}
        </AppText>
        {sub ? (
          <AppText
            variant="caption"
            color={colors.textFaint}
            numberOfLines={1}
            style={{ marginTop: 2 }}
          >
            {sub}
          </AppText>
        ) : null}
      </View>
      <View style={styles.extTag}>
        <IconButton
          name={rmabEnabled ? icons.bolt : icons.shoppingCart}
          size={15}
          color={colors.accent}
        />
        <AppText variant="caption" color={colors.accent} style={{ fontWeight: '600' }}>
          {rmabEnabled ? 'Request' : 'Not in library'}
        </AppText>
      </View>
    </Touchable>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    extSection: { marginTop: spacing.lg, gap: spacing.xs },
    extHead: { marginBottom: spacing.xs },
    extRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      opacity: 0.85,
    },
    extTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    searchBox: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    input: { flex: 1, paddingVertical: spacing.md, color: colors.text, fontSize: 16 },
  })
