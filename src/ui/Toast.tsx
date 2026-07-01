/**
 * Small bottom-anchored confirmation toast, auto-dismissing after ~1.9s. Ported
 * from the DS's toast pattern (bookmark saved, added to list, jumped to a
 * session). A screen owns its own toast state via useToast() and renders one
 * <Toast> absolutely positioned over its content.
 */
import { useCallback, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Icon, icons } from './icons'
import { colors, radius, spacing } from './theme'

const DISMISS_MS = 1900

export function useToast() {
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(msg)
    timer.current = setTimeout(() => setMessage(null), DISMISS_MS)
  }, [])

  return { message, show }
}

export function Toast({ message, bottom = 118 }: { message: string | null; bottom?: number }) {
  if (!message) return null
  return (
    <View style={[styles.wrap, { bottom }]} pointerEvents="none">
      <View style={styles.pill}>
        <Icon name={icons.checkCircle} size={18} color={colors.accent} />
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 32,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(20,17,15,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  text: { color: colors.text, fontSize: 13, fontWeight: '600' },
})
