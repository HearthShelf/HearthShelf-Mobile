/**
 * Server Admin home: what this server is, then every section. This is the one
 * door to server management, so the everyday settings menu stays short.
 *
 * Sections kept on the web open the web panel, so nothing goes missing.
 */
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { ActivityHomeTiles } from '@/admin/ActivityHomeTiles'
import { AdminGate } from '@/admin/AdminGate'
import { ADMIN_SECTIONS } from '@/admin/sections'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { getServerRuntime } from '@/api/admin/server'
import { useConnection } from '@/api/ConnectionProvider'
import { WEBAPP_URL } from '@/lib/config'
import { type IconName } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

const WEB_SECTIONS: { icon: IconName; title: string; desc: string; path: string }[] = [
  { icon: 'lock', title: 'Authentication', desc: 'Sign-in methods.', path: 'auth' },
  {
    icon: 'troubleshoot',
    title: 'Queue Debugger',
    desc: "Why a user's queue looks the way it does.",
    path: 'queue-debug',
  },
  {
    icon: 'account-tree',
    title: 'Series Debugger',
    desc: 'Why a series is matched the way it is.',
    path: 'series-debug',
  },
]

export default function AdminScreen() {
  return (
    <AdminGate fresh>
      <AdminHome />
    </AdminGate>
  )
}

function AdminHome() {
  const router = useRouter()
  const { serverName } = useConnection()
  const colors = useColors()
  const runtime = useAdminResource(getServerRuntime)
  const info = runtime.data

  if (runtime.error && !info) {
    return <AdminUnavailable error={runtime.error} onRetry={runtime.reload} />
  }

  return (
    <SettingsPanel>
      <SettingsLabel>This server</SettingsLabel>
      {runtime.loading ? (
        <SkeletonRow />
      ) : (
        <SettingsGroup>
          <SettingsRow
            icon="dns"
            title={info?.serverName ?? serverName ?? 'Your server'}
            desc="You're an admin here."
          />
          <SettingsRow
            icon="info"
            title="Versions"
            desc={`HearthShelf ${info?.hsVersion ?? 'unknown'} · Audiobookshelf ${
              info?.absVersion ?? 'unknown'
            }`}
            last
          />
        </SettingsGroup>
      )}

      <SettingsLabel>Right now</SettingsLabel>
      <ActivityHomeTiles />

      {ADMIN_SECTIONS.map((section) => (
        <View key={section.label}>
          <SettingsLabel>{section.label}</SettingsLabel>
          <SettingsGroup>
            {section.items.map((item, i) => (
              <SettingsRow
                key={item.title}
                icon={item.icon}
                title={item.title}
                desc={item.desc}
                onPress={() => router.push(item.href)}
                last={i === section.items.length - 1}
              />
            ))}
          </SettingsGroup>
        </View>
      ))}

      <View>
        <SettingsLabel>On the web</SettingsLabel>
        <SettingsGroup>
          {WEB_SECTIONS.map((item, i) => (
            <SettingsRow
              key={item.path}
              icon={item.icon}
              title={item.title}
              desc={item.desc}
              onPress={() => void WebBrowser.openBrowserAsync(`${WEBAPP_URL}/config/${item.path}`)}
              last={i === WEB_SECTIONS.length - 1}
            />
          ))}
        </SettingsGroup>
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.xs, marginTop: spacing.xs }}
        >
          These are safer on a bigger screen. They open on the server selected on the web.
        </AppText>
      </View>
    </SettingsPanel>
  )
}
