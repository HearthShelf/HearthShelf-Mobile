/** New library: a name, a type, and one folder the server has confirmed. */
import { useState } from 'react'
import { useRouter } from 'expo-router'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { normalizeLibraryPath } from '@/admin/LibraryDraft'
import { LibraryPathField, useLibraryPathCheck } from '@/admin/LibraryPathField'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  createLibrary,
  getLibraries,
  scanLibrary,
  type LibraryMediaType,
} from '@/api/admin/libraries'
import { Seg, SettingsGroup, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { showToast } from '@/ui/Toast'

export default function NewLibraryScreen() {
  return (
    <AdminGate>
      <NewLibrary />
    </AdminGate>
  )
}

function NewLibrary() {
  const router = useRouter()
  const { run, busy } = useAdminWrite()
  const path = useLibraryPathCheck()
  const [name, setName] = useState('')
  const [mediaType, setMediaType] = useState<LibraryMediaType>('book')
  const [fullPath, setFullPath] = useState('')
  // A create that timed out may have worked. This reloads after one, so trying again
  // is stopped here rather than making a second library on the same folder.
  const libraries = useAdminResource(getLibraries)
  const folder = normalizeLibraryPath(fullPath)
  const folderInUse = libraries.data?.some((l) => l.folders.some((f) => f.fullPath === folder))

  function checkPath() {
    if (folder) void path.check(folder)
  }

  async function create() {
    // Everything stays inside run so a second tap can't create the library twice.
    await run(
      async () => {
        const library = await createLibrary({
          name: name.trim(),
          mediaType,
          fullPath: folder,
        })
        // The server doesn't scan a new library by itself, and it stays empty until one runs.
        try {
          await scanLibrary(library.id)
          showToast('Library created. Scanning it now.')
        } catch {
          showToast('Library created, but the scan did not start. Start it from your libraries.')
        }
        router.back()
      },
      { failed: "Couldn't create the library.", reload: libraries.reload },
    )
  }

  return (
    <SettingsPanel>
      <AdminField
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        placeholder="Audiobooks"
      />
      <SettingsGroup>
        <SettingsRow
          title="Type"
          last
          control={
            <Seg
              value={mediaType}
              onChange={setMediaType}
              options={[
                { value: 'book', label: 'Books' },
                { value: 'podcast', label: 'Podcasts' },
              ]}
            />
          }
        />
      </SettingsGroup>
      <LibraryPathField
        value={fullPath}
        onChangeText={(value) => {
          setFullPath(value)
          path.reset()
        }}
        state={path.state}
        problem={folderInUse ? 'A library already uses this folder.' : undefined}
        onSubmit={checkPath}
        onBlur={checkPath}
      />
      <AdminButton
        label="Create library"
        icon="add"
        onPress={() => void create()}
        disabled={!name.trim() || path.state !== 'exists' || folderInUse}
        busy={busy}
      />
    </SettingsPanel>
  )
}
