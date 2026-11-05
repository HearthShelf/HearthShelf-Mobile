/**
 * Backups: Audiobookshelf's own (/api/backups), HearthShelf's (/hs/backups) and the
 * full archive (/hs/archive).
 *
 * Backup files can be hundreds of megabytes, so they never sit whole in JS. Downloads
 * and uploads run in the native file system module, which needs the token passed by
 * hand and so gets none of adminRequest's 401 refresh: withTokenRetry stands in.
 *
 * The native downloaders are GET only, and POST /hs/archive answers with the file.
 * That one call streams through expo/fetch and is written to disk chunk by chunk.
 */
import { Directory, File, Paths, UploadType, type UploadOptions } from 'expo-file-system'
import { fetch as streamingFetch } from 'expo/fetch'
import * as DocumentPicker from 'expo-document-picker'
import * as Sharing from 'expo-sharing'
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  archiveFilename,
  type ABSBackupsResponse,
  type ABSServerSettings,
  type HsBackupConfig,
  type HsBackupsResponse,
  type HsRestoreResult,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest, getMe } from '@/api/abs'
import { getSession } from '@/api/session'

/** The server does the whole job before it answers. */
const SLOW_CALL_MS = 10 * 60_000
/** MAX_BACKUP_UPLOAD_BYTES in the server's routes/backups.js. */
const HS_UPLOAD_LIMIT_BYTES = 512 * 1024 * 1024
const HS_RUN_POLL_MS = 2000
const HS_RUN_WAIT_MS = 90_000
const PROGRESS_INTERVAL_MS = 200
const PROBE_TIMEOUT_MS = 8000
const ZIP_MIME = 'application/zip'

// --- Audiobookshelf backups ---------------------------------------------------

export async function getAbsBackups(): Promise<ABSBackupsResponse> {
  const res = await adminRequest<Partial<ABSBackupsResponse>>(ABS_ENDPOINTS.backups)
  return { backups: res?.backups ?? [], backupLocation: res?.backupLocation ?? '' }
}

export async function getAbsBackupSettings(): Promise<ABSServerSettings> {
  const res = await adminRequest<{ serverSettings?: ABSServerSettings }>(ABS_ENDPOINTS.authorize, {
    method: 'POST',
  })
  if (!res?.serverSettings) throw new ABSRequestError(500, ABS_ENDPOINTS.authorize)
  return res.serverSettings
}

export function setAbsBackupSettings(
  patch: Pick<ABSServerSettings, 'backupSchedule'> | Pick<ABSServerSettings, 'backupsToKeep'>,
): Promise<unknown> {
  return adminRequest(ABS_ENDPOINTS.serverSettings, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function runAbsBackup(): Promise<unknown> {
  return adminRequest(ABS_ENDPOINTS.backups, { method: 'POST' }, { timeoutMs: SLOW_CALL_MS })
}

export function deleteAbsBackup(id: string): Promise<unknown> {
  return adminRequest(ABS_ENDPOINTS.backup(encodeURIComponent(id)), { method: 'DELETE' })
}

/** Audiobookshelf's apply route really is a GET. It answers once the restore is done. */
export function applyAbsBackup(id: string): Promise<unknown> {
  return adminRequest(ABS_ENDPOINTS.backupApply(encodeURIComponent(id)), undefined, {
    timeoutMs: SLOW_CALL_MS,
  })
}

// --- HearthShelf backups ------------------------------------------------------

/** Null when this server has no HearthShelf backend, so the section hides. Any other
 *  failure is thrown: an admin must not read a broken backend as "not installed". */
export async function getHsBackups(): Promise<HsBackupsResponse | null> {
  try {
    return await adminRequest<HsBackupsResponse>(HS_ENDPOINTS.backups)
  } catch (e) {
    if (e instanceof ABSRequestError && e.status === 404) return null
    throw e
  }
}

export function runHsBackup(): Promise<unknown> {
  return adminRequest(HS_ENDPOINTS.backups, { method: 'POST' })
}

export type HsBackupRun = { outcome: 'finished' | 'pending' } | { outcome: 'failed' }

/** POST /hs/backups only queues the job, so ask until its file shows up. */
export async function waitForHsBackup(before: HsBackupsResponse): Promise<HsBackupRun> {
  const known = new Set(before.backups.map((b) => b.id))
  const deadline = Date.now() + HS_RUN_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, HS_RUN_POLL_MS))
    const now = await getHsBackups().catch(() => undefined)
    if (now === null) return { outcome: 'pending' }
    if (now?.backups.some((b) => !known.has(b.id))) return { outcome: 'finished' }
    if (now?.lastRun?.status === 'error' && now.lastRun.at !== before.lastRun?.at) {
      return { outcome: 'failed' }
    }
  }
  return { outcome: 'pending' }
}

export function setHsBackupConfig(
  patch: Partial<Pick<HsBackupConfig, 'schedule' | 'keep'>>,
): Promise<unknown> {
  return adminRequest(HS_ENDPOINTS.backupsConfig, { method: 'PUT', body: JSON.stringify(patch) })
}

export function deleteHsBackup(id: string): Promise<unknown> {
  return adminRequest(HS_ENDPOINTS.backup(encodeURIComponent(id)), { method: 'DELETE' })
}

export function restoreHsBackup(id: string): Promise<HsRestoreResult> {
  return adminRequest<HsRestoreResult>(
    HS_ENDPOINTS.backupRestore(encodeURIComponent(id)),
    { method: 'POST' },
    { timeoutMs: SLOW_CALL_MS },
  )
}

// --- After a restore ----------------------------------------------------------

export type RestoreKind = 'abs' | 'hs' | 'archive'
export type ServerAnswer = 'up' | 'token-lost' | 'down'

/** Is the server really back? /api/me alone can't say: it can answer from memory while
 *  a restore still has the database closed, so each half also gets a read that needs it.
 *  getMe also refreshes the token and the account's role, which the restore may change. */
export async function askServerAfterRestore(kind: RestoreKind): Promise<ServerAnswer> {
  try {
    await getMe()
    const options = { timeoutMs: PROBE_TIMEOUT_MS }
    if (kind !== 'hs') await adminRequest(ABS_ENDPOINTS.users, undefined, options)
    if (kind !== 'abs') await adminRequest(HS_ENDPOINTS.backups, undefined, options)
    return 'up'
  } catch (e) {
    if (!(e instanceof ABSRequestError)) return 'down'
    if (e.status === 401) return 'token-lost'
    // The server answered. A 403 means the restored data has this account as a
    // regular user, which AdminGate handles from the role getMe just read.
    return e.status === 403 || e.status === 404 ? 'up' : 'down'
  }
}

// --- Files --------------------------------------------------------------------

export interface TransferOptions {
  /** 0 to 1, or null when the server didn't say how big the file is. */
  onProgress?: (fraction: number | null) => void
  signal?: AbortSignal
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

const TRANSFER_FOLDER = 'backup-transfers'

function transferFolder(): Directory {
  const folder = new Directory(Paths.cache, TRANSFER_FOLDER)
  folder.create({ intermediates: true, idempotent: true })
  return folder
}

/** HearthShelf backups hold server secrets, so nothing stays here longer than it must.
 *  Not cleared right after sharing: on Android the app picked in the share sheet can
 *  still be reading the file when control comes back. */
export function clearBackupFiles(): void {
  try {
    const folder = new Directory(Paths.cache, TRANSFER_FOLDER)
    if (folder.exists) folder.delete()
  } catch {
    // Still in use, or already gone. The next visit clears it.
  }
}

function safeFilename(name: string): string {
  return name.replace(/[\\/]/g, '_')
}

function session(): { serverUrl: string; token: string } {
  const current = getSession()
  if (!current) throw new Error('not_connected')
  return current
}

/** Native transfers report a bad status only in the error text. */
function statusInMessage(e: unknown): number | null {
  const match = e instanceof Error ? e.message.match(/\bHTTP (\d{3})\b/) : null
  return match ? Number(match[1]) : null
}

/** A 401 means the server refused the call, so it is safe to send again. */
async function withTokenRetry<T>(attempt: () => Promise<T>): Promise<T> {
  const before = getSession()?.token
  try {
    return await attempt()
  } catch (e) {
    if (!(e instanceof ABSRequestError) || e.status !== 401) throw e
    // absRequest owns the token refresh, and getMe is the cheapest way to run it.
    await getMe().catch(() => undefined)
    if (getSession()?.token === before) throw e
    return attempt()
  }
}

function downloadToFile(path: string, filename: string, options: TransferOptions): Promise<File> {
  return withTokenRetry(async () => {
    const { serverUrl, token } = session()
    const destination = new File(transferFolder(), safeFilename(filename))
    if (destination.exists) destination.delete()
    const task = File.createDownloadTask(`${serverUrl}${path}`, destination, {
      headers: { Authorization: `Bearer ${token}` },
      signal: options.signal,
      onProgress: ({ bytesWritten, totalBytes }) =>
        options.onProgress?.(totalBytes > 0 ? bytesWritten / totalBytes : null),
    })
    try {
      const file = await task.downloadAsync()
      if (!file) throw new Error('download_paused')
      return file
    } catch (e) {
      const status = statusInMessage(e)
      throw status ? new ABSRequestError(status, path) : e
    }
  })
}

export function downloadAbsBackup(
  backup: { id: string; filename: string },
  options: TransferOptions,
): Promise<File> {
  const path = ABS_ENDPOINTS.backupDownload(encodeURIComponent(backup.id))
  return downloadToFile(path, backup.filename, options)
}

export function downloadHsBackup(
  backup: { id: string; filename: string },
  options: TransferOptions,
): Promise<File> {
  const path = HS_ENDPOINTS.backupDownload(encodeURIComponent(backup.id))
  return downloadToFile(path, backup.filename, options)
}

/** The server builds the whole archive before its first byte, so this can sit quiet for
 *  a long time. Android never gives up on it. iOS drops a request after 60 quiet seconds,
 *  and expo/fetch has no setting for that. */
export function downloadArchive(options: TransferOptions): Promise<File> {
  return withTokenRetry(async () => {
    const { serverUrl, token } = session()
    const res = await streamingFetch(`${serverUrl}${HS_ENDPOINTS.archive}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      signal: options.signal,
    })
    if (!res.ok) throw new ABSRequestError(res.status, HS_ENDPOINTS.archive)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('archive_empty')

    const total = Number(res.headers.get('content-length')) || 0
    const name = archiveFilename(res.headers.get('content-disposition'))
    const destination = new File(transferFolder(), safeFilename(name))
    destination.create({ overwrite: true })
    const handle = destination.open()
    let written = 0
    let lastReport = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        handle.writeBytes(value)
        written += value.byteLength
        if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = Date.now()
          options.onProgress?.(total ? written / total : null)
        }
      }
    } finally {
      handle.close()
    }
    if (total && written !== total) throw new Error('archive_cut_short')
    return destination
  })
}

/** Hands the file to the system share sheet, which is how it leaves the app. */
export async function shareBackupFile(file: File): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing_unavailable')
  await Sharing.shareAsync(file.uri, {
    mimeType: ZIP_MIME,
    UTI: 'public.zip-archive',
    dialogTitle: 'Save your backup',
  })
}

export type BackupFileType = 'abs' | 'hs' | 'archive'

const FILE_TYPES: Record<BackupFileType, { extensions: string[]; wrongFile: string }> = {
  abs: {
    extensions: ['.audiobookshelf'],
    wrongFile: 'Pick a file that ends in .audiobookshelf.',
  },
  hs: {
    extensions: ['.hsbackup', '.zip'],
    wrongFile: 'Pick a file that ends in .hsbackup.',
  },
  archive: {
    extensions: ['.hsarchive', '.zip'],
    wrongFile: 'Pick a file that ends in .hsarchive.',
  },
}

/** Why a picked file can't be sent. The message is for the admin. */
export class BackupFileError extends Error {}

/** Opens the file picker. Null when the admin backs out. The picker's copy is moved to a
 *  file with its real name, since Audiobookshelf turns away anything else and Android's
 *  copy gets a random one. The caller deletes it when the upload is done. */
export async function pickBackupFile(type: BackupFileType): Promise<File | null> {
  // These extensions have no registered file type, so the picker can't filter on them.
  const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false })
  const asset = picked.canceled ? null : picked.assets[0]
  if (!asset) return null

  const { extensions, wrongFile } = FILE_TYPES[type]
  const name = asset.name.toLowerCase()
  if (!extensions.some((extension) => name.endsWith(extension))) {
    throw new BackupFileError(wrongFile)
  }
  if (type !== 'abs' && (asset.size ?? 0) > HS_UPLOAD_LIMIT_BYTES) {
    throw new BackupFileError('That file is too big. The server takes up to 512 MB.')
  }
  const file = new File(asset.uri)
  await file.move(new File(transferFolder(), safeFilename(asset.name)), { overwrite: true })
  return file
}

function uploadFile(
  path: string,
  file: File,
  upload: Pick<UploadOptions, 'uploadType' | 'fieldName' | 'mimeType'>,
  options: TransferOptions,
): Promise<string> {
  return withTokenRetry(async () => {
    const { serverUrl, token } = session()
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (upload.uploadType === UploadType.BINARY_CONTENT) headers['Content-Type'] = ZIP_MIME
    const result = await file.upload(`${serverUrl}${path}`, {
      ...upload,
      httpMethod: 'POST',
      headers,
      signal: options.signal,
      onProgress: ({ bytesSent, totalBytes }) =>
        options.onProgress?.(totalBytes > 0 ? bytesSent / totalBytes : null),
    })
    if (result.status < 200 || result.status >= 300) throw new ABSRequestError(result.status, path)
    return result.body
  })
}

export function uploadAbsBackup(file: File, options: TransferOptions): Promise<string> {
  const upload = { uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: ZIP_MIME }
  return uploadFile(ABS_ENDPOINTS.backupUpload, file, upload, options)
}

export function uploadHsBackup(file: File, options: TransferOptions): Promise<string> {
  const upload = { uploadType: UploadType.BINARY_CONTENT }
  return uploadFile(HS_ENDPOINTS.backupsUpload, file, upload, options)
}

export async function restoreArchive(
  file: File,
  options: TransferOptions,
): Promise<HsRestoreResult> {
  const path = `${HS_ENDPOINTS.archiveRestore}?mode=replace`
  const body = await uploadFile(path, file, { uploadType: UploadType.BINARY_CONTENT }, options)
  return JSON.parse(body) as HsRestoreResult
}

export function deleteLocalFile(file: File): void {
  try {
    if (file.exists) file.delete()
  } catch {
    // clearBackupFiles picks it up on the next visit.
  }
}
