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
  Keyboard,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type KeyboardEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import type {
  HSClubBook,
  HSClubDetail,
  HSClubMember,
  HSNote,
  HSNoteStub,
  NoteReactionKind,
  HSNoteReactionDetail,
} from '@hearthshelf/core'
import {
  coverHue,
  formatTimestamp,
  queueLengthLabel,
  sortMembersByProgress,
  quickReactions,
} from '@hearthshelf/core'
import {
  getClub,
  setClubMembership,
  markClubRead,
  archiveClub,
  deleteClub,
  kickClubMember,
  setClubCurrentBook,
  removeClubQueued,
  requeueClubBook,
  reorderClubQueue,
  getClubInvitees,
  inviteClubUsers,
  revokeClubInvite,
  type ClubInvitee,
} from '@/api/clubs'
import { holdClubPolling } from '@/player/clubSync'
import { useMiniPlayerInset } from '@/ui/useContentInset'
import { useSheetBackHandler } from '@/ui/useBackHandler'
import { postNote, deleteNote, reactToNote, getNoteReactionDetails, editNote } from '@/api/notes'
import { getMeId } from '@/api/me'
import * as Clipboard from 'expo-clipboard'
import { coverUrl, avatarUrl, getLibraries } from '@/api/abs'
import {
  getState as getPlayerState,
  requestSeek,
  subscribe as subscribePlayer,
} from '@/player/store'
import { playItemById } from '@/player/playback'
import { PlayerClubProgressStrip } from '@/player/PlayerClubStrip'
import {
  NoteThread,
  reactionGlyph,
  reactionLabel,
  stampLabel,
  type ChapterMark,
} from '@/social/NoteThread'
import { EmojiPickerSheet } from '@/social/EmojiPickerSheet'
import {
  getReactionRecents,
  hydrateReactionRecents,
  noteReactionUsed,
  subscribeReactionRecents,
} from '@/store/reactionRecents'
import { SafeSwitch } from '@/social/NoteComposerControls'
import { AddClubBooksSheet } from '@/social/AddClubBooksSheet'
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
import { AppTabBar, tabFromParam, useGoToTab } from '@/ui/AppTabBar'
import { Toast, useToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { choose, confirm } from '@/ui/confirm'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

// Poll the room while it's open so other members' notes/progress stay fresh
// without a realtime channel (the house 15s cadence, matching the design doc).
const ROOM_POLL_MS = 15_000

export default function ClubRoomScreen() {
  const router = useRouter()
  // Hardware back closes an open sheet first; only with none open does it pop
  // the route (dismiss() returns false, letting the default back proceed).
  useSheetBackHandler()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  // `note` is an optional deep-link param (hearthshelf://club/:id?note=:noteId),
  // set by Phase 7 note-pop notifications - see docs/social.md. On open, the
  // thread scrolls to and highlights that note (see scrollToDeepLink below).
  const {
    id,
    note: deepLinkNoteId,
    from,
  } = useLocalSearchParams<{
    id: string
    note?: string
    from?: string
  }>()
  const active = tabFromParam(from, 'home')
  const { message, show } = useToast()
  const meId = getMeId()

  const player = useSyncExternalStore(subscribePlayer, getPlayerState)
  // The quick-pick row: three pinned reactions plus this reader's most recent
  // other choices. Purely local - see store/reactionRecents.
  const reactionRecents = useSyncExternalStore(subscribeReactionRecents, getReactionRecents)
  const quickPicks = useMemo(() => quickReactions(reactionRecents), [reactionRecents])
  useEffect(() => {
    void hydrateReactionRecents()
  }, [])
  const miniPlayerInset = useMiniPlayerInset()
  const [detail, setDetail] = useState<HSClubDetail | null>(null)
  // The library the add-books search runs against. Best-effort: a failure just
  // leaves the sheet saying no library is available, rather than blocking the room.
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  // Which book of the history is being viewed; undefined = the current book.
  const [viewBookId, setViewBookId] = useState<string | undefined>(undefined)
  const [body, setBody] = useState('')
  // Members picked from the @ list. Collected on selection rather than re-parsed
  // from the text, so a username with a space (or one that is a prefix of
  // another) resolves to exactly who was chosen. Filtered against the final body
  // on submit, so deleting the "@name" drops the mention with it.
  const [mentionPicks, setMentionPicks] = useState<HSClubMember[]>([])
  const [replyTo, setReplyTo] = useState<HSNote | null>(null)
  const [safe, setSafe] = useState(false)
  const [spoiler, setSpoiler] = useState(false)
  const [section, setSection] = useState<'discussion' | 'queue' | 'members'>('discussion')
  const [progressExpanded, setProgressExpanded] = useState(false)
  const [composingNew, setComposingNew] = useState(false)
  const [busy, setBusy] = useState(false)
  // Whether the next note carries a position stamp. Was implicit ("stamped iff
  // playing this book"); now an explicit, removable chip above the composer.
  const [stampEnabled, setStampEnabled] = useState(true)
  // The frozen "new since last visit" divider boundary (see load()). undefined
  // until the first load resolves it; reset when the viewed book changes.
  const [newSinceTs, setNewSinceTs] = useState<number | undefined>(undefined)
  const [invitees, setInvitees] = useState<ClubInvitee[] | null>(null)
  const [selectedInvitees, setSelectedInvitees] = useState<string[]>([])

  const membersSheetRef = useRef<SheetRef>(null)
  const historySheetRef = useRef<SheetRef>(null)
  const addBooksSheetRef = useRef<SheetRef>(null)
  const noteActionsRef = useRef<SheetRef>(null)
  const emojiPickerRef = useRef<SheetRef>(null)
  const reactionsSheetRef = useRef<SheetRef>(null)
  const [reactionDetails, setReactionDetails] = useState<HSNoteReactionDetail[]>([])
  const [reactionKind, setReactionKind] = useState<NoteReactionKind | null>(null)
  const [reactionNote, setReactionNote] = useState<HSNote | null>(null)
  const [editingNote, setEditingNote] = useState<HSNote | null>(null)
  // The note a long-press opened the action menu for.
  const [actionNote, setActionNote] = useState<HSNote | null>(null)
  const ownerSheetRef = useRef<SheetRef>(null)
  const inviteSheetRef = useRef<SheetRef>(null)

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

  // Keyboard-aware composer. The reply/edit composer renders INLINE, at the note
  // it belongs to, inside this ScrollView - so replying to the last comment in a
  // long thread put the input directly behind the keyboard. Android on SDK 57 is
  // always edge-to-edge and ignores adjustResize, so the OS will not move it for
  // us (see the edge-to-edge keyboard note in the app's docs); the scroll view
  // has to make the room itself.
  //
  // Two parts: pad the content by the keyboard's height so the bottom-most
  // composer CAN be scrolled clear of it, then scroll it into view.
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const composerRef = useRef<View>(null)

  // Scroll the composer clear of the keyboard. measureLayout is ASYNC, so the
  // scroll happens inside its callback - reading the ref straight after the call
  // would use the previous measurement and land in the wrong place.
  //
  // Measured against the ScrollView rather than summed from section/note
  // offsets, because the composer renders several levels deep inside whichever
  // note it belongs to.
  const scrollComposerIntoView = useCallback((clearance: number) => {
    const node = scrollRef.current as unknown as View | null
    if (!node || !composerRef.current) return
    composerRef.current.measureLayout(
      node as never,
      (_x, y, _width, height) => {
        const bottom = y + height
        // Land the composer's bottom edge above the keyboard, with a little air.
        scrollRef.current?.scrollTo({
          y: Math.max(0, bottom - clearance + 40),
          animated: true,
        })
      },
      () => {
        // Measure can fail mid-unmount; the composer just won't auto-scroll.
      },
    )
  }, [])

  useEffect(() => {
    const onShow = (event: KeyboardEvent) => setKeyboardHeight(event.endCoordinates?.height ?? 0)
    const onHide = () => setKeyboardHeight(0)
    const showSub = Keyboard.addListener('keyboardDidShow', onShow)
    const hideSub = Keyboard.addListener('keyboardDidHide', onHide)
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [])

  // Once the keyboard is up AND we know where the composer sits, bring it into
  // view. Depends on both so it re-runs whichever arrives second.
  useEffect(() => {
    if (keyboardHeight <= 0) return
    // A frame of delay lets the keyboard padding land first, so there is room to
    // scroll into by the time we measure.
    const frame = requestAnimationFrame(() => scrollComposerIntoView(keyboardHeight))
    return () => cancelAnimationFrame(frame)
  }, [keyboardHeight, scrollComposerIntoView, replyTo?.id, editingNote?.id, composingNew])

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
      // Freeze the "new since last visit" boundary once, on the first load of
      // this visit, BEFORE marking read moves the cursor. The unreadCount newest
      // notes are new; the boundary is the newest ALREADY-READ note's time (or 0
      // when everything is new). Held for the whole visit so the divider is
      // stable while polling and after posting.
      setNewSinceTs((prev) => {
        if (prev != null) return prev
        const sorted = [...res.notes.notes].sort((a, b) => b.createdAt - a.createdAt)
        if (res.unreadCount <= 0 || sorted.length === 0) return 0
        const firstRead = sorted[res.unreadCount] // one past the last unread
        return firstRead ? firstRead.createdAt : 0
      })
      // Reading the thread bumps the unread cursor to the newest unlocked note.
      if (opts.markRead && res.notes.notes.length > 0) {
        const newest = res.notes.notes.reduce((m, n) => Math.max(m, n.createdAt), 0)
        void markClubRead(id, newest)
      }
    },
    [id, viewBookId, position],
  )

  // Resolve the book library once, for the add-books search. Owner-only surface,
  // but resolving unconditionally keeps the effect free of role timing.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const libs = await getLibraries()
        if (cancelled) return
        const primary = libs.find((l) => l.mediaType === 'book') ?? libs[0]
        setLibraryId(primary?.id ?? null)
      } catch {
        // Offline or unreachable - the sheet reports no library.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // New book view = recompute the divider boundary from its own unread count.
    setNewSinceTs(undefined)
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

  const goToTab = useGoToTab()

  const isOwner = detail?.members.some((m) => m.userId === meId && m.role === 'owner') ?? false
  // The server decides this, not the member list: on a public club it answers a
  // non-member with a PREVIEW (books, members, progress - no comment bodies),
  // and says so. Falling back to the roster keeps older servers working.
  const isMember = detail?.isMember ?? detail?.members.some((m) => m.userId === meId) ?? false

  // Pending invitations belong in the Members tab, not only in the invite
  // picker. Load the owner-only roster when that tab opens so the room shows
  // who has not accepted yet without requiring a second sheet.
  useEffect(() => {
    if (section !== 'members' || !isOwner || !detail?.club.id) return
    let cancelled = false
    void getClubInvitees(detail.club.id)
      .then((rows) => {
        if (!cancelled) setInvitees(rows)
      })
      .catch(() => {
        if (!cancelled) setInvitees([])
      })
    return () => {
      cancelled = true
    }
  }, [detail?.club.id, isOwner, section])

  // The "@…" being typed at the end of the draft, if any. Anchored to the end
  // rather than the caret: RN's TextInput needs explicit selection tracking for
  // mid-string editing, and typing a mention as you go is the real case.
  const mentionQuery = useMemo(() => {
    const at = body.lastIndexOf('@')
    if (at === -1) return null
    const before = body[at - 1]
    if (before !== undefined && !/\s/.test(before)) return null
    const tail = body.slice(at + 1)
    // Allow one space so "@ann marie" keeps matching, but stop at a second.
    if (tail.includes('\n') || (tail.match(/ /g)?.length ?? 0) > 1) return null
    return { at, text: tail }
  }, [body])

  const mentionMatches = useMemo(() => {
    if (!mentionQuery || !isMember) return []
    const q = mentionQuery.text.trim().toLowerCase()
    return (detail?.members ?? [])
      .filter((m) => m.userId && m.userId !== meId)
      .filter((m) => !q || m.username.toLowerCase().includes(q))
      .slice(0, 5)
  }, [mentionQuery, detail?.members, meId, isMember])

  const pickMention = (member: HSClubMember) => {
    if (!mentionQuery) return
    setBody(`${body.slice(0, mentionQuery.at)}@${member.username} `)
    setMentionPicks((picked) =>
      picked.some((p) => p.userId === member.userId) ? picked : [...picked, member],
    )
  }

  const submit = async () => {
    const text = body.trim()
    if (!text || !detail || !viewedBook || busy) return
    setBusy(true)
    haptics.success()
    const created = await postNote({
      libraryItemId: viewedBook.libraryItemId,
      clubId: detail.club.id,
      parentId: replyTo?.id ?? '',
      // Replies only carry the current position when the author explicitly
      // opts in. Opening a reply composer starts this toggle off.
      timeSec: playingThisBook && stampEnabled ? Math.round(position) : null,
      // Club posts are always club-scoped (no visibility toggle). Safe is a
      // top-level opt-in; a reply can't be safe.
      safe: replyTo ? false : safe,
      spoiler,
      body: text,
      mentions: mentionPicks
        .filter((m) => text.toLowerCase().includes(`@${m.username.toLowerCase()}`))
        .map((m) => m.userId),
    })
    setBusy(false)
    if (created) {
      setBody('')
      setMentionPicks([])
      setReplyTo(null)
      setSafe(false)
      setSpoiler(false)
      setStampEnabled(true)
      setComposingNew(false)
      await load({ markRead: true })
    } else {
      show('Could not post')
    }
  }

  // Toggle one reaction. The tallies are re-read from the server response rather
  // than incremented locally, so a stale count converges on the truth.
  const toggleReaction = async (note: HSNote, kind: NoteReactionKind, on: boolean) => {
    if (!isMember) return
    haptics.select()
    const reactions = await reactToNote(note.id, kind, on)
    if (!reactions) {
      show('Could not save that reaction')
      return
    }
    // Only a reaction that actually landed earns a place in the quick row, so a
    // failed send does not reshuffle it. Removing one is not "using" it either.
    if (on) noteReactionUsed(kind)
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            notes: {
              ...prev.notes,
              notes: prev.notes.notes.map((n) => (n.id === note.id ? { ...n, reactions } : n)),
            },
          }
        : prev,
    )
  }

  const openReactionDetails = async (note: HSNote, kind: NoteReactionKind) => {
    setReactionNote(note)
    setReactionKind(kind)
    setReactionDetails([])
    reactionsSheetRef.current?.present()
    setReactionDetails(await getNoteReactionDetails(note.id))
  }

  const saveEdit = async () => {
    const text = body.trim()
    if (!editingNote || busy || !text) return
    setBusy(true)
    const updated = await editNote(editingNote.id, {
      body: text,
      spoiler,
      // A stamp can be dropped while editing, but not re-pointed at wherever
      // you happen to be listening now - the comment stays where it was made.
      timeSec: stampEnabled ? editingNote.timeSec : null,
    })
    setBusy(false)
    if (!updated) return show('Could not edit that comment')
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            notes: {
              ...prev.notes,
              notes: prev.notes.notes.map((n) => (n.id === updated.id ? { ...n, ...updated } : n)),
            },
          }
        : prev,
    )
    closeComposer()
  }

  const openNoteActions = (note: HSNote) => {
    haptics.select()
    setActionNote(note)
    noteActionsRef.current?.present()
  }

  /**
   * Jump to the moment a comment is about, turning the comment into a bookmark.
   *
   * `rewindSec` backs up from the stamp so you hear the run-up rather than
   * landing mid-sentence on the thing being discussed.
   *
   * When the comment is on the book already loaded, this is a plain seek. When
   * it is not, the position is passed INTO the load rather than seeked after it:
   * a seek issued after a load races the load's own resume and can lose, which
   * is what once froze the scrubber for hours on the car handback path.
   */
  const playFromNote = async (note: HSNote, rewindSec: number) => {
    const itemId = note.libraryItemId
    if (note.timeSec == null || !itemId) return
    const target = Math.max(0, note.timeSec - rewindSec)
    haptics.transport()
    if (player.nowPlaying?.itemId === itemId) {
      requestSeek(target)
      return
    }
    await playItemById(itemId, true, { resumeAt: target })
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
        message: `Leave "${detail.club.name}"? You'll stop getting its updates${detail.club.isOpen ? ' and can find it again while it stays public' : ''}.`,
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

  // Owner: promote a queued book to be the current book now, or drop it from the
  // queue. Starting a book when one is already current has to say what happened
  // to the outgoing book, so we ask rather than assume: finishing it files it
  // under past reads, setting it aside keeps it eligible to come back later.
  // Cancel stays a real third answer - it must not quietly pick a branch.
  const promoteQueued = async (book: HSClubBook) => {
    if (!detail || busy) return
    const outgoing = detail.club.currentBook
    let finishPrevious = true
    if (outgoing && outgoing.libraryItemId !== book.libraryItemId) {
      const answer = await choose({
        title: `Start "${book.title || 'this book'}"?`,
        message: `The club is currently reading "${outgoing.title || 'a book'}". What should happen to it?`,
        options: [
          { value: 'finished', label: 'We finished it' },
          { value: 'aside', label: 'Set it aside' },
        ],
      })
      if (!answer) return
      finishPrevious = answer === 'finished'
    }
    setBusy(true)
    haptics.success()
    const ok = await setClubCurrentBook(detail.club.id, book.libraryItemId, finishPrevious)
    setBusy(false)
    if (ok) {
      show(`Now reading ${book.title || 'the next book'}`)
      setViewBookId(undefined)
      await load({ markRead: true })
    } else show('Could not start the book')
  }

  // Owner: put a past read or a set aside book back into the up-next queue.
  const requeueBook = async (book: HSClubBook) => {
    if (!detail || busy) return
    setBusy(true)
    const ok = await requeueClubBook(detail.club.id, book.libraryItemId)
    setBusy(false)
    if (ok) {
      haptics.mode()
      show(`"${book.title || 'Book'}" moved back to up next`)
      setViewBookId(undefined)
      await load()
    } else show('Could not move that book. Start a different book first.')
  }

  // Owner: nudge a queued book one slot up or down. The whole order is sent, so
  // the server never has to reconcile a partial list.
  const moveQueued = async (index: number, delta: number) => {
    if (!detail || busy) return
    const target = index + delta
    if (target < 0 || target >= detail.queue.length) return
    const ids = detail.queue.map((b) => b.libraryItemId)
    const [moved] = ids.splice(index, 1)
    ids.splice(target, 0, moved)
    setBusy(true)
    haptics.select()
    const ok = await reorderClubQueue(detail.club.id, ids)
    setBusy(false)
    if (ok) await load()
    else show('Could not reorder the queue')
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

  const openInvites = async () => {
    if (!detail || !isOwner) return
    setInvitees(null)
    setSelectedInvitees([])
    inviteSheetRef.current?.present()
    setInvitees(await getClubInvitees(detail.club.id))
  }

  const sendInvites = async () => {
    if (!detail || selectedInvitees.length === 0 || busy) return
    setBusy(true)
    const results = await inviteClubUsers(detail.club.id, selectedInvitees)
    setBusy(false)
    const sent = results.filter((result) => result.invited).length
    if (sent === 0) {
      show('Could not send those invitations')
      return
    }
    const withoutEmail = results.filter(
      (result) => result.invited && result.emailSent === false,
    ).length
    show(
      withoutEmail > 0
        ? `${sent} invited in-app; ${withoutEmail} could not be emailed`
        : `${sent} ${sent === 1 ? 'invitation' : 'invitations'} sent`,
    )
    setSelectedInvitees([])
    setInvitees(await getClubInvitees(detail.club.id))
  }

  const cancelInvite = async (invitee: ClubInvitee) => {
    if (!detail || !invitee.pendingInviteId || busy) return
    setBusy(true)
    const ok = await revokeClubInvite(detail.club.id, invitee.pendingInviteId)
    setBusy(false)
    if (!ok) show('Could not cancel that invitation')
    setInvitees(await getClubInvitees(detail.club.id))
  }

  if (loadError) {
    return (
      <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
        <Header title="Book Club" onBack={() => router.back()} />
        <Centered>
          <AppText variant="meta" color={colors.textMuted}>
            This club isn't available.
          </AppText>
        </Centered>
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
  // One resolution of the book's length, shared by the progress bar and the
  // note stamps: the live player when this book is loaded, else whatever length
  // a member's progress row reports.
  const bookDurationSec = playingThisBook
    ? (player.nowPlaying?.duration ?? 0)
    : (detail.members.find((member) => member.userId === meId)?.duration ??
      sortedMembers.find((member) => member.duration)?.duration ??
      0)
  const pendingInvitees = (invitees ?? []).filter((invitee) => invitee.pendingInviteId)
  // Books that have left the current slot, whether the club finished them or set
  // them aside. Both belong in the history sheet - a set aside book is the one
  // most likely to be brought back, so hiding it would strand it.
  const pastBooks = detail.books.filter((b) => b.finishedAt != null || b.abandonedAt != null)
  const isCurrentView = !viewBookId || viewBookId === detail.club.currentBook?.libraryItemId

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
    const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 40
    if (atBottom && detail.notes.notes.length > 0 && id) {
      const newest = detail.notes.notes.reduce((m, n) => Math.max(m, n.createdAt), 0)
      void markClubRead(id, newest)
    }
  }

  const beginReply = (note: HSNote) => {
    setReplyTo(note)
    setComposingNew(false)
    setBody('')
    setMentionPicks([])
    setSafe(false)
    setSpoiler(false)
    setStampEnabled(false)
  }

  const closeComposer = () => {
    setReplyTo(null)
    setEditingNote(null)
    setComposingNew(false)
    setBody('')
    setMentionPicks([])
    setSafe(false)
    setSpoiler(false)
    setStampEnabled(true)
  }

  const composer = (reply: boolean, editing?: HSNote) => (
    <View
      ref={composerRef}
      style={[styles.composer, styles.inlineComposer]}
      // Nudge the keyboard effect to re-measure once this composer has laid out.
      // Its own layout y is relative to the note that owns it, several levels
      // down, so it is measured against the ScrollView instead (see
      // measureComposer) rather than summed from section offsets.
      onLayout={() => {
        if (keyboardHeight > 0) scrollComposerIntoView(keyboardHeight)
      }}
    >
      {editing ? (
        <View style={styles.replyBanner}>
          <View style={styles.replyBar} />
          <AppText variant="caption" color={colors.accent} style={{ flex: 1 }}>
            Editing your comment
          </AppText>
          <IconButton
            name={icons.close}
            size={16}
            color={colors.textMuted}
            onPress={closeComposer}
            accessibilityLabel="Cancel edit"
          />
        </View>
      ) : null}
      {reply && replyTo ? (
        <View style={styles.replyBanner}>
          <View style={styles.replyBar} />
          <View style={{ flex: 1 }}>
            <AppText variant="caption" color={colors.accent} numberOfLines={1}>
              Replying to {replyTo.username}
            </AppText>
            <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
              {replyTo.body}
            </AppText>
          </View>
          <IconButton
            name={icons.close}
            size={16}
            color={colors.textMuted}
            onPress={closeComposer}
            accessibilityLabel="Cancel reply"
          />
        </View>
      ) : null}
      {editing ? (
        editing.timeSec != null && stampEnabled ? (
          <View style={styles.stampChip}>
            <Icon name={icons.schedule} size={14} color={colors.accent} />
            <AppText variant="caption" color={colors.accent} style={{ flex: 1 }}>
              {stampLabel(editing.timeSec, chapters)}
            </AppText>
            <IconButton
              name={icons.close}
              size={14}
              color={colors.accent}
              onPress={() => setStampEnabled(false)}
              accessibilityLabel="Remove attached position"
            />
          </View>
        ) : null
      ) : playingThisBook ? (
        stampEnabled ? (
          <View style={styles.stampChip}>
            <Icon name={icons.schedule} size={14} color={colors.accent} />
            <AppText variant="caption" color={colors.accent} style={{ flex: 1 }}>
              {stampLabel(Math.round(position), chapters)}
            </AppText>
            <IconButton
              name={icons.close}
              size={14}
              color={colors.accent}
              onPress={() => setStampEnabled(false)}
              accessibilityLabel="Remove attached position"
            />
          </View>
        ) : (
          <Touchable style={styles.stampAdd} onPress={() => setStampEnabled(true)}>
            <Icon name={icons.schedule} size={14} color={colors.textMuted} />
            <AppText variant="caption" color={colors.textMuted}>
              Attach my position
            </AppText>
          </Touchable>
        )
      ) : null}
      {mentionMatches.length > 0 ? (
        <View style={styles.mentionList}>
          {mentionMatches.map((m) => (
            <Touchable key={m.userId} style={styles.mentionItem} onPress={() => pickMention(m)}>
              <Avatar
                uri={avatarUrl(m.userId)}
                size={24}
                name={m.username}
                hue={coverHue(m.userId)}
              />
              <AppText variant="label" numberOfLines={1}>
                {m.username}
              </AppText>
            </Touchable>
          ))}
        </View>
      ) : null}
      <TextInput
        style={styles.input}
        autoFocus
        placeholder={
          editing
            ? 'Edit your comment…'
            : reply && replyTo
              ? `Reply to ${replyTo.username}…`
              : 'Start a new thread…'
        }
        placeholderTextColor={colors.textFaint}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={2000}
      />
      <View style={styles.composerTools}>
        <View style={styles.composerOptions}>
          <Touchable
            style={[styles.spoilerToggle, spoiler && styles.spoilerToggleOn]}
            onPress={() => setSpoiler((value) => !value)}
            accessibilityRole="switch"
            accessibilityState={{ checked: spoiler }}
          >
            <Icon
              name={spoiler ? icons.hidden : icons.visible}
              size={16}
              color={spoiler ? colors.accent : colors.textMuted}
            />
            <AppText variant="caption" color={spoiler ? colors.accent : colors.textMuted}>
              Spoiler
            </AppText>
          </Touchable>
          {!reply && !editing ? <SafeSwitch on={safe} onChange={setSafe} /> : null}
        </View>
        <View style={styles.composerActions}>
          <Touchable
            style={styles.cancelComposerBtn}
            onPress={closeComposer}
            accessibilityRole="button"
            accessibilityLabel="Cancel comment"
          >
            <AppText variant="caption" color={colors.textMuted}>
              Cancel
            </AppText>
          </Touchable>
          <Touchable
            style={[styles.sendBtn, (!body.trim() || busy) && { opacity: 0.5 }]}
            disabled={!body.trim() || busy}
            onPress={() => void (editing ? saveEdit() : submit())}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Save changes' : reply ? 'Post reply' : 'Post comment'}
          >
            <Icon name={editing ? icons.check : icons.send} size={18} color={colors.onAccent} />
          </Touchable>
        </View>
      </View>
    </View>
  )

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      <Header
        title={detail.club.name}
        subtitle={`${detail.members.length} ${detail.members.length === 1 ? 'member' : 'members'}`}
        onBack={() => router.back()}
        onOverflow={isMember ? () => ownerSheetRef.current?.present() : undefined}
      />

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{
          // The keyboard's height is added so a composer at the very bottom of
          // the thread can actually be scrolled above it - without this there is
          // simply no content left to scroll to.
          paddingBottom: miniPlayerInset + spacing.xl + keyboardHeight,
        }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={200}
      >
        {viewedBook ? (
          <View style={styles.bookHeader}>
            <Touchable
              onPress={() => router.push(`/item/${viewedBook.libraryItemId}?from=${active}`)}
            >
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
            {/* Members only: a preview is pinned to the club's current book by
                the server, so a history switcher would do nothing. */}
            {isMember && (pastBooks.length > 0 || !isCurrentView) ? (
              <Touchable
                style={styles.historyBtn}
                onPress={() => historySheetRef.current?.present()}
              >
                <Icon name={icons.recent} size={18} color={colors.accent} />
              </Touchable>
            ) : null}
          </View>
        ) : (
          // No book yet. Without an action this reads as a dead end, since books
          // are added from a book's own page rather than from here.
          <View style={styles.emptyBook}>
            <Icon name={icons.book} size={28} color={colors.textFaint} />
            <AppText variant="title">Choose your first read</AppText>
            <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
              {isOwner
                ? 'Open a book in your library and add it to this club.'
                : "The club owner hasn't picked a book yet."}
            </AppText>
            {isOwner ? (
              <Touchable
                style={styles.queueStartBtn}
                onPress={() => router.push(`/(tabs)/library`)}
                accessibilityRole="button"
              >
                <AppText variant="caption" color={colors.onAccent}>
                  Browse library
                </AppText>
              </Touchable>
            ) : null}
          </View>
        )}

        {/* Exact avatar progress rail from the player. Tap to expand the richer
            member card instead of spending permanent vertical space on it. */}
        {viewedBook ? (
          <View style={styles.progressStripWrap}>
            <PlayerClubProgressStrip
              clubName={detail.club.name}
              members={detail.members}
              memberCount={detail.members.length}
              position={
                playingThisBook
                  ? position
                  : (detail.members.find((member) => member.userId === meId)?.currentTime ?? 0)
              }
              duration={bookDurationSec}
              expanded={progressExpanded}
              onPress={() => setProgressExpanded((value) => !value)}
            />
          </View>
        ) : null}

        {/* Progress race for the viewed book. */}
        {viewedBook && progressExpanded ? (
          <View style={styles.raceSection}>
            <AppText
              variant="eyebrow"
              color={colors.textMuted}
              style={{ marginBottom: spacing.sm }}
            >
              Where everyone is
            </AppText>
            {sortedMembers.map((m) => (
              <MemberRace
                key={m.userId}
                member={m}
                isMe={m.userId === meId}
                onOpenUser={(userId) =>
                  router.push(`/user/${encodeURIComponent(userId)}?from=${active}`)
                }
              />
            ))}
          </View>
        ) : null}

        <View style={styles.sectionTabs} accessibilityRole="tablist">
          {(['discussion', 'queue', 'members'] as const).map((tab) => (
            <Touchable
              key={tab}
              style={[styles.sectionTab, section === tab && styles.sectionTabOn]}
              onPress={() => setSection(tab)}
              accessibilityRole="tab"
              accessibilityState={{ selected: section === tab }}
            >
              <AppText variant="caption" color={section === tab ? colors.accent : colors.textMuted}>
                {tab === 'discussion' ? 'Discussion' : tab === 'queue' ? 'Queue' : 'Members'}
              </AppText>
            </Touchable>
          ))}
        </View>

        {/* Chat thread. */}
        {section === 'discussion' ? (
          <View
            style={styles.chatSection}
            onLayout={(e) => {
              chatSectionYRef.current = e.nativeEvent.layout.y
              tryScrollToDeepLink()
            }}
          >
            {isMember && isCurrentView && viewedBook && !replyTo ? (
              composingNew ? (
                composer(false)
              ) : (
                <Touchable
                  style={styles.newThreadButton}
                  onPress={() => {
                    setComposingNew(true)
                    setStampEnabled(playingThisBook)
                    setSpoiler(false)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Start a new discussion thread"
                >
                  <Icon name={icons.commentAdd} size={20} color={colors.onAccent} />
                  <AppText variant="label" color={colors.onAccent}>
                    Start a new thread
                  </AppText>
                </Touchable>
              )
            ) : null}
            {!isMember ? (
              <LockedDiscussion
                stubs={detail.notes.locked}
                total={detail.notes.hiddenAhead}
                durationSec={bookDurationSec}
                colors={colors}
                styles={styles}
              />
            ) : detail.notes.notes.length === 0 ? (
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
                durationSec={bookDurationSec}
                meId={meId}
                canModerate={isOwner}
                highlightId={highlightId ?? undefined}
                newSinceTs={newSinceTs}
                onReply={isMember && detail.club.allowReplies ? beginReply : undefined}
                onDelete={isMember ? removeNote : undefined}
                onOpenUser={(userId) =>
                  router.push(`/user/${encodeURIComponent(userId)}?from=${active}`)
                }
                onReact={isMember ? (n, kind, on) => void toggleReaction(n, kind, on) : undefined}
                onOpenReactions={(n, kind) => void openReactionDetails(n, kind)}
                onOpenActions={openNoteActions}
                replyComposerFor={replyTo?.id}
                replyComposer={replyTo ? composer(true) : undefined}
                editComposerFor={editingNote?.id}
                editComposer={
                  editingNote ? composer(!!editingNote.parentId, editingNote) : undefined
                }
                onNoteLayout={(_, y) => {
                  noteYRef.current = y
                  tryScrollToDeepLink()
                }}
              />
            )}
          </View>
        ) : null}

        {/* Up next queue. Everyone sees what's lined up; the owner can start the
            next book now, reorder, or remove one. Only shown on the current-book
            view. The owner still gets the section when the queue is empty - that
            is where "Add books" lives, so hiding it would hide the way in. */}
        {section === 'queue' && isCurrentView && (detail.queue.length > 0 || isOwner) ? (
          <View style={styles.queueSection}>
            <View style={styles.queueHead}>
              <View style={styles.queueHeadLabel}>
                <AppText variant="eyebrow" color={colors.textMuted}>
                  Up next
                </AppText>
                {detail.queue.length > 0 ? (
                  <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                    {queueLengthLabel(detail.queue)}
                  </AppText>
                ) : null}
              </View>
              {isOwner ? (
                <Touchable
                  style={styles.addBooksBtn}
                  onPress={() => addBooksSheetRef.current?.present()}
                  accessibilityRole="button"
                  accessibilityLabel="Add books to up next"
                >
                  <Icon name={icons.add} size={14} color={colors.accent} />
                  <AppText variant="caption" color={colors.accent}>
                    Add books
                  </AppText>
                </Touchable>
              ) : null}
            </View>
            {detail.queue.length === 0 ? (
              <AppText variant="caption" color={colors.textMuted}>
                Line up what the club reads next.
              </AppText>
            ) : null}
            {detail.queue.map((b, i) => (
              <View key={b.libraryItemId} style={styles.queueRow}>
                <Touchable onPress={() => router.push(`/item/${b.libraryItemId}?from=${active}`)}>
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
                  <QueuedBookReaders members={detail.members} book={b} />
                </View>
                {isOwner ? (
                  <>
                    {detail.queue.length > 1 ? (
                      <>
                        <Touchable
                          hitSlop={6}
                          disabled={busy || i === 0}
                          onPress={() => void moveQueued(i, -1)}
                          accessibilityRole="button"
                          accessibilityLabel={`Move ${b.title || 'book'} up`}
                          style={{ padding: spacing.xs, opacity: i === 0 ? 0.3 : 1 }}
                        >
                          <Icon name={icons.arrowUpward} size={16} color={colors.textMuted} />
                        </Touchable>
                        <Touchable
                          hitSlop={6}
                          disabled={busy || i === detail.queue.length - 1}
                          onPress={() => void moveQueued(i, 1)}
                          accessibilityRole="button"
                          accessibilityLabel={`Move ${b.title || 'book'} down`}
                          style={{
                            padding: spacing.xs,
                            opacity: i === detail.queue.length - 1 ? 0.3 : 1,
                          }}
                        >
                          <Icon name={icons.arrowDownward} size={16} color={colors.textMuted} />
                        </Touchable>
                      </>
                    ) : null}
                    <Touchable
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => void dropQueued(b)}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${b.title || 'book'} from up next`}
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
        {section === 'members' ? (
          <View style={styles.queueSection}>
            {isOwner ? (
              <View style={styles.memberActions}>
                <Touchable
                  style={styles.memberAction}
                  onPress={() => void openInvites()}
                  accessibilityRole="button"
                  accessibilityLabel="Invite readers"
                >
                  <Icon name={icons.personAdd} size={18} color={colors.accent} />
                  <AppText variant="label" color={colors.accent}>
                    Invite readers
                  </AppText>
                </Touchable>
                <Touchable
                  style={styles.memberAction}
                  onPress={() => membersSheetRef.current?.present()}
                  accessibilityRole="button"
                  accessibilityLabel="Manage members"
                >
                  <Icon name={icons.people} size={18} color={colors.textMuted} />
                  <AppText variant="label">Manage members</AppText>
                </Touchable>
              </View>
            ) : null}
            {isOwner && pendingInvitees.length > 0 ? (
              <View style={styles.pendingInvites}>
                <AppText variant="eyebrow" color={colors.textMuted}>
                  Pending invites
                </AppText>
                {pendingInvitees.map((invitee) => (
                  <View key={invitee.pendingInviteId} style={styles.pendingInviteRow}>
                    <Avatar
                      uri={avatarUrl(invitee.userId)}
                      size={36}
                      name={invitee.username}
                      hue={coverHue(invitee.userId)}
                    />
                    <View style={styles.pendingInviteCopy}>
                      <AppText variant="label" numberOfLines={1}>
                        {invitee.username}
                      </AppText>
                      <AppText variant="caption" color={colors.textMuted}>
                        Waiting to join
                      </AppText>
                    </View>
                    <Touchable
                      style={styles.cancelInviteButton}
                      disabled={busy}
                      onPress={() => void cancelInvite(invitee)}
                      accessibilityRole="button"
                      accessibilityLabel={`Cancel invitation to ${invitee.username}`}
                    >
                      <AppText variant="caption" color={colors.textMuted}>
                        Cancel
                      </AppText>
                    </Touchable>
                  </View>
                ))}
              </View>
            ) : null}
            {sortedMembers.map((m) => (
              <MemberRace
                key={m.userId}
                member={m}
                isMe={m.userId === meId}
                onOpenUser={(userId) =>
                  router.push(`/user/${encodeURIComponent(userId)}?from=${active}`)
                }
              />
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Composer - members only, on the current book. Wrapped so the keyboard
          lifts it and it clears the docked mini player above the tab bar. */}
      {/* `padding` on BOTH platforms. Android used to pass undefined and rely on
          the window's adjustResize, but SDK 57 renders edge-to-edge and ignores
          it - so the composer sat behind the keyboard and you could not see what
          you were typing (HS-MOBILEAPP-17). */}
      {!isMember ? (
        <View style={styles.joinBar}>
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            Join to read the discussion. Members see your progress in this club&apos;s books.
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

      <Sheet
        ref={inviteSheetRef}
        title="Invite readers"
        kicker={detail.club.name}
        snapPoints={['78%']}
      >
        <AppText variant="meta" color={colors.textMuted} style={styles.inviteHelp}>
          Choose readers from this server. They’ll receive an in-app invitation and an email when an
          address is available.
        </AppText>
        {invitees === null ? (
          <Loading label="Loading readers…" />
        ) : invitees.length === 0 ? (
          <Centered>
            <Icon name={icons.people} size={34} color={colors.textMuted} />
            <AppText variant="label">Everyone is already here</AppText>
            <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
              There are no other server readers available to invite.
            </AppText>
          </Centered>
        ) : (
          <>
            <BottomSheetScrollView contentContainerStyle={styles.inviteList}>
              {invitees.map((invitee) => {
                const selected = selectedInvitees.includes(invitee.userId)
                return (
                  <View key={invitee.userId} style={styles.inviteRow}>
                    <Avatar
                      uri={avatarUrl(invitee.userId)}
                      size={40}
                      name={invitee.username}
                      hue={coverHue(invitee.userId)}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <AppText variant="label" numberOfLines={1}>
                        {invitee.username}
                      </AppText>
                      <AppText variant="caption" color={colors.textMuted}>
                        {invitee.pendingInviteId ? 'Invitation pending' : 'On this server'}
                      </AppText>
                    </View>
                    {invitee.pendingInviteId ? (
                      <Touchable
                        style={styles.inviteSecondary}
                        disabled={busy}
                        onPress={() => void cancelInvite(invitee)}
                        accessibilityRole="button"
                        accessibilityLabel={`Cancel invitation to ${invitee.username}`}
                      >
                        <AppText variant="caption">Cancel</AppText>
                      </Touchable>
                    ) : (
                      <Touchable
                        style={[styles.inviteSecondary, selected && styles.inviteSelected]}
                        onPress={() =>
                          setSelectedInvitees((value) =>
                            selected
                              ? value.filter((userId) => userId !== invitee.userId)
                              : [...value, invitee.userId],
                          )
                        }
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                        accessibilityLabel={`Invite ${invitee.username}`}
                      >
                        <Icon
                          name={selected ? icons.check : icons.personAdd}
                          size={17}
                          color={selected ? colors.onAccent : colors.textMuted}
                        />
                        <AppText variant="caption" color={selected ? colors.onAccent : colors.text}>
                          {selected ? 'Selected' : 'Select'}
                        </AppText>
                      </Touchable>
                    )}
                  </View>
                )
              })}
            </BottomSheetScrollView>
            <Touchable
              style={[styles.inviteSend, selectedInvitees.length === 0 && { opacity: 0.45 }]}
              disabled={selectedInvitees.length === 0 || busy}
              onPress={() => void sendInvites()}
              accessibilityRole="button"
              accessibilityLabel={`Send ${selectedInvitees.length} book club invitations`}
            >
              <Icon name={icons.send} size={18} color={colors.onAccent} />
              <AppText variant="label" color={colors.onAccent}>
                {busy
                  ? 'Sending…'
                  : `Send invites${selectedInvitees.length ? ` (${selectedInvitees.length})` : ''}`}
              </AppText>
            </Touchable>
          </>
        )}
      </Sheet>

      {/* Book history. */}
      <Sheet ref={historySheetRef} title="Book history" snapPoints={['60%']}>
        {detail.books.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
            No books yet.
          </AppText>
        ) : (
          detail.books.map((b) => {
            // A book leaves the current slot either finished or set aside, so
            // "not finished" alone no longer means it is the current read.
            const current =
              b.libraryItemId === detail.club.currentBook?.libraryItemId ||
              (b.finishedAt == null && b.abandonedAt == null)
            const setAside = !current && b.abandonedAt != null
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
                    {current ? 'Reading now' : setAside ? 'Set aside' : 'Finished'}
                  </AppText>
                </View>
                {isOwner && !current ? (
                  <Touchable
                    style={styles.requeueBtn}
                    disabled={busy}
                    onPress={() => {
                      historySheetRef.current?.dismiss()
                      void requeueBook(b)
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${b.title || 'book'} back to up next`}
                  >
                    <AppText variant="caption" color={colors.textMuted}>
                      Up next
                    </AppText>
                  </Touchable>
                ) : null}
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
            <Touchable
              style={styles.sheetAction}
              onPress={() => {
                ownerSheetRef.current?.dismiss()
                router.push(`/club/admin?id=${encodeURIComponent(detail.club.id)}&from=${active}`)
              }}
            >
              <Icon name={icons.settings} size={20} color={colors.textMuted} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="body">Club admin</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Who can join, discussion permissions, and reading pace
                </AppText>
              </View>
            </Touchable>
            {/* Archive is reversible, so it reads neutral - not the same red as
                Delete. The caption says the history can come back. */}
            <Touchable style={styles.sheetAction} onPress={() => void archive()}>
              <Icon name={icons.archive} size={20} color={colors.textMuted} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="body">Archive this club</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Hides it from active lists. Can be restored later.
                </AppText>
              </View>
            </Touchable>
            <Touchable style={styles.sheetAction} onPress={() => void removeClub()}>
              <Icon name={icons.delete} size={20} color={colors.destructive} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="body" color={colors.destructive}>
                  Delete this club
                </AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Permanently removes members, books, and notes.
                </AppText>
              </View>
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

      <AddClubBooksSheet
        ref={addBooksSheetRef}
        clubId={detail.club.id}
        clubName={detail.club.name}
        libraryId={libraryId}
        existing={[...detail.books, ...detail.queue]}
        onAdded={() => void load()}
        onMessage={show}
      />

      {/* Actions for one comment, opened by a tap or a long press. Reactions live
          here rather than as a permanent row under every note, which would crowd
          the thread; the tallies under a note stay tappable for a quick
          re-toggle. */}
      <Sheet ref={noteActionsRef} title={actionNote?.username || 'Comment'}>
        {actionNote ? (
          <>
            <View style={styles.reactPickRow}>
              {quickPicks.map((kind: NoteReactionKind) => {
                const mine = actionNote.reactions?.some((r) => r.kind === kind && r.mine) ?? false
                return (
                  <Touchable
                    key={kind}
                    style={[styles.reactPick, mine && styles.reactPickOn]}
                    disabled={!isMember}
                    onPress={() => {
                      noteActionsRef.current?.dismiss()
                      void toggleReaction(actionNote, kind, !mine)
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mine }}
                    accessibilityLabel={reactionLabel(kind)}
                  >
                    <AppText variant="title">{reactionGlyph(kind)}</AppText>
                  </Touchable>
                )
              })}
              {/* Anything outside the quick row. Pushed OVER this sheet rather
                  than replacing it, so dismissing the picker returns here. */}
              <Touchable
                style={styles.reactPick}
                disabled={!isMember}
                onPress={() => emojiPickerRef.current?.present()}
                accessibilityRole="button"
                accessibilityLabel="More reactions"
              >
                <Icon name={icons.add} size={20} color={colors.textMuted} />
              </Touchable>
            </View>
            {/* Turn a comment into a bookmark: jump to the moment being talked
                about. Only for a timestamped comment - a general note marks no
                spot to jump to. */}
            {actionNote.timeSec != null ? (
              <>
                <Touchable
                  style={styles.sheetAction}
                  onPress={() => {
                    noteActionsRef.current?.dismiss()
                    void playFromNote(actionNote, 0)
                  }}
                >
                  <Icon name={icons.play} size={20} color={colors.textMuted} />
                  <AppText variant="body">Play from here</AppText>
                </Touchable>
                <Touchable
                  style={styles.sheetAction}
                  onPress={() => {
                    noteActionsRef.current?.dismiss()
                    void playFromNote(actionNote, 60)
                  }}
                >
                  <Icon name={icons.replay} size={20} color={colors.textMuted} />
                  <AppText variant="body">Play from a minute before</AppText>
                </Touchable>
              </>
            ) : null}
            {isMember && detail.club.allowReplies && !actionNote.parentId ? (
              <Touchable
                style={styles.sheetAction}
                onPress={() => {
                  noteActionsRef.current?.dismiss()
                  beginReply(actionNote)
                }}
              >
                <Icon name={icons.chat} size={20} color={colors.textMuted} />
                <AppText variant="body">Reply</AppText>
              </Touchable>
            ) : null}
            {actionNote.userId === meId && (isOwner || detail.club.allowCommentEditing) ? (
              <Touchable
                style={styles.sheetAction}
                onPress={() => {
                  noteActionsRef.current?.dismiss()
                  setReplyTo(null)
                  setComposingNew(false)
                  setEditingNote(actionNote)
                  setBody(actionNote.body)
                  setSpoiler(actionNote.spoiler)
                  setStampEnabled(actionNote.timeSec != null)
                }}
              >
                <Icon name={icons.edit} size={20} color={colors.textMuted} />
                <AppText variant="body">Edit comment</AppText>
              </Touchable>
            ) : null}
            <Touchable
              style={styles.sheetAction}
              onPress={() => {
                noteActionsRef.current?.dismiss()
                void Clipboard.setStringAsync(actionNote.body).then(() => show('Comment copied'))
              }}
            >
              <Icon name={icons.notes} size={20} color={colors.textMuted} />
              <AppText variant="body">Copy text</AppText>
            </Touchable>
            <Touchable
              style={styles.sheetAction}
              onPress={() => {
                noteActionsRef.current?.dismiss()
                router.push(`/user/${encodeURIComponent(actionNote.userId)}?from=${active}`)
              }}
            >
              <Icon name={icons.person} size={20} color={colors.textMuted} />
              <AppText variant="body">View profile</AppText>
            </Touchable>
            {actionNote.userId === meId || isOwner ? (
              <Touchable
                style={styles.sheetAction}
                onPress={() => {
                  noteActionsRef.current?.dismiss()
                  void removeNote(actionNote)
                }}
              >
                <Icon name={icons.delete} size={20} color={colors.destructive} />
                <AppText variant="body" color={colors.destructive}>
                  Delete
                </AppText>
              </Touchable>
            ) : null}
          </>
        ) : null}
      </Sheet>

      <Sheet ref={reactionsSheetRef} title="Reactions" snapPoints={['55%']}>
        <View style={styles.reactionTabs}>
          {reactionDetails.map((detailRow) => (
            <Touchable
              key={detailRow.kind}
              style={[styles.reactionTab, reactionKind === detailRow.kind && styles.reactionTabOn]}
              onPress={() => setReactionKind(detailRow.kind)}
              accessibilityRole="tab"
              accessibilityState={{ selected: reactionKind === detailRow.kind }}
            >
              <AppText variant="meta">
                {reactionGlyph(detailRow.kind)} {detailRow.users.length}
              </AppText>
            </Touchable>
          ))}
        </View>
        {reactionDetails.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
            Loading reactions…
          </AppText>
        ) : (
          (
            reactionDetails.find((row) => row.kind === reactionKind) ?? reactionDetails[0]
          ).users.map((user) => (
            <Touchable
              key={user.userId}
              style={styles.memberRow}
              onPress={() => {
                reactionsSheetRef.current?.dismiss()
                router.push(`/user/${encodeURIComponent(user.userId)}?from=${active}`)
              }}
            >
              <Avatar
                uri={avatarUrl(user.userId)}
                size={36}
                name={user.username}
                hue={coverHue(user.userId)}
              />
              <AppText variant="label" style={{ flex: 1 }}>
                {user.username}
              </AppText>
              {reactionNote?.reactions?.find((r) => r.kind === reactionKind)?.mine &&
              user.userId === meId ? (
                <AppText variant="caption" color={colors.textMuted}>
                  You
                </AppText>
              ) : null}
            </Touchable>
          ))
        )}
      </Sheet>

      {/* Layered over the actions sheet, so picking an emoji (or backing out)
          returns to the comment it belongs to. */}
      <EmojiPickerSheet
        sheetRef={emojiPickerRef}
        onPick={(emoji) => {
          if (!actionNote) return
          const mine = actionNote.reactions?.some((r) => r.kind === emoji && r.mine) ?? false
          noteActionsRef.current?.dismiss()
          void toggleReaction(actionNote, emoji, !mine)
        }}
      />

      <Toast message={message} />
    </Screen>
  )
}

function QueuedBookReaders({ members, book }: { members: HSClubMember[]; book: HSClubBook }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const readers = members.filter(
    (member) =>
      member.reach?.aheadOfClub === true && member.reach.libraryItemId === book.libraryItemId,
  )
  if (!readers.length) return null

  const first = readers[0]
  const allFinished = readers.every((reader) => reader.reach?.isFinished === true)
  const readerLabel =
    readers.length === 1
      ? `${first.username} ${allFinished ? 'finished' : 'is on'} this book`
      : `${first.username} + ${readers.length - 1} ${
          readers.length === 2 ? 'reader' : 'readers'
        } ${allFinished ? 'finished' : 'are on'} this book`

  return (
    <View
      style={styles.queueReaders}
      accessible
      accessibilityLabel={readers
        .map(
          (reader) =>
            `${reader.username} ${reader.reach?.isFinished ? 'finished' : 'is on'} this book`,
        )
        .join('. ')}
    >
      <View style={styles.queueReaderAvatars}>
        {readers.slice(0, 3).map((reader, index) => (
          <View
            key={reader.userId}
            style={[styles.queueReaderAvatar, index > 0 && { marginLeft: -6 }]}
          >
            <Avatar
              uri={avatarUrl(reader.userId)}
              size={18}
              name={reader.username}
              hue={coverHue(reader.userId)}
            />
          </View>
        ))}
      </View>
      <AppText variant="caption" color={colors.accent} numberOfLines={1} style={{ flex: 1 }}>
        {readerLabel}
      </AppText>
    </View>
  )
}

// ---- Member progress race row ----

function MemberRace({
  member,
  isMe,
  onOpenUser,
}: {
  member: HSClubMember
  isMe: boolean
  onOpenUser?: (userId: string) => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const fraction =
    member.currentTime != null && member.duration != null && member.duration > 0
      ? Math.max(0, Math.min(1, member.currentTime / member.duration))
      : 0
  const finished = member.isFinished === true
  return (
    <Touchable
      style={styles.raceRow}
      disabled={!onOpenUser}
      onPress={() => onOpenUser?.(member.userId)}
      accessibilityRole={onOpenUser ? 'button' : undefined}
      accessibilityLabel={onOpenUser ? `View ${member.username}'s profile` : undefined}
    >
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
            // Percent AND timestamp. A percentage alone can't be compared with a
            // comment, which is stamped at a time - so "42%" and "1:02:05" were
            // two units for the same thing and neither could be read against the
            // other (HS-MOBILEAPP-25).
            <AppText variant="caption" color={colors.textMuted}>
              {Math.round(fraction * 100)}%
              {member.currentTime != null ? ` · ${formatTimestamp(member.currentTime)}` : ''}
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
        {/* Where this member is across the club's whole book list, shown only
            once there is more than one book for them to be somewhere in. */}
        {member.reach && member.reach.total > 1 ? (
          <View style={styles.reachRow}>
            {member.reach.aheadOfClub ? (
              <Icon name={icons.trending} size={12} color={colors.accent} />
            ) : null}
            <AppText
              variant="caption"
              color={member.reach.aheadOfClub ? colors.accent : colors.textFaint}
              numberOfLines={1}
            >
              Book {member.reach.index + 1} of {member.reach.total}
              {member.reach.title ? ` · ${member.reach.title}` : ''}
            </AppText>
          </View>
        ) : null}
        {member.listeningNow ? (
          <AppText variant="caption" color={colors.accent} style={{ marginTop: 2 }}>
            Listening now
          </AppText>
        ) : null}
      </View>
    </Touchable>
  )
}

// ---- Header ----

/** The discussion as seen from OUTSIDE a public club.
 *
 * There is nothing to un-blur here: the server sends no comment bodies to a
 * non-member, so each row is a stub carrying only who wrote it and where in the
 * book they were. The blur is honest rather than decorative - tapping does
 * nothing, because the text does not exist on this device. */
function LockedDiscussion({
  stubs,
  total,
  durationSec,
  colors,
  styles,
}: {
  stubs: HSNoteStub[]
  total: number
  durationSec: number
  colors: Palette
  styles: ReturnType<typeof makeStyles>
}) {
  if (total === 0) {
    return (
      <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
        No comments on this book yet.
      </AppText>
    )
  }
  return (
    <View>
      <View style={styles.lockedBanner}>
        <Icon name={icons.lock} size={16} color={colors.textMuted} />
        <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
          {total === 1 ? '1 comment is' : `${total} comments are`} hidden. Join this club to read
          the discussion.
        </AppText>
      </View>
      {stubs.map((stub) => (
        <View key={stub.id} style={styles.lockedRow}>
          <Avatar
            uri={stub.userId ? avatarUrl(stub.userId) : undefined}
            size={30}
            name={stub.username ?? ''}
            hue={coverHue(stub.userId ?? stub.id)}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.lockedMeta}>
              <AppText variant="caption" numberOfLines={1}>
                {stub.username || 'A member'}
              </AppText>
              {stub.timeSec != null ? (
                <AppText variant="caption" color={colors.textMuted}>
                  {durationSec > 0 ? formatTimestamp(stub.timeSec) : ''}
                </AppText>
              ) : null}
            </View>
            {/* Fixed-width bars, not the real text - the body never reached us. */}
            <View style={styles.lockedBars}>
              <View style={[styles.lockedBar, { width: '92%' }]} />
              <View style={[styles.lockedBar, { width: '64%' }]} />
            </View>
          </View>
        </View>
      ))}
    </View>
  )
}

function Header({
  title,
  subtitle,
  onBack,
  onOverflow,
}: {
  title: string
  subtitle?: string
  onBack: () => void
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
    progressStripWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    sectionTabs: {
      flexDirection: 'row',
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    sectionTab: {
      minHeight: 48,
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    sectionTabOn: { borderBottomColor: colors.accent },
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
    queueReaders: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: 4,
    },
    queueReaderAvatars: { flexDirection: 'row', alignItems: 'center' },
    queueReaderAvatar: {
      borderWidth: 1,
      borderColor: colors.card,
      borderRadius: 10,
    },
    queueStartBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    requeueBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    emptyBook: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xl,
    },
    reachRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    reactPickRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: spacing.md,
      paddingBottom: spacing.sm,
    },
    reactPick: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.fill,
    },
    reactPickOn: { borderColor: colors.accent, backgroundColor: colors.accentWash },
    queueHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    // Eyebrow + queue summary sit together on the left so "Add books" stays
    // pinned right; the summary shrinks first when a long total meets a narrow
    // screen.
    queueHeadLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
    addBooksBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: spacing.xs },
    chatSection: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
    newThreadButton: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
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
    inlineComposer: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.md,
      marginBottom: spacing.md,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.card,
    },
    composerTools: { gap: spacing.sm },
    composerOptions: { gap: spacing.sm },
    composerActions: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.sm,
    },
    spoilerToggle: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.fill,
    },
    spoilerToggleOn: { borderColor: colors.accent, backgroundColor: colors.accentWash },
    cancelComposerBtn: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
    },
    stampChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      paddingLeft: spacing.md,
      paddingRight: 2,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: colors.accentWash,
    },
    stampAdd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
    // Quoted context for the comment being replied to. Tinted and bar-marked so
    // it reads as "this is what you're answering" rather than a stray caption.
    replyBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.accentWash,
      borderRadius: radius.row,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    replyBar: {
      width: 3,
      alignSelf: 'stretch',
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    // Sits in the composer stack above the input (like the reply banner) rather
    // than floating over it, so it stays attached to the exact thread target.
    mentionList: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      overflow: 'hidden',
    },
    mentionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
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
    lockedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      marginBottom: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    lockedRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingVertical: spacing.md,
      opacity: 0.55,
    },
    lockedMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    lockedBars: { marginTop: spacing.sm, gap: 6 },
    lockedBar: {
      height: 9,
      borderRadius: radius.pill,
      backgroundColor: colors.hairline,
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
    memberActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    memberAction: {
      flex: 1,
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.fill,
    },
    pendingInvites: {
      gap: spacing.xs,
      marginBottom: spacing.md,
    },
    pendingInviteRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    pendingInviteCopy: { flex: 1, minWidth: 0 },
    cancelInviteButton: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
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
    reactionTabs: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    reactionTab: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
    reactionTabOn: {
      backgroundColor: colors.accentWash,
      borderWidth: 1,
      borderColor: colors.accent,
    },
    inviteHelp: { marginBottom: spacing.md, lineHeight: 20 },
    inviteList: { paddingBottom: spacing.md },
    inviteRow: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    inviteSecondary: {
      minWidth: 88,
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
    },
    inviteSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
    inviteSend: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
  })
