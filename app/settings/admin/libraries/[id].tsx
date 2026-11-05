/**
 * One library: a row for each section, and the single Save for all of them. The
 * sections edit a shared draft (src/admin/LibraryDraft.ts), so nothing reaches the
 * server until Save here.
 */
import { useEffect, useRef, useState } from 'react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { usePreventRemove } from 'expo-router/react-navigation'
import { libraryUpdatePatch, METADATA_SOURCES } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import {
  clearLibraryDraft,
  isLibraryDraftDirty,
  libraryDraftProblems,
  libraryFoldersToSave,
  libraryScheduleLabel,
  removedLibraryFolders,
  seedLibraryDraft,
  useLibraryDraft,
  type LibraryDraftState,
} from '@/admin/LibraryDraft'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { getLibrary, LIBRARY_SLOW_TIMEOUT_MS, updateLibrary } from '@/api/admin/libraries'
import { confirm } from '@/ui/confirm'
import { AppText, type SheetRef } from '@/ui/primitives'
import { SettingsGroup, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { showToast } from '@/ui/Toast'

export default function LibraryScreen() {
  return (
    <AdminGate>
      <LibraryLoader />
    </AdminGate>
  )
}

function LibraryLoader() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const resource = useAdminResource(() => getLibrary(id))
  const state = useLibraryDraft(id)

  useEffect(() => {
    if (resource.data) seedLibraryDraft(resource.data)
  }, [resource.data])
  useEffect(() => () => clearLibraryDraft(id), [id])

  if (state) return <LibraryHub state={state} reload={resource.reload} />
  if (resource.error) return <AdminUnavailable error={resource.error} onRetry={resource.reload} />
  return (
    <SettingsPanel>
      <SkeletonRow />
      <SkeletonRow />
    </SettingsPanel>
  )
}

function LibraryHub({ state, reload }: { state: LibraryDraftState; reload: () => void }) {
  const router = useRouter()
  const navigation = useNavigation()
  const colors = useColors()
  const { run, busy } = useAdminWrite()
  const removeSheet = useRef<SheetRef>(null)
  const [saved, setSaved] = useState(false)
  const { library, draft } = state
  const base = `/settings/admin/libraries/${library.id}`
  const isBook = library.mediaType === 'book'
  const dirty = isLibraryDraftDirty(state)
  const problems = libraryDraftProblems(state)
  const problem = problems.details ?? problems.settings ?? problems.schedule
  const removed = removedLibraryFolders(state)

  usePreventRemove(dirty && !saved, ({ data }) => {
    void confirm({
      title: 'Discard your changes?',
      message: `Your edits to ${library.name} haven't been saved.`,
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    }).then((discard) => {
      if (discard) navigation.dispatch(data.action)
    })
  })

  // Leaves only after the render that lifts the guard above.
  useEffect(() => {
    if (saved) router.back()
  }, [saved, router])

  async function commit() {
    const ok = await run(
      async () => {
        const patch = libraryUpdatePatch(library, draft)
        if (patch.folders) {
          patch.folders = libraryFoldersToSave(await getLibrary(library.id), state)
        }
        if (Object.keys(patch).length === 0) return
        // Removing a folder removes every item in it before the server answers.
        await updateLibrary(library.id, patch, removed.length ? LIBRARY_SLOW_TIMEOUT_MS : undefined)
      },
      { failed: `Couldn't save ${library.name}.`, reload },
    )
    if (!ok) return
    showToast('Library saved')
    setSaved(true)
  }

  function save() {
    if (removed.length) removeSheet.current?.present()
    else void commit()
  }

  const firstSource = METADATA_SOURCES.find((s) => s.id === draft.settings.metadataPrecedence[0])
  const folderCount = draft.folders.length

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRow
          icon="edit"
          title="Details"
          desc={
            problems.details ??
            `${draft.name} · ${folderCount} folder${folderCount === 1 ? '' : 's'}`
          }
          descColor={problems.details ? colors.destructive : undefined}
          onPress={() => router.push(`${base}/details`)}
        />
        <SettingsRow
          icon="tune"
          title="Settings"
          desc={problems.settings ?? 'Covers, watching for new files, and finishing books.'}
          descColor={problems.settings ? colors.destructive : undefined}
          onPress={() => router.push(`${base}/settings`)}
        />
        {isBook ? (
          <SettingsRow
            icon="layers"
            title="Scanner"
            desc={`First choice: ${firstSource?.name ?? 'custom'}`}
            onPress={() => router.push(`${base}/scanner`)}
          />
        ) : null}
        <SettingsRow
          icon="schedule"
          title="Schedule"
          desc={problems.schedule ?? libraryScheduleLabel(draft.settings.autoScanCron)}
          descColor={problems.schedule ? colors.destructive : undefined}
          onPress={() => router.push(`${base}/schedule`)}
        />
        <SettingsRow
          icon="build"
          title="Tools"
          desc="Actions that run right away."
          onPress={() => router.push(`${base}/tools`)}
          last
        />
      </SettingsGroup>

      {removed.length ? (
        <AppText variant="meta" color={colors.destructive}>
          {`Saving removes ${removed.length} folder${removed.length === 1 ? '' : 's'}.`}
        </AppText>
      ) : null}
      <AdminButton
        label="Save"
        icon="save"
        onPress={save}
        disabled={!dirty || Boolean(problem) || saved}
        busy={busy}
      />

      <TypedConfirm
        ref={removeSheet}
        title={removed.length === 1 ? 'Remove folder?' : 'Remove folders?'}
        message={`Saving removes ${removed.map((f) => f.fullPath).join(', ')} from ${library.name}, with every item in it. That includes everyone's listening progress on those items, and their places in playlists. This can't be undone. Files on disk are kept.`}
        confirmText={library.name}
        confirmLabel="Remove and save"
        onConfirm={() => void commit()}
      />
    </SettingsPanel>
  )
}
