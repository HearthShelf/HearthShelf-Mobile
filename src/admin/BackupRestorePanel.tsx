/** Takes over the Backups screen for the length of a restore. */
import { ActivityIndicator, View } from 'react-native'
import {
  cancelRestoreUpload,
  checkRestoreNow,
  dismissRestore,
  type RestoreState,
} from '@/admin/BackupRestore'
import { AdminButton } from '@/admin/AdminButton'
import { currentServerId } from '@/api/session'
import { Icon, icons } from '@/ui/icons'
import { AppText, Card, ProgressBar } from '@/ui/primitives'
import { SettingsPanel } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

const SAFE_TO_LEAVE = 'You can leave the app. We will check on the server when you come back.'
const SAVED_COPY =
  'If something looks wrong, your old HearthShelf data is in a pre-restore folder on the server.'

function finishedMessage(state: RestoreState): string {
  const lines = [
    state.lostContact
      ? "We lost touch with the server during the restore, so we can't tell if it worked. The server is answering now. Check that your data looks right, and give it a few minutes if it looks old."
      : 'Your server is back with the data from the backup.',
  ]
  if (state.crossServer) {
    lines.push('This backup came from a different server, so some links may need attention.')
  }
  if (state.kind !== 'abs') lines.push(SAVED_COPY)
  return lines.join('\n\n')
}

export function BackupRestorePanel({
  state,
  onClosed,
}: {
  state: RestoreState
  /** The restore is over and the backup lists should show again. */
  onClosed: () => void
}) {
  const colors = useColors()

  const close = () => {
    dismissRestore()
    onClosed()
  }

  const elsewhere = state.serverId !== currentServerId()
  const waitingHint = elsewhere
    ? 'This restore is on another server. We will check on it when you switch back.'
    : state.slow
      ? 'This is taking longer than usual. The server may still be working.'
      : SAFE_TO_LEAVE

  return (
    <SettingsPanel>
      <Card>
        <View style={{ gap: spacing.md }}>
          {state.phase === 'uploading' ? (
            <>
              <AppText variant="body">Sending your archive</AppText>
              <ProgressBar progress={state.uploaded} />
              <AppText variant="meta" color={colors.textMuted}>
                Your data stays as it is until the whole file is on the server. Keep the app open
                until this is done.
              </AppText>
              <AdminButton label="Cancel" kind="secondary" onPress={cancelRestoreUpload} />
            </>
          ) : null}

          {state.phase === 'restarting' || state.phase === 'reconnecting' ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <ActivityIndicator color={colors.accent} />
                <AppText variant="body">
                  {state.phase === 'restarting' ? 'Server restarting' : 'Signing you back in'}
                </AppText>
              </View>
              <AppText variant="meta" color={colors.textMuted}>
                {state.phase === 'restarting'
                  ? 'Your server is putting the backup in place. This can take a few minutes.'
                  : 'The server is back, but the restore replaced its accounts.'}
              </AppText>
              <AppText variant="meta" color={colors.textMuted}>
                {waitingHint}
              </AppText>
              {state.slow || elsewhere ? (
                <>
                  <AdminButton label="Check now" kind="secondary" onPress={checkRestoreNow} />
                  <AdminButton label="Stop waiting" kind="secondary" onPress={close} />
                </>
              ) : null}
            </>
          ) : null}

          {state.phase === 'finished' ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Icon name={icons.checkCircle} size={20} color={colors.success} />
                <AppText variant="body">
                  {state.lostContact ? 'Your server is back' : 'Restore finished'}
                </AppText>
              </View>
              <AppText variant="meta" color={colors.textMuted}>
                {finishedMessage(state)}
              </AppText>
              <AdminButton label="Done" onPress={close} />
            </>
          ) : null}

          {state.phase === 'failed' ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Icon name={icons.error} size={20} color={colors.destructive} />
                <AppText variant="body">Restore failed</AppText>
              </View>
              <AppText variant="meta" color={colors.textMuted}>
                {state.failure}
              </AppText>
              <AdminButton label="Back to backups" onPress={close} />
            </>
          ) : null}
        </View>
      </Card>
    </SettingsPanel>
  )
}
