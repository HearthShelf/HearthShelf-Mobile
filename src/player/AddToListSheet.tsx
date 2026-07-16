/**
 * Add a book to an existing collection/playlist, or create a new one containing
 * it. Ported from the WebApp's AddToListModal.tsx (Collection/Playlist tabs,
 * type-a-name-to-create) - the real feature, replacing the design mock's
 * single hardcoded "Want to listen" watchlist assumption.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native'
import type { ABSCollection, ABSPlaylist, QueueEntry } from '@hearthshelf/core'
import {
  addBookToCollection,
  addBooksToCollection,
  addItemToPlaylist,
  addItemsToPlaylist,
  createCollection,
  createPlaylist,
  getLibraryCollections,
  getLibraryPlaylists,
} from '@/api/abs'
import { addToQueue, getQueueState, subscribeQueue } from './queue'
import { AppText, IconButton, Sheet, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import type { SheetHandle } from './sheets'

type Tab = 'queue' | 'collection' | 'playlist'

export const AddToListSheet = forwardRef<
  SheetHandle,
  {
    libraryId: string
    /** A single book, or several for a bulk add. Exactly one of these is set. */
    libraryItemId?: string
    libraryItemIds?: string[]
    /** When provided, a "Queue" tab appears that adds these to the up-next
     *  manual queue. Carries title/author so the queue entry is self-contained;
     *  callers that can't supply them omit this and the Queue tab is hidden. */
    queueEntries?: QueueEntry[]
    onAdded: (message: string) => void
  }
>(function AddToListSheet({ libraryId, libraryItemId, libraryItemIds, queueEntries, onAdded }, ref) {
  // Normalize single/bulk callers to one id list.
  const ids = libraryItemIds ?? (libraryItemId ? [libraryItemId] : [])
  const canQueue = (queueEntries?.length ?? 0) > 0
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [tab, setTab] = useState<Tab>(canQueue ? 'queue' : 'collection')
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const queuedIds = useMemo(
    () => new Set(queue.manual.map((m) => m.libraryItemId)),
    [queue.manual],
  )
  const [collections, setCollections] = useState<ABSCollection[] | null>(null)
  const [playlists, setPlaylists] = useState<ABSPlaylist[] | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getLibraryCollections(libraryId)
      .then(setCollections)
      .catch(() => setCollections([]))
    getLibraryPlaylists(libraryId)
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
  }, [libraryId])

  const finish = (message: string) => {
    onAdded(message)
    sheetRef.current?.dismiss()
  }

  const suffix = ids.length > 1 ? ` (${ids.length})` : ''

  const addToUpNext = () => {
    const entries = queueEntries ?? []
    let added = 0
    for (const e of entries) {
      if (queuedIds.has(e.libraryItemId)) continue
      addToQueue(e)
      added += 1
    }
    finish(
      added === 0
        ? 'Already in your queue'
        : `Added to up next${added > 1 ? ` (${added})` : ''}`,
    )
  }

  const addToCollection = async (id: string, name: string) => {
    if (!ids.length) return
    setBusy(true)
    try {
      if (ids.length === 1) await addBookToCollection(id, ids[0])
      else await addBooksToCollection(id, ids)
      finish(`Added to ${name}${suffix}`)
    } finally {
      setBusy(false)
    }
  }
  const addToPlaylist = async (id: string, name: string) => {
    if (!ids.length) return
    setBusy(true)
    try {
      if (ids.length === 1) await addItemToPlaylist(id, ids[0])
      else await addItemsToPlaylist(id, ids)
      finish(`Added to ${name}${suffix}`)
    } finally {
      setBusy(false)
    }
  }
  const createNew = async () => {
    const name = newName.trim()
    if (!name || !ids.length) return
    setBusy(true)
    try {
      if (tab === 'collection') await createCollection(libraryId, name, ids)
      else
        await createPlaylist(
          libraryId,
          name,
          ids.map((libraryItemId) => ({ libraryItemId })),
        )
      setNewName('')
      finish(`Created ${name}${suffix}`)
    } finally {
      setBusy(false)
    }
  }

  const lists = tab === 'collection' ? collections : playlists
  const loading = lists === null

  return (
    <Sheet ref={sheetRef} title="Add to list" snapPoints={['70%']}>
      <View style={styles.segFull}>
        {(canQueue ? (['queue', 'collection', 'playlist'] as Tab[]) : (['collection', 'playlist'] as Tab[])).map((t) => (
          <Pressable
            key={t}
            style={[styles.seg, tab === t && styles.segOn]}
            onPress={() => setTab(t)}
          >
            <AppText
              variant="label"
              color={tab === t ? colors.text : colors.textMuted}
              style={{ textTransform: 'capitalize' }}
            >
              {t === 'queue' ? 'Queue' : `${t}s`}
            </AppText>
          </Pressable>
        ))}
      </View>

      {tab === 'queue' ? (
        <View>
          <AppText variant="meta" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
            Add {ids.length > 1 ? `these ${ids.length} books` : 'this book'} to your up-next
            queue. In Auto mode they play after your Auto picks.
          </AppText>
          <Pressable
            style={[styles.queueBtn, busy && { opacity: 0.5 }]}
            disabled={busy}
            onPress={addToUpNext}
          >
            <Icon name={icons.queue} size={18} color={colors.onAccent} />
            <AppText variant="label" color={colors.onAccent}>
              Add to up next
            </AppText>
          </Pressable>
        </View>
      ) : (
        <>
      <View style={styles.createRow}>
        <TextInput
          style={styles.input}
          placeholder={`New ${tab} name…`}
          placeholderTextColor={colors.textFaint}
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={() => void createNew()}
        />
        <Pressable
          style={[styles.createBtn, (!newName.trim() || busy) && { opacity: 0.5 }]}
          disabled={!newName.trim() || busy}
          onPress={() => void createNew()}
        >
          <Icon name={icons.check} size={16} color={colors.onAccent} />
          <AppText variant="label" color={colors.onAccent}>
            Create
          </AppText>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : lists.length === 0 ? (
        <AppText
          variant="meta"
          color={colors.textMuted}
          style={{ textAlign: 'center', marginTop: spacing.xl }}
        >
          No {tab}s yet. Create one above.
        </AppText>
      ) : (
        <View>
          {lists.map((l) => (
            <Pressable
              key={l.id}
              style={styles.row}
              disabled={busy}
              onPress={() =>
                tab === 'collection'
                  ? void addToCollection(l.id, l.name)
                  : void addToPlaylist(l.id, l.name)
              }
            >
              <View style={styles.rowIcon}>
                <Icon
                  name={tab === 'collection' ? icons.checkCircle : icons.chapters}
                  size={18}
                  color={colors.textMuted}
                />
              </View>
              <AppText variant="body" style={{ flex: 1 }} numberOfLines={1}>
                {l.name}
              </AppText>
              <IconButton name={icons.check} color={colors.textMuted} size={20} />
            </Pressable>
          ))}
        </View>
      )}
        </>
      )}
    </Sheet>
  )
})

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  segFull: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: colors.fill,
    borderRadius: radius.card,
    padding: 4,
    marginBottom: spacing.lg,
  },
  seg: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.row },
  segOn: { backgroundColor: colors.card },
  createRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderRadius: radius.row,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  createBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.row,
    backgroundColor: colors.accent,
  },
  queueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.accent,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
