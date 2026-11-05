/**
 * Backups. Two separate systems protect a server, Audiobookshelf's and HearthShelf's,
 * and the full archive holds both. Files download to the cache, then leave through the
 * share sheet. A restore takes over the screen until the server is back.
 */
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import type { File } from 'expo-file-system'
import {
  fmtBytes,
  isAbsScheduleOff,
  isHsScheduleOff,
  type ABSBackup,
  type HsBackupEntry,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { getRestoreState, startRestore, useBackupRestore } from '@/admin/BackupRestore'
import { BackupRestorePanel } from '@/admin/BackupRestorePanel'
import { BackupSchedule } from '@/admin/BackupSchedule'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  BackupFileError,
  applyAbsBackup,
  clearBackupFiles,
  deleteAbsBackup,
  deleteHsBackup,
  deleteLocalFile,
  downloadAbsBackup,
  downloadArchive,
  downloadHsBackup,
  getAbsBackupSettings,
  getAbsBackups,
  getHsBackups,
  isAbort,
  pickBackupFile,
  restoreArchive,
  restoreHsBackup,
  runAbsBackup,
  runHsBackup,
  setAbsBackupSettings,
  setHsBackupConfig,
  shareBackupFile,
  uploadAbsBackup,
  uploadHsBackup,
  waitForHsBackup,
  type BackupFileType,
  type TransferOptions,
} from '@/api/admin/backups'
import { adminErrorKind } from '@/api/admin/errors'
import { confirm } from '@/ui/confirm'
import { Icon, icons, type IconName } from '@/ui/icons'
import { AppText, Card, IconButton, ProgressBar, type SheetRef } from '@/ui/primitives'
import { SettingsLabel, SettingsPanel } from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { showToast } from '@/ui/Toast'
import { spacing } from '@/ui/theme'

const REJECTED_FILE = 'The server turned that file down. It may be damaged, or not a backup.'
const TYPE_TO_RESTORE = 'restore'
const TYPE_TO_RESTORE_ALL = 'restore everything'

interface Transfer {
  label: string
  fraction: number | null
}

interface PendingRestore {
  title: string
  message: string
  confirmText: string
  confirmLabel: string
  run: () => void
}

function formatDate(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function downloadFailure(e: unknown): string {
  switch (adminErrorKind(e)) {
    case 'unreachable':
      return 'The download stopped. Check your connection and try again.'
    case 'forbidden':
      return "Your account can't do that on this server."
    case 'missing':
      return 'That backup is gone. It may have been replaced by a newer one.'
    case 'failed':
      return "The server couldn't send that file."
  }
}

function Note({ icon, children }: { icon: IconName; children: string }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
      <Icon name={icon} size={16} color={colors.textMuted} />
      <AppText variant="meta" color={colors.textMuted} style={{ flex: 1 }}>
        {children}
      </AppText>
    </View>
  )
}

function BackupRow({
  title,
  subtitle,
  disabled,
  onDownload,
  onRestore,
  onDelete,
}: {
  title: string
  subtitle: string
  disabled: boolean
  onDownload: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const colors = useColors()
  const tint = disabled ? colors.textFaint : colors.text
  const guard = (action: () => void) => (disabled ? undefined : action)
  return (
    <AdminCard title={title} subtitle={subtitle}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-end',
          gap: spacing.lg,
          marginTop: spacing.sm,
        }}
      >
        <IconButton
          name={icons.download}
          color={tint}
          accessibilityLabel={`Download ${title}`}
          onPress={guard(onDownload)}
        />
        <IconButton
          name="restore"
          color={tint}
          accessibilityLabel={`Restore ${title}`}
          onPress={guard(onRestore)}
        />
        <IconButton
          name={icons.delete}
          color={disabled ? colors.textFaint : colors.destructive}
          accessibilityLabel={`Delete ${title}`}
          onPress={guard(onDelete)}
        />
      </View>
    </AdminCard>
  )
}

function Backups() {
  const colors = useColors()
  const restore = useBackupRestore()
  const abs = useAdminResource(getAbsBackups)
  const settings = useAdminResource(getAbsBackupSettings)
  const hs = useAdminResource(getHsBackups)
  const { run, busy } = useAdminWrite()
  const [runningFor, setRunningFor] = useState<'abs' | 'hs' | null>(null)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null)
  const confirmSheet = useRef<SheetRef>(null)
  const transferAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (getRestoreState().phase !== 'uploading') clearBackupFiles()
    return () => transferAbort.current?.abort()
  }, [])

  useEffect(() => {
    if (pendingRestore) confirmSheet.current?.present()
  }, [pendingRestore])

  const reloadAll = () => {
    abs.reload()
    settings.reload()
    hs.reload()
  }

  if (restore.phase !== 'idle') return <BackupRestorePanel state={restore} onClosed={reloadAll} />

  if (abs.error && !abs.data) {
    return <AdminUnavailable error={abs.error} onRetry={reloadAll} />
  }

  const locked = busy || transfer !== null

  const startTransfer = (label: string): TransferOptions => {
    const controller = new AbortController()
    transferAbort.current = controller
    setTransfer({ label, fraction: null })
    return {
      signal: controller.signal,
      onProgress: (fraction) => setTransfer({ label, fraction }),
    }
  }

  const endTransfer = () => {
    transferAbort.current = null
    setTransfer(null)
  }

  const saveToPhone = async (label: string, download: (t: TransferOptions) => Promise<File>) => {
    if (locked) return
    try {
      const file = await download(startTransfer(label))
      endTransfer()
      await shareBackupFile(file)
    } catch (e) {
      endTransfer()
      clearBackupFiles()
      if (!isAbort(e)) showToast(downloadFailure(e))
    }
  }

  const pick = async (type: BackupFileType): Promise<File | null> => {
    try {
      return await pickBackupFile(type)
    } catch (e) {
      showToast(e instanceof BackupFileError ? e.message : "We couldn't open that file.")
      return null
    }
  }

  const upload = async (
    type: 'abs' | 'hs',
    send: (file: File, t: TransferOptions) => Promise<unknown>,
    reload: () => void,
  ) => {
    if (locked) return
    const file = await pick(type)
    if (!file) return
    const options = startTransfer('Uploading backup')
    await run(
      async () => {
        try {
          await send(file, options)
          showToast('Backup uploaded')
        } catch (e) {
          if (!isAbort(e)) throw e
        }
      },
      { failed: REJECTED_FILE, reload },
    )
    endTransfer()
    deleteLocalFile(file)
  }

  const runAbs = async () => {
    setRunningFor('abs')
    await run(runAbsBackup, {
      done: 'Backup created',
      failed: 'The backup failed. Check that your server has free disk space.',
      reload: abs.reload,
    })
    setRunningFor(null)
  }

  const runHs = async () => {
    const before = hs.data
    if (!before) return
    setRunningFor('hs')
    await run(
      async () => {
        await runHsBackup()
        const { outcome } = await waitForHsBackup(before)
        showToast(
          outcome === 'finished'
            ? 'Backup created'
            : outcome === 'failed'
              ? 'The backup failed. Check your server logs.'
              : 'The backup is still running. It will show up here when it is done.',
        )
      },
      { failed: "Couldn't start the backup. One may be running already.", reload: hs.reload },
    )
    setRunningFor(null)
  }

  const deleteAbs = async (backup: ABSBackup) => {
    const ok = await confirm({
      title: 'Delete this backup?',
      message: `The backup from ${backup.datePretty} will be gone for good.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    await run(() => deleteAbsBackup(backup.id), {
      done: 'Backup deleted',
      failed: "Couldn't delete that backup.",
      reload: abs.reload,
    })
  }

  const deleteHs = async (backup: HsBackupEntry) => {
    const ok = await confirm({
      title: 'Delete this backup?',
      message: `The backup from ${formatDate(backup.createdAt)} will be gone for good.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    await run(() => deleteHsBackup(backup.id), {
      done: 'Backup deleted',
      failed: "Couldn't delete that backup.",
      reload: hs.reload,
    })
  }

  const restoreAbs = (backup: ABSBackup) =>
    setPendingRestore({
      title: 'Restore Audiobookshelf backup',
      message: `This replaces all library data, users, and listening progress with the backup from ${backup.datePretty}. Anything newer is lost, and no copy is kept. The server restarts, and you may need to sign in again. HearthShelf data is not touched.`,
      confirmText: TYPE_TO_RESTORE,
      confirmLabel: 'Restore',
      run: () => void startRestore('abs', () => applyAbsBackup(backup.id)),
    })

  const restoreHs = (backup: HsBackupEntry) =>
    setPendingRestore({
      title: 'Restore HearthShelf backup',
      message: `This replaces HearthShelf's data with the backup from ${formatDate(backup.createdAt)}. Your current data is saved to a pre-restore folder on the server first. Audiobookshelf is not touched.`,
      confirmText: TYPE_TO_RESTORE,
      confirmLabel: 'Restore',
      run: () => void startRestore('hs', () => restoreHsBackup(backup.id)),
    })

  const restoreFromArchive = async () => {
    if (locked) return
    const file = await pick('archive')
    if (!file) return
    setPendingRestore({
      title: 'Restore full archive',
      message: `This replaces BOTH Audiobookshelf and HearthShelf data with what is in ${file.name}. Your current HearthShelf data is saved to a pre-restore folder first, but no copy of your library data is kept. The server restarts, and you may need to sign in again.`,
      confirmText: TYPE_TO_RESTORE_ALL,
      confirmLabel: 'Restore everything',
      run: () =>
        void startRestore('archive', (options) => restoreArchive(file, options)).finally(() =>
          deleteLocalFile(file),
        ),
    })
  }

  const absSchedule = settings.data?.backupSchedule
  const absOff = settings.data ? isAbsScheduleOff(absSchedule) : false
  const hsOff = isHsScheduleOff(hs.data)
  const offNames =
    absOff && hsOff ? 'Audiobookshelf and HearthShelf' : absOff ? 'Audiobookshelf' : 'HearthShelf'

  const saveAbs = (patch: Parameters<typeof setAbsBackupSettings>[0], done: string) =>
    void run(() => setAbsBackupSettings(patch), {
      done,
      failed: "Couldn't save that.",
      reload: settings.reload,
    })

  const saveHs = (patch: Parameters<typeof setHsBackupConfig>[0], done: string) =>
    void run(() => setHsBackupConfig(patch), {
      done,
      failed: "Couldn't save that.",
      reload: hs.reload,
    })

  const hsFailed = Boolean(hs.error) && !hs.data

  return (
    <SettingsPanel>
      {transfer ? (
        <Card>
          <View style={{ gap: spacing.sm }}>
            <AppText variant="body">{transfer.label}</AppText>
            {transfer.fraction === null ? (
              <AppText variant="meta" color={colors.textMuted}>
                Working on it. Keep this screen open.
              </AppText>
            ) : (
              <ProgressBar progress={transfer.fraction} />
            )}
            <AdminButton
              label="Cancel"
              kind="secondary"
              onPress={() => transferAbort.current?.abort()}
            />
          </View>
        </Card>
      ) : null}

      {absOff || hsOff ? (
        <Note icon={icons.error}>
          {`Automatic backups are off for ${offNames}. Turn on a schedule so your data stays safe without you having to remember.`}
        </Note>
      ) : null}

      <SettingsLabel>Audiobookshelf backups</SettingsLabel>
      <Note icon={icons.info}>
        Your library database, book and author details, users, and listening progress. Audio files
        are not included.
      </Note>
      {settings.data ? (
        <BackupSchedule
          schedule={absSchedule || ''}
          keep={settings.data.backupsToKeep ?? 2}
          disabled={locked}
          onSchedule={(backupSchedule) => saveAbs({ backupSchedule }, 'Schedule saved')}
          onKeep={(backupsToKeep) => saveAbs({ backupsToKeep }, 'Saved')}
        />
      ) : null}
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <AdminButton
            label="Back up now"
            icon={icons.cloudSync}
            busy={runningFor === 'abs'}
            disabled={locked}
            onPress={() => void runAbs()}
          />
        </View>
        <View style={{ flex: 1 }}>
          <AdminButton
            label="Upload"
            icon="upload"
            kind="secondary"
            disabled={locked}
            onPress={() => void upload('abs', uploadAbsBackup, abs.reload)}
          />
        </View>
      </View>
      {abs.loading ? <SkeletonRow /> : null}
      {abs.data?.backups.length === 0 ? (
        <EmptyState
          icon={icons.cloudQueue}
          title="No backups yet"
          body="Back up now, or turn on a schedule."
        />
      ) : null}
      {abs.data?.backups.map((backup) => (
        <BackupRow
          key={backup.id}
          title={backup.datePretty}
          subtitle={`Version ${backup.serverVersion} · ${fmtBytes(backup.fileSize)}`}
          disabled={locked}
          onDownload={() =>
            void saveToPhone('Downloading backup', (options) => downloadAbsBackup(backup, options))
          }
          onRestore={() => restoreAbs(backup)}
          onDelete={() => void deleteAbs(backup)}
        />
      ))}

      {hs.loading ? <SkeletonRow /> : null}
      {hsFailed ? (
        <>
          <SettingsLabel>HearthShelf backups</SettingsLabel>
          <Note icon={icons.error}>The server couldn't load its HearthShelf backups.</Note>
          <AdminButton label="Try again" kind="secondary" onPress={hs.reload} />
        </>
      ) : null}

      {hs.data ? (
        <>
          <SettingsLabel>HearthShelf backups</SettingsLabel>
          <Note icon={icons.info}>
            HearthShelf's own data: settings, clubs, notes, reading history, profile photos, and
            connected services.
          </Note>
          <Note icon={icons.lock}>
            These hold server secrets like API keys. Keep a downloaded copy as safe as a password.
          </Note>
          <BackupSchedule
            schedule={hs.data.config.schedule}
            keep={hs.data.config.keep}
            scheduleLocked={hs.data.config.env.schedule}
            keepLocked={hs.data.config.env.keep}
            disabled={locked}
            onSchedule={(schedule) => saveHs({ schedule }, 'Schedule saved')}
            onKeep={(keep) => saveHs({ keep }, 'Saved')}
          />
          {hs.data.config.offBoxPath ? (
            <Note
              icon={icons.info}
            >{`Also copying each backup to ${hs.data.config.offBoxPath}.`}</Note>
          ) : null}
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <AdminButton
                label="Back up now"
                icon={icons.cloudSync}
                busy={runningFor === 'hs'}
                disabled={locked}
                onPress={() => void runHs()}
              />
            </View>
            <View style={{ flex: 1 }}>
              <AdminButton
                label="Upload"
                icon="upload"
                kind="secondary"
                disabled={locked}
                onPress={() => void upload('hs', uploadHsBackup, hs.reload)}
              />
            </View>
          </View>
          {hs.data.backups.length === 0 ? (
            <EmptyState
              icon={icons.cloudQueue}
              title="No backups yet"
              body="Back up now, or turn on a schedule."
            />
          ) : null}
          {hs.data.backups.map((backup) => (
            <BackupRow
              key={backup.id}
              title={formatDate(backup.createdAt)}
              subtitle={`Version ${backup.hsVersion ?? '-'} · ${fmtBytes(backup.size)}`}
              disabled={locked}
              onDownload={() =>
                void saveToPhone('Downloading backup', (options) =>
                  downloadHsBackup(backup, options),
                )
              }
              onRestore={() => restoreHs(backup)}
              onDelete={() => void deleteHs(backup)}
            />
          ))}

          <SettingsLabel>Full-server archive</SettingsLabel>
          <Note icon={icons.info}>
            One file with both backups from the same moment. It is the easiest way to move your
            whole server, or to come back from a crash.
          </Note>
          <AdminButton
            label="Download full archive"
            icon={icons.archive}
            disabled={locked}
            onPress={() => void saveToPhone('Building your archive', downloadArchive)}
          />
          <AdminButton
            label="Restore archive"
            icon="restore"
            kind="secondary"
            disabled={locked}
            onPress={() => void restoreFromArchive()}
          />
        </>
      ) : null}

      <Note icon={icons.info}>
        Audio files are in neither backup. Protect the folder that holds your audiobooks on the
        server itself.
      </Note>

      <TypedConfirm
        ref={confirmSheet}
        title={pendingRestore?.title ?? ''}
        message={pendingRestore?.message ?? ''}
        confirmText={pendingRestore?.confirmText ?? TYPE_TO_RESTORE}
        confirmLabel={pendingRestore?.confirmLabel ?? 'Restore'}
        onConfirm={() => {
          pendingRestore?.run()
          setPendingRestore(null)
        }}
      />
    </SettingsPanel>
  )
}

export default function BackupsScreen() {
  return (
    <AdminGate>
      <Backups />
    </AdminGate>
  )
}
