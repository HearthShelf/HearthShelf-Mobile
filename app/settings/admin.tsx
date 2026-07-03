/**
 * Server Admin - the single door to server management, shown on the More menu
 * only to users whose role on the connected server is 'admin' (see
 * ConnectionProvider.activeRole). This is the deliberate "make a mess here"
 * surface: as admin tooling grows it all hangs off this screen, keeping the
 * everyday settings menu short for normal users.
 *
 * For now the sections are honest stubs - the entry point and IA exist, the
 * panels behind them don't yet. Each `disabled` row shows a "Soon" chip instead
 * of pushing, so we can ship the structure without pretending it works. Header
 * comes from settings/_layout.
 */
import { useConnection } from '@/api/ConnectionProvider'
import { AppText } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { type IconName } from '@/ui/icons'
import { SettingsPanel, SettingsGroup, SettingsLabel, SettingsRow } from '@/ui/settingsControls'
import { View } from 'react-native'

interface AdminItem {
  icon: IconName
  title: string
  desc: string
}

const SECTIONS: { label: string; items: AdminItem[] }[] = [
  {
    label: 'Server',
    items: [
      { icon: 'group', title: 'Users', desc: 'Accounts, roles, and invites.' },
      { icon: 'auto-stories', title: 'Libraries', desc: 'Folders, scans, and metadata.' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { icon: 'sync', title: 'Scans & tasks', desc: 'Trigger and watch background jobs.' },
      { icon: 'insights', title: 'Server stats', desc: 'Sessions, storage, and health.' },
    ],
  },
]

export default function AdminScreen() {
  const { serverName } = useConnection()
  const colors = useColors()

  return (
    <SettingsPanel>
      <AppText variant="caption" color={colors.textMuted} style={{ paddingHorizontal: spacing.xs }}>
        {serverName ? `Managing ${serverName}.` : 'Manage the connected server.'} You see this
        because you're an admin here.
      </AppText>

      {SECTIONS.map((section) => (
        <View key={section.label}>
          <SettingsLabel>{section.label}</SettingsLabel>
          <SettingsGroup>
            {section.items.map((item, i) => (
              <SettingsRow
                key={item.title}
                icon={item.icon}
                title={item.title}
                desc={item.desc}
                control={<SoonChip />}
                last={i === section.items.length - 1}
              />
            ))}
          </SettingsGroup>
        </View>
      ))}
    </SettingsPanel>
  )
}

function SoonChip() {
  const colors = useColors()
  return (
    <View
      style={{
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: colors.fill,
      }}
    >
      <AppText variant="caption" color={colors.textMuted}>
        Soon
      </AppText>
    </View>
  )
}
