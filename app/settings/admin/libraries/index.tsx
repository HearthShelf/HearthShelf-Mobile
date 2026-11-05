/** Libraries: scan, reorder, and the way into editing, creating and deleting. */
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import type { ABSLibrary } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { deleteLibrary, getLibraries, reorderLibraries, scanLibrary } from '@/api/admin/libraries'
import { confirm } from '@/ui/confirm'
import { Icon, icons } from '@/ui/icons'
import { AppText, IconButton, Sheet, type SheetRef } from '@/ui/primitives'
import { SettingsGroup, SettingsRow } from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'

export default function LibrariesScreen() {
  return (
    <AdminGate>
      <Libraries />
    </AdminGate>
  )
}

function Libraries() {
  const router = useRouter()
  const colors = useColors()
  const bottomInset = useContentInset()
  const libraries = useAdminResource(getLibraries)
  const action = useAdminWrite()
  const order = useAdminWrite()
  const menuSheet = useRef<SheetRef>(null)
  const deleteSheet = useRef<SheetRef>(null)
  const [menuFor, setMenuFor] = useState<ABSLibrary | null>(null)
  const [deleting, setDeleting] = useState<ABSLibrary | null>(null)

  // The list renders from local state: swapping its data mid-drop can strand the
  // gesture. A failed save reloads, and that new data puts the old order back.
  const [rows, setRows] = useState<ABSLibrary[]>([])
  useEffect(() => {
    if (libraries.data) setRows(libraries.data)
  }, [libraries.data])

  if (libraries.error && !libraries.data) {
    return <AdminUnavailable error={libraries.error} onRetry={libraries.reload} />
  }

  function saveOrder(next: ABSLibrary[]) {
    setRows(next)
    void order.run(() => reorderLibraries(next.map((l, i) => ({ id: l.id, newOrder: i }))), {
      failed: "Couldn't save the new order.",
      reload: libraries.reload,
    })
  }

  function move(library: ABSLibrary, by: -1 | 1) {
    const from = rows.findIndex((l) => l.id === library.id)
    const to = from + by
    if (from < 0 || to < 0 || to >= rows.length) return
    const next = [...rows]
    next.splice(from, 1)
    next.splice(to, 0, library)
    saveOrder(next)
  }

  function scan(library: ABSLibrary) {
    void action.run(() => scanLibrary(library.id), {
      done: `Scanning ${library.name}`,
      failed: `Couldn't start a scan of ${library.name}.`,
    })
  }

  async function forceScan(library: ABSLibrary) {
    const ok = await confirm({
      title: `Force scan ${library.name}?`,
      message:
        "This reads every file again, even ones that haven't changed. It can take a long time, and book details may change to match the files.",
      confirmLabel: 'Force scan',
    })
    if (!ok) return
    await action.run(() => scanLibrary(library.id, true), {
      done: `Scanning all of ${library.name}`,
      failed: `Couldn't start a scan of ${library.name}.`,
    })
  }

  function fromMenu(run: (library: ABSLibrary) => void) {
    menuSheet.current?.dismiss()
    if (menuFor) run(menuFor)
  }

  const menuIndex = menuFor ? rows.findIndex((l) => l.id === menuFor.id) : -1

  return (
    <GestureHandlerRootView style={styles.screen}>
      <View style={styles.top}>
        <AdminButton
          label="New library"
          icon="add"
          onPress={() => router.push('/settings/admin/libraries/new')}
        />
        {rows.length > 1 ? (
          <AppText variant="caption" color={colors.textFaint}>
            Hold a library to drag it. This is the order everyone sees.
          </AppText>
        ) : null}
      </View>

      {libraries.loading ? (
        <View style={styles.loading}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={icons.notInterested}
          title="No libraries yet"
          body="Add a library to start sharing your books."
        />
      ) : (
        <DraggableFlatList
          data={rows}
          containerStyle={styles.fill}
          keyExtractor={(library) => library.id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomInset }]}
          onDragEnd={({ data }) => saveOrder(data)}
          renderItem={(params) => (
            <LibraryRow
              {...params}
              canDrag={!order.busy}
              scanDisabled={action.busy}
              onOpen={() => router.push(`/settings/admin/libraries/${params.item.id}`)}
              onScan={() => scan(params.item)}
              onMenu={() => {
                setMenuFor(params.item)
                menuSheet.current?.present()
              }}
            />
          )}
        />
      )}

      <Sheet ref={menuSheet} title={menuFor?.name}>
        <SettingsGroup>
          <SettingsRow
            icon="sync"
            title="Force scan"
            desc="Read every file again."
            onPress={() => fromMenu((l) => void forceScan(l))}
          />
          {menuIndex > 0 ? (
            <SettingsRow
              icon={icons.arrowUpward}
              title="Move up"
              onPress={() => fromMenu((l) => move(l, -1))}
            />
          ) : null}
          {menuIndex >= 0 && menuIndex < rows.length - 1 ? (
            <SettingsRow
              icon="arrow-downward"
              title="Move down"
              onPress={() => fromMenu((l) => move(l, 1))}
            />
          ) : null}
          <SettingsRow
            icon="delete"
            title="Delete library"
            danger
            last
            onPress={() =>
              fromMenu((l) => {
                setDeleting(l)
                deleteSheet.current?.present()
              })
            }
          />
        </SettingsGroup>
      </Sheet>

      <TypedConfirm
        ref={deleteSheet}
        title="Delete library?"
        message={`${deleting?.name ?? 'This library'} and everything in it will be removed from the server. That includes everyone's listening progress on its books, its collections, and its books in playlists. This can't be undone. Files on disk are kept.`}
        confirmText={deleting?.name ?? ''}
        confirmLabel="Delete library"
        onConfirm={() => {
          if (!deleting) return
          void action.run(() => deleteLibrary(deleting.id), {
            done: `Deleted ${deleting.name}`,
            failed: `Couldn't delete ${deleting.name}.`,
            reload: libraries.reload,
          })
        }}
      />
    </GestureHandlerRootView>
  )
}

function LibraryRow({
  item,
  drag,
  isActive,
  canDrag,
  scanDisabled,
  onOpen,
  onScan,
  onMenu,
}: RenderItemParams<ABSLibrary> & {
  canDrag: boolean
  scanDisabled: boolean
  onOpen: () => void
  onScan: () => void
  onMenu: () => void
}) {
  const colors = useColors()
  const podcast = item.mediaType === 'podcast'
  const folders = item.folders.length
  return (
    <Pressable
      onPress={onOpen}
      onLongPress={canDrag ? drag : undefined}
      delayLongPress={150}
      accessibilityRole="button"
      accessibilityLabel={`Edit ${item.name}`}
      style={[styles.row, { backgroundColor: isActive ? colors.fillStrong : colors.fill }]}
    >
      <Icon name={icons.dragHandle} size={22} color={colors.textMuted} />
      <Icon name={podcast ? 'podcasts' : 'menu-book'} size={20} color={colors.accent} />
      <View style={{ flex: 1 }}>
        <AppText variant="body" numberOfLines={1}>
          {item.name}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {`${podcast ? 'Podcasts' : 'Audiobooks'} · ${folders} folder${folders === 1 ? '' : 's'}`}
        </AppText>
      </View>
      <IconButton
        name="sync"
        size={22}
        color={scanDisabled ? colors.textFaint : colors.textMuted}
        onPress={scanDisabled ? undefined : onScan}
        accessibilityLabel={`Scan ${item.name}`}
      />
      <IconButton
        name="more-vert"
        size={22}
        color={colors.textMuted}
        onPress={onMenu}
        accessibilityLabel={`More for ${item.name}`}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  top: { padding: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
  loading: { padding: spacing.lg, gap: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 56,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.row,
  },
})
