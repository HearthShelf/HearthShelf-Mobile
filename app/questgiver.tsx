/**
 * QuestGiver: the guided "what should I listen to next" flow.
 *
 * Four questions, one per screen (web stacks them in a scrolling column, which
 * only works on a wide viewport), then a matched shortlist. Answers survive
 * going back, so the whole flow is one piece of state held here.
 *
 * The engine is entirely in @hearthshelf/core - profile, candidate pools, the
 * deterministic recommender, the prompt - and pick resolution is shared too
 * (qgResolvePicks), so this screen only owns the asking and the rendering.
 *
 * A run ALWAYS produces picks: qgRecommend falls through to qgHeuristic on any
 * failure, so no AI provider is needed for the flow to work end to end.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  QG_EXPLORE_GENRES,
  qgBooks,
  qgBuildProfile,
  qgExternalCandidates,
  qgExternalSearchTerms,
  qgLibraryCandidates,
  qgResolvePicks,
  qgRunLabel,
  type QgAnswers,
  type QgCandidate,
  type QgExternalHit,
  type QgRenderedPick,
} from '@hearthshelf/core'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { getAllLibraryItems, getLibraries } from '@/api/abs'
import { searchAudible } from '@/api/absAudible'
import { getRmabEnabled, submitRequest } from '@/api/absRmab'
import {
  fetchServerRuns,
  getFeedback,
  getQgConfig,
  getRuns,
  loadLocalCache,
  qgRecommend,
  saveRun,
  setFeedback as persistFeedback,
  type QgConfig,
  type QgFeedback,
  type QgRun,
} from '@/api/questgiver'
import { playItemById } from '@/player/playback'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { AppText, Centered, PrimaryButton, Screen, Touchable } from '@/ui/primitives'
import { Loading } from '@/ui/primitives'
import { Chip } from '@/ui/primitives'
import { EmptyState } from '@/ui/states'
import { Icon } from '@/ui/icons'
import { QgChoice, QgSteps, QgWeightRow } from '@/ui/questgiver/QuestGiverParts'
import { QuestGiverPicker } from '@/ui/questgiver/QuestGiverPicker'
import { QuestGiverResultCard, type QgRequestState } from '@/ui/questgiver/QuestGiverResultCard'
import { AppTabBar, useGoToTab } from '@/ui/AppTabBar'
import { useContentInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'

type Direction = 'more' | 'switch' | 'new'
type Length = 'any' | 'short' | 'standard' | 'epic'
type Basis = 'history' | 'list'

const STEP_LABELS = ['Basis', 'Direction', 'Weights', 'Fine-tune']
/** How many genres the weights step shows before the expand. Enough to feel like
 *  real control, short enough that Continue stays on screen. */
const VISIBLE_GENRES = 4
const EXTERNAL_HIT_CAP = 30

export default function QuestGiverScreen() {
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const inset = useContentInset()
  const goToTab = useGoToTab()
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  // Reached from the More menu, so More reads as the active tab. Rendered on
  // both the loading and loaded branches so the nav doesn't flicker away while
  // the library loads.
  const tabBar = <AppTabBar activeName="more" onPressTab={goToTab} />

  const [items, setItems] = useState<ABSLibraryItem[] | null>(null)
  const [config, setConfig] = useState<QgConfig | null>(null)
  const [rmabEnabled, setRmabEnabled] = useState(false)

  // wizard state - one piece so going back never loses an answer
  const [step, setStep] = useState(0)
  const [basis, setBasis] = useState<Basis>('history')
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [direction, setDirection] = useState<Direction>('more')
  const [mood, setMood] = useState('')
  const [weights, setWeights] = useState<Record<string, number> | null>(null)
  const [expandGenres, setExpandGenres] = useState(false)
  const [length, setLength] = useState<Length>('any')
  const [familiarity, setFamiliarity] = useState(4)
  const [narratorAffinity, setNarratorAffinity] = useState(true)
  const [lookBeyond, setLookBeyond] = useState(false)

  // Step 4 IS the running state - it renders the spinner unconditionally - so
  // there is no separate loading flag.
  const [result, setResult] = useState<{
    intro: string
    engine: 'ai' | 'heuristic'
    picks: QgRenderedPick[]
  } | null>(null)
  const [runs, setRuns] = useState<QgRun[]>([])
  const [feedback, setFeedbackState] = useState<Record<string, QgFeedback>>({})
  const [view, setView] = useState<'flow' | 'history'>('flow')
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [requesting, setRequesting] = useState<Record<string, QgRequestState>>({})

  // Library + config + local mirror. The server is the truth for run history;
  // the local cache is what paints instantly and survives being offline.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await loadLocalCache()
      if (cancelled) return
      setRuns(getRuns())
      setFeedbackState(getFeedback())

      const [libs, cfg, rmab] = await Promise.all([
        getLibraries().catch(() => []),
        getQgConfig(),
        getRmabEnabled(),
      ])
      if (cancelled) return
      setConfig(cfg)
      setRmabEnabled(rmab)

      const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
      const all = lib ? await getAllLibraryItems(lib.id).catch(() => []) : []
      if (cancelled) return
      setItems(all)

      const serverRuns = await fetchServerRuns()
      if (!cancelled) setRuns(serverRuns)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const books = useMemo(
    () => (items ? qgBooks(items, new Map(progressById)) : []),
    [items, progressById],
  )

  // Profile recomputes from history OR the hand-picked list.
  const profile = useMemo(() => {
    if (basis === 'list' && picked.size)
      return qgBuildProfile(books.filter((b) => picked.has(b.id)))
    return qgBuildProfile(books)
  }, [basis, picked, books])

  // Seed a weight for EVERY genre when the weights step is first reached - the
  // owned ones from the profile, the explore ones at 0. Collapsing the list is
  // presentation only: every seeded genre is submitted with the run, so what the
  // listener gets does not depend on whether they expanded it.
  useEffect(() => {
    if (step === 2 && !weights) {
      const w: Record<string, number> = {}
      profile.listened.forEach((x) => {
        w[x.genre] = x.weight
      })
      QG_EXPLORE_GENRES.forEach((g) => {
        if (w[g] == null) w[g] = 0
      })
      setWeights(w)
    }
  }, [step, weights, profile])

  // Changing the basis invalidates the seeded weights so they re-seed.
  useEffect(() => {
    setWeights(null)
  }, [basis, picked])

  const setW = useCallback(
    (g: string, v: number) => setWeights((w) => ({ ...(w ?? {}), [g]: v })),
    [],
  )

  const aiLabel = config?.enabled ? (config.provider ?? 'AI') : 'AI'
  const exhausted = config?.limit != null && config.remaining != null && config.remaining <= 0

  // The genres the weights step actually draws. Owned genres are already sorted
  // strongest-first by qgBuildProfile, so this is a slice, not new ranking.
  const ownedGenres = useMemo(() => profile.listened.filter((x) => x.owned > 0), [profile])
  const exploreGenres = useMemo(
    () => QG_EXPLORE_GENRES.filter((g) => !profile.stat[g]?.owned),
    [profile],
  )
  const hiddenCount = Math.max(0, ownedGenres.length - VISIBLE_GENRES) + exploreGenres.length
  const shownGenres = expandGenres ? ownedGenres : ownedGenres.slice(0, VISIBLE_GENRES)

  const setVote = (key: string, vote: 1 | -1 | 0) => {
    haptics.select()
    setFeedbackState(persistFeedback(key, vote === 0 ? { vote: undefined } : { vote }))
  }
  const setNote = (key: string, note: string) => {
    setFeedbackState(persistFeedback(key, { note: note || undefined }))
  }

  const requestPick = async (pick: QgRenderedPick) => {
    if (!pick.itemId) return
    setRequesting((r) => ({ ...r, [pick.key]: 'pending' }))
    const res = await submitRequest({
      asin: pick.itemId,
      title: pick.title,
      author: pick.author,
    })
    setRequesting((r) => {
      if (res.success) return { ...r, [pick.key]: 'done' }
      const next = { ...r }
      delete next[pick.key]
      return next
    })
  }

  /**
   * Search the external catalog across several terms and flatten to hits. Each
   * search is best-effort so one bad query cannot sink a run, and the pool is
   * capped to keep the AI prompt small.
   */
  const fetchExternalHits = async (terms: string[]): Promise<QgExternalHit[]> => {
    const results = await Promise.allSettled(terms.map((t) => searchAudible(t)))
    const hits: QgExternalHit[] = []
    const seen = new Set<string>()
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const c of r.value.results ?? []) {
        if (!c.asin || seen.has(c.asin)) continue
        seen.add(c.asin)
        hits.push({
          id: c.asin,
          title: c.title,
          author: c.author ?? '',
          hours: c.durationMinutes ? Math.round((c.durationMinutes / 60) * 10) / 10 : 0,
        })
        if (hits.length >= EXTERNAL_HIT_CAP) break
      }
      if (hits.length >= EXTERNAL_HIT_CAP) break
    }
    return hits
  }

  const run = async () => {
    haptics.select()
    setStep(4)
    setView('flow')

    const answers: QgAnswers = {
      direction,
      mood: mood.trim(),
      weights: weights ?? {},
      length,
      familiarity,
      narratorAffinity,
      includeRequest: lookBeyond,
      count: lookBeyond ? 5 : 4,
    }

    // Library pool always; external pool when looking beyond. Not gated on a
    // request backend - enabling the option searches, and what you can DO with
    // an external pick is decided later by `kind`.
    let candidates: QgCandidate[] = qgLibraryCandidates(books)
    const externalById = new Map<string, QgCandidate>()
    if (lookBeyond) {
      const terms = qgExternalSearchTerms(profile, books, weights ?? {})
      const hits = await fetchExternalHits(terms)
      const ext = qgExternalCandidates(hits, books)
      ext.forEach((c) => externalById.set(c.id, c))
      candidates = [...candidates, ...ext]
    }

    const out = await qgRecommend(profile, answers, candidates)

    const top = qgResolvePicks({
      result: out,
      books,
      externalById,
      priorPicks: runs.flatMap((r) => r.picks),
      canRequest: rmabEnabled,
      count: answers.count ?? 4,
    })

    const now = new Date()
    const runRec: QgRun = {
      id: 'run' + now.getTime(),
      label: qgRunLabel(direction, mood, weights ?? {}),
      when: now.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
      engine: out.engine,
      intro: out.intro,
      picks: top,
    }
    setRuns(saveRun(runRec))
    setResult({ intro: out.intro, engine: out.engine, picks: top })
    setStep(5)
  }

  const restart = () => {
    setStep(0)
    setResult(null)
    setWeights(null)
    setExpandGenres(false)
    setMood('')
    setPicked(new Set())
    setBasis('history')
    setDirection('more')
    setLength('any')
    setView('flow')
    setOpenRun(null)
  }

  const openDetails = (itemId: string) => router.push(`/item/${itemId}`)
  const play = (itemId: string) => {
    void playItemById(itemId)
  }

  if (items === null) {
    return (
      <Screen tabBar={tabBar}>
        <Centered>
          <Loading label="Reading your library" />
        </Centered>
      </Screen>
    )
  }

  const footer = (back: (() => void) | null, next: React.ReactNode) => (
    <View style={s.foot}>
      {back ? (
        <Touchable
          onPress={back}
          style={s.ghostBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={16} color={colors.text} />
          <AppText variant="label">Back</AppText>
        </Touchable>
      ) : (
        <View />
      )}
      {next}
    </View>
  )

  return (
    <Screen tabBar={tabBar}>
      <View style={s.head}>
        <Touchable
          onPress={() => router.back()}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Close QuestGiver"
        >
          <Icon name="arrow-back" size={20} color={colors.text} />
        </Touchable>
        <View style={s.headText}>
          <AppText variant="eyebrow" color={colors.accent}>
            QuestGiver
          </AppText>
          <AppText variant="title">Find your next listen</AppText>
        </View>
        {runs.length > 0 ? (
          <Touchable
            onPress={() => {
              setView((v) => (v === 'history' ? 'flow' : 'history'))
              setOpenRun(null)
            }}
            style={s.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={view === 'history' ? 'Back to QuestGiver' : 'Past runs'}
          >
            <Icon name={view === 'history' ? 'explore' : 'history'} size={20} color={colors.text} />
          </Touchable>
        ) : (
          <View style={s.iconBtn} />
        )}
      </View>

      <ScrollView
        contentContainerStyle={[s.body, { paddingBottom: inset + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {config?.limit != null && config.remaining != null ? (
          <View style={s.limitNote}>
            <Icon name="bolt" size={14} color={colors.accent} />
            <AppText variant="caption" color={colors.textMuted}>
              {`${config.remaining} of ${config.limit} ${
                config.remaining === 1 ? 'match' : 'matches'
              } left ${
                config.period === 'week'
                  ? 'this week'
                  : config.period === 'month'
                    ? 'this month'
                    : 'today'
              }`}
            </AppText>
          </View>
        ) : null}

        {view === 'history' ? (
          runs.length === 0 ? (
            <EmptyState
              icon="history"
              title="No past runs yet"
              body="Run QuestGiver once and your history shows up here."
            />
          ) : (
            runs.map((r) => (
              <View key={r.id} style={s.card}>
                <Touchable
                  onPress={() => setOpenRun((o) => (o === r.id ? null : r.id))}
                  style={s.runHead}
                  accessibilityRole="button"
                  accessibilityLabel={r.label}
                >
                  <View style={s.grow}>
                    <AppText variant="label">{r.label}</AppText>
                    <AppText variant="caption" color={colors.textFaint}>
                      {`${r.when} · ${r.picks.length} books · ${
                        r.engine === 'ai' ? 'Matched by ' + aiLabel : 'Matched to weights'
                      }`}
                    </AppText>
                  </View>
                  <Icon
                    name={openRun === r.id ? 'expand-less' : 'expand-more'}
                    size={20}
                    color={colors.textMuted}
                  />
                </Touchable>
                {openRun === r.id ? (
                  <View style={s.stack}>
                    {r.picks.map((p) => (
                      <QuestGiverResultCard
                        key={p.key}
                        pick={p}
                        feedback={feedback[p.key]}
                        onPlay={play}
                        onDetails={openDetails}
                        onVote={setVote}
                        onNote={setNote}
                        onRequest={rmabEnabled ? requestPick : undefined}
                        requestState={requesting[p.key] ?? 'idle'}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            ))
          )
        ) : (
          <>
            {step <= 3 ? (
              <QgSteps step={step} total={STEP_LABELS.length} labels={STEP_LABELS} />
            ) : null}

            {step === 0 ? (
              <View style={s.card}>
                <AppText variant="title">What should I base your match on?</AppText>
                <AppText variant="meta" color={colors.textMuted}>
                  I read your library and play stats either way - this just sets the starting point.
                </AppText>
                <View style={s.stack}>
                  <QgChoice
                    icon="history"
                    title="My listening history"
                    tag="Recommended"
                    desc={`Weighs everything you've finished - ${profile.totalFin} books analyzed.`}
                    on={basis === 'history'}
                    onPress={() => setBasis('history')}
                  />
                  <QgChoice
                    icon="checklist"
                    title="A list I pick"
                    desc="Choose a few books and I'll match the vibe of just those."
                    on={basis === 'list'}
                    onPress={() => setBasis('list')}
                  />
                </View>
                {basis === 'list' ? (
                  <QuestGiverPicker
                    books={books}
                    picked={picked}
                    onToggle={(id) =>
                      setPicked((set) => {
                        const n = new Set(set)
                        if (n.has(id)) n.delete(id)
                        else n.add(id)
                        return n
                      })
                    }
                  />
                ) : null}
                {footer(
                  null,
                  <PrimaryButton
                    label="Continue"
                    icon="arrow-forward"
                    onPress={basis === 'list' && picked.size === 0 ? undefined : () => setStep(1)}
                    style={[s.grow, basis === 'list' && picked.size === 0 && s.disabled]}
                  />,
                )}
              </View>
            ) : null}

            {step === 1 ? (
              <View style={s.card}>
                <AppText variant="title">Where to next?</AppText>
                <AppText variant="meta" color={colors.textMuted}>
                  {profile.dominant
                    ? `You've been deep in ${profile.dominant} lately${
                        profile.cold
                          ? `, while your ${profile.cold.genre} shelf (${profile.cold.owned} titles) has gone quiet`
                          : ''
                      }.`
                    : "Tell me the direction and I'll do the rest."}
                </AppText>
                <View style={s.stack}>
                  <QgChoice
                    icon="repeat"
                    title="More like what I love"
                    desc={
                      profile.dominant
                        ? `Stay in the ${profile.dominant} lane with fresh picks.`
                        : 'Stay close to your recent listens.'
                    }
                    on={direction === 'more'}
                    onPress={() => setDirection('more')}
                  />
                  <QgChoice
                    icon="swap-horiz"
                    title="Switch it up"
                    desc={
                      profile.cold
                        ? `Pull you back into ${profile.cold.genre} - you have ${profile.cold.owned} waiting.`
                        : 'Revive a genre you have drifted from.'
                    }
                    on={direction === 'switch'}
                    onPress={() => setDirection('switch')}
                  />
                  <QgChoice
                    icon="auto-awesome"
                    title="Something totally new"
                    desc="Stretch into a genre you don't really own yet."
                    on={direction === 'new'}
                    onPress={() => setDirection('new')}
                  />
                </View>
                <View style={s.field}>
                  <AppText variant="label">Anything specific in mind?</AppText>
                  <TextInput
                    value={mood}
                    onChangeText={setMood}
                    placeholder="e.g. something propulsive for a long drive"
                    placeholderTextColor={colors.textFaint}
                    style={s.input}
                  />
                </View>
                {footer(
                  () => setStep(0),
                  <PrimaryButton
                    label="Continue"
                    icon="arrow-forward"
                    onPress={() => setStep(2)}
                    style={s.grow}
                  />,
                )}
              </View>
            ) : null}

            {step === 2 && weights ? (
              <View style={s.card}>
                <AppText variant="title">Weight your genres</AppText>
                <AppText variant="meta" color={colors.textMuted}>
                  Pre-set from what you actually listen to. Nudge each dial toward what you're
                  hungry for - 0 means skip it.
                </AppText>
                <View style={s.stack}>
                  {shownGenres.map((x) => (
                    <QgWeightRow
                      key={x.genre}
                      label={x.genre}
                      sub={
                        (x.finished ? `${x.finished} finished` : `${x.owned} in library`) +
                        (x.hours ? ` · ${Math.round(x.hours)}h listened` : '')
                      }
                      value={weights[x.genre] ?? 0}
                      onChange={(v) => setW(x.genre, v)}
                    />
                  ))}
                  {expandGenres
                    ? exploreGenres.map((g) => (
                        <QgWeightRow
                          key={g}
                          label={g}
                          sub="Not in your library yet"
                          value={weights[g] ?? 0}
                          onChange={(v) => setW(g, v)}
                        />
                      ))
                    : null}
                </View>
                {/* Only offered when something is actually behind it. */}
                {hiddenCount > 0 ? (
                  <Touchable
                    onPress={() => setExpandGenres((v) => !v)}
                    style={s.expand}
                    accessibilityRole="button"
                    accessibilityLabel={expandGenres ? 'Show fewer genres' : 'Show more genres'}
                  >
                    <Icon
                      name={expandGenres ? 'expand-less' : 'expand-more'}
                      size={18}
                      color={colors.accent}
                    />
                    <AppText variant="label" color={colors.accent}>
                      {expandGenres ? 'Show fewer' : `Show ${hiddenCount} more`}
                    </AppText>
                  </Touchable>
                ) : null}
                {footer(
                  () => setStep(1),
                  <PrimaryButton
                    label="Continue"
                    icon="arrow-forward"
                    onPress={() => setStep(3)}
                    style={s.grow}
                  />,
                )}
              </View>
            ) : null}

            {step === 3 ? (
              <View style={s.card}>
                <AppText variant="title">A few finishing touches</AppText>
                <AppText variant="meta" color={colors.textMuted}>
                  All inferred from your stats - change only what you want.
                </AppText>

                <View style={s.field}>
                  <AppText variant="label">Length sweet spot</AppText>
                  <View style={s.chipRow}>
                    {(
                      [
                        ['any', 'Surprise me'],
                        ['short', 'Short · under 8h'],
                        ['standard', 'Standard · 8-15h'],
                        ['epic', 'Epic · 15h+'],
                      ] as [Length, string][]
                    ).map(([v, l]) => (
                      <Chip key={v} label={l} active={length === v} onPress={() => setLength(v)} />
                    ))}
                  </View>
                </View>

                <QgWeightRow
                  label="New voices vs. authors I know"
                  sub="0 = stick with my authors · 10 = all fresh discoveries"
                  value={familiarity}
                  onChange={setFamiliarity}
                />

                <Touchable
                  onPress={() => setNarratorAffinity((v) => !v)}
                  style={s.toggleRow}
                  accessibilityRole="switch"
                  accessibilityLabel="Favor narrators I trust"
                >
                  <View style={s.grow}>
                    <AppText variant="label">Favor narrators I trust</AppText>
                    <AppText variant="caption" color={colors.textFaint}>
                      Lean toward the voices you finish most.
                    </AppText>
                  </View>
                  <Icon
                    name={narratorAffinity ? 'toggle-on' : 'toggle-off'}
                    size={30}
                    color={narratorAffinity ? colors.accent : colors.textFaint}
                  />
                </Touchable>

                <Touchable
                  onPress={() => setLookBeyond((v) => !v)}
                  style={s.toggleRow}
                  accessibilityRole="switch"
                  accessibilityLabel="Look beyond my library"
                >
                  <View style={s.grow}>
                    <AppText variant="label">Look beyond my library</AppText>
                    <AppText variant="caption" color={colors.textFaint}>
                      {rmabEnabled
                        ? 'Suggest titles you can request, or buy on Audible.'
                        : 'Suggest great titles to buy on Audible, not just what you own.'}
                    </AppText>
                  </View>
                  <Icon
                    name={lookBeyond ? 'toggle-on' : 'toggle-off'}
                    size={30}
                    color={lookBeyond ? colors.accent : colors.textFaint}
                  />
                </Touchable>

                {exhausted ? (
                  <View style={s.limitNote}>
                    <Icon name="bolt" size={14} color={colors.destructive} />
                    <AppText variant="caption" color={colors.textMuted}>
                      {`You're out of matches ${
                        config?.period === 'week'
                          ? 'for this week'
                          : config?.period === 'month'
                            ? 'for this month'
                            : 'for today'
                      }. Check back later.`}
                    </AppText>
                  </View>
                ) : null}

                {footer(
                  () => setStep(2),
                  <PrimaryButton
                    label="Find my next listen"
                    icon="explore"
                    onPress={exhausted ? undefined : run}
                    style={[s.grow, exhausted && s.disabled]}
                  />,
                )}
              </View>
            ) : null}

            {step === 4 ? (
              <View style={s.card}>
                <Centered>
                  <Loading label="Matching you to your next listen..." />
                </Centered>
                <AppText variant="meta" color={colors.textMuted} style={s.center}>
                  Reading your weighted genres, length and narrator preferences against your
                  library.
                </AppText>
                <View style={s.chipRow}>
                  {Object.entries(weights ?? {})
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([g, v]) => (
                      <Chip key={g} label={`${g} ${v}`} />
                    ))}
                  <Chip
                    label={
                      direction === 'more'
                        ? 'Stay in lane'
                        : direction === 'switch'
                          ? 'Switch it up'
                          : 'Explore new'
                    }
                  />
                </View>
              </View>
            ) : null}

            {step === 5 && result ? (
              <>
                <View style={s.card}>
                  <AppText variant="quote">{result.intro}</AppText>
                  <View style={s.engineRow}>
                    <Icon
                      name={result.engine === 'ai' ? 'auto-awesome' : 'tune'}
                      size={14}
                      color={colors.accent}
                    />
                    <AppText variant="caption" color={colors.accent}>
                      {result.engine === 'ai' ? `Matched by ${aiLabel}` : 'Matched to your weights'}
                    </AppText>
                  </View>
                </View>

                {result.picks.length === 0 ? (
                  <EmptyState
                    icon="search-off"
                    title="No clean match"
                    body="Try widening your weights or picking a different direction."
                  />
                ) : (
                  <View style={s.stack}>
                    {result.picks.map((p) => (
                      <QuestGiverResultCard
                        key={p.key}
                        pick={p}
                        feedback={feedback[p.key]}
                        onPlay={play}
                        onDetails={openDetails}
                        onVote={setVote}
                        onNote={setNote}
                        onRequest={rmabEnabled ? requestPick : undefined}
                        requestState={requesting[p.key] ?? 'idle'}
                      />
                    ))}
                  </View>
                )}

                <View style={s.foot}>
                  <Touchable
                    onPress={() => setStep(3)}
                    style={s.ghostBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Adjust answers"
                  >
                    <Icon name="tune" size={16} color={colors.text} />
                    <AppText variant="label">Adjust answers</AppText>
                  </Touchable>
                  <Touchable
                    onPress={restart}
                    style={s.ghostBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Start over"
                  >
                    <Icon name="refresh" size={16} color={colors.text} />
                    <AppText variant="label">Start over</AppText>
                  </Touchable>
                </View>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    headText: { flex: 1, gap: 1 },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    body: { paddingHorizontal: spacing.lg, gap: spacing.lg },
    card: {
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
    },
    stack: { gap: spacing.md },
    grow: { flex: 1 },
    center: { textAlign: 'center' },
    disabled: { opacity: 0.45 },
    field: { gap: spacing.sm },
    input: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    expand: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
    },
    foot: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    ghostBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
    },
    runHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    limitNote: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    engineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  })
}
