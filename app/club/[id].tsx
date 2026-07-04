/**
 * Book Club room. A club moves through books together: one current book plus a
 * readable history of past ones. The screen has three parts for the book being
 * viewed (the current book by default):
 *
 *  - A member progress race: every member's position in this book as a
 *    horizontal bar (avatar, finished check, a pulse when listening recently),
 *    ordered by progress (finished first) via core's sortMembersByProgress.
 *  - The chat: timestamped notes form a per-book thread. Notes made while
 *    playing this book carry a 'Chapter X - H:MM:SS' label; general notes don't.
 *    One level of replies. Owner/admin can delete any note; anyone deletes own.
 *  - A book-history strip to jump back to a past book and read its (final) chat.
 *
 * Spoiler-safe: the server only sends notes at or behind the caller's position
 * in the viewed book (plus their own and, once finished, all). Reading the
 * thread at the bottom bumps the per-club unread cursor (PUT /read, max()).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { HSClubBook, HSClubDetail, HSClubMember, HSNote } from '@hearthshelf/core'
import { coverHue, formatTimestamp, sortMembersByProgress } from '@hearthshelf/core'
import {
  getClub,
  setClubMembership,
  markClubRead,
  archiveClub,
  deleteClub,
  kickClubMember,
  setClubCurrentBook,
  removeClubQueued,
} from '@/api/clubs'
import { holdClubPolling } from '@/player/clubSync'
import { useMiniPlayerInset } from '@/ui/useContentInset'
import { postNote, deleteNote } from '@/api/notes'
import { getMeId } from '@/api/me'
import { coverUrl, avatarUrl } from '@/api/abs'
import { getState as getPlayerState, subscribe as subscribePlayer } from '@/player/store'
import { NoteThread, type ChapterMark } from '@/social/NoteThread'
import { SafeSwitch } from '@/social/NoteComposerControls'
import {
  AppText,
  Avatar,
  Centered,
  Cover,
  IconButton,
  Loading,
  Screen,
  Sheet,
  Touchable,
  type SheetRef,
  icons,
} from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { AppTabBar } from '@/ui/AppTabBar'
import { Toast, useToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { confirm } from '@/ui/confirm'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

// Poll the room while it's open so other members' notes/progress stay fresh
// without a realtime channel (the house 15s cadence, matching the design doc).
const ROOM_POLL_MS = 15_000

export default function ClubRoomScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  // `note` is an optional deep-link param (hearthshelf://club/:id?note=:noteId),
  // set by Phase 7 note-pop notifications - see docs/social.md. On open, the
  // thread scrolls to and highlights that note (see scrollToDeepLink below).
  const { id, note: deepLinkNoteId } = useLocalSearchParams<{ id: string; note?: string }>()
  const { message, show } = useToast()
  const meId = getMeId()

  const player = useSyncExternalStore(subscribePlayer, getPlayerState)
  // Clearance so the composer/join bar sits above the docked mini player.
  const miniInset = useMiniPlayerInset()

  const [detail, setDetail] = useState<HSClubDetail | null>(null)
  const [loadError, setLoadError] = useState(false)
  // Which book of the history is being viewed; undefined = the current book.
  const [viewBookId, setViewBookId] = useState<string | undefined>(undefined)
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<HSNote | null>(null)
  const [safe, setSafe] = useState(false)
  const [busy, setBusy] = useState(false)

  const membersSheetRef = useRef<SheetRef>(null)
  const historySheetRef = useRef<SheetRef>(null)
  const ownerSheetRef = useRef<SheetRef>(null)

  // Deep-link scroll: when opened from a note-pop notification, scroll the thread
  // to the note and briefly highlight it. `highlightId` clears after the flash so
  // re-scrolling on later renders doesn't yank the view. A ref tracks whether we
  // already scrolled for this note id, so the 15s poll re-render doesn't re-scroll.
  const scrollRef = useRef<ScrollView>(null)
  const [highlightId, setHighlightId] = useState<string | null>(deepLinkNoteId ?? null)
  const scrolledForRef = useRef<string | null>(null)

  // The chat section's y within the scroll content, plus the target note's y
  // within the thread, combine into the absolute scroll offset. Captured lazily:
  // whichever of the two fires last triggers the scroll.
  const chatSectionYRef = useRef(0)
  const noteYRef = useRef<number | null>(null)

  const tryScrollToDeepLink = useCallback(() => {
    if (!deepLinkNoteId || scrolledForRef.current === deepLinkNoteId) return
    if (noteYRef.current == null) return
    scrolledForRef.current = deepLinkNoteId
    const y = chatSectionYRef.current + noteYRef.current
    // Nudge up a little so the highlighted note isn't flush against the top.
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true })
    // Clear the highlight after a moment so it reads as a flash, not a stuck state.
    setTimeout(() => setHighlightId(null), 2400)
  }, [deepLinkNoteId])

  // The book being viewed and whether the player is currently on it - drives
  // whether the composer stamps a timestamp.
  const viewedBook: HSClubBook | null =
    detail?.books.find(
      (b) => b.libraryItemId === (viewBookId ?? detail.club.currentBook?.libraryItemId),
    ) ??
    detail?.club.currentBook ??
    null
  const playingThisBook =
    !!player.nowPlaying && !!viewedBook && player.nowPlaying.itemId === viewedBook.libraryItemId
  const position = playingThisBook ? player.position : 0
  const chapters: ChapterMark[] = playingThisBook ? player.nowPlaying!.chapters : []

  const load = useCallback(
    async (opts: { markRead?: boolean } = {}) => {
      if (!id) return
      const res = await getClub(id, { bookId: viewBookId, position })
      if (!res) {
        setLoadError(true)
        return
      }
      setDetail(res)
      // Reading the thread bumps the unread cursor to the newest unlocked note.
      if (opts.markRead && res.notes.notes.length > 0) {
        const newest = res.notes.notes.reduce((m, n) => Math.max(m, n.createdAt), 0)
        void markClubRead(id, newest)
      }
    },
    [id, viewBookId, position],
  )

  useEffect(() => {
    void load({ markRead: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, viewBookId])

  // Keep the room fresh on the house 15s cadence while it's open. `load` closes
  // over the live position (changes every second), so hold it in a ref and run a
  // single stable interval - otherwise the interval would reset every tick and
  // never fire.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    const t = setInterval(() => void loadRef.current(), ROOM_POLL_MS)
    return () => clearInterval(t)
  }, [])

  // While the room is open, force the club/notes background poll on so the pop
  // watcher's stubs stay fresh even if the playing book isn't this club's book.
  useEffect(() => holdClubPolling(), [])

  const goToTab = (name: string) => {
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  const isOwner = detail?.members.some((m) => m.userId === meId && m.role === 'owner') ?? false
  const isMember = detail?.members.some((m) => m.userId === meId) ?? false

  const submit = async () => {
    const text = body.trim()
    if (!text || !detail || !viewedBook || busy) return
    setBusy(true)
    haptics.success()
    const created = await postNote({
      libraryItemId: viewedBook.libraryItemId,
      clubId: detail.club.id,
      parentId: replyTo?.id ?? '',
      // Stamp the current position only when the player is on this book AND
      // we're not replying (a reply inherits its parent's gate).
      timeSec: playingThisBook && !replyTo ? Math.round(position) : null,
      // Club posts are always club-scoped (no visibility toggle). Safe is a
      // top-level opt-in; a reply can't be safe.
      safe: replyTo ? false : safe,
      body: text,
    })
    setBusy(false)
    if (created) {
      setBody('')
      setReplyTo(null)
      setSafe(false)
      await load({ markRead: true })
    } else {
      show('Could not post')
    }
  }

  const removeNote = async (note: HSNote) => {
    if (
      !(await confirm({
        title: 'Delete note',
        message: 'Delete this note? This cannot be undone.',
        confirmLabel: 'Delete',
      }))
    )
      return
    const ok = await deleteNote(note.id)
    if (ok) await load()
    else show('Could not delete')
  }

  const leave = async () => {
    if (!detail) return
    if (
      !(await confirm({
        title: 'Leave club',
        message: `Leave "${detail.club.name}"? You'll stop getting its updates and can rejoin later if it's open.`,
        confirmLabel: 'Leave',
      }))
    )
      return
    ownerSheetRef.current?.dismiss()
    const ok = await setClubMembership(detail.club.id, false)
    if (ok) {
      show('Left the club')
      router.back()
    } else {
      show('Could not leave')
    }
  }

  const archive = async () => {
    if (!detail) return
    if (
      !(await confirm({
        title: 'Archive club',
        message: `Archive "${detail.club.name}"? It will be hidden from active club lists, but its history can still be restored from the server later.`,
        confirmLabel: 'Archive',
      }))
    )
      return
    ownerSheetRef.current?.dismiss()
    const ok = await archiveClub(detail.club.id)
    if (ok) {
      show('Club archived')
      router.back()
    } else {
      show('Could not archive')
    }
  }

  const removeClub = async () => {
    if (!detail) return
    if (
      !(await confirm({
        title: 'Delete club',
        message: `Permanently delete "${detail.club.name}"? This removes members, book history, and club notes. This cannot be undone.`,
        confirmLabel: 'Delete',
      }))
    )
      return
    ownerSheetRef.current?.dismiss()
    const ok = await deleteClub(detail.club.id)
    if (ok) {
      show('Club deleted')
      router.back()
    } else {
      show('Could not delete')
    }
  }

  const kick = async (member: HSClubMember) => {
    if (!detail) return
    if (
      !(await confirm({
        title: 'Remove member',
        message: `Remove ${member.username} from the club?`,
        confirmLabel: 'Remove',
      }))
    )
      return
    const ok = await kickClubMember(detail.club.id, member.userId)
    if (ok) await load()
    else show('Could not remove')
  }

  // Owner: promote a queued book to be the current book now (finishes the old
  // one), or drop it from the queue.
  const promoteQueued = async (book: HSClubBook) => {
    if (!detail || busy) return
    setBusy(true)
    haptics.success()
    const ok = await setClubCurrentBook(detail.club.id, book.libraryItemId)
    setBusy(false)
    if (ok) {
      show(`Now reading ${book.title || 'the next book'}`)
      setViewBookId(undefined)
      await load({ markRead: true })
    } else show('Could not start the book')
  }

  const dropQueued = async (book: HSClubBook) => {
    if (!detail || busy) return
    if (
      !(await confirm({
        title: 'Remove from up next',
        message: `Remove "${book.title || 'this book'}" from the club's up-next queue?`,
        confirmLabel: 'Remove',
      }))
    )
      return
    setBusy(true)
    const ok = await removeClubQueued(detail.club.id, book.libraryItemId)
    setBusy(false)
    if (ok) await load()
    else show('Could not remove')
  }

  if (loadError) {
    return (
      <Screen>
        <Header title="Book Club" onBack={() => router.back()} />
        <Centered>
          <AppText variant="meta" color={colors.textMuted}>
            This club isn't available.
          </AppText>
        </Centered>
        <AppTabBar activeName={null} onPressTab={goToTab} />
      </Screen>
    )
  }

  if (!detail) {
    return (
      <Screen>
        <Header title="Book Club" onBack={() => router.back()} />
        <Loading />
      </Screen>
    )
  }

  const sortedMembers = sortMembersByProgress(detail.members)
  const pastBooks = detail.books.filter((b) => b.finishedAt != null)
  const isCurrentView = !viewBookId || viewBookId === detail.club.currentBook?.libraryItemId

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
    const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 40
    if (atBottom && detail.notes.notes.length > 0 && id) {
      const newest = detail.notes.notes.reduce((m, n) => Math.max(m, n.createdAt), 0)
      void markClubRead(id, newest)
    }
  }

  return (
    <Screen>
      <Header
        title={detail.club.name}
        subtitle={`${detail.members.length} ${detail.members.length === 1 ? 'member' : 'members'}`}
        onBack={() => router.back()}
        onMembers={() => membersSheetRef.current?.present()}
        onOverflow={isMember ? () => ownerSheetRef.current?.present() : undefined}
      />

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={200}
      >
        {viewedBook ? (
          <View style={styles.bookHeader}>
            <Touchable onPress={() => router.push(`/item/${viewedBook.libraryItemId}`)}>
              <Cover
                uri={coverUrl(viewedBook.libraryItemId)}
                itemId={viewedBook.libraryItemId}
                size={54}
                radius={radius.tile}
                fallback={{
                  hue: coverHue(viewedBook.libraryItemId),
                  initial: (viewedBook.title || '?').charAt(0),
                }}
              />
            </Touchable>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="eyebrow" color={colors.textMuted}>
                {isCurrentView ? 'Reading now' : 'Past book'}
              </AppText>
              <AppText variant="label" numberOfLines={1} style={{ marginTop: 2 }}>
                {viewedBook.title || 'Untitled'}
              </AppText>
              {viewedBook.author ? (
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {viewedBook.author}
                </AppText>
              ) : null}
            </View>
            {pastBooks.length > 0 || !isCurrentView ? (
              <Touchable
                style={styles.historyBtn}
                onPress={() => historySheetRef.current?.present()}
              >
                <Icon name={icons.recent} size={18} color={colors.accent} />
              </Touchable>
            ) : null}
          </View>
        ) : (
          <View style={styles.bookHeader}>
            <AppText variant="meta" color={colors.textMuted}>
              This club hasn't picked a book yet.
            </AppText>
          </View>
        )}

        {/* Progress race for the viewed book. */}
        {viewedBook ? (
          <View style={styles.raceSection}>
            <AppText
              variant="eyebrow"
              color={colors.textMuted}
              style={{ marginBottom: spacing.sm }}
            >
              Where everyone is
            </AppText>
            {sortedMembers.map((m) => (
              <MemberRace key={m.userId} member={m} isMe={m.userId === meId} />
            ))}
          </View>
        ) : null}

        {/* Up next queue. Everyone sees what's lined up; the owner can start the
            next book now or remove one. Only shown on the current-book view. */}
        {isCurrentView && detail.queue.length > 0 ? (
          <View style={styles.queueSection}>
            <AppText
              variant="eyebrow"
              color={colors.textMuted}
              style={{ marginBottom: spacing.sm }}
            >
              Up next
            </AppText>
            {detail.queue.map((b) => (
              <View key={b.libraryItemId} style={styles.queueRow}>
                <Touchable onPress={() => router.push(`/item/${b.libraryItemId}`)}>
                  <Cover
                    uri={coverUrl(b.libraryItemId)}
                    itemId={b.libraryItemId}
                    size={40}
                    radius={radius.tile}
                    fallback={{
                      hue: coverHue(b.libraryItemId),
                      initial: (b.title || '?').charAt(0),
                    }}
                  />
                </Touchable>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="meta" numberOfLines={1}>
                    {b.title || 'Untitled'}
                  </AppText>
                  {b.author ? (
                    <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                      {b.author}
                    </AppText>
                  ) : null}
                </View>
                {isOwner ? (
                  <>
                    <Touchable
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => void dropQueued(b)}
                      style={{ padding: spacing.xs }}
                    >
                      <Icon name={icons.close} size={16} color={colors.textMuted} />
                    </Touchable>
                    <Touchable
                      style={styles.queueStartBtn}
                      disabled={busy}
                      onPress={() => void promoteQueued(b)}
                    >
                      <AppText variant="caption" color={colors.onAccent}>
                        Start
                      </AppText>
                    </Touchable>
                  </>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* Chat thread. */}
        <View
          style={styles.chatSection}
          onLayout={(e) => {
            chatSectionYRef.current = e.nativeEvent.layout.y
            tryScrollToDeepLink()
          }}
        >
          <AppText variant="title" style={{ marginBottom: spacing.sm }}>
            Discussion
          </AppText>
          {detail.notes.notes.length === 0 ? (
            <AppText
              variant="meta"
              color={colors.textMuted}
              style={{ paddingVertical: spacing.lg }}
            >
              No notes on this book yet.
            </AppText>
          ) : (
            <NoteThread
              notes={detail.notes.notes}
              chapters={chapters}
              meId={meId}
              canModerate={isOwner}
              highlightId={highlightId ?? undefined}
              onReply={isMember ? (n) => setReplyTo(n) : undefined}
              onDelete={isMember ? removeNote : undefined}
              onNoteLayout={(_, y) => {
                noteYRef.current = y
                tryScrollToDeepLink()
              }}
            />
          )}
          {detail.notes.hiddenAhead > 0 ? (
            <View style={styles.teaser}>
              <Icon name={icons.notes} size={16} color={colors.textMuted} />
              <AppText variant="caption" color={colors.textMuted}>
                {detail.notes.hiddenAhead}{' '}
                {detail.notes.hiddenAhead === 1 ? 'note is' : 'notes are'} ahead of you. Keep
                listening to unlock them.
              </AppText>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {/* Composer - members only, on the current book. Wrapped so the keyboard
          lifts it and it clears the docked mini player above the tab bar. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ paddingBottom: miniInset }}
      >
        {isMember && isCurrentView && viewedBook ? (
          <View style={styles.composer}>
            {replyTo ? (
              <View style={styles.replyBanner}>
                <AppText
                  variant="caption"
                  color={colors.textMuted}
                  numberOfLines={1}
                  style={{ flex: 1 }}
                >
                  Replying to {replyTo.username}
                </AppText>
                <IconButton
                  name={icons.close}
                  size={16}
                  color={colors.textMuted}
                  onPress={() => setReplyTo(null)}
                />
              </View>
            ) : null}
            <View style={styles.composerRow}>
              <TextInput
                style={styles.input}
                placeholder={
                  playingThisBook
                    ? `Note at ${formatTimestamp(position)}…`
                    : 'Leave a note (play the book to timestamp it)…'
                }
                placeholderTextColor={colors.textFaint}
                value={body}
                onChangeText={setBody}
                multiline
                maxLength={2000}
              />
              <Touchable
                style={[styles.sendBtn, (!body.trim() || busy) && { opacity: 0.5 }]}
                disabled={!body.trim() || busy}
                onPress={() => void submit()}
              >
                <Icon name={icons.send} size={18} color={colors.onAccent} />
              </Touchable>
            </View>
            {!replyTo ? <SafeSwitch on={safe} onChange={setSafe} /> : null}
          </View>
        ) : !isMember ? (
          <View style={styles.joinBar}>
            <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
              Members see your progress in this club's books.
            </AppText>
            <Touchable
              style={styles.joinBtn}
              disabled={busy}
              onPress={async () => {
                setBusy(true)
                const ok = await setClubMembership(detail.club.id, true)
                setBusy(false)
                if (ok) await load({ markRead: true })
                else show('Could not join')
              }}
            >
              <AppText variant="label" color={colors.onAccent}>
                Join club
              </AppText>
            </Touchable>
          </View>
        ) : null}
      </KeyboardAvoidingView>

      <AppTabBar activeName={null} onPressTab={goToTab} />

      {/* Members sheet (with kick for the owner). */}
      <Sheet ref={membersSheetRef} title="Members" snapPoints={['60%']}>
        {sortedMembers.map((m) => (
          <View key={m.userId} style={styles.memberRow}>
            <Avatar
              uri={avatarUrl(m.userId)}
              size={34}
              name={m.username}
              hue={coverHue(m.userId)}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="label" numberOfLines={1}>
                {m.username}
                {m.userId === meId ? ' (you)' : ''}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {m.role === 'owner' ? 'Owner' : 'Member'}
                {m.listeningNow ? ' · listening now' : ''}
              </AppText>
            </View>
            {isOwner && m.role !== 'owner' ? (
              <Touchable hitSlop={8} onPress={() => void kick(m)}>
                <AppText variant="caption" color={colors.destructive}>
                  Remove
                </AppText>
              </Touchable>
            ) : null}
          </View>
        ))}
      </Sheet>

      {/* Book history. */}
      <Sheet ref={historySheetRef} title="Book history" snapPoints={['60%']}>
        {detail.books.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
            No books yet.
          </AppText>
        ) : (
          detail.books.map((b) => {
            const current = b.finishedAt == null
            const active =
              b.libraryItemId === (viewBookId ?? detail.club.currentBook?.libraryItemId)
            return (
              <Touchable
                key={b.libraryItemId}
                style={styles.historyRow}
                onPress={() => {
                  setViewBookId(current ? undefined : b.libraryItemId)
                  historySheetRef.current?.dismiss()
                }}
              >
                <Cover
                  uri={coverUrl(b.libraryItemId)}
                  itemId={b.libraryItemId}
                  size={40}
                  radius={radius.tile}
                  fallback={{ hue: coverHue(b.libraryItemId), initial: (b.title || '?').charAt(0) }}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="meta" numberOfLines={1}>
                    {b.title || 'Untitled'}
                  </AppText>
                  <AppText variant="caption" color={current ? colors.accent : colors.textMuted}>
                    {current ? 'Reading now' : 'Finished'}
                  </AppText>
                </View>
                {active ? <Icon name={icons.checkCircle} size={18} color={colors.accent} /> : null}
              </Touchable>
            )
          })
        )}
      </Sheet>

      {/* Overflow: leave (member) / archive or delete (owner). */}
      <Sheet ref={ownerSheetRef} title={detail.club.name}>
        {isOwner ? (
          <>
            <Touchable style={styles.sheetAction} onPress={() => void archive()}>
              <Icon name={icons.archive} size={20} color={colors.destructive} />
              <AppText variant="body" color={colors.destructive}>
                Archive this club
              </AppText>
            </Touchable>
            <Touchable style={styles.sheetAction} onPress={() => void removeClub()}>
              <Icon name={icons.delete} size={20} color={colors.destructive} />
              <AppText variant="body" color={colors.destructive}>
                Delete this club
              </AppText>
            </Touchable>
          </>
        ) : (
          <Touchable style={styles.sheetAction} onPress={() => void leave()}>
            <Icon name={icons.signOut} size={20} color={colors.destructive} />
            <AppText variant="body" color={colors.destructive}>
              Leave this club
            </AppText>
          </Touchable>
        )}
      </Sheet>

      <Toast message={message} />
    </Screen>
  )
}

// ---- Member progress race row ----

function MemberRace({ member, isMe }: { member: HSClubMember; isMe: boolean }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const fraction =
    member.currentTime != null && member.duration != null && member.duration > 0
      ? Math.max(0, Math.min(1, member.currentTime / member.duration))
      : 0
  const finished = member.isFinished === true
  return (
    <View style={styles.raceRow}>
      <View>
        <Avatar
          uri={avatarUrl(member.userId)}
          size={30}
          name={member.username}
          hue={coverHue(member.userId)}
        />
        {member.listeningNow ? <View style={styles.racePulse} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.raceMeta}>
          <AppText
            variant="caption"
            color={isMe ? colors.accent : colors.text}
            numberOfLines={1}
            style={{ flex: 1 }}
          >
            {member.username}
            {isMe ? ' (you)' : ''}
          </AppText>
          {finished ? (
            <Icon name={icons.checkCircle} size={15} color={colors.success} />
          ) : (
            <AppText variant="caption" color={colors.textMuted}>
              {Math.round(fraction * 100)}%
            </AppText>
          )}
        </View>
        <View style={styles.raceTrack}>
          <View
            style={[
              styles.raceFill,
              {
                width: `${(finished ? 1 : fraction) * 100}%`,
                backgroundColor: finished ? colors.success : colors.accent,
              },
            ]}
          />
        </View>
      </View>
    </View>
  )
}

// ---- Header ----

function Header({
  title,
  subtitle,
  onBack,
  onMembers,
  onOverflow,
}: {
  title: string
  subtitle?: string
  onBack: () => void
  onMembers?: () => void
  onOverflow?: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.header}>
      <IconButton name={icons.back} onPress={onBack} style={styles.headerBtn} />
      <View style={{ flex: 1, minWidth: 0, marginHorizontal: spacing.sm }}>
        <AppText variant="label" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {onMembers ? (
        <IconButton name={icons.people} size={22} onPress={onMembers} style={styles.headerBtn} />
      ) : null}
      {onOverflow ? (
        <IconButton name={icons.more} onPress={onOverflow} style={styles.headerBtn} />
      ) : null}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    headerBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bookHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    historyBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.accentWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    raceSection: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginHorizontal: spacing.lg,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    raceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    racePulse: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.accent,
      borderWidth: 1.5,
      borderColor: colors.card,
    },
    raceMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    raceTrack: {
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.elevated,
      overflow: 'hidden',
      marginTop: 4,
    },
    raceFill: { height: '100%', borderRadius: 3 },
    queueSection: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    queueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    queueStartBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    chatSection: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
    teaser: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
    },
    composer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm },
    replyBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    input: {
      flex: 1,
      maxHeight: 120,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: colors.text,
      fontSize: 15,
    },
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    joinBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    joinBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    memberRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    sheetAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md + 2,
    },
  })
