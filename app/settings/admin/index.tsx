/**
 * Server Admin home: what this server is, then every section. This is the one
 * door to server management, so the everyday settings menu stays short.
 *
 * `href`-less sections are not built yet and show a "Soon" pill instead of
 * pushing. Sections kept on the web open the web panel, so nothing goes missing.
 */
import { View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { StatusPill } from '@/admin/StatusPill'
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

interface AdminSection {
  icon: IconName
  title: string
  desc: string
}

const SECTIONS: { label: string; items: AdminSection[] }[] = [
  {
    label: 'Activity',
    items: [
      { icon: 'insights', title: 'Stats', desc: 'Server and library totals, and activity.' },
      { icon: 'graphic-eq', title: 'Listening sessions', desc: 'What everyone has played.' },
      { icon: 'schedule', title: 'Tasks', desc: 'Run background jobs and read their logs.' },
      { icon: 'rss-feed', title: 'RSS feeds', desc: 'See open feeds and close them.' },
    ],
  },
  {
    label: 'People',
    items: [
      { icon: 'group', title: 'Users', desc: 'Accounts, permissions, and invites.' },
      { icon: 'smart-toy', title: 'Service accounts', desc: 'Accounts for other apps.' },
      { icon: 'key', title: 'API keys', desc: 'Create and revoke keys.' },
    ],
  },
  {
    label: 'Library',
    items: [
      { icon: 'video-library', title: 'Libraries', desc: 'Folders, scans, and settings.' },
      { icon: 'sell', title: 'Tags and genres', desc: 'Rename or remove them everywhere.' },
    ],
  },
  {
    label: 'Server',
    items: [
      { icon: 'tune', title: 'General', desc: 'Server name, scanner, and date format.' },
      { icon: 'cloud-sync', title: 'Backups', desc: 'Run, download, and restore.' },
      { icon: 'groups', title: 'Community', desc: 'Sharing defaults, notes, and clubs.' },
      { icon: 'notifications', title: 'Notifications', desc: 'What the server alerts on.' },
      { icon: 'mail', title: 'Email', desc: 'E-reader devices and a test send.' },
      { icon: 'hub', title: 'HearthShelf Connect', desc: 'Connection health and invites.' },
      { icon: 'extension', title: 'Integrations', desc: 'Requests and catalog services.' },
      { icon: 'explore', title: 'QuestGiver', desc: 'Turn recommendations on or off.' },
    ],
  },
]

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
                control={<StatusPill label="Soon" />}
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
