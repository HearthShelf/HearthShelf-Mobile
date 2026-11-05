/** Library details: name, metadata source, icon and folders. */
import { useState } from 'react'
import { View } from 'react-native'
import { LIBRARY_ICON_OPTIONS } from '@hearthshelf/core'
import { AdminField } from '@/admin/AdminField'
import {
  normalizeLibraryPath,
  patchLibraryDraft,
  removedLibraryFolders,
  restoreLibraryFolder,
  type LibraryDraftState,
} from '@/admin/LibraryDraft'
import { LibraryDraftScreen } from '@/admin/LibraryDraftScreen'
import { LibraryPathField, useLibraryPathCheck } from '@/admin/LibraryPathField'
import { LibraryPicker, withCurrentOption } from '@/admin/LibraryPicker'
import { useAdminResource } from '@/admin/useAdminResource'
import { getSearchProviders } from '@/api/admin/libraries'
import { AppText, IconButton } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export default function LibraryDetailsScreen() {
  return <LibraryDraftScreen>{(state) => <Details state={state} />}</LibraryDraftScreen>
}

function Details({ state }: { state: LibraryDraftState }) {
  const colors = useColors()
  const { library, draft } = state
  const providers = useAdminResource(getSearchProviders)
  const path = useLibraryPathCheck()
  const [newPath, setNewPath] = useState('')
  const [pathProblem, setPathProblem] = useState<string>()
  const removed = removedLibraryFolders(state)

  const listed = library.mediaType === 'book' ? providers.data?.books : providers.data?.podcasts
  const providerOptions = withCurrentOption(
    (listed ?? []).map((p) => ({ value: p.value, label: p.text })),
    draft.provider,
  )

  async function addFolder() {
    const fullPath = normalizeLibraryPath(newPath)
    if (!fullPath) return
    if (draft.folders.some((f) => f.fullPath === fullPath)) {
      setPathProblem('This folder is already in the library.')
      return
    }
    const wasRemoved = removed.find((f) => f.fullPath === fullPath)
    if (wasRemoved) {
      restoreLibraryFolder(state, wasRemoved.id)
    } else {
      if ((await path.check(fullPath)) !== 'exists') return
      patchLibraryDraft({ folders: [...draft.folders, { fullPath }] })
    }
    setNewPath('')
    path.reset()
  }

  return (
    <SettingsPanel>
      <AdminField
        label="Name"
        value={draft.name}
        onChangeText={(name) => patchLibraryDraft({ name })}
        autoCapitalize="words"
      />
      <SettingsGroup>
        <LibraryPicker
          title="Metadata source"
          value={draft.provider}
          options={providerOptions}
          onChange={(provider) => patchLibraryDraft({ provider })}
        />
        <LibraryPicker
          title="Icon"
          value={draft.icon}
          options={withCurrentOption(
            LIBRARY_ICON_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
            draft.icon,
          )}
          onChange={(icon) => patchLibraryDraft({ icon })}
          last
        />
      </SettingsGroup>
      {providers.error ? (
        <AppText variant="meta" color={colors.textMuted}>
          We couldn&apos;t load the list of metadata sources.
        </AppText>
      ) : null}

      <View>
        <SettingsLabel>Folders</SettingsLabel>
        <SettingsGroup>
          {draft.folders.map((folder, i) => (
            <SettingsRow
              key={folder.id ?? folder.fullPath}
              icon="folder"
              title={folder.fullPath}
              desc={folder.id ? undefined : 'New. Added when you save.'}
              last={i === draft.folders.length - 1 && removed.length === 0}
              control={
                draft.folders.length > 1 ? (
                  <IconButton
                    name="close"
                    size={20}
                    color={colors.textMuted}
                    accessibilityLabel={`Remove ${folder.fullPath}`}
                    onPress={() =>
                      patchLibraryDraft({ folders: draft.folders.filter((_, x) => x !== i) })
                    }
                  />
                ) : undefined
              }
            />
          ))}
          {removed.map((folder, i) => (
            <SettingsRow
              key={folder.id}
              icon="folder-off"
              title={folder.fullPath}
              desc="Removed when you save, with its items."
              descColor={colors.destructive}
              last={i === removed.length - 1}
              control={
                <IconButton
                  name="undo"
                  size={20}
                  color={colors.textMuted}
                  accessibilityLabel={`Keep ${folder.fullPath}`}
                  onPress={() => restoreLibraryFolder(state, folder.id)}
                />
              }
            />
          ))}
        </SettingsGroup>
        {draft.folders.length === 1 ? (
          <AppText
            variant="caption"
            color={colors.textMuted}
            style={{ paddingHorizontal: spacing.xs, marginTop: spacing.xs }}
          >
            A library needs at least one folder. Add another to remove this one.
          </AppText>
        ) : null}
      </View>

      <LibraryPathField
        label="Add a folder"
        actionLabel="Check and add"
        value={newPath}
        onChangeText={(value) => {
          setNewPath(value)
          setPathProblem(undefined)
          path.reset()
        }}
        state={path.state}
        problem={pathProblem}
        onSubmit={() => void addFolder()}
      />
    </SettingsPanel>
  )
}
