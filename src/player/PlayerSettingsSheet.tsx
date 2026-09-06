/**
 * Player settings as an in-context bottom sheet, opened from the player's More
 * tray so you can tweak speed / skips / progress bar / artwork without tabbing
 * away to Settings.
 *
 * It renders the SAME rows as the full Player settings screen
 * (app/settings/playback.tsx) - both mount PlayerSettingsContent - so the two
 * surfaces cannot drift apart. Rows that navigate elsewhere (the player-button
 * editor, the queue editor) dismiss the sheet first, so the pushed screen isn't
 * left underneath an open sheet.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { StyleSheet } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { useRouter } from 'expo-router'
import { PlayerSettingsContent } from '@/player/PlayerSettingsContent'
import { Sheet, type SheetRef } from '@/ui/primitives'
import { spacing } from '@/ui/theme'
import type { SheetHandle } from './sheets'

export const PlayerSettingsSheet = forwardRef<SheetHandle>(
  function PlayerSettingsSheet(_props, ref) {
    const styles = useMemo(() => makeStyles(), [])
    const router = useRouter()
    const sheetRef = useRef<SheetRef>(null)

    useImperativeHandle(ref, () => ({
      present: () => sheetRef.current?.present(),
      dismiss: () => sheetRef.current?.dismiss(),
    }))

    return (
      <Sheet ref={sheetRef} title="Player settings" snapPoints={['85%']} stackBehavior="push">
        <BottomSheetScrollView contentContainerStyle={styles.body}>
          <PlayerSettingsContent
            onNavigate={(href) => {
              sheetRef.current?.dismiss()
              router.push(href)
            }}
          />
        </BottomSheetScrollView>
      </Sheet>
    )
  },
)

const makeStyles = () =>
  StyleSheet.create({
    body: { paddingBottom: spacing.xxl, gap: spacing.md },
  })
