/**
 * Shared composer affordances for note visibility + the spoiler-safe flag, used
 * by the public NotesSheet, the player's Notes/Club sheet, and the club room.
 *
 *  - VisibilityToggle: a 2-way Public / Personal segmented control. Only shown on
 *    GENERAL (non-club) top-level composers; club posts are always club-scoped and
 *    replies inherit their parent's visibility, so neither offers this.
 *  - SafeSwitch: an opt-in "show to everyone now (no spoilers)" toggle sitting by
 *    Submit. Offered on every TOP-LEVEL composer (general and club), never on a
 *    reply composer (a reply can't be safe - it gates at its parent's time).
 *
 * Both are read-side-agnostic: they only surface the author's intent. The server
 * enforces the rules; older servers ignore the extra fields (graceful degrade).
 */
import { StyleSheet, View } from 'react-native'
import type { NoteDefaultVisibility } from '@/store/settings'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** Public / Personal segmented toggle for a general note composer. */
export function VisibilityToggle({
  value,
  onChange,
}: {
  value: NoteDefaultVisibility
  onChange: (v: NoteDefaultVisibility) => void
}) {
  const colors = useColors()
  const styles = makeStyles(colors)
  const opts = [
    { value: 'public', label: 'Public', icon: icons.visible },
    { value: 'personal', label: 'Only me', icon: icons.lock },
  ] as const
  return (
    <View style={styles.seg}>
      {opts.map((o) => {
        const on = o.value === value
        return (
          <Touchable
            key={o.value}
            style={[styles.segItem, on && styles.segItemOn]}
            onPress={() => onChange(o.value)}
          >
            <Icon name={o.icon} size={15} color={on ? colors.onAccent : colors.textMuted} />
            <AppText variant="caption" color={on ? colors.onAccent : colors.textMuted}>
              {o.label}
            </AppText>
          </Touchable>
        )
      })}
    </View>
  )
}

/**
 * Who can see this note before they reach your spot in the book.
 *
 * This was one "Safe" pill, which read as pressed whether or not it was on: a
 * lone highlighted control shows its LABEL, not its state, so there was nothing
 * to compare it against. It is now the same 2-way segmented control as
 * VisibilityToggle above it, where the selected half is obvious because the
 * unselected half is sitting next to it.
 *
 * The labels name the outcome for the reader rather than the flag ("Safe"):
 * Hidden keeps the note gated until someone listens past this point, Visible
 * shows it to the whole club right away.
 */
export function SafeSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const colors = useColors()
  const styles = makeStyles(colors)
  const opts = [
    { value: false, label: 'Hidden', icon: icons.lock },
    { value: true, label: 'Visible', icon: icons.visible },
  ] as const
  return (
    <View style={styles.safeRow}>
      <AppText variant="caption" color={colors.textMuted}>
        Until they reach this point
      </AppText>
      <View style={styles.seg}>
        {opts.map((o) => {
          const active = o.value === on
          return (
            <Touchable
              key={String(o.value)}
              style={[styles.segItem, active && styles.segItemOn]}
              onPress={() => onChange(o.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={
                o.value
                  ? 'Visible to everyone now'
                  : 'Hidden until they reach this point in the book'
              }
            >
              <Icon name={o.icon} size={14} color={active ? colors.onAccent : colors.textMuted} />
              <AppText variant="caption" color={active ? colors.onAccent : colors.textMuted}>
                {o.label}
              </AppText>
            </Touchable>
          )
        })}
      </View>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    seg: {
      flexDirection: 'row',
      gap: 4,
      backgroundColor: colors.fill,
      borderRadius: radius.pill,
      padding: 4,
      alignSelf: 'flex-start',
    },
    segItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.xs + 2,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
    },
    segItemOn: { backgroundColor: colors.accent },
    safeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
  })
