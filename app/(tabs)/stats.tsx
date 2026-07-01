/**
 * Stats tab. Placeholder shell until the listening-stats read lands (plan
 * sections 6.4/6.5): the /hs/stats endpoint + HSListeningStats type feed the
 * real streak / this-week / most-listened content here. Kept minimal so the
 * 5-tab nav is wired without a broken empty screen.
 */
import { AppText, Centered, Screen } from '@/ui/primitives'
import { colors } from '@/ui/theme'

export default function StatsTab() {
  return (
    <Screen>
      <Centered>
        <AppText variant="hero">Your listening</AppText>
        <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
          Your streak, hours, and most-listened books will appear here.
        </AppText>
      </Centered>
    </Screen>
  )
}
