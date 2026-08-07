/**
 * One recommended pick: what it is, why it was chosen, and the action that
 * actually applies to it.
 *
 * The action follows `pick.kind`, which core decides:
 *   library -> play it or open details
 *   request -> queue it via the connected request backend (falls back to Audible)
 *   new     -> no request backend, so the only thing to offer is a way to buy it
 * Whether an external pick appears at all is a separate question (the "look
 * beyond" answer); this card only decides what to DO with one.
 */
import { memo, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import { coverHue, coverInitial, type QgRenderedPick } from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import { audibleStoreUrl } from '@/api/absAudible'
import type { QgFeedback } from '@/api/questgiver'
import { AppText, Cover, PrimaryButton, Touchable } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export type QgRequestState = 'idle' | 'pending' | 'done'

export const QuestGiverResultCard = memo(function QuestGiverResultCard({
  pick,
  feedback,
  onPlay,
  onDetails,
  onVote,
  onNote,
  onRequest,
  requestState = 'idle',
}: {
  pick: QgRenderedPick
  feedback?: QgFeedback
  onPlay: (itemId: string) => void
  onDetails: (itemId: string) => void
  onVote: (key: string, vote: 1 | -1 | 0) => void
  onNote: (key: string, note: string) => void
  /** Absent when no request backend is connected - the card then offers Audible. */
  onRequest?: (pick: QgRenderedPick) => void
  requestState?: QgRequestState
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const fb = feedback ?? {}
  const [noteOpen, setNoteOpen] = useState(false)
  const [draft, setDraft] = useState(fb.note ?? '')

  const openAudible = () => {
    void Linking.openURL(
      audibleStoreUrl({ asin: pick.itemId, title: pick.title, author: pick.author }),
    )
  }

  return (
    <View style={s.card}>
      <View style={s.top}>
        <Cover
          uri={pick.kind === 'library' && pick.itemId ? coverUrl(pick.itemId) : undefined}
          width={64}
          aspectRatio={1}
          fallback={{
            hue: coverHue(pick.itemId ?? pick.key),
            initial: coverInitial(pick.title),
            title: pick.title,
            kicker: pick.genre,
          }}
        />
        <View style={s.head}>
          <View style={s.tagRow}>
            <View style={[s.tag, pick.kind === 'library' ? s.tagLib : s.tagNew]}>
              <Icon
                name={pick.kind === 'library' ? 'library-books' : 'auto-awesome'}
                size={12}
                color={pick.kind === 'library' ? colors.accent : colors.brandHearth}
              />
              <AppText
                variant="caption"
                color={pick.kind === 'library' ? colors.accent : colors.brandHearth}
              >
                {pick.kind === 'library'
                  ? 'In your library'
                  : pick.kind === 'request'
                    ? 'Can be requested'
                    : 'New to your shelf'}
              </AppText>
            </View>
            {pick.priorCount > 0 ? (
              <AppText variant="caption" color={colors.textFaint}>
                {`${pick.priorCount}x before`}
              </AppText>
            ) : null}
          </View>
          <AppText variant="label" numberOfLines={2}>
            {pick.title}
          </AppText>
          <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
            {pick.author + (pick.hours ? ` · ${pick.hours}h` : '')}
          </AppText>
        </View>
      </View>

      <AppText variant="meta" color={colors.textMuted} style={s.why}>
        {pick.reason}
      </AppText>

      {pick.kind === 'library' && pick.itemId ? (
        <View style={s.actions}>
          <PrimaryButton
            label="Start listening"
            icon="play-arrow"
            onPress={() => onPlay(pick.itemId as string)}
            style={s.grow}
          />
          <Touchable
            onPress={() => onDetails(pick.itemId as string)}
            style={s.ghostBtn}
            accessibilityRole="button"
            accessibilityLabel="Details"
          >
            <Icon name="info-outline" size={16} color={colors.text} />
            <AppText variant="label">Details</AppText>
          </Touchable>
        </View>
      ) : (
        <View style={s.actions}>
          {pick.kind === 'request' && onRequest ? (
            <PrimaryButton
              label={
                requestState === 'done'
                  ? 'Requested'
                  : requestState === 'pending'
                    ? 'Requesting...'
                    : 'Request'
              }
              icon={requestState === 'done' ? 'check' : 'bolt'}
              onPress={requestState === 'idle' ? () => onRequest(pick) : undefined}
              style={s.grow}
            />
          ) : null}
          <Touchable
            onPress={openAudible}
            style={[s.ghostBtn, pick.kind === 'new' && s.grow]}
            accessibilityRole="link"
            accessibilityLabel={`Find ${pick.title} on Audible`}
          >
            <Icon name="open-in-new" size={16} color={colors.text} />
            <AppText variant="label">{pick.kind === 'new' ? 'Find on Audible' : 'Audible'}</AppText>
          </Touchable>
        </View>
      )}

      <View style={s.feedback}>
        <Touchable
          onPress={() => onVote(pick.key, fb.vote === 1 ? 0 : 1)}
          style={[s.vote, fb.vote === 1 && s.voteUp]}
          accessibilityRole="button"
          accessibilityLabel="Good pick"
        >
          <Icon
            name="thumb-up"
            size={16}
            color={fb.vote === 1 ? colors.accent : colors.textMuted}
          />
        </Touchable>
        <Touchable
          onPress={() => onVote(pick.key, fb.vote === -1 ? 0 : -1)}
          style={[s.vote, fb.vote === -1 && s.voteDown]}
          accessibilityRole="button"
          accessibilityLabel="Not for me"
        >
          <Icon
            name="thumb-down"
            size={16}
            color={fb.vote === -1 ? colors.destructive : colors.textMuted}
          />
        </Touchable>
        <Touchable
          onPress={() => {
            setDraft(fb.note ?? '')
            setNoteOpen((o) => !o)
          }}
          style={s.noteBtn}
          accessibilityRole="button"
          accessibilityLabel={fb.note ? 'Edit note' : 'Add note'}
        >
          <Icon name="edit-note" size={16} color={colors.textMuted} />
          <AppText variant="caption" color={colors.textMuted}>
            {fb.note ? 'Edit note' : 'Add note'}
          </AppText>
        </Touchable>
      </View>

      {noteOpen ? (
        <View style={s.noteEdit}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="What worked, or why this isn't for you..."
            placeholderTextColor={colors.textFaint}
            multiline
            style={s.noteField}
          />
          <Touchable
            onPress={() => {
              onNote(pick.key, draft.trim())
              setNoteOpen(false)
            }}
            style={s.ghostBtn}
            accessibilityRole="button"
            accessibilityLabel="Save note"
          >
            <Icon name="check" size={16} color={colors.text} />
            <AppText variant="label">Save</AppText>
          </Touchable>
        </View>
      ) : fb.note ? (
        <Touchable
          onPress={() => {
            setDraft(fb.note ?? '')
            setNoteOpen(true)
          }}
          style={s.noteSaved}
          accessibilityRole="button"
          accessibilityLabel="Edit note"
        >
          <AppText variant="caption" color={colors.textMuted}>
            {`"${fb.note}"`}
          </AppText>
        </Touchable>
      ) : null}
    </View>
  )
})

function makeStyles(c: Palette) {
  return StyleSheet.create({
    card: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
    },
    top: { flexDirection: 'row', gap: spacing.md },
    head: { flex: 1, gap: 2 },
    tagRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    tag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
    },
    tagLib: { backgroundColor: c.accentTile },
    tagNew: { backgroundColor: c.fill },
    why: { fontStyle: 'italic' },
    actions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    grow: { flex: 1 },
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
    feedback: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingTop: spacing.xs,
    },
    vote: {
      width: 36,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
    },
    voteUp: { borderColor: c.accent, backgroundColor: c.accentWash },
    voteDown: { borderColor: c.destructive },
    noteBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: 6 },
    noteEdit: { gap: spacing.sm },
    noteField: {
      minHeight: 64,
      padding: spacing.sm,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      textAlignVertical: 'top',
    },
    noteSaved: {
      padding: spacing.sm,
      borderRadius: radius.row,
      backgroundColor: c.fill,
    },
  })
}
