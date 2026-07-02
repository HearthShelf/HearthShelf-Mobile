/**
 * Renders note-pop toasts from the global popToast store. Mounted once near the
 * mini-player. Auto-dismisses after a few seconds; tapping deep-links into the
 * club room. Sits above content, non-blocking except for its own pill.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { getPopToast, subscribePopToast, clearPopToast } from './popToastStore'
import { AppText } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const DISMISS_MS = 5200

export function PopToast() {
  const router = useRouter()
  const colors = useColors()
  const styles = makeStyles(colors)
  const pop = useSyncExternalStore(subscribePopToast, getPopToast)
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A new pop (nonce change) shows the toast and restarts the dismiss timer.
  useEffect(() => {
    if (!pop) return
    setVisible(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setVisible(false), DISMISS_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [pop?.nonce, pop])

  if (!pop || !visible) return null

  const open = () => {
    setVisible(false)
    clearPopToast()
    if (pop.clubId) router.push(`/club/${encodeURIComponent(pop.clubId)}`)
  }

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Pressable style={styles.pill} onPress={open}>
        <Icon name={icons.notes} size={18} color={colors.accent} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="label" color={colors.text} numberOfLines={1}>
            {pop.author}
          </AppText>
          <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
            {pop.body}
          </AppText>
        </View>
        <Icon name={icons.chevronRight} size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: spacing.lg,
      right: spacing.lg,
      bottom: 150,
      alignItems: 'center',
      zIndex: 40,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      width: '100%',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.sheet,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
  })
