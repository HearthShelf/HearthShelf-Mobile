/**
 * The full emoji picker for reacting to a comment.
 *
 * A bundled, categorized grid rather than an off-the-shelf picker dependency:
 * the set below is small enough to read at a glance, renders identically on iOS
 * and Android, and needs no native module - so this ships as a JS-only change
 * with no rebuild.
 *
 * Reactions are stored as the emoji itself (see core lib/noteReactions.ts), so
 * anything picked here works on every client with no icon table to update.
 */
import { useMemo, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { AppText, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** Emoji offered in the picker, grouped the way a reader thinks about them
 *  rather than by Unicode block. Keywords drive the search box; they are the
 *  words someone would actually type looking for that emoji. */
const GROUPS: Array<{ title: string; emoji: Array<[string, string]> }> = [
  {
    title: 'Reactions',
    emoji: [
      ['\u{1F44D}', 'thumbs up like yes'],
      ['\u{1F44E}', 'thumbs down dislike no'],
      ['\u{2764}\u{FE0F}', 'heart love red'],
      ['\u{1F525}', 'fire hot lit'],
      ['\u{1F44F}', 'clap applause bravo'],
      ['\u{1F64C}', 'raised hands praise celebrate'],
      ['\u{1F4AF}', 'hundred perfect score'],
      ['\u{2728}', 'sparkles shiny nice'],
      ['\u{1F389}', 'party tada celebrate'],
      ['\u{1F440}', 'eyes looking watching'],
      ['\u{1F91D}', 'handshake agree deal'],
      ['\u{270A}', 'fist solidarity'],
    ],
  },
  {
    title: 'Faces',
    emoji: [
      ['\u{1F602}', 'laugh joy crying laughing'],
      ['\u{1F923}', 'rofl rolling laughing'],
      ['\u{1F60D}', 'heart eyes love adore'],
      ['\u{1F60E}', 'cool sunglasses'],
      ['\u{1F914}', 'thinking hmm curious'],
      ['\u{1F62E}', 'surprised wow open mouth'],
      ['\u{1F631}', 'scream shocked fear'],
      ['\u{1F622}', 'cry sad tear'],
      ['\u{1F62D}', 'sobbing bawling sad'],
      ['\u{1F621}', 'angry mad rage'],
      ['\u{1F644}', 'eye roll whatever'],
      ['\u{1F910}', 'zipper mouth no spoilers secret'],
      ['\u{1F92F}', 'mind blown exploding head'],
      ['\u{1F971}', 'yawn bored tired sleepy'],
      ['\u{1F60F}', 'smirk knowing'],
      ['\u{1F495}', 'hearts love'],
    ],
  },
  {
    title: 'Books and story',
    emoji: [
      ['\u{1F4D6}', 'book open reading'],
      ['\u{1F4DA}', 'books library series'],
      ['\u{1F516}', 'bookmark save'],
      ['\u{1F3A7}', 'headphones audiobook listening'],
      ['\u{1F5E3}\u{FE0F}', 'narrator voice speaking'],
      ['\u{1F4DD}', 'note writing memo'],
      ['\u{1F52E}', 'crystal ball prediction theory'],
      ['\u{1F5DD}\u{FE0F}', 'key clue answer'],
      ['\u{1F480}', 'skull death died dead'],
      ['\u{1F494}', 'broken heart heartbreak sad'],
      ['\u{1F91B}', 'punch fight action'],
      ['\u{1F3C6}', 'trophy win victory'],
    ],
  },
  {
    title: 'Everything else',
    emoji: [
      ['\u{1F4A9}', 'poop crap bad'],
      ['\u{1F346}', 'eggplant aubergine'],
      ['\u{1F351}', 'peach butt'],
      ['\u{1F355}', 'pizza food'],
      ['\u{2615}', 'coffee tea drink'],
      ['\u{1F37F}', 'popcorn drama watching'],
      ['\u{1F308}', 'rainbow pride'],
      ['\u{1F30D}', 'earth world globe'],
      ['\u{1F3B5}', 'music note song'],
      ['\u{1F680}', 'rocket fast launch'],
      ['\u{1F41B}', 'bug glitch problem'],
      ['\u{1F42C}', 'dolphin so long thanks'],
    ],
  },
]

/**
 * The emoji picker, presented over the comment actions sheet.
 *
 * `onPick` fires with the chosen emoji and the sheet closes itself, so callers
 * only handle the reaction, never the dismissal.
 */
export function EmojiPickerSheet({
  sheetRef,
  onPick,
}: {
  sheetRef: React.RefObject<SheetRef | null>
  onPick: (emoji: string) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GROUPS
    // Match the glyph itself too, so pasting an emoji finds it.
    return GROUPS.map((g) => ({
      title: g.title,
      emoji: g.emoji.filter(([glyph, words]) => words.includes(q) || glyph === q),
    })).filter((g) => g.emoji.length > 0)
  }, [query])

  const pick = (emoji: string) => {
    setQuery('')
    sheetRef.current?.dismiss()
    onPick(emoji)
  }

  return (
    <Sheet
      ref={sheetRef}
      title="Pick a reaction"
      snapPoints={['70%']}
      stackBehavior="push"
      onDismiss={() => setQuery('')}
    >
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search reactions"
        placeholderTextColor={colors.textFaint}
        style={styles.search}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <BottomSheetScrollView keyboardShouldPersistTaps="handled">
        {groups.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={styles.empty}>
            Nothing matches that search.
          </AppText>
        ) : null}
        {groups.map((group) => (
          <View key={group.title} style={styles.group}>
            <AppText variant="caption" color={colors.textMuted}>
              {group.title.toUpperCase()}
            </AppText>
            <View style={styles.grid}>
              {group.emoji.map(([glyph, words]) => (
                <Touchable
                  key={glyph}
                  style={styles.cell}
                  onPress={() => pick(glyph)}
                  accessibilityRole="button"
                  accessibilityLabel={words.split(' ')[0]}
                >
                  <AppText variant="title">{glyph}</AppText>
                </Touchable>
              ))}
            </View>
          </View>
        ))}
      </BottomSheetScrollView>
    </Sheet>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    search: {
      backgroundColor: colors.fill,
      borderRadius: radius.row,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      marginBottom: spacing.sm,
    },
    empty: { padding: spacing.md },
    group: { marginBottom: spacing.md, gap: spacing.xs },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    cell: {
      width: 46,
      height: 46,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.row,
      backgroundColor: colors.fill,
    },
  })

function useStyles() {
  const colors = useColors()
  return useMemo(() => makeStyles(colors), [colors])
}
