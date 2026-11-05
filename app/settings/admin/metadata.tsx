/** Tags and genres: rename or remove one across every item on the server. */
import { useRef, useState } from 'react'
import { FlatList, View } from 'react-native'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  deleteMetadataName,
  getMetadataNames,
  renameMetadataName,
  type MetadataKind,
} from '@/api/admin/metadata'
import { confirm } from '@/ui/confirm'
import { AppText, IconButton, Sheet, type SheetRef } from '@/ui/primitives'
import { Seg } from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'

const KINDS: { value: MetadataKind; label: string }[] = [
  { value: 'genres', label: 'Genres' },
  { value: 'tags', label: 'Tags' },
]

export default function MetadataScreen() {
  return (
    <AdminGate>
      <Metadata />
    </AdminGate>
  )
}

function Metadata() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const { run, busy } = useAdminWrite()
  const [kind, setKind] = useState<MetadataKind>('genres')
  const genres = useAdminResource(() => getMetadataNames('genres'))
  const tags = useAdminResource(() => getMetadataNames('tags'))
  const active = kind === 'tags' ? tags : genres
  const names = active.data ?? []
  const noun = kind === 'tags' ? 'tag' : 'genre'

  const renameSheet = useRef<SheetRef>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const trimmed = newName.trim()
  const merges = trimmed !== renaming && names.includes(trimmed)

  function openRename(name: string) {
    setRenaming(name)
    setNewName(name)
    renameSheet.current?.present()
  }

  async function rename() {
    if (!renaming) return
    const ok = await run(() => renameMetadataName(kind, renaming, trimmed), {
      done: `Renamed to ${trimmed}`,
      failed: `Couldn't rename that ${noun}.`,
      reload: active.reload,
    })
    if (ok) renameSheet.current?.dismiss()
  }

  async function remove(name: string) {
    const yes = await confirm({
      title: `Delete this ${noun}?`,
      message: `This removes "${name}" from every item that uses it. You can't undo this.`,
      confirmLabel: 'Delete',
    })
    if (!yes) return
    await run(() => deleteMetadataName(kind, name), {
      done: `Deleted ${name}`,
      failed: `Couldn't delete that ${noun}.`,
      reload: active.reload,
    })
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: spacing.lg, gap: spacing.sm }}>
        <Seg value={kind} onChange={setKind} options={KINDS} fill label="Show" />
        {active.data ? (
          <AppText variant="caption" color={colors.textMuted}>
            {`${names.length} ${names.length === 1 ? noun : kind}`}
          </AppText>
        ) : null}
      </View>

      {active.error && !active.data ? (
        <AdminUnavailable error={active.error} onRetry={active.reload} />
      ) : active.loading ? (
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : (
        <FlatList
          data={names}
          keyExtractor={(name) => name}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: bottomInset }}
          ListEmptyComponent={
            <EmptyState
              icon="sell"
              title={`No ${kind} yet`}
              body={`${kind === 'tags' ? 'Tags' : 'Genres'} show up here once a book has one.`}
            />
          }
          renderItem={({ item }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.lg,
                paddingVertical: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: colors.hairline,
              }}
            >
              <AppText variant="body" style={{ flex: 1 }}>
                {item}
              </AppText>
              <IconButton
                name="edit"
                size={22}
                color={colors.textMuted}
                accessibilityLabel={`Rename ${item}`}
                onPress={() => openRename(item)}
              />
              <IconButton
                name="delete"
                size={22}
                color={colors.textMuted}
                accessibilityLabel={`Delete ${item}`}
                onPress={() => void remove(item)}
              />
            </View>
          )}
        />
      )}

      <Sheet ref={renameSheet} title={`Rename ${noun}`} onDismiss={() => setRenaming(null)}>
        <View style={{ gap: spacing.md }}>
          <AdminField
            inSheet
            label="New name"
            autoCapitalize="sentences"
            value={newName}
            onChangeText={setNewName}
            hint={
              merges
                ? `"${trimmed}" already exists. The two will become one, and you can't split them again.`
                : `This changes every item using "${renaming ?? ''}".`
            }
          />
          <AdminButton
            label={merges ? 'Merge' : 'Rename'}
            busy={busy}
            disabled={!trimmed || trimmed === renaming}
            onPress={() => void rename()}
          />
        </View>
      </Sheet>
    </View>
  )
}
