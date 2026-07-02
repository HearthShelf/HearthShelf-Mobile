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

/** "Safe - show to everyone now (no spoilers)" opt-in, next to Submit. */
export function SafeSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const colors = useColors()
  const styles = makeStyles(colors)
  return (
    <Touchable style={[styles.safe, on && styles.safeOn]} onPress={() => onChange(!on)}>
      <Icon
        name={on ? icons.checkCircle : icons.shield}
        size={16}
        color={on ? colors.accent : colors.textMuted}
      />
      <AppText variant="caption" color={on ? colors.accent : colors.textMuted} style={{ flex: 1 }}>
        Safe - show to everyone now (no spoilers)
      </AppText>
    </Touchable>
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
    safe: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.fill,
    },
    safeOn: { borderColor: colors.accent, backgroundColor: colors.accentWash },
  })
