/**
 * HearthShelf Connect: is this server healthy, and can people reach it. Pairing,
 * disconnecting, and credential resets stay on the web, because they can cut off
 * the connection this phone is using.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import {
  HostedError,
  isHostedOutage,
  serviceHealthView,
  type HSHostedPortCheckResult,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { StatusPill, type StatusTone } from '@/admin/StatusPill'
import { useAdminResource } from '@/admin/useAdminResource'
import { checkPort, getSecureAddress, getServiceHealth } from '@/api/admin/connect'
import { getHostedStatus } from '@/api/admin/hosted'
import { useConnection } from '@/api/ConnectionProvider'
import { WEBAPP_URL } from '@/lib/config'
import { AppText } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

const AUTO_CHECK_ATTEMPTS = 3
const AUTO_RETRY_MS = 15000
const ADDRESS_POLL_MS = 4000

/** `outage` and `offline` say nothing about whether the port is open, so they must
 *  never read like "closed". Only `done` has an answer. */
type PortCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; result: HSHostedPortCheckResult }
  | { state: 'outage' }
  | { state: 'offline' }
  | { state: 'failed' }

function portFailure(error: unknown): PortCheck {
  if (error instanceof HostedError && error.code === 'network') return { state: 'offline' }
  return isHostedOutage(error) ? { state: 'outage' } : { state: 'failed' }
}

function openConnectOnWeb() {
  void WebBrowser.openBrowserAsync(`${WEBAPP_URL}/config/connect`)
}

export default function ConnectScreen() {
  return (
    <AdminGate>
      <Connect />
    </AdminGate>
  )
}

function usePortCheck(paired: boolean) {
  const [check, setCheck] = useState<PortCheck>({ state: 'idle' })
  const attempts = useRef(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useRef(true)

  const run = useCallback(async (auto: boolean) => {
    if (retry.current) clearTimeout(retry.current)
    retry.current = null
    setCheck({ state: 'checking' })
    try {
      const result = await checkPort()
      if (live.current) setCheck({ state: 'done', result })
    } catch (e) {
      if (!live.current) return
      setCheck(portFailure(e))
      // A dead check service must not be asked forever. The button still works.
      if (auto && attempts.current < AUTO_CHECK_ATTEMPTS) {
        attempts.current += 1
        retry.current = setTimeout(() => void run(true), AUTO_RETRY_MS)
      }
    }
  }, [])

  useEffect(() => {
    live.current = true
    if (paired && attempts.current === 0) {
      attempts.current = 1
      void run(true)
    }
    return () => {
      live.current = false
      if (retry.current) clearTimeout(retry.current)
    }
  }, [paired, run])

  return { check, runCheck: () => void run(false) }
}

function Connect() {
  const router = useRouter()
  const colors = useColors()
  const { serverName } = useConnection()
  const name = serverName || 'This server'

  const status = useAdminResource(getHostedStatus)
  const health = useAdminResource(getServiceHealth)
  const [addressPending, setAddressPending] = useState(false)
  const address = useAdminResource(getSecureAddress, {
    pollMs: addressPending ? ADDRESS_POLL_MS : undefined,
  })
  const addressStatus = address.data?.status
  useEffect(() => setAddressPending(addressStatus === 'pending'), [addressStatus])

  const paired = status.data?.paired ?? false
  const { check, runCheck } = usePortCheck(paired)

  if (status.error && !status.data) {
    return <AdminUnavailable error={status.error} onRetry={status.reload} />
  }

  if (status.loading || !status.data) {
    return (
      <SettingsPanel>
        <SkeletonRow />
        <SkeletonRow />
      </SettingsPanel>
    )
  }

  const healthView = health.data ? serviceHealthView(health.data) : null
  const healthFine = healthView?.tone === 'ok'
  const reach = reachRow(check)

  return (
    <SettingsPanel>
      <SettingsLabel>Connection</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="link"
          title={paired ? 'Connected to HearthShelf' : 'Not connected'}
          desc={
            paired
              ? `${name} is linked to HearthShelf, so you can invite people by email.`
              : 'Connect this server on the web so people you invite can reach it.'
          }
          control={
            <StatusPill label={paired ? 'Connected' : 'Off'} tone={paired ? 'good' : 'neutral'} />
          }
        />
        {paired && addressStatus === 'active' ? (
          <SettingsRow
            icon="lock"
            title="Secure address"
            desc={`${name} has a secure web address. There's nothing to copy or share.`}
            control={<StatusPill label="Ready" tone="good" />}
          />
        ) : null}
        {paired && addressStatus === 'pending' ? (
          <SettingsRow
            icon="lock-clock"
            title="Secure address"
            desc="Setting this up. You can still check the connection."
            control={<StatusPill label="Setting up" />}
          />
        ) : null}
        {healthView ? (
          <SettingsRow
            icon="verified-user"
            title="Service account"
            desc={
              healthView.detail ? `${healthView.title}. ${healthView.detail}` : healthView.title
            }
            control={
              <StatusPill label={healthFine ? 'OK' : 'Fix'} tone={healthFine ? 'good' : 'bad'} />
            }
            onPress={healthFine ? undefined : openConnectOnWeb}
            last
          />
        ) : health.error && !health.data ? (
          <SettingsRow
            icon="error-outline"
            title="Couldn't check the service account"
            desc="Tap to try again."
            onPress={health.reload}
            last
          />
        ) : null}
      </SettingsGroup>

      {paired ? (
        <>
          <SettingsLabel>Reachable from outside your network?</SettingsLabel>
          <SettingsGroup>
            <SettingsRow
              icon="travel-explore"
              title={reach.title}
              desc={reach.desc}
              control={reach.pill ? <StatusPill label={reach.pill} tone={reach.tone} /> : undefined}
              last
            />
          </SettingsGroup>
          <AdminButton
            label="Check connection"
            icon="refresh"
            kind="secondary"
            busy={check.state === 'checking'}
            onPress={runCheck}
          />
        </>
      ) : null}

      <SettingsLabel>People</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="person-add"
          title="Invite someone"
          desc={paired ? 'Send an invite by email.' : 'Connect this server first.'}
          onPress={paired ? () => router.push('/settings/admin/users/invite') : undefined}
          last
        />
      </SettingsGroup>

      <View>
        <SettingsLabel>On the web</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            icon="open-in-new"
            title="Pair, disconnect, or reset"
            desc="These can cut off this phone's connection, so they're on the web."
            onPress={openConnectOnWeb}
            last
          />
        </SettingsGroup>
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.xs, marginTop: spacing.xs }}
        >
          This opens on the server selected on the web.
        </AppText>
      </View>
    </SettingsPanel>
  )
}

function reachRow(check: PortCheck): {
  title: string
  desc?: string
  pill?: string
  tone?: StatusTone
} {
  switch (check.state) {
    case 'idle':
      return { title: 'Not checked yet' }
    case 'checking':
      return { title: 'Checking' }
    case 'done':
      return check.result.open
        ? {
            title: `Reachable on port ${check.result.port}`,
            desc: 'People you invite can reach this server.',
            pill: 'Open',
            tone: 'good',
          }
        : {
            title: `Not reachable on port ${check.result.port}`,
            desc: `Forward port ${check.result.port} on your router to this machine so people you invite can reach it. Look for "port forwarding" in your router's settings.`,
            pill: 'Closed',
            tone: 'bad',
          }
    case 'outage':
      return {
        title: "Couldn't run this check",
        desc: "The check service didn't answer. This doesn't mean anything is wrong with your server. Try again in a moment.",
        pill: 'Unknown',
      }
    case 'offline':
      return {
        title: "Couldn't run this check",
        desc: "This phone couldn't reach your server to ask. Check your connection and try again.",
        pill: 'Unknown',
      }
    case 'failed':
      return {
        title: "Couldn't run this check",
        desc: 'Try again in a moment.',
        pill: 'Unknown',
      }
  }
}
