/**
 * Send feedback. A temporary pinned tab (sitting between Stats and More) during
 * the beta so testers can report something the moment it happens - once the beta
 * settles this moves under More, which the banner at the top says out loud.
 *
 * Reports go to Sentry as a feedback event (Sentry.captureFeedback), so they land
 * in the same project as the crash reports and can be tied back to a build. We
 * render our own themed form rather than Sentry's built-in widget so it matches
 * the app; the widget's default styling is nothing like the hearth theme.
 */
import { useState } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import * as Sentry from '@sentry/react-native'
import * as ImagePicker from 'expo-image-picker'
import { useUser } from '@clerk/expo'
import { AppText, Chip, PrimaryButton, Screen, SectionHeader } from '@/ui/primitives'
import { Icon, iconFor } from '@/ui/icons'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { useContentInset } from '@/ui/useContentInset'
import { FULL_VERSION, SENTRY_DSN } from '@/lib/config'
import { withFeedbackScope } from '@/lib/feedbackDiagnostics'

type Kind = 'bug' | 'idea' | 'other'

/**
 * Ceiling on an attached screenshot, in DECODED bytes.
 *
 * Sentry drops attachments over its per-event limit silently - the report still
 * arrives, just without the image - so an unbounded attach would look like it
 * worked and lose the one thing the reporter went out of their way to include.
 * 1MB sits well under the limit with room for the event itself, and a
 * quality-0.5 phone screenshot lands far below it.
 */
const MAX_SHOT_BYTES = 1_000_000

/**
 * Ceiling on ALL attached screenshots together, in decoded bytes.
 *
 * The Sentry limit that matters is per EVENT, not per file, so several images
 * that each pass MAX_SHOT_BYTES can still blow it collectively - and the failure
 * mode is the same silent drop, except now it can take the log file with it.
 * Kept a little under 3x the single-image cap to leave room for the event body
 * and the diagnostic log.
 */
const MAX_SHOTS_TOTAL_BYTES = 2_800_000

/** How many screenshots one report may carry. Enough to show a before/after or a
 *  short sequence; past that a report is better told in words, and every extra
 *  image eats the same per-event budget the diagnostic log needs. */
const MAX_SHOTS = 4

/**
 * base64 -> bytes, so the attachment is stored as a real JPEG rather than a text
 * blob. `atob` is present in Hermes (already relied on in api/serverIdentity.ts),
 * which avoids pulling in a Buffer polyfill for one call site.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const KINDS: { id: Kind; label: string }[] = [
  { id: 'bug', label: 'Something broke' },
  { id: 'idea', label: 'An idea' },
  { id: 'other', label: 'Something else' },
]

export default function FeedbackScreen() {
  const colors = useColors()
  const styles = useStyles(colors)
  const bottomInset = useContentInset()
  const { user } = useUser()

  const [kind, setKind] = useState<Kind>('bug')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState(user?.primaryEmailAddress?.emailAddress ?? '')
  const [sending, setSending] = useState(false)
  const [shots, setShots] = useState<{ uri: string; base64: string; bytes: number }[]>([])
  const shotsBytes = shots.reduce((total, s) => total + s.bytes, 0)

  const canSend = message.trim().length >= 5 && !sending

  /**
   * Attach a screenshot the listener already took.
   *
   * A picker rather than an in-app screen capture on purpose: the screen worth
   * reporting is usually the broken one, and you cannot be on it and on this
   * form at the same time. Capturing the app's current view would only ever
   * photograph the feedback screen.
   *
   * quality 0.5 + a size check because Sentry silently DROPS an attachment over
   * its per-event limit - a full-resolution Pixel screenshot is comfortably over
   * it, so an unconstrained attach would look like it worked and arrive with
   * nothing. Better to say so than to send a report that quietly lost its image.
   *
   * Several images may be picked at once (a before/after, or a short sequence).
   * The budget that matters is per EVENT, so each image is checked against
   * MAX_SHOT_BYTES and the running total against MAX_SHOTS_TOTAL_BYTES - a set
   * that individually passes can still collectively overflow and take the
   * diagnostic log down with it. Anything that does not fit is reported by name
   * rather than dropped quietly, and whatever DID fit is still attached: a
   * partial set of screenshots is worth more than an all-or-nothing refusal.
   */
  const pickShot = async () => {
    const room = MAX_SHOTS - shots.length
    if (room <= 0) {
      showToast(`You can attach up to ${MAX_SHOTS} screenshots.`)
      return
    }
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        quality: 0.5,
        base64: true,
        allowsMultipleSelection: true,
        selectionLimit: room,
      })
      if (res.canceled) return
      const picked = res.assets ?? []
      if (!picked.length) return

      const accepted: { uri: string; base64: string; bytes: number }[] = []
      let running = shotsBytes
      let tooBig = 0
      let noRoom = 0
      let unreadable = 0
      for (const asset of picked) {
        if (accepted.length >= room) {
          noRoom += 1
          continue
        }
        if (!asset.base64) {
          unreadable += 1
          continue
        }
        // base64 inflates ~4/3; measure the DECODED size, which is what ships.
        const bytes = Math.floor((asset.base64.length * 3) / 4)
        if (bytes > MAX_SHOT_BYTES) {
          tooBig += 1
          continue
        }
        if (running + bytes > MAX_SHOTS_TOTAL_BYTES) {
          noRoom += 1
          continue
        }
        running += bytes
        accepted.push({ uri: asset.uri, base64: asset.base64, bytes })
      }

      if (accepted.length) {
        haptics.select()
        setShots((current) => [...current, ...accepted])
      }
      const skipped = tooBig + noRoom + unreadable
      if (skipped) {
        showToast(
          tooBig && !noRoom && !unreadable
            ? `${tooBig === 1 ? 'That image is' : `${tooBig} images are`} too large to attach. Try a cropped screenshot.`
            : `Attached ${accepted.length}; skipped ${skipped} that wouldn't fit.`,
        )
      }
    } catch {
      showToast("Couldn't open your photos.")
    }
  }

  const send = () => {
    if (!canSend) return
    if (!SENTRY_DSN) {
      showToast("Feedback isn't set up in this build.")
      return
    }
    setSending(true)
    try {
      // Capture player state alongside the report, so it carries what the app was
      // actually doing. A description alone ("progress reset when I unlocked my
      // phone") can't distinguish a sync failure from a process kill from a bad
      // resume - the snapshot can. The log trail comes back to be attached as a
      // file: feedback events drop scope breadcrumbs, so that is the one way it
      // reaches Sentry (see feedbackDiagnostics).
      //
      // withFeedbackScope confines the diagnostic CONTEXTS to this capture. They
      // used to be set globally and never cleared, so every later crash in the run
      // inherited this report's snapshot; the tags now ride on the event below
      // rather than on the scope, for the same reason.
      withFeedbackScope(({ tags, log }) => {
        const attachments = [
          // Numbered so the order the reporter picked them in survives into
          // Sentry - a before/after pair is meaningless if they arrive shuffled
          // or overwrite each other under one filename.
          ...shots.map((s, i) => ({
            filename: shots.length > 1 ? `screenshot-${i + 1}.jpg` : 'screenshot.jpg',
            // Decoded from base64 to bytes rather than sent as a string, so
            // Sentry stores a real image file instead of a text blob.
            data: base64ToBytes(s.base64),
            contentType: 'image/jpeg',
          })),
          ...(log
            ? [{ filename: 'hearthshelf-log.txt', data: log, contentType: 'text/plain' }]
            : []),
        ]
        Sentry.captureFeedback(
          {
            message: message.trim(),
            name: user?.username ?? user?.fullName ?? undefined,
            email: email.trim() || undefined,
            source: 'mobile-feedback-tab',
            tags: {
              ...tags,
              feedback_kind: kind,
              app_version: FULL_VERSION || 'unknown',
              platform: Platform.OS,
              has_screenshot: String(shots.length > 0),
              // The count, not just the boolean: a report that meant to carry
              // three images and arrived with one is a dropped attachment, and
              // that is invisible without something to compare against.
              screenshot_count: String(shots.length),
              has_log: String(!!log),
            },
          },
          // Second arg is an EventHint; `attachments` rides along with the event.
          attachments.length ? { attachments } : undefined,
        )
      })
      haptics.success()
      setMessage('')
      setShots([])
      showToast('Thanks - your feedback is on its way.')
    } catch {
      showToast("That didn't send. Please try again.")
    } finally {
      setSending(false)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
          keyboardShouldPersistTaps="handled"
        >
          <SectionHeader title="Send feedback" icon={iconFor('feedback')} />

          <View style={styles.banner}>
            <Icon name={iconFor('info')} size={18} color={colors.accent} />
            <AppText variant="caption" color={colors.textMuted} style={styles.flex}>
              Feedback is pinned to the bar while the app is in beta. In a later build it moves
              under More.
            </AppText>
          </View>

          <View style={styles.kinds}>
            {KINDS.map((k) => (
              <Chip
                key={k.id}
                label={k.label}
                active={k.id === kind}
                onPress={() => {
                  haptics.select()
                  setKind(k.id)
                }}
              />
            ))}
          </View>

          <AppText variant="eyebrow" color={colors.textMuted}>
            What happened?
          </AppText>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="Tell us what you saw, and what you expected instead."
            placeholderTextColor={colors.textFaint}
            style={[styles.input, styles.messageInput]}
            multiline
            textAlignVertical="top"
          />

          <AppText variant="eyebrow" color={colors.textMuted}>
            Email (optional)
          </AppText>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="So we can follow up"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />

          <AppText variant="eyebrow" color={colors.textMuted}>
            Screenshots (optional)
          </AppText>
          {shots.map((s, i) => (
            <View key={`${s.uri}:${i}`} style={styles.shotRow}>
              <Image source={{ uri: s.uri }} style={styles.shotThumb} resizeMode="cover" />
              <View style={styles.flex}>
                <AppText variant="label" numberOfLines={1}>
                  {shots.length > 1 ? `Screenshot ${i + 1}` : 'Screenshot attached'}
                </AppText>
                <AppText variant="caption" color={colors.textFaint}>
                  {Math.round(s.bytes / 1024)} KB
                </AppText>
              </View>
              <Pressable
                onPress={() => setShots((current) => current.filter((_, at) => at !== i))}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={`Remove screenshot ${i + 1}`}
              >
                <AppText variant="label" color={colors.destructive}>
                  Remove
                </AppText>
              </Pressable>
            </View>
          ))}
          {shots.length < MAX_SHOTS ? (
            <Pressable onPress={() => void pickShot()} style={styles.shotPick}>
              <AppText variant="label" color={colors.textMuted}>
                {shots.length ? 'Attach another screenshot' : 'Attach a screenshot'}
              </AppText>
            </Pressable>
          ) : null}

          <PrimaryButton
            label={sending ? 'Sending...' : 'Send feedback'}
            icon={iconFor('send')}
            onPress={send}
            style={canSend ? undefined : styles.disabled}
          />

          <AppText variant="caption" color={colors.textFaint}>
            Your app version and device type are sent along so we can reproduce the problem.
          </AppText>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function useStyles(colors: Palette) {
  return StyleSheet.create({
    flex: { flex: 1 },
    content: { padding: spacing.lg, gap: spacing.md },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.row,
      backgroundColor: colors.elevated,
    },
    kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    input: {
      backgroundColor: colors.elevated,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    messageInput: { minHeight: 140 },
    disabled: { opacity: 0.45 },
    shotPick: {
      borderWidth: 1,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      borderStyle: 'dashed',
      paddingVertical: spacing.md,
      alignItems: 'center',
    },
    shotRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      padding: spacing.sm,
    },
    shotThumb: {
      width: 44,
      height: 44,
      borderRadius: radius.tile,
      backgroundColor: colors.hairline,
    },
  })
}
