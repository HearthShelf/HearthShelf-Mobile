/**
 * "What's new" - the Home header chip and the release-notes modal it opens.
 *
 * The chip is the whole point of the design: an update announcement should be
 * something you notice and choose, not a dialog thrown in front of the app you
 * opened to use. It sits beside Home's Arrange button with a slow accent
 * gradient sweep to catch the eye, survives two launches (see lib/whatsNew.ts),
 * and then gets out of the way. The same modal is permanently reachable from
 * Settings > About.
 *
 * Notes come from the public changelog API (api/changelog.ts) - the same data
 * the website's Changelog page shows, so there is nothing to keep in sync by
 * hand. Sections are colour-coded on a fixed severity order.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import {
  entriesUpToVersion,
  fetchMobileChangelog,
  type ChangelogEntry,
  type ChangelogSection,
} from '@/api/changelog'
import { FULL_VERSION } from '@/lib/config'
import { dismissChip } from '@/lib/whatsNew'
import { Icon, icons } from '@/ui/icons'
import { AppText, Touchable } from '@/ui/primitives'
import { useReducedMotion } from '@/ui/motion'
import { useColors, useTheme } from '@/ui/ThemeProvider'
import { radius, spacing, withAlpha, type Palette } from '@/ui/theme'

/** One sweep of the chip's gradient. Slow enough to read as a shimmer. */
const SWEEP_MS = 2600

/**
 * Section presentation, in the order they're shown. Breaking first because it's
 * the one thing a reader must not miss; docs/other last because they rarely
 * matter to someone who just wants to know what changed.
 *
 * Colours are literals rather than theme tokens on purpose: green-means-added
 * is the meaning here, and it must survive an accent change.
 *
 * Each carries a light twin of the same hue. The dark values are tuned for the
 * dark room and drop to 1.7-2.6:1 on a light ground - these render as label TEXT,
 * not just a dot, so they need 4.5:1. The twins keep the meaning and clear it.
 */
const SECTION_META: Record<ChangelogSection, { label: string; color: string; colorLight: string }> =
  {
    breaking: { label: 'Heads up', color: '#e0654a', colorLight: '#b03f34' },
    feature: { label: 'New', color: '#4ade80', colorLight: '#1f7a3d' },
    change: { label: 'Improved', color: '#60a5fa', colorLight: '#1d5fb8' },
    fix: { label: 'Fixed', color: '#fbbf24', colorLight: '#8a5a02' },
    docs: { label: 'Docs', color: '#94a3b8', colorLight: '#4a5568' },
    other: { label: 'Notes', color: '#94a3b8', colorLight: '#4a5568' },
  }

const SECTION_ORDER: ChangelogSection[] = ['breaking', 'feature', 'change', 'fix', 'docs', 'other']

/** '2026-08-14T12:00:00Z' -> 'Aug 14, 2026'. Empty string if unparseable. */
function formatReleaseDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---- Chip ----

/**
 * The Home header chip. Renders nothing unless `visible`, so Home can mount it
 * unconditionally and let the launch-budget check decide.
 */
export function WhatsNewChip({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const colors = useColors()
  const styles = useStyles()
  const reduceMotion = useReducedMotion()
  // -1 -> 1 in screen-widths, same shape as states.tsx's Skeleton shimmer: the
  // band is fully off one edge at each end, so the loop's wrap is invisible.
  // Linear easing for the same reason - an eased loop visibly stops and restarts.
  const x = useSharedValue(-1)

  useEffect(() => {
    if (!visible || reduceMotion) return
    x.value = -1
    x.value = withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1, false)
    // An infinite withRepeat keeps running on the UI thread even once this
    // renders null, so cancel it when the chip is retired or unmounts.
    return () => {
      cancelAnimation(x)
    }
  }, [visible, reduceMotion, x])

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: `${x.value * 100}%` }],
  }))

  if (!visible) return null

  return (
    <Touchable
      onPress={onPress}
      accessibilityRole="button"
      style={styles.chip}
      accessibilityLabel={`What's new in version ${FULL_VERSION}`}
    >
      {/* Reduced motion keeps the tint but not the travel: an unanimated
          absoluteFill gradient is already the centred, even wash we want. */}
      <Animated.View
        style={[styles.chipSweep, reduceMotion ? null : sweepStyle]}
        pointerEvents="none"
      >
        <LinearGradient
          colors={[
            withAlpha(colors.accent, 0.1),
            withAlpha(colors.accent, 0.55),
            withAlpha(colors.accent, 0.1),
          ]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.chipSweep}
        />
      </Animated.View>
      <Icon name={icons.newRelease} size={14} color={colors.accent} />
      <AppText variant="caption" color={colors.text} numberOfLines={1} style={styles.chipLabel}>
        What&apos;s New!
      </AppText>
    </Touchable>
  )
}

// ---- Modal ----

/**
 * Release-notes modal: 80% of the screen wide, 70% tall, as specified. A
 * centered card rather than a bottom sheet because this is a destination you
 * chose to open, not a control panel for the screen behind it.
 */
export function WhatsNewModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = useColors()
  const styles = useStyles()
  const { width, height } = useWindowDimensions()
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      // Anchored to the running build: this version's notes and older, never a
      // newer release's. Crediting a 0.0.2 build with 0.4.0's features is worse
      // than showing nothing.
      const all = await fetchMobileChangelog()
      setEntries(entriesUpToVersion(all, FULL_VERSION))
    } catch {
      setEntries(null)
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    // Refetch on each open: cheap, and it means a release published while the
    // app sat in memory still shows up.
    setEntries(null)
    void load()
  }, [visible, load])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* Keep the dismiss target behind the card instead of wrapping it. A
            parent Pressable can win the responder negotiation from a nested
            ScrollView on Android and leave long release notes unscrollable. */}
        <Pressable
          style={styles.backdropDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close release notes"
        />
        <View style={[styles.card, { width: width * 0.8, height: height * 0.7 }]}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderText}>
              <AppText variant="caption" color={colors.textMuted}>
                WHAT&apos;S NEW
              </AppText>
              <AppText variant="title" numberOfLines={1}>
                HearthShelf {FULL_VERSION}
              </AppText>
            </View>
            <Touchable onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
              <Icon name="close" size={20} color={colors.text} />
            </Touchable>
          </View>

          {entries === null && !failed ? (
            // Not primitives' <Loading/>: it wraps <Centered/>, which paints a
            // scaffold-coloured fill over this sheet-coloured card.
            <View style={styles.stateBox}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : failed ? (
            <View style={styles.stateBox}>
              <AppText variant="body" color={colors.textMuted} style={styles.stateText}>
                Couldn&apos;t load the release notes. Check your connection and try again.
              </AppText>
              <Touchable onPress={load} style={styles.retryBtn}>
                <AppText variant="label" color={colors.onAccent}>
                  Try again
                </AppText>
              </Touchable>
            </View>
          ) : entries && entries.length === 0 ? (
            <View style={styles.stateBox}>
              <AppText variant="body" color={colors.textMuted} style={styles.stateText}>
                {/* Reached when this exact build isn't published - a local dev
                    build or an unreleased tag. Deliberately shows nothing rather
                    than a newer release's notes. */}
                No release notes for this build.
              </AppText>
              <AppText variant="meta" color={colors.textFaint} style={styles.stateText}>
                {FULL_VERSION}
              </AppText>
            </View>
          ) : (
            <ScrollView
              // flex:1 on the ScrollView ITSELF, not the content container. The
              // card is a fixed-height flex column; without this the scroll view
              // sizes to its content and overflows (clipped, unscrollable)
              // instead of taking the space left under the header and scrolling
              // inside it.
              style={styles.scroll}
              contentContainerStyle={styles.scrollBody}
              showsVerticalScrollIndicator={false}
            >
              {entries?.map((entry) => (
                <ReleaseBlock key={entry.id} entry={entry} />
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  )
}

/** One release: version + date, then its items grouped by colour-coded section. */
function ReleaseBlock({ entry }: { entry: ChangelogEntry }) {
  const colors = useColors()
  const { name: themeName } = useTheme()
  const isLight = themeName === 'light'
  const styles = useStyles()
  const isCurrent = entry.version === FULL_VERSION

  // Group once per entry rather than filtering the list six times.
  const grouped = useMemo(() => {
    const bySection = new Map<ChangelogSection, typeof entry.items>()
    for (const item of entry.items) {
      const list = bySection.get(item.section)
      if (list) list.push(item)
      else bySection.set(item.section, [item])
    }
    return SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => ({
      section,
      items: bySection.get(section)!.sort((a, b) => a.sort_order - b.sort_order),
    }))
  }, [entry.items])

  const date = formatReleaseDate(entry.released_at)

  return (
    <View style={styles.release}>
      <View style={styles.releaseHead}>
        <AppText variant="label">{entry.version}</AppText>
        {isCurrent ? (
          <View style={styles.currentPill}>
            <AppText variant="meta" color={colors.accent}>
              This build
            </AppText>
          </View>
        ) : null}
        {date ? (
          <AppText variant="meta" color={colors.textFaint} style={styles.releaseDate}>
            {date}
          </AppText>
        ) : null}
      </View>

      {grouped.length === 0 ? (
        <AppText variant="body" color={colors.textMuted}>
          {entry.changelog?.trim() || 'No details for this release.'}
        </AppText>
      ) : (
        grouped.map(({ section, items }) => {
          const meta = SECTION_META[section]
          // Same meaning, readable ground: the dark hues vanish on light.
          const tag = isLight ? meta.colorLight : meta.color
          return (
            <View key={section} style={styles.section}>
              <View style={styles.sectionHead}>
                <View style={[styles.sectionDot, { backgroundColor: tag }]} />
                <AppText variant="caption" color={tag}>
                  {meta.label.toUpperCase()}
                </AppText>
              </View>
              {items.map((item) => (
                <View key={item.id} style={styles.item}>
                  <View style={[styles.bullet, { backgroundColor: withAlpha(tag, 0.5) }]} />
                  <AppText variant="body" style={styles.itemText}>
                    {item.text}
                  </AppText>
                </View>
              ))}
            </View>
          )
        })
      )}
    </View>
  )
}

/**
 * Chip + modal wired together, for callers that just want the whole feature.
 *
 * Opening retires the chip both on screen (`used`) and in storage
 * (`dismissChip`) - once you've seen the notes the announcement has done its
 * job, so it shouldn't linger for the rest of the session. The chip and the
 * modal are siblings rather than parent/child precisely so hiding one doesn't
 * unmount the other.
 */
export function WhatsNew({ chipVisible }: { chipVisible: boolean }) {
  const [open, setOpen] = useState(false)
  const [used, setUsed] = useState(false)
  return (
    <>
      <WhatsNewChip
        visible={chipVisible && !used}
        onPress={() => {
          setOpen(true)
          setUsed(true)
          void dismissChip()
        }}
      />
      <WhatsNewModal visible={open} onClose={() => setOpen(false)} />
    </>
  )
}

function useStyles() {
  const colors = useColors()
  return useMemo(() => makeStyles(colors), [colors])
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    // Chip: pill-height to match the 38px header buttons beside it.
    chip: {
      height: 38,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      // sm, not md: this chip shares the header row with the greeting (flex:1)
      // and three 38px buttons. On a 320pt screen every point here comes
      // straight out of the greeting's truncation budget.
      paddingHorizontal: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.accent, 0.5),
      overflow: 'hidden',
    },
    chipSweep: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    chipLabel: { fontWeight: '600' },

    // Modal
    backdrop: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    backdropDismiss: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    card: {
      borderRadius: radius.sheet,
      backgroundColor: colors.sheet,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      overflow: 'hidden',
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    cardHeaderText: { flex: 1, minWidth: 0 },
    closeBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },

    scroll: { flex: 1 },
    // No flexGrow here: the content must be free to exceed the card's height,
    // which is what makes it scroll.
    scrollBody: { padding: spacing.lg, gap: spacing.xl },
    stateBox: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xl,
    },
    stateText: { textAlign: 'center' },
    retryBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },

    release: { gap: spacing.md },
    releaseHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    releaseDate: { marginLeft: 'auto' },
    currentPill: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: colors.accentWash,
    },

    section: { gap: spacing.xs },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    sectionDot: { width: 7, height: 7, borderRadius: 4 },
    item: { flexDirection: 'row', gap: spacing.sm, paddingLeft: spacing.xs },
    // Nudged down to sit on the first line's optical centre.
    bullet: { width: 5, height: 5, borderRadius: 3, marginTop: 8 },
    itemText: { flex: 1 },
  })
