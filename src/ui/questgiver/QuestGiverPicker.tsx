/**
 * Book selector for the "match against a list I pick" basis.
 *
 * Deliberately plain. The web picker animates covers flying between the grid and
 * a selected list (FLIP, measured DOM rects); there is no direct RN equivalent
 * and it is decoration. Selection state reads off the tile itself instead.
 */
import { memo, useMemo, useState } from 'react'
import { FlatList, StyleSheet, TextInput, View } from 'react-native'
import { coverHue, coverInitial, type QgBook } from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, Touchable } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const TILE_W = 92

export const QuestGiverPicker = memo(function QuestGiverPicker({
  books,
  picked,
  onToggle,
}: {
  books: QgBook[]
  picked: Set<string>
  onToggle: (id: string) => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const [q, setQ] = useState('')

  // Finished books first - they are what a listener is most likely to reach for
  // when describing a vibe - then the rest, filtered by the search box.
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = needle
      ? books.filter(
          (b) => b.title.toLowerCase().includes(needle) || b.author.toLowerCase().includes(needle),
        )
      : books
    return [...match]
      .sort((a, b) => Number(b.finished) - Number(a.finished) || a.title.localeCompare(b.title))
      .slice(0, 120)
  }, [books, q])

  return (
    <View style={s.wrap}>
      <View style={s.searchRow}>
        <Icon name="search" size={18} color={colors.textFaint} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search your library"
          placeholderTextColor={colors.textFaint}
          style={s.search}
          autoCorrect={false}
        />
      </View>
      <AppText variant="caption" color={colors.textFaint}>
        {picked.size === 0 ? 'Pick at least one book to match against.' : `${picked.size} selected`}
      </AppText>
      <FlatList
        data={shown}
        keyExtractor={(b) => b.id}
        numColumns={3}
        columnWrapperStyle={s.col}
        contentContainerStyle={s.grid}
        scrollEnabled={false}
        renderItem={({ item }) => {
          const on = picked.has(item.id)
          return (
            <Touchable
              onPress={() => onToggle(item.id)}
              style={s.tile}
              accessibilityRole="checkbox"
              accessibilityLabel={item.title}
            >
              <View>
                <Cover
                  uri={coverUrl(item.id)}
                  width={TILE_W}
                  aspectRatio={1}
                  fallback={{
                    hue: coverHue(item.id),
                    initial: coverInitial(item.title),
                    title: item.title,
                  }}
                  style={on ? s.coverOn : undefined}
                />
                {on ? (
                  <View style={[s.check, { backgroundColor: colors.accent }]}>
                    <Icon name="check" size={13} color={colors.onAccent} />
                  </View>
                ) : null}
              </View>
              <AppText
                variant="caption"
                numberOfLines={2}
                color={on ? colors.accent : colors.textMuted}
              >
                {item.title}
              </AppText>
            </Touchable>
          )
        }}
        ListEmptyComponent={
          <AppText variant="meta" color={colors.textFaint}>
            Nothing matches that search.
          </AppText>
        }
      />
    </View>
  )
})

function makeStyles(c: Palette) {
  return StyleSheet.create({
    wrap: { gap: spacing.sm },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.base,
    },
    search: { flex: 1, paddingVertical: spacing.sm + 2, color: c.text },
    grid: { gap: spacing.md },
    col: { gap: spacing.md, justifyContent: 'flex-start' },
    tile: { width: TILE_W, gap: spacing.xs },
    coverOn: { opacity: 0.75 },
    check: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
  })
}
