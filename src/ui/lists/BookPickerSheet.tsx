/**
 * Pick books by search, with multi-select and one confirming action.
 *
 * Shared by both entry points: "New collection/playlist" on the browse surface
 * (create mode, which also asks for a name) and "Add books" on a detail screen
 * (add mode). Selection survives changing the query - search "dune", tick two,
 * search something else, and all of them still go in one batch call.
 *
 * Like the rest of the list surfaces this reads everything kind-specific off a
 * descriptor rather than branching on `kind` (see kind.ts).
 */
import { forwardRef, useCallback, useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import {
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetModal,
} from '@gorhom/bottom-sheet'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue, coverInitial } from '@hearthshelf/core'
import { coverUrl, itemAuthor, itemTitle, searchLibrary } from '@/api/abs'
import type { ListKindDescriptor } from '@/ui/lists/kind'
import { AppText, Cover, PrimaryButton, Sheet, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export const BookPickerSheet = forwardRef<
  BottomSheetModal,
  {
    descriptor: ListKindDescriptor
    libraryId: string | null
    mode: 'create' | 'add'
    /** Books already in the list, shown as Added so they can't double-add. */
    existingIds?: string[]
    /** Called with the picked ids (and the typed name, in create mode). */
    onSubmit: (books: string[], name: string) => Promise<void>
    onDismiss?: () => void
  }
>(function BookPickerSheet(
  { descriptor, libraryId, mode, existingIds = [], onSubmit, onDismiss },
  ref,
) {
  const colors = useColors()
  const s = makeStyles(colors)

  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ABSLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Map<string, ABSLibraryItem>>(new Map())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const already = new Set(existingIds)

  const runSearch = useCallback(
    async (q: string) => {
      const term = q.trim()
      if (!term || !libraryId) {
        setResults([])
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        setResults(await searchLibrary(libraryId, term))
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [libraryId],
  )

  // Debounce so typing doesn't fire a search per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 300)
    return () => clearTimeout(t)
  }, [query, runSearch])

  const toggle = (item: ABSLibraryItem) => {
    haptics.select()
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.set(item.id, item)
      return next
    })
  }

  const count = picked.size
  const trimmedName = name.trim()
  const ready = !busy && count > 0 && (mode === 'add' || trimmedName.length > 0)

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit([...picked.keys()], trimmedName)
      haptics.success()
      // Reset so reopening the sheet starts clean.
      setPicked(new Map())
      setName('')
      setQuery('')
      setResults([])
    } catch {
      setFailed(true)
      haptics.warn()
    } finally {
      setBusy(false)
    }
  }

  const noun = descriptor.label.toLowerCase()
  const confirmLabel =
    mode === 'create'
      ? `Create ${noun}`
      : count > 0
        ? `Add ${count} ${count === 1 ? 'book' : 'books'}`
        : 'Add books'

  return (
    <Sheet
      ref={ref}
      kicker={descriptor.label}
      title={mode === 'create' ? `New ${noun}` : 'Add books'}
      snapPoints={['85%']}
      stackBehavior="push"
      onDismiss={onDismiss}
    >
      {mode === 'create' ? (
        <View style={s.nameWrap}>
          <BottomSheetTextInput
            value={name}
            onChangeText={setName}
            placeholder={`${descriptor.label} name`}
            placeholderTextColor={colors.textFaint}
            style={s.nameInput}
            autoCorrect={false}
          />
          {/* ABS will not create a collection with no books, so say so up front
              rather than letting the create fail server-side. */}
          <AppText variant="meta" color={colors.textMuted}>
            Pick at least one book to start this {noun} off.
          </AppText>
        </View>
      ) : null}

      <View style={s.search}>
        <Icon name={icons.search} size={18} color={colors.textMuted} />
        <BottomSheetTextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search your library"
          placeholderTextColor={colors.textFaint}
          style={s.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      {failed ? (
        <AppText variant="meta" color={colors.destructive} style={s.error}>
          That didn't go through. Try again.
        </AppText>
      ) : null}

      <BottomSheetFlatList
        data={results}
        keyExtractor={(it) => it.id}
        contentContainerStyle={s.listPad}
        ListEmptyComponent={
          <AppText variant="meta" color={colors.textMuted} style={s.empty}>
            {loading ? 'Searching...' : query.trim() ? 'No matches' : 'Search to add books'}
          </AppText>
        }
        renderItem={({ item }) => {
          const inList = already.has(item.id)
          const on = picked.has(item.id)
          const title = itemTitle(item)
          return (
            <Touchable
              style={s.row}
              disabled={inList || busy}
              onPress={() => toggle(item)}
              accessibilityRole="button"
              accessibilityState={{ checked: on, disabled: inList }}
              accessibilityLabel={title}
            >
              <Cover
                uri={coverUrl(item.id)}
                width={38}
                aspectRatio={2 / 3}
                itemId={item.id}
                fallback={{ hue: coverHue(title), initial: coverInitial(title) }}
              />
              <View style={s.rowText}>
                <AppText numberOfLines={1}>{title}</AppText>
                <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
                  {itemAuthor(item)}
                </AppText>
              </View>
              {inList ? (
                <AppText variant="meta" color={colors.textFaint}>
                  Added
                </AppText>
              ) : (
                <Icon
                  name={on ? 'check-circle' : 'add-circle-outline'}
                  size={22}
                  color={on ? colors.accent : colors.textMuted}
                />
              )}
            </Touchable>
          )
        }}
      />

      <View style={s.foot}>
        <AppText variant="meta" color={colors.textMuted}>
          {count} selected
        </AppText>
        <PrimaryButton
          label={confirmLabel}
          icon={mode === 'create' ? 'add' : 'library-add'}
          onPress={ready ? () => void submit() : undefined}
          style={!ready ? s.disabled : undefined}
        />
      </View>
    </Sheet>
  )
})

function makeStyles(c: Palette) {
  return StyleSheet.create({
    nameWrap: { gap: spacing.xs, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    nameInput: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      fontSize: 17,
    },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      paddingHorizontal: spacing.md,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: c.border,
    },
    searchInput: { flex: 1, paddingVertical: spacing.md, color: c.text, fontSize: 16 },
    error: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    listPad: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
    empty: { textAlign: 'center', paddingVertical: spacing.xl },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowText: { flex: 1, gap: 1 },
    foot: {
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    disabled: { opacity: 0.45 },
  })
}
