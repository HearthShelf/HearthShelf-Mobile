/** Community: what listeners share by default, which shared features are on, and
 *  the anonymous stats opt-in. */
import { useState } from 'react'
import { View } from 'react-native'
import {
  type HSCommunityConfig,
  type HSCommunityConfigPatch,
  type HSTelemetryStatus,
} from '@hearthshelf/core'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { StatusPill } from '@/admin/StatusPill'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  getCommunityConfig,
  getTelemetry,
  setCommunityConfig,
  setTelemetryEnabled,
} from '@/api/admin/community'
import { confirm } from '@/ui/confirm'
import { AppText } from '@/ui/primitives'
import {
  SettingsGroup,
  SettingsLabel,
  SettingsPanel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'

export default function CommunityScreen() {
  return (
    <AdminGate>
      <Community />
    </AdminGate>
  )
}

function Community() {
  const config = useAdminResource(getCommunityConfig)
  const telemetry = useAdminResource(getTelemetry)

  if (config.error && !config.data) {
    return <AdminUnavailable error={config.error} onRetry={config.reload} />
  }

  return (
    <SettingsPanel>
      {config.data ? (
        <CommunityForm
          key={JSON.stringify(config.data)}
          config={config.data}
          onSaved={config.reload}
        />
      ) : (
        <SkeletonRow />
      )}

      <SettingsLabel>Anonymous usage stats</SettingsLabel>
      {telemetry.data ? (
        <TelemetryForm
          key={String(telemetry.data.enabled)}
          status={telemetry.data}
          onSaved={telemetry.reload}
        />
      ) : telemetry.loading ? (
        <SkeletonRow />
      ) : (
        <SettingsGroup>
          <SettingsRow
            icon="error-outline"
            title="Usage stats unavailable"
            desc="Tap to try again."
            onPress={telemetry.reload}
            last
          />
        </SettingsGroup>
      )}
    </SettingsPanel>
  )
}

function Switch({
  label,
  on,
  canEdit,
  onChange,
}: {
  label: string
  on: boolean
  canEdit: boolean
  onChange: (on: boolean) => void
}) {
  if (!canEdit) return <StatusPill label={on ? 'On' : 'Off'} />
  return <SettingsToggle on={on} onChange={onChange} label={label} />
}

function CommunityForm({ config, onSaved }: { config: HSCommunityConfig; onSaved: () => void }) {
  const { run, busy } = useAdminWrite()
  // Shows a tap straight away. The form remounts from the server's answer after.
  const [shown, setShown] = useState(config)

  async function save(patch: HSCommunityConfigPatch, done: string) {
    if (busy) return
    setShown((cur) => ({ ...cur, ...patch }))
    const ok = await run(() => setCommunityConfig(patch), {
      done,
      failed: "Couldn't save that setting.",
      reload: onSaved,
    })
    if (!ok) setShown(config)
  }

  /** Turning a default on shows people who never chose, so it asks first. */
  async function saveDefault(
    patch: HSCommunityConfigPatch,
    on: boolean,
    ask: { title: string; message: string },
  ) {
    if (on && !(await confirm({ ...ask, confirmLabel: 'Turn on', destructive: false }))) return
    await save(patch, 'Default saved')
  }

  return (
    <>
      <SettingsLabel>Default sharing</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="leaderboard"
          title="Show on the leaderboard"
          desc={
            shown.defaultShare
              ? 'People show up unless they turn sharing off. Anyone who chose to hide stays hidden.'
              : 'People stay hidden unless they turn sharing on. Anyone who chose to share stays shown.'
          }
          control={
            <Switch
              label="Show on the leaderboard"
              on={shown.defaultShare}
              canEdit={config.canEdit}
              onChange={(on) =>
                void saveDefault({ defaultShare: on }, on, {
                  title: 'Show people on the leaderboard?',
                  message:
                    'Everyone who never made a choice will show up on the leaderboard. Anyone who chose to hide stays hidden.',
                })
              }
            />
          }
        />
        <SettingsRow
          icon="podcasts"
          title={'Show as "listening recently"'}
          desc={`This is more private than a reading list, so it starts off. It is ${
            shown.defaultShareListening ? 'on' : 'off'
          } for anyone who hasn't chosen.`}
          control={
            <Switch
              label="Show as listening recently"
              on={shown.defaultShareListening}
              canEdit={config.canEdit}
              onChange={(on) =>
                void saveDefault({ defaultShareListening: on }, on, {
                  title: 'Show what people are listening to?',
                  message:
                    'Everyone who never made a choice will show as listening recently. Anyone who chose to hide stays hidden.',
                })
              }
            />
          }
          last
        />
      </SettingsGroup>

      <SettingsLabel>Features</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="sticky-note-2"
          title="Public notes"
          desc="Notes on a book that every listener here can see."
          control={
            <Switch
              label="Public notes"
              on={shown.notesEnabled}
              canEdit={config.canEdit}
              onChange={(on) =>
                void save({ notesEnabled: on }, `Public notes ${on ? 'on' : 'off'}`)
              }
            />
          }
        />
        <SettingsRow
          icon="groups"
          title="Book Club"
          desc="Reading groups with a chat for each book."
          control={
            <Switch
              label="Book Club"
              on={shown.clubsEnabled}
              canEdit={config.canEdit}
              onChange={(on) => void save({ clubsEnabled: on }, `Book Club ${on ? 'on' : 'off'}`)}
            />
          }
          last
        />
      </SettingsGroup>
    </>
  )
}

function TelemetryForm({ status, onSaved }: { status: HSTelemetryStatus; onSaved: () => void }) {
  const colors = useColors()
  const { run, busy } = useAdminWrite()
  const [enabled, setEnabled] = useState(status.enabled)
  const p = status.payloadPreview

  async function change(on: boolean) {
    if (busy) return
    setEnabled(on)
    const ok = await run(() => setTelemetryEnabled(on), {
      done: on ? 'Thanks. Anonymous stats are on' : 'Anonymous stats are off',
      failed: "Couldn't save that setting.",
      reload: onSaved,
    })
    if (!ok) setEnabled(status.enabled)
  }

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          icon="bar-chart"
          title="Share anonymous stats"
          desc="Helps improve HearthShelf and feeds the public stats page. Off by default."
          control={
            <Switch
              label="Share anonymous stats"
              on={enabled}
              canEdit={status.canEdit}
              onChange={(on) => void change(on)}
            />
          }
          last
        />
      </SettingsGroup>
      <View style={{ gap: spacing.sm }}>
        <AppText variant="label">What we send</AppText>
        <AppText variant="meta" color={colors.textMuted}>
          Rough numbers only. No names, emails, book titles, IP addresses, or anything that says
          which server this is. A random id lets us count installs without knowing whose they are.
          This is exactly what a report would hold right now:
        </AppText>
        <View
          style={{ padding: spacing.md, borderRadius: radius.row, backgroundColor: colors.fill }}
        >
          <AppText variant="mono" color={colors.textMuted}>
            {JSON.stringify(
              {
                anonymous_id: p.telemetry_id,
                hearthshelf_version: p.hs_version,
                audiobookshelf_version: p.abs_version,
                mode: p.mode,
                users: p.user_bucket,
                library_size: p.book_bucket,
                quests_given: p.quests_given,
                quests_accepted: p.quests_accepted,
                books_finished: p.books_finished,
                club_books_finished: p.club_books_finished,
                clubs_active: p.clubs_active,
              },
              null,
              2,
            )}
          </AppText>
        </View>
      </View>
    </>
  )
}
