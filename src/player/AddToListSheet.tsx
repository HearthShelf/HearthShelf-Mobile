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
import { enqueueClubBook, getClubs, type ClubSummary } from '@/api/clubs'
import { getMeId } from '@/api/me'
import { addToQueue, getQueueState, subscribeQueue } from './queue'
import { AppText, IconButton, Sheet, type SheetRef } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import type { SheetHandle } from './sheets'

type Tab = 'queue' | 'collection' | 'playlist' | 'club'

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
>(function AddToListSheet(
  { libraryId, libraryItemId, libraryItemIds, queueEntries, onAdded },
  ref,
) {
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
  const queuedIds = useMemo(() => new Set(queue.manual.map((m) => m.libraryItemId)), [queue.manual])
  const [collections, setCollections] = useState<ABSCollection[] | null>(null)
  const [playlists, setPlaylists] = useState<ABSPlaylist[] | null>(null)
  const [collectionsFailed, setCollectionsFailed] = useState(false)
  const [playlistsFailed, setPlaylistsFailed] = useState(false)
  const [clubs, setClubs] = useState<ClubSummary[] | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    // An empty array here would render as "No collections yet. Create one above."
    // - which is a lie when the fetch failed, and the lie is worst on exactly the
    // servers that fail: a big list library, where creating a duplicate is the
    // likely next move. Track the failure separately and say so.
    setCollectionsFailed(false)
    setPlaylistsFailed(false)
    getLibraryCollections(libraryId)
      .then(setCollections)
      .catch(() => {
        setCollections([])
        setCollectionsFailed(true)
      })
    getLibraryPlaylists(libraryId)
      .then(setPlaylists)
      .catch(() => {
        setPlaylists([])
        setPlaylistsFailed(true)
      })
    void getClubs()
      .then((response) => {
        const meId = getMeId()
        // Adding a club book is owner-only. Keep clubs where ownership is known;
        // if identity has not hydrated yet, let the server remain the final gate.
        setClubs(response.mine.filter((club) => !meId || club.createdBy === meId))
      })
      .catch(() => setClubs([]))
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
      added === 0 ? 'Already in your queue' : `Added to up next${added > 1 ? ` (${added})` : ''}`,
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
  const addToClub = async (club: ClubSummary) => {
    if (!ids.length) return
    setBusy(true)
    setErrorMessage('')
    let added = 0
    try {
      // The server derives queue order from the current maximum, so preserve the
      // selected order and wait for each insertion before sending the next.
      for (const libraryItemId of ids) {
        if (await enqueueClubBook(club.id, libraryItemId)) added += 1
      }
      if (added === ids.length) {
        finish(`Added to ${club.name}${suffix}`)
      } else if (added > 0) {
        finish(`Added ${added} of ${ids.length} to ${club.name}`)
      } else {
        setErrorMessage(`Could not add to ${club.name}`)
      }
    } catch {
      setErrorMessage(`Could not add to ${club.name}`)
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
  const listsFailed = tab === 'collection' ? collectionsFailed : playlistsFailed

  return (
    <Sheet ref={sheetRef} title="Add to list" snapPoints={['70%']}>
      <View style={styles.segFull}>
        {(
          [
            ...(canQueue ? (['queue'] as Tab[]) : []),
            'collection',
            'playlist',
            ...((clubs?.length ?? 0) > 0 ? (['club'] as Tab[]) : []),
          ] as Tab[]
        ).map((t) => (
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
              {t === 'queue' ? 'Queue' : t === 'club' ? 'Book Clubs' : `${t}s`}
            </AppText>
          </Pressable>
        ))}
      </View>

      {tab === 'queue' ? (
        <View>
          <AppText variant="meta" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
            Add {ids.length > 1 ? `these ${ids.length} books` : 'this book'} to your up-next queue.
            In Auto mode they play after your Auto picks.
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
      ) : tab === 'club' ? (
        <View>
          <AppText variant="meta" color={colors.textMuted} style={{ marginBottom: spacing.md }}>
            Add {ids.length > 1 ? `these ${ids.length} books` : 'this book'} to a club&apos;s
            up-next list.
          </AppText>
          {clubs === null ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
          ) : (
            clubs.map((club) => (
              <Pressable
                key={club.id}
                style={styles.row}
                disabled={busy}
                onPress={() => void addToClub(club)}
                accessibilityRole="button"
                accessibilityLabel={`Add to ${club.name}`}
              >
                <View style={styles.rowIcon}>
                  <Icon name={icons.club} size={18} color={colors.textMuted} />
                </View>
                <AppText variant="body" style={{ flex: 1 }} numberOfLines={1}>
                  {club.name}
                </AppText>
                <Icon name={icons.add} size={20} color={colors.textMuted} />
              </Pressable>
            ))
          )}
          {errorMessage ? (
            <AppText variant="meta" color={colors.destructive} style={styles.errorMessage}>
              {errorMessage}
            </AppText>
          ) : null}
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
          ) : listsFailed ? (
            <AppText
              variant="meta"
              color={colors.textMuted}
              style={{ textAlign: 'center', marginTop: spacing.xl }}
            >
              Could not load your {tab}s. Check your connection and try again.
            </AppText>
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
    seg: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.row,
    },
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
      minHeight: 48,
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
    errorMessage: { marginTop: spacing.md, textAlign: 'center' },
  })
