/** Library tools. These run right away and are not part of Save. */
import { useRef, useState } from 'react'
import type { LibraryDraftState } from '@/admin/LibraryDraft'
import { LibraryDraftScreen } from '@/admin/LibraryDraftScreen'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  matchAllLibraryItems,
  removeLibraryMetadata,
  type LibraryMetadataExt,
} from '@/api/admin/libraries'
import { confirm } from '@/ui/confirm'
import { AppText, type SheetRef } from '@/ui/primitives'
import { SettingsGroup, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { showToast } from '@/ui/Toast'

const METADATA_FILE: Record<LibraryMetadataExt, string> = {
  json: 'metadata.json',
  abs: 'metadata.abs',
}

export default function LibraryToolsScreen() {
  return <LibraryDraftScreen>{(state) => <Tools state={state} />}</LibraryDraftScreen>
}

function removedMessage(file: string, found: number, removed: number): string {
  if (found === 0) return `No ${file} files found.`
  if (removed < found) return `Removed ${removed} of ${found} ${file} files.`
  return `Removed ${removed} ${file} file${removed === 1 ? '' : 's'}.`
}

function Tools({ state }: { state: LibraryDraftState }) {
  const colors = useColors()
  const { library } = state
  const { run, busy } = useAdminWrite()
  const removeSheet = useRef<SheetRef>(null)
  const [ext, setExt] = useState<LibraryMetadataExt>('json')
  const file = METADATA_FILE[ext]

  async function matchAll() {
    const ok = await confirm({
      title: 'Match all books?',
      message: `Every book in ${library.name} will be matched against its metadata source. This runs in the background and may replace book details.`,
      confirmLabel: 'Match all',
    })
    if (!ok) return
    await run(() => matchAllLibraryItems(library.id), {
      done: 'Matching started',
      failed: "Couldn't start matching.",
    })
  }

  function askRemove(next: LibraryMetadataExt) {
    setExt(next)
    removeSheet.current?.present()
  }

  function remove() {
    void run(
      async () => {
        const { found, removed } = await removeLibraryMetadata(library.id, ext)
        showToast(removedMessage(file, found, removed))
      },
      { failed: `Couldn't remove the ${file} files.` },
    )
  }

  return (
    <SettingsPanel>
      <AppText variant="meta" color={colors.textMuted}>
        These run right away. They don&apos;t wait for Save.
      </AppText>
      <SettingsGroup>
        {library.mediaType === 'book' ? (
          <SettingsRow
            icon="auto-fix-high"
            title="Match all books"
            desc="Look up every book in the metadata source."
            onPress={busy ? undefined : () => void matchAll()}
          />
        ) : null}
        <SettingsRow
          icon="delete"
          title="Remove metadata.json files"
          desc="Delete them from every item folder on disk."
          danger
          onPress={busy ? undefined : () => askRemove('json')}
        />
        <SettingsRow
          icon="delete"
          title="Remove metadata.abs files"
          desc="Delete them from every item folder on disk."
          danger
          onPress={busy ? undefined : () => askRemove('abs')}
          last
        />
      </SettingsGroup>

      <TypedConfirm
        ref={removeSheet}
        title="Remove metadata files?"
        message={`This deletes the ${file} file in every item folder of ${library.name}, on the server's disk. Details saved only in those files are lost. This can't be undone.`}
        confirmText={library.name}
        confirmLabel="Remove files"
        onConfirm={remove}
      />
    </SettingsPanel>
  )
}
