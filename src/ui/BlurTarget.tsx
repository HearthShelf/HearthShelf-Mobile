import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { StyleSheet, View } from 'react-native'
import { useFocusEffect } from 'expo-router'

export type AppBlurTargetRef = RefObject<View | null>

type BlurTargetContextValue = {
  activeTarget: AppBlurTargetRef | null
  setActiveTarget: React.Dispatch<React.SetStateAction<AppBlurTargetRef | null>>
}

const BlurTargetContext = createContext<BlurTargetContextValue | null>(null)

/** Owns the active screen target without putting the floating BlurView inside it. */
export function AppBlurTargetProvider({ children }: { children: React.ReactNode }) {
  const [activeTarget, setActiveTarget] = useState<AppBlurTargetRef | null>(null)
  const value = useMemo(() => ({ activeTarget, setActiveTarget }), [activeTarget])
  return (
    <BlurTargetContext.Provider value={value}>
      <View style={styles.root}>{children}</View>
    </BlurTargetContext.Provider>
  )
}

/** Ref for a focused screen's BlurTargetView. Focus registration matters because
 * tab screens remain mounted while only one of them is visible. */
export function useScreenBlurTarget(): AppBlurTargetRef {
  const targetRef = useRef<View>(null)
  const setActiveTarget = useContext(BlurTargetContext)?.setActiveTarget

  useFocusEffect(
    useCallback(() => {
      if (!setActiveTarget) return undefined
      setActiveTarget(targetRef)
      return () => setActiveTarget((current) => (current === targetRef ? null : current))
    }, [setActiveTarget]),
  )

  return targetRef
}

export function useActiveBlurTarget(): AppBlurTargetRef | null {
  return useContext(BlurTargetContext)?.activeTarget ?? null
}

const styles = StyleSheet.create({ root: { flex: 1 } })
