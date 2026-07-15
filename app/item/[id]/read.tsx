/**
 * Ebook reader screen. Renders the item's EPUB with @epubjs-react-native/core
 * (epub.js inside a WebView) using the shared @hearthshelf/core reader-pref
 * model, so themes/typography match the web readers. Reachable from the item
 * screen's "Read" action when the book has an ebook file.
 *
 * The EPUB bytes are fetched with the per-user ABS token and handed to the
 * reader as a base64 data source (the reader treats a `base64,` string as an
 * in-memory book - no file-system download, no extra native module). Reading
 * position is saved per item as a CFI in AsyncStorage and restored on reopen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { AppSlider } from '@/ui/AppSlider'
import { showToast } from '@/ui/Toast'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Reader, ReaderProvider, useReader } from '@epubjs-react-native/core'
import type { Location, Section } from '@epubjs-react-native/core'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { cacheDirectory, documentDirectory, downloadAsync } from 'expo-file-system/legacy'
import {
  ABS_ENDPOINTS,
  cfiStorageKey,
  READER_THEMES,
  READER_SIZE_MIN,
  READER_SIZE_MAX,
  type ReaderPrefs,
  type ReaderTheme,
  type ReaderFont,
} from '@hearthshelf/core'
import { getSession } from '@/api/session'
import { getItemDetail } from '@/api/abs'
import { useTheme } from '@/ui/ThemeProvider'
import { AppText, IconButton } from '@/ui/primitives'
import { icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { useReaderFileSystem } from '@/reader/readerFileSystem'
import { buildReaderTheme } from '@/reader/readerTheme'
import { READER_FONT_FAMILIES } from '@/reader/readerPrefs'
import {
  getReaderPrefs,
  setReaderPref,
  subscribeReaderPrefs,
  hydrateReaderPrefs,
} from '@/reader/readerPrefs'

function useReaderPrefs(): ReaderPrefs {
  return useSyncExternalStore(subscribeReaderPrefs, getReaderPrefs, getReaderPrefs)
}

// Download the EPUB with the ABS token to a cache file and return its file://
// URI. The reader detects a ".epub" file source and loads it with epub.js/jszip
// straight from the file (WebView file access is enabled). We deliberately do
// NOT base64-inline the book: that bloats index.html to the book's size and
// crashes the WebView renderer on large books (DCC). We also can't use
// fetch().blob() - RN can't build a Blob from the response ArrayBuffer.
async function fetchEbookFileUri(itemId: string): Promise<string> {
  const session = getSession()
  if (!session) throw new Error('not_connected')
  const url = `${session.serverUrl}${ABS_ENDPOINTS.itemEbook(itemId)}`
  const dir = cacheDirectory ?? documentDirectory
  if (!dir) throw new Error('no_cache_dir')
  const fileUri = `${dir}reader-${itemId}.epub`
  const dl = await downloadAsync(url, fileUri, {
    headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/epub+zip' },
  })
  if (dl.status !== 200) throw new Error(`ebook ${dl.status}`)
  return dl.uri
}

export default function ReaderScreen() {
  return (
    <ReaderProvider>
      <ReaderInner />
    </ReaderProvider>
  )
}

function ReaderInner() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const prefs = useReaderPrefs()
  const { goToLocation, goPrevious, goNext, changeTheme, changeFontSize, toc, locations } =
    useReader()

  const [src, setSrc] = useState<string | null>(null)
  const [title, setTitle] = useState('Reading')
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'settings' | 'chapters' | null>(null)
  const [pct, setPct] = useState(0)
  const [chapterLabel, setChapterLabel] = useState('')
  // Whether the position slider spans the whole book or the current chapter,
  // mirroring the audio scrubber's Chapter/Book scope pill (D-CONSIST).
  const [scope, setScope] = useState<'chapter' | 'book'>('book')
  // Chapter-relative page position from the reader's `displayed` counters, so
  // chapter scope can scrub and show "N min left in chapter".
  const [chPage, setChPage] = useState(0)
  const [chPages, setChPages] = useState(0)
  // The whole-book CFI before a slider jump, so a big jump can be undone.
  const preJumpCfi = useRef<string | undefined>(undefined)
  // Live drag flag + last chapter seen, so the location callback can fire a
  // chapter-crossing haptic only while the user is actively scrubbing.
  const dragging = useRef(false)
  const lastChapterRef = useRef('')
  // Reading pace, in whole-book fraction per minute, smoothed across turns, to
  // estimate time left. Seeded conservatively until we've measured a real pace.
  const pace = useRef<{ pctPerMs: number; lastPct: number; lastAt: number }>({
    pctPerMs: 0,
    lastPct: 0,
    lastAt: 0,
  })
  const [paceReady, setPaceReady] = useState(false)
  const initialCfi = useRef<string | undefined>(undefined)
  const readerTheme = READER_THEMES[prefs.theme]
  // Stable per pref-values so it isn't a new object every render (the Reader
  // depends on defaultTheme; a fresh ref each render loops it).
  const epubTheme = useMemo(
    () => buildReaderTheme(prefs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs.theme, prefs.font, prefs.size, prefs.lh, prefs.width, prefs.align],
  )

  // Load prefs + the book once.
  useEffect(() => {
    let cancelled = false
    void hydrateReaderPrefs()
    ;(async () => {
      if (!id) return
      try {
        const saved = (await AsyncStorage.getItem(cfiStorageKey(id))) || undefined
        if (!cancelled) initialCfi.current = saved
        // Title is nice-to-have; don't block the book on it.
        getItemDetail(id)
          .then((d) => {
            if (!cancelled) setTitle(d.media.metadata.title || 'Reading')
          })
          .catch(() => {})
        const fileUri = await fetchEbookFileUri(id)
        if (!cancelled) setSrc(fileUri)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'load_failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  // Re-apply the theme + size whenever the actual pref VALUES change (after the
  // book renders). Depend on the primitive fields, not the prefs object or the
  // changeTheme/changeFontSize identities - useReader() returns fresh function
  // refs every render, so depending on them would loop this effect forever
  // ("Maximum update depth exceeded").
  const ready = Boolean(src)
  useEffect(() => {
    if (!ready) return
    changeTheme(epubTheme)
    changeFontSize(`${prefs.size}px`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, epubTheme, prefs.size])

  const onLocationChange = useCallback(
    (_total: number, current: Location, progress: number, section: Section | null) => {
      if (!id) return
      const cfi = current?.start?.cfi
      if (cfi) void AsyncStorage.setItem(cfiStorageKey(id), cfi)
      const displayed = current?.start?.displayed
      if (displayed) {
        setChPage(displayed.page ?? 0)
        setChPages(displayed.total ?? 0)
      }
      if (typeof progress === 'number' && !Number.isNaN(progress)) {
        setPct(progress)
        // Measure reading pace from forward progress between page turns. Ignore
        // backward jumps and slider seeks (which set preJumpCfi); a page turn is
        // a small forward delta over a short-to-moderate dwell.
        const now = Date.now()
        const p = pace.current
        const dPct = progress - p.lastPct
        const dMs = now - p.lastAt
        if (p.lastAt > 0 && dPct > 0 && dPct < 0.05 && dMs > 1500 && dMs < 10 * 60_000) {
          const inst = dPct / dMs
          // Exponential smoothing so one slow/fast page doesn't swing the estimate.
          p.pctPerMs = p.pctPerMs > 0 ? p.pctPerMs * 0.7 + inst * 0.3 : inst
          if (!paceReady) setPaceReady(true)
        }
        p.lastPct = progress
        p.lastAt = now
      }
      if (section?.label) {
        const label = section.label.trim()
        // A chapter tick while scrubbing: pulse when the seeked position lands in
        // a new chapter, so a fast drag "clicks" past chapter boundaries.
        if (dragging.current && label !== lastChapterRef.current) haptics.select()
        lastChapterRef.current = label
        setChapterLabel(label)
      }
    },
    [id, paceReady],
  )

  const back = () => {
    if (panel) setPanel(null)
    else router.back()
  }

  // Seek to a whole-book fraction (0..1) by indexing the generated location
  // table - the one seek primitive epub.js exposes that reliably lands anywhere,
  // the page-model equivalent of the audio scrubber's SetValue.
  const seekToBookFraction = useCallback(
    (frac: number) => {
      const list = locations ?? []
      if (list.length === 0) return
      const idx = Math.max(0, Math.min(list.length - 1, Math.round(frac * (list.length - 1))))
      const cfi = list[idx]
      if (cfi) goToLocation(cfi)
    },
    [locations, goToLocation],
  )

  // Chapter scope maps the slider (0..1 within the chapter) onto the chapter's
  // slice of the whole book, estimated from where we are now plus how far
  // through the chapter's pages we are. Book scope is a straight 0..1.
  const chapterFrac = chPages > 1 ? (chPage - 1) / (chPages - 1) : 0
  // Estimated chapter width in whole-book fraction: pages-in-chapter as a share
  // of an assumed ~book-average, bounded so a huge/tiny chapter stays sane.
  const chapterWidth = Math.min(0.5, Math.max(0.02, chPages > 0 ? 1 / Math.max(1, toc.length) : 0.1))
  const chapterStart = Math.max(0, Math.min(1 - chapterWidth, pct - chapterFrac * chapterWidth))

  const sliderValue = scope === 'book' ? pct : chapterFrac
  const onSlide = (v: number) => {
    // Remember where we were the moment a drag begins, so a big jump is undoable.
    if (!dragging.current) {
      dragging.current = true
      preJumpCfi.current = initialCfi.current
      void AsyncStorage.getItem(id ? cfiStorageKey(id) : '').then((c) => {
        if (c) preJumpCfi.current = c
      })
    }
    if (scope === 'book') seekToBookFraction(v)
    else seekToBookFraction(chapterStart + v * chapterWidth)
  }
  const onSlideComplete = (v: number) => {
    dragging.current = false
    const from = scope === 'book' ? pct : chapterFrac
    // A big jump (>10% of the current scope) offers a one-tap return.
    if (Math.abs(v - from) > 0.1) {
      const cfi = preJumpCfi.current
      if (cfi) {
        showToast('Jumped', {
          action: { label: 'Back to page', onPress: () => goToLocation(cfi) },
        })
      }
    }
  }

  // "~N min left" from measured pace. Book scope = to end of book; chapter scope
  // = to the end of the current chapter. Hidden until a pace is measured.
  const remainingFrac =
    scope === 'book' ? Math.max(0, 1 - pct) : Math.max(0, (1 - chapterFrac) * chapterWidth)
  const minsLeft =
    paceReady && pace.current.pctPerMs > 0
      ? Math.round(remainingFrac / pace.current.pctPerMs / 60_000)
      : null
  const estimate =
    minsLeft != null && minsLeft > 0
      ? `~${minsLeft} min left${scope === 'chapter' ? ' in chapter' : ''}`
      : null

  if (error) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: colors.scaffold }]}>
        <AppText style={{ color: colors.textMuted, marginBottom: 8 }}>
          Could not open this ebook.
        </AppText>
        <AppText style={{ color: colors.textMuted, marginBottom: 16, fontSize: 11, opacity: 0.7 }}>
          {error}
        </AppText>
        <Pressable onPress={() => router.back()} style={[styles.btn, { borderColor: colors.border }]}>
          <AppText style={{ color: colors.text }}>Go back</AppText>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={[styles.fill, { backgroundColor: readerTheme.bg, paddingTop: insets.top }]}>
      {/* Top bar - app chrome, uses the reader-page palette so it blends with
          the book surface rather than the app scaffold. */}
      <View style={styles.topbar}>
        <IconButton name={icons.back} onPress={back} color={readerTheme.ink} />
        <AppText numberOfLines={1} style={[styles.title, { color: readerTheme.ink }]}>
          {title}
        </AppText>
        <IconButton
          name={icons.chapters}
          onPress={() => setPanel((p) => (p === 'chapters' ? null : 'chapters'))}
          color={readerTheme.ink}
        />
        <IconButton
          name={icons.textFields}
          onPress={() => setPanel((p) => (p === 'settings' ? null : 'settings'))}
          color={readerTheme.ink}
        />
      </View>

      {/* The book. */}
      <View style={styles.stage}>
        {src ? (
          <Reader
            src={src}
            fileSystem={useReaderFileSystem}
            width="100%"
            height="100%"
            initialLocation={initialCfi.current}
            defaultTheme={epubTheme}
            flow={prefs.layout === 'paged' ? 'paginated' : 'scrolled-doc'}
            onLocationChange={onLocationChange}
            onDisplayError={(reason) => setError(reason)}
          />
        ) : (
          <View style={[styles.fill, styles.center]}>
            <ActivityIndicator color={readerTheme.ink} />
            <AppText style={{ color: readerTheme.faint, marginTop: 12 }}>Opening book...</AppText>
          </View>
        )}
      </View>

      {/* Bottom position bar: scope pill + chapter/estimate row, then the
          draggable position slider flanked by single-step page arrows. Mirrors
          the audio scrubber so both mediums scrub the same way (D-CONSIST). */}
      <View style={[styles.pagebar, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.posInfoRow}>
          <Pressable
            onPress={() => {
              haptics.select()
              setScope((s) => (s === 'book' ? 'chapter' : 'book'))
            }}
            style={[styles.scopePill, { borderColor: readerTheme.line }]}
          >
            <AppText style={{ color: readerTheme.ink, fontSize: 12, fontWeight: '600' }}>
              {scope === 'book' ? 'Book' : 'Chapter'}
            </AppText>
          </Pressable>
          <AppText numberOfLines={1} style={{ color: readerTheme.faint, flex: 1, fontSize: 12 }}>
            {chapterLabel || `${Math.round(pct * 100)}%`}
          </AppText>
          {estimate ? (
            <AppText style={{ color: readerTheme.faint, fontSize: 12 }}>{estimate}</AppText>
          ) : null}
        </View>
        <View style={styles.posSliderRow}>
          <IconButton
            name={icons.chevronLeft}
            onPress={() => goPrevious()}
            color={readerTheme.ink}
          />
          <AppSlider
            value={sliderValue}
            min={0}
            max={1}
            step={0.005}
            haptic={false}
            onChange={onSlide}
            onComplete={onSlideComplete}
            style={{ flex: 1 }}
          />
          <IconButton name={icons.chevronRight} onPress={() => goNext()} color={readerTheme.ink} />
        </View>
      </View>

      {panel === 'settings' && (
        <SettingsPanel prefs={prefs} onClose={() => setPanel(null)} tokens={readerTheme} />
      )}
      {panel === 'chapters' && (
        <ChaptersPanel
          toc={toc}
          onPick={(href) => {
            setPanel(null)
            goToLocation(href)
          }}
          tokens={readerTheme}
        />
      )}
    </View>
  )
}

// ---- Settings panel: theme, font, size, layout ----------------------------

const THEME_ORDER: ReaderTheme[] = ['light', 'sepia', 'paper', 'dark']
const FONT_ORDER: { key: ReaderFont; label: string }[] = [
  { key: 'serif', label: 'Serif' },
  { key: 'sans', label: 'Sans' },
  { key: 'dyslexic', label: 'Dyslexic' },
]

function SettingsPanel({
  prefs,
  onClose,
  tokens,
}: {
  prefs: ReaderPrefs
  onClose: () => void
  tokens: (typeof READER_THEMES)[ReaderTheme]
}) {
  return (
    <Pressable style={styles.scrim} onPress={onClose}>
      <Pressable style={[styles.panel, { backgroundColor: tokens.surface }]} onPress={() => {}}>
        <AppText style={[styles.panelSec, { color: tokens.faint }]}>Theme</AppText>
        <View style={styles.row}>
          {THEME_ORDER.map((t) => {
            const on = prefs.theme === t
            const tt = READER_THEMES[t]
            return (
              <Pressable
                key={t}
                onPress={() => {
                  haptics.select()
                  setReaderPref('theme', t)
                }}
                style={[
                  styles.swatch,
                  { backgroundColor: tt.bg, borderColor: on ? tokens.ink : tt.line },
                ]}
              >
                <AppText style={{ color: tt.ink, fontSize: 15 }}>Aa</AppText>
              </Pressable>
            )
          })}
        </View>

        <AppText style={[styles.panelSec, { color: tokens.faint }]}>Typeface</AppText>
        <View style={styles.row}>
          {FONT_ORDER.map((f) => {
            const on = prefs.font === f.key
            return (
              <Pressable
                key={f.key}
                onPress={() => {
                  haptics.select()
                  setReaderPref('font', f.key)
                }}
                style={[styles.seg, { borderColor: on ? tokens.ink : tokens.line }]}
              >
                <AppText style={{ color: tokens.ink, fontFamily: READER_FONT_FAMILIES[f.key] }}>
                  {f.label}
                </AppText>
              </Pressable>
            )
          })}
        </View>

        <AppText style={[styles.panelSec, { color: tokens.faint }]}>Text size</AppText>
        <View style={styles.row}>
          <Pressable
            onPress={() => setReaderPref('size', Math.max(READER_SIZE_MIN, prefs.size - 1))}
            style={[styles.stepBtn, { borderColor: tokens.line }]}
          >
            <AppText style={{ color: tokens.ink, fontSize: 18 }}>A-</AppText>
          </Pressable>
          <AppText style={{ color: tokens.ink, minWidth: 44, textAlign: 'center' }}>
            {prefs.size}px
          </AppText>
          <Pressable
            onPress={() => setReaderPref('size', Math.min(READER_SIZE_MAX, prefs.size + 1))}
            style={[styles.stepBtn, { borderColor: tokens.line }]}
          >
            <AppText style={{ color: tokens.ink, fontSize: 22 }}>A+</AppText>
          </Pressable>
        </View>

        <AppText style={[styles.panelSec, { color: tokens.faint }]}>Layout</AppText>
        <View style={styles.row}>
          {(['scroll', 'paged'] as const).map((l) => {
            const on = prefs.layout === l
            return (
              <Pressable
                key={l}
                onPress={() => {
                  haptics.select()
                  setReaderPref('layout', l)
                }}
                style={[styles.seg, { borderColor: on ? tokens.ink : tokens.line }]}
              >
                <AppText style={{ color: tokens.ink }}>{l === 'scroll' ? 'Scroll' : 'Paged'}</AppText>
              </Pressable>
            )
          })}
        </View>
      </Pressable>
    </Pressable>
  )
}

function ChaptersPanel({
  toc,
  onPick,
  tokens,
}: {
  toc: { label: string; href: string }[]
  onPick: (href: string) => void
  tokens: (typeof READER_THEMES)[ReaderTheme]
}) {
  return (
    <Pressable style={styles.scrim} onPress={() => onPick.length && undefined}>
      <Pressable style={[styles.panel, { backgroundColor: tokens.surface }]} onPress={() => {}}>
        <AppText style={[styles.panelSec, { color: tokens.faint }]}>Chapters</AppText>
        <ScrollView style={{ maxHeight: 360 }}>
          {toc.map((c) => (
            <Pressable
              key={c.href}
              onPress={() => onPick(c.href)}
              style={[styles.chapRow, { borderBottomColor: tokens.line }]}
            >
              <AppText numberOfLines={1} style={{ color: tokens.ink }}>
                {c.label.trim()}
              </AppText>
            </Pressable>
          ))}
        </ScrollView>
      </Pressable>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: { flex: 1, fontSize: 15, fontWeight: '600' },
  stage: { flex: 1 },
  pagebar: {
    paddingHorizontal: 12,
    paddingTop: 6,
    gap: 4,
  },
  posInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  scopePill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  posSliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  btn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  panel: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 34,
    gap: 6,
  },
  panelSec: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  swatch: {
    width: 54,
    height: 44,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seg: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  stepBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minWidth: 52,
    alignItems: 'center',
  },
  chapRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
})
