/**
 * Reading panel. No ebook reader on mobile yet - this shows the reader prefs a
 * mobile reader will expose (matching the self-hosted app), as an honest
 * "coming soon" list rather than omitting the surface.
 */
import { View } from 'react-native'
import { AppText } from '@/ui/primitives'
import { spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { SettingsPanel, SettingsGroup, SettingsRow } from '@/ui/settingsControls'

const ROWS = [
  { label: 'Reader theme', desc: 'Dark, sepia, or light page colors.' },
  { label: 'Typeface', desc: 'Serif, sans, or a dyslexia-friendly face.' },
  { label: 'Text size', desc: 'How large the body text is set.' },
  { label: 'Line spacing', desc: 'Breathing room between lines.' },
  { label: 'Page width', desc: 'How wide the column of text runs.' },
  { label: 'Justify text', desc: 'Align both edges, like a printed book.' },
]

export default function ReadingPanel() {
  const colors = useColors()
  return (
    <SettingsPanel>
      <AppText variant="caption" color={colors.textMuted} style={{ paddingHorizontal: spacing.xs }}>
        HearthShelf Mobile doesn't have an ebook reader yet. When it does, these will match the
        self-hosted app's reader settings.
      </AppText>
      <View style={{ opacity: 0.5 }}>
        <SettingsGroup>
          {ROWS.map((r, i) => (
            <SettingsRow key={r.label} title={r.label} desc={r.desc} last={i === ROWS.length - 1} />
          ))}
        </SettingsGroup>
      </View>
    </SettingsPanel>
  )
}
