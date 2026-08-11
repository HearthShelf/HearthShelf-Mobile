/**
 * "You don't own this book" tray, shared by the series screen's missing-books
 * rows and the search screen's "Not in your library" results. Opens on an intro
 * step and, when the request backend is connected, advances to a request
 * confirm + success. Mirrors the web app's RequestConfirmModal flow.
 *
 * This is also where the per-book actions for an unowned book live, so they sit
 * in one tray the way an owned book's actions do:
 *   Follow  - tell me when it lands (an unreleased book can't be requested)
 *   Ignore  - it will never be an audiobook (an ebook-only side story, a print
 *             edition), so stop counting it against the series
 */
import { forwardRef, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import type { HSAudibleSearchResult } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { isUpcoming } from '@hearthshelf/core'
import { audibleStoreUrl } from '@/api/absAudible'
import { submitRequest, type RmabRequestResult } from '@/api/absRmab'
import {
  findSubscription,
  subscribe,
  unsubscribe,
  getSubscriptionsState,
  subscribeSubscriptions,
} from '@/player/subscriptions'
import {
  dismiss as dismissEntity,
  restore as restoreEntity,
  getDismissalsState,
  subscribeDismissals,
} from '@/store/dismissals'
import { AppText, Cover, IconButton, PrimaryButton, Sheet, Touchable, icons } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export const NotOwnedSheet = forwardRef<
  BottomSheetModal,
  { book: HSAudibleSearchResult | null; rmabEnabled: boolean; onDismiss: () => void }
>(function NotOwnedSheet({ book, rmabEnabled, onDismiss }, ref) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [phase, setPhase] = useState<'intro' | 'confirm'>('intro')
  // Follow + ignore state, read live so the tray reflects a change made here or
  // anywhere else in the app.
  useSyncExternalStore(subscribeSubscriptions, getSubscriptionsState)
  const dismissals = useSyncExternalStore(subscribeDismissals, getDismissalsState)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<RmabRequestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset to the intro step whenever a new book opens the sheet.
  useEffect(() => {
    if (book) {
      setPhase('intro')
      setPending(false)
      setResult(null)
      setError(null)
    }
  }, [book])

  const reset = () => {
    setPhase('intro')
    setPending(false)
    setResult(null)
    setError(null)
    onDismiss()
  }

  const openAudible = () => {
    if (book) void Linking.openURL(audibleStoreUrl(book))
  }

  const sub = book ? findSubscription({ kind: 'book', asin: book.asin }) : undefined
  const following = Boolean(sub)
  const ignored = book
    ? (dismissals.rosterAsins ?? []).some((a) => a.toLowerCase() === book.asin.toLowerCase())
    : false

  const toggleFollow = () => {
    if (!book) return
    if (sub) {
      void unsubscribe(sub.id).catch(() => {})
      return
    }
    void subscribe({
      kind: 'book',
      asin: book.asin,
      seriesAsin: book.seriesAsin,
      title: book.title,
      author: book.author,
      seriesTitle: book.series,
      coverArtUrl: book.coverArtUrl,
      narrator: book.narrator,
      durationMinutes: book.durationMinutes,
      releaseDate: book.releaseDate,
      publicationDatetime: book.publicationDatetime,
    }).catch(() => {})
  }

  const toggleIgnore = () => {
    if (!book) return
    const done = ignored
      ? restoreEntity('roster', book.asin)
      : dismissEntity('roster', book.asin, book.title)
    void done.then(() => reset()).catch(() => {})
  }

  const confirm = async () => {
    if (!book) return
    setPending(true)
    setError(null)
    const res = await submitRequest({
      asin: book.asin,
      title: book.title,
      author: book.author,
      narrator: book.narrator,
      description: book.description,
      coverArtUrl: book.coverArtUrl,
    })
    setPending(false)
    if (res.success && res.request) setResult(res)
    else setError('Request failed. Please try again.')
  }

  const approved = result?.request?.status !== 'awaiting_approval'
  const title = result ? 'Request sent' : phase === 'confirm' ? 'Request audiobook' : undefined
  const kicker = result || phase === 'confirm' ? 'ReadMeABook' : undefined

  return (
    <Sheet ref={ref} kicker={kicker} title={title ?? "You don't own this book"} onDismiss={reset}>
      {book ? (
        <View style={{ gap: spacing.lg, paddingBottom: spacing.md }}>
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <Cover
              uri={book.coverArtUrl}
              size={64}
              radius={radius.tile}
              fallback={{
                hue: coverHue(book.asin),
                initial: (book.title || '?').charAt(0).toUpperCase(),
              }}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="label" numberOfLines={2}>
                {book.title}
              </AppText>
              <AppText
                variant="caption"
                color={colors.textMuted}
                numberOfLines={1}
                style={{ marginTop: 2 }}
              >
                {book.author}
              </AppText>
            </View>
          </View>

          {result ? (
            <>
              <AppText variant="meta" color={colors.textMuted}>
                {approved
                  ? `We'll add ${book.title} to your library when it's ready.`
                  : `Your request was sent - an admin needs to approve it before it downloads.`}
              </AppText>
              <PrimaryButton label="Done" icon={icons.check} onPress={reset} />
            </>
          ) : phase === 'confirm' ? (
            <>
              <AppText variant="meta" color={colors.textMuted}>
                ReadMeABook will search for it, download it, and add it to your library
                automatically.
              </AppText>
              {error ? (
                <AppText variant="meta" color={colors.destructive}>
                  {error}
                </AppText>
              ) : null}
              <PrimaryButton
                label={pending ? 'Requesting...' : 'Request'}
                icon={icons.add}
                onPress={pending ? undefined : () => void confirm()}
              />
              <Touchable
                onPress={pending ? undefined : () => setPhase('intro')}
                style={styles.sheetGhostBtn}
              >
                <AppText variant="label" color={colors.textMuted}>
                  Back
                </AppText>
              </Touchable>
            </>
          ) : (
            <>
              <AppText variant="meta" color={colors.textMuted}>
                {book.title} isn't in your library yet.
                {rmabEnabled
                  ? ' Request it through ReadMeABook, or open it on Audible.'
                  : ' You can open it on Audible.'}
              </AppText>
              {rmabEnabled ? (
                <PrimaryButton
                  label="Request"
                  icon={icons.bolt}
                  onPress={() => setPhase('confirm')}
                />
              ) : null}
              <Touchable onPress={toggleFollow} style={styles.sheetSecondaryBtn}>
                <IconButton
                  name={following ? icons.bellActive : icons.bell}
                  size={18}
                  color={following ? colors.accent : colors.text}
                />
                <AppText variant="label" color={following ? colors.accent : colors.text}>
                  {following ? 'Following' : 'Notify me when it lands'}
                </AppText>
              </Touchable>
              <Touchable onPress={openAudible} style={styles.sheetSecondaryBtn}>
                <IconButton name={icons.openInNew} size={18} color={colors.text} />
                <AppText variant="label">Open Audible</AppText>
              </Touchable>
              <Touchable onPress={toggleIgnore} style={styles.sheetSecondaryBtn}>
                <IconButton
                  name={ignored ? icons.visible : icons.hidden}
                  size={18}
                  color={colors.textMuted}
                />
                <AppText variant="label" color={colors.textMuted}>
                  {ignored ? 'Stop ignoring' : "Ignore - it's not an audiobook"}
                </AppText>
              </Touchable>
              <Touchable onPress={reset} style={styles.sheetGhostBtn}>
                <AppText variant="label" color={colors.textMuted}>
                  Close
                </AppText>
              </Touchable>
            </>
          )}
        </View>
      ) : null}
    </Sheet>
  )
})

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetSecondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    sheetGhostBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm },
  })
