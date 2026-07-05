/**
 * Full-screen, pinch-zoomable cover-art lightbox. One implementation shared by
 * the player and the book-details screen so both enlarge artwork the same way:
 * pinch to zoom (1x-4x), pan while zoomed, double-tap to toggle 2x, and tap the
 * scrim (while un-zoomed) or the close button to dismiss. Renders nothing when
 * not visible; the caller owns the `visible` flag.
 */
import { useEffect, useMemo } from 'react'
import {
  BackHandler,
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  FadeIn,
  FadeOut,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { Cover, IconButton, icons } from '@/ui/primitives'
import { useTheme } from '@/ui/ThemeProvider'
import { type Palette } from '@/ui/theme'

export function CoverLightbox({
  visible,
  uri,
  title,
  author,
  hue,
  onClose,
}: {
  visible: boolean
  uri?: string
  title: string
  author?: string
  hue: string
  onClose: () => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()

  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const savedTx = useSharedValue(0)
  const savedTy = useSharedValue(0)

  // Hardware back closes the lightbox instead of leaving the screen. Registered
  // only while visible, so it takes precedence over the host screen's own back
  // handler (later-registered handlers run first).
  useEffect(() => {
    if (Platform.OS !== 'android' || !visible) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => sub.remove()
  }, [visible, onClose])

  // Reset the transform each time it opens, so a prior zoom doesn't linger.
  useEffect(() => {
    if (visible) {
      scale.value = 1
      savedScale.value = 1
      tx.value = 0
      ty.value = 0
      savedTx.value = 0
      savedTy.value = 0
    }
  }, [visible, scale, savedScale, tx, ty, savedTx, savedTy])

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(4, savedScale.value * e.scale))
    })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= 1) {
        scale.value = withTiming(1)
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        savedTx.value = 0
        savedTy.value = 0
      }
    })
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (scale.value <= 1) return
      tx.value = savedTx.value + e.translationX
      ty.value = savedTy.value + e.translationY
    })
    .onEnd(() => {
      savedTx.value = tx.value
      savedTy.value = ty.value
    })
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1 ? 1 : 2
      scale.value = withTiming(next)
      savedScale.value = next
      if (next === 1) {
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        savedTx.value = 0
        savedTy.value = 0
      }
    })
  // Single tap on the scrim closes, but only while un-zoomed (so a tap meant to
  // pan/settle a zoomed image doesn't dismiss).
  const tapClose = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (scale.value <= 1) runOnJS(onClose)()
    })
    .requireExternalGestureToFail(doubleTap)
  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, tapClose))

  const imgStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }))

  if (!visible) return null

  return (
    <Animated.View
      style={styles.lightbox}
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(140)}
    >
      <IconButton
        name={icons.close}
        size={24}
        color="#fff"
        onPress={onClose}
        style={[styles.close, { top: insets.top + 12 }]}
      />
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.imgWrap, { width, height }, imgStyle]}>
          {uri ? (
            // Full uncropped artwork (contain) so nothing is cut off.
            <Image source={{ uri }} style={{ width, height: height * 0.7 }} resizeMode="contain" />
          ) : (
            <Cover
              width={Math.min(320, width * 0.84)}
              aspectRatio={1}
              radius={16}
              fallback={{ hue, initial: title.charAt(0).toUpperCase(), title }}
            />
          )}
        </Animated.View>
      </GestureDetector>
      <View style={styles.meta} pointerEvents="none">
        <Text style={styles.title}>{title}</Text>
        {author ? <Text style={styles.author}>{author}</Text> : null}
      </View>
    </Animated.View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    lightbox: {
      position: 'absolute',
      inset: 0,
      zIndex: 30,
      backgroundColor: 'rgba(8,7,6,0.96)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    imgWrap: { alignItems: 'center', justifyContent: 'center' },
    close: {
      position: 'absolute',
      right: 20,
      zIndex: 2,
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    meta: { position: 'absolute', bottom: 60, alignItems: 'center' },
    title: { color: colors.text, fontSize: 15, fontWeight: '700' },
    author: { color: colors.textMuted, fontSize: 12.5, marginTop: 4 },
  })
