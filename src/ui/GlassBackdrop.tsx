import { Platform, StyleSheet, View } from 'react-native'
import { BlurView } from 'expo-blur'
import { useActiveBlurTarget } from './BlurTarget'

/** Native backdrop blur shared by floating glass surfaces. The translucent tint
 * remains a readable fallback while Android's blur target is not yet available. */
export function GlassBackdrop({
  tintColor,
  intensity = 70,
}: {
  tintColor: string
  intensity?: number
}) {
  const blurTarget = useActiveBlurTarget()

  return (
    <BlurView
      pointerEvents="none"
      intensity={intensity}
      tint="systemUltraThinMaterialDark"
      blurTarget={blurTarget ?? undefined}
      blurMethod={Platform.OS === 'android' && blurTarget ? 'dimezisBlurView' : undefined}
      style={StyleSheet.absoluteFill}
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
    </BlurView>
  )
}
