/**
 * "When did you finish this?" prompt. Marking a book finished opens this bottom
 * sheet with Month + Year selectors and a "Now" button, so a book you actually
 * finished a while ago can be backdated and land in the right bucket for
 * year/listening stats instead of piling onto today.
 *
 * Promise-based, like `confirm`: call `finishDatePrompt({ count })` and await
 * the choice. A single <FinishDateHost> is mounted once at the root layout (same
 * pattern as ToastHost) and driven through a tiny external store, so any screen,
 * sheet, or non-React store can raise it.
 *
 * Resolves { finishedAt: number } for a picked month (epoch ms, 1st of month,
 * local, clamped to now), { finishedAt: null } for "Now" (let the server stamp
 * the time), or null if dismissed.
 */
import { useMemo, useRef, useState, useSyncExternalStore, useEffect } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { AppText, Chip, PrimaryButton, Sheet, Touchable, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'

export type FinishChoice = { finishedAt: number | null } | null

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// --- singleton store: one prompt at a time, resolved via a stashed callback ---
interface PromptRequest {
  count: number
  resolve: (choice: FinishChoice) => void
}
let current: PromptRequest | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
function getSnapshot(): PromptRequest | null {
  return current
}

/**
 * Ask the user when they finished, then resolve with the choice. `count` (for
 * bulk marks) tunes the copy. Resolves null if dismissed. If a prompt is somehow
 * already open, the new request supersedes it (the old one resolves null).
 */
export function finishDatePrompt(opts?: { count?: number }): Promise<FinishChoice> {
  if (current) current.resolve(null)
  return new Promise<FinishChoice>((resolve) => {
    current = { count: opts?.count ?? 1, resolve }
    emit()
  })
}

function settle(choice: FinishChoice): void {
  const req = current
  current = null
  emit()
  req?.resolve(choice)
}

/** Mounted once at the root layout. Renders the sheet whenever a prompt is open. */
export function FinishDateHost() {
  const req = useSyncExternalStore(subscribe, getSnapshot)
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)

  const now = new Date()
  const [month, setMonth] = useState(now.getMonth())
  const [year, setYear] = useState(now.getFullYear())

  // Present when a request arrives; reset selectors to the current month/year.
  useEffect(() => {
    if (req) {
      setMonth(now.getMonth())
      setYear(now.getFullYear())
      sheetRef.current?.present()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  const years: number[] = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 15; y--) years.push(y)

  const many = (req?.count ?? 1) > 1
  const title = many
    ? `When did you finish these ${req?.count} books?`
    : 'When did you finish this?'

  const pickNow = () => {
    haptics.success()
    sheetRef.current?.dismiss()
    settle({ finishedAt: null })
  }
  const confirmPicked = () => {
    haptics.success()
    // Start of the chosen month, local. Clamp to now so a current-month pick
    // never stamps a future instant.
    const picked = new Date(year, month, 1, 12, 0, 0, 0).getTime()
    sheetRef.current?.dismiss()
    settle({ finishedAt: Math.min(picked, Date.now()) })
  }
  // A swipe-to-dismiss (no button) resolves null so the caller bails.
  const onDismiss = () => {
    if (current) settle(null)
  }

  return (
    <Sheet ref={sheetRef} title={title} onDismiss={onDismiss}>
      <AppText variant="meta" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
        Backdating keeps your listening stats accurate. Pick the month you finished, or tap Now.
      </AppText>

      <AppText variant="caption" color={colors.textMuted} style={styles.groupLabel}>
        MONTH
      </AppText>
      <View style={styles.chipWrap}>
        {MONTHS.map((m, i) => (
          <Chip key={m} label={m} active={i === month} onPress={() => setMonth(i)} />
        ))}
      </View>

      <AppText variant="caption" color={colors.textMuted} style={styles.groupLabel}>
        YEAR
      </AppText>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.yearRow}
      >
        {years.map((y) => (
          <Chip key={y} label={String(y)} active={y === year} onPress={() => setYear(y)} />
        ))}
      </ScrollView>

      <View style={styles.actions}>
        <Touchable style={styles.nowBtn} onPress={pickNow}>
          <Icon name={icons.schedule} size={18} color={colors.text} />
          <AppText variant="label">Now</AppText>
        </Touchable>
        <PrimaryButton
          label="Done"
          icon={icons.check}
          onPress={confirmPicked}
          style={{ flex: 1 }}
        />
      </View>
    </Sheet>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    groupLabel: { marginTop: spacing.sm, marginBottom: spacing.xs, letterSpacing: 1 },
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    yearRow: { gap: spacing.sm, paddingRight: spacing.lg },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.lg,
    },
    nowBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
  })
