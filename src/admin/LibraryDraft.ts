/**
 * The one draft behind the library edit screens. Details, Settings, Scanner and
 * Schedule are separate screens that all edit this, and the library screen holds
 * the single Save. It lives outside React so moving between them keeps every edit.
 *
 * A draft belongs to one server: reads return nothing once the active server
 * differs, so an edit can never be saved to another server.
 */
import { useSyncExternalStore } from 'react'
import {
  settingsFromLibrary,
  type ABSLibrary,
  type LibraryDraftSettings,
  type LibraryEditDraft,
  type LibraryFolderInput,
} from '@hearthshelf/core'
import { currentServerId } from '@/api/session'

export interface LibraryDraftState {
  serverId: string | null
  /** The library as it was when editing began. */
  library: ABSLibrary
  draft: LibraryEditDraft
}

let current: LibraryDraftState | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(id: string): LibraryDraftState | null {
  if (current?.library.id !== id || current.serverId !== currentServerId()) return null
  return current
}

export function useLibraryDraft(id: string): LibraryDraftState | null {
  return useSyncExternalStore(subscribe, () => read(id))
}

function folderInput(folder: { id: string; fullPath: string }): LibraryFolderInput {
  return { id: folder.id, fullPath: folder.fullPath }
}

function draftFromLibrary(library: ABSLibrary): LibraryEditDraft {
  return {
    name: library.name,
    provider: library.provider,
    icon: library.icon,
    folders: library.folders.map(folderInput),
    settings: settingsFromLibrary(library.settings),
  }
}

/** Starts a draft unless one is open. The screen reloads on focus, and returning
 *  from a section must not throw the edits away. */
export function seedLibraryDraft(library: ABSLibrary) {
  if (read(library.id)) return
  current = { serverId: currentServerId(), library, draft: draftFromLibrary(library) }
  emit()
}

export function clearLibraryDraft(id: string) {
  if (current?.library.id !== id) return
  current = null
  emit()
}

export function patchLibraryDraft(patch: Partial<LibraryEditDraft>) {
  if (!current) return
  current = { ...current, draft: { ...current.draft, ...patch } }
  emit()
}

export function patchLibrarySettings(patch: Partial<LibraryDraftSettings>) {
  if (!current) return
  patchLibraryDraft({ settings: { ...current.draft.settings, ...patch } })
}

export function isLibraryDraftDirty({ library, draft }: LibraryDraftState): boolean {
  return JSON.stringify(draft) !== JSON.stringify(draftFromLibrary(library))
}

// --- Folders ----------------------------------------------------------------

/** The server stores paths resolved, so "/books/" and "/books" are one folder. */
export function normalizeLibraryPath(path: string): string {
  const trimmed = path.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') || '/' : trimmed
}

export function removedLibraryFolders({ library, draft }: LibraryDraftState) {
  return library.folders.filter((f) => !draft.folders.some((d) => d.id === f.id))
}

/** Puts a folder marked for removal back, keeping its id. Sending the same path
 *  without the id would delete the folder's items and start it again as new. */
export function restoreLibraryFolder(state: LibraryDraftState, folderId: string) {
  const kept = state.library.folders.filter(
    (f) => f.id === folderId || state.draft.folders.some((d) => d.id === f.id),
  )
  patchLibraryDraft({
    folders: [...kept.map(folderInput), ...state.draft.folders.filter((d) => !d.id)],
  })
}

/**
 * The folder list to send, built on a fresh read. The server removes any folder
 * left out, along with its items, so a list from when editing began would delete a
 * folder someone added since. Only folders this admin removed are dropped, and a
 * new path is skipped if an earlier unconfirmed save already added it.
 */
export function libraryFoldersToSave(
  fresh: ABSLibrary,
  state: LibraryDraftState,
): LibraryFolderInput[] {
  const removed = new Set(removedLibraryFolders(state).map((f) => f.id))
  const stay = fresh.folders.filter((f) => !removed.has(f.id)).map(folderInput)
  const added = state.draft.folders.filter(
    (d) => !d.id && !stay.some((f) => f.fullPath === d.fullPath),
  )
  return [...stay, ...added]
}

// --- Schedule ---------------------------------------------------------------

export const LIBRARY_SCHEDULE_PRESETS: readonly { value: string; label: string }[] = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 3 * * *', label: 'Every day at 3:00 AM' },
  { value: '0 0 * * 1', label: 'Every Monday at midnight' },
  { value: '0 0 1 * *', label: 'First day of each month' },
]

export const LIBRARY_DEFAULT_CRON = '0 0 * * 1'

export function libraryScheduleLabel(cron: string | null): string {
  if (cron == null) return 'Off'
  return LIBRARY_SCHEDULE_PRESETS.find((p) => p.value === cron)?.label ?? `Custom: ${cron}`
}

const CRON_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

function isValidCronField(field: string, [low, high]: readonly [number, number]): boolean {
  return field.split(',').every((item) => {
    const [span, step, extra] = item.split('/')
    if (extra !== undefined || !/^(\*|\d+(-\d+)?)$/.test(span)) return false
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false
    return (span.match(/\d+/g) ?? []).every((n) => Number(n) >= low && Number(n) <= high)
  })
}

/** The server schedules this without checking it, and a bad one fails there after
 *  it is already saved, so it has to be caught here. Numbers only: named months and
 *  days are valid cron, but a typo in one could not be told apart. */
export function isValidLibraryCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) return false
  const ranges = fields.length === 6 ? [CRON_RANGES[0], ...CRON_RANGES] : CRON_RANGES
  return fields.every((field, i) => isValidCronField(field, ranges[i]))
}

// --- Checks before Save -----------------------------------------------------

export interface LibraryDraftProblems {
  details?: string
  settings?: string
  schedule?: string
}

/** What stops a Save. Values are only checked once changed, so an unusual value
 *  already on the server can't block an unrelated edit. */
export function libraryDraftProblems({ library, draft }: LibraryDraftState): LibraryDraftProblems {
  const problems: LibraryDraftProblems = {}
  const before = settingsFromLibrary(library.settings)
  const { markAsFinishedValue: value, markAsFinishedWhen: when, autoScanCron } = draft.settings

  if (!draft.name.trim()) problems.details = 'Give the library a name.'
  else if (!draft.folders.length) problems.details = 'Add at least one folder.'

  if (value !== before.markAsFinishedValue || when !== before.markAsFinishedWhen) {
    if (!/^\d+$/.test(value)) {
      problems.settings = 'Enter a number for when a book counts as finished.'
    } else if (when === 'percentComplete' && (Number(value) < 1 || Number(value) > 100)) {
      problems.settings = 'The finished percent must be from 1 to 100.'
    }
  }

  if (autoScanCron != null && autoScanCron !== before.autoScanCron) {
    if (!isValidLibraryCron(autoScanCron)) problems.schedule = 'The custom schedule is not valid.'
  }
  return problems
}
