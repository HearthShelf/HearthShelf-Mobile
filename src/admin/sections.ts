/** Every Server Admin section, shared by the admin home and the settings search. */
import { type IconName } from '@/ui/icons'

export interface AdminSection {
  icon: IconName
  title: string
  href: string
  desc: string
}

export const ADMIN_SECTIONS: { label: string; items: AdminSection[] }[] = [
  {
    label: 'Activity',
    items: [
      {
        icon: 'insights',
        title: 'Stats',
        href: '/settings/admin/stats',
        desc: 'Server and library totals, and activity.',
      },
      {
        icon: 'graphic-eq',
        title: 'Listening sessions',
        href: '/settings/admin/sessions',
        desc: 'What everyone has played.',
      },
      {
        icon: 'schedule',
        title: 'Tasks',
        href: '/settings/admin/tasks',
        desc: 'Run background jobs and read their logs.',
      },
      {
        icon: 'rss-feed',
        title: 'RSS feeds',
        href: '/settings/admin/rss',
        desc: 'See open feeds and close them.',
      },
    ],
  },
  {
    label: 'People',
    items: [
      {
        icon: 'group',
        title: 'Users',
        href: '/settings/admin/users',
        desc: 'Accounts, permissions, and invites.',
      },
      {
        icon: 'smart-toy',
        title: 'Service accounts',
        href: '/settings/admin/service-accounts',
        desc: 'Accounts for other apps.',
      },
      {
        icon: 'key',
        title: 'API keys',
        href: '/settings/admin/apikeys',
        desc: 'Create and revoke keys.',
      },
    ],
  },
  {
    label: 'Library',
    items: [
      {
        icon: 'video-library',
        title: 'Libraries',
        href: '/settings/admin/libraries',
        desc: 'Folders, scans, and settings.',
      },
      {
        icon: 'sell',
        title: 'Tags and genres',
        href: '/settings/admin/metadata',
        desc: 'Rename or remove them everywhere.',
      },
    ],
  },
  {
    label: 'Server',
    items: [
      {
        icon: 'tune',
        title: 'General',
        href: '/settings/admin/general',
        desc: 'Server name, scanner, and date format.',
      },
      {
        icon: 'cloud-sync',
        title: 'Backups',
        href: '/settings/admin/backups',
        desc: 'Run, download, and restore.',
      },
      {
        icon: 'groups',
        title: 'Community',
        href: '/settings/admin/community',
        desc: 'Sharing defaults, notes, and clubs.',
      },
      {
        icon: 'notifications',
        title: 'Notifications',
        href: '/settings/admin/notifications',
        desc: 'What the server alerts on.',
      },
      {
        icon: 'mail',
        title: 'Email',
        href: '/settings/admin/email',
        desc: 'E-reader devices and a test send.',
      },
      {
        icon: 'hub',
        title: 'HearthShelf Connect',
        href: '/settings/admin/connect',
        desc: 'Connection health and invites.',
      },
      {
        icon: 'extension',
        title: 'Integrations',
        href: '/settings/admin/integrations',
        desc: 'Requests and catalog services.',
      },
      {
        icon: 'explore',
        title: 'QuestGiver',
        href: '/settings/admin/questgiver',
        desc: 'Turn recommendations on or off.',
      },
    ],
  },
]
