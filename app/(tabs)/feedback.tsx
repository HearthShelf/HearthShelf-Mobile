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
import { attachFeedbackDiagnostics } from '@/lib/feedbackDiagnostics'

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
  const [shot, setShot] = useState<{ uri: string; base64: string; bytes: number } | null>(null)

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
   */
  const pickShot = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        quality: 0.5,
        base64: true,
        allowsMultipleSelection: false,
      })
      if (res.canceled) return
      const asset = res.assets?.[0]
      if (!asset?.base64) {
        showToast("Couldn't read that image.")
        return
      }
      // base64 inflates ~4/3; measure the DECODED size, which is what ships.
      const bytes = Math.floor((asset.base64.length * 3) / 4)
      if (bytes > MAX_SHOT_BYTES) {
        showToast('That image is too large to attach. Try a cropped screenshot.')
        return
      }
      haptics.select()
      setShot({ uri: asset.uri, base64: asset.base64, bytes })
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
      // Attach player state + the breadcrumb trail BEFORE capturing, so the
      // report carries what the app was actually doing. A description alone
      // ("progress reset when I unlocked my phone") can't distinguish a sync
      // failure from a process kill from a bad resume - the snapshot can.
      attachFeedbackDiagnostics()
      Sentry.captureFeedback(
        {
          message: message.trim(),
          name: user?.username ?? user?.fullName ?? undefined,
          email: email.trim() || undefined,
          source: 'mobile-feedback-tab',
          tags: {
            feedback_kind: kind,
            app_version: FULL_VERSION || 'unknown',
            platform: Platform.OS,
            has_screenshot: String(!!shot),
          },
        },
        // Second arg is an EventHint; `attachments` rides along with the event.
        // Decoded from base64 to bytes rather than sent as a string, so Sentry
        // stores a real image file instead of a text blob.
        shot
          ? {
              attachments: [
                {
                  filename: 'screenshot.jpg',
                  data: base64ToBytes(shot.base64),
                  contentType: 'image/jpeg',
                },
              ],
            }
          : undefined,
      )
      haptics.success()
      setMessage('')
      setShot(null)
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
            Screenshot (optional)
          </AppText>
          {shot ? (
            <View style={styles.shotRow}>
              <Image source={{ uri: shot.uri }} style={styles.shotThumb} resizeMode="cover" />
              <View style={styles.flex}>
                <AppText variant="label" numberOfLines={1}>
                  Screenshot attached
                </AppText>
                <AppText variant="caption" color={colors.textFaint}>
                  {Math.round(shot.bytes / 1024)} KB
                </AppText>
              </View>
              <Pressable onPress={() => setShot(null)} hitSlop={12}>
                <AppText variant="label" color={colors.destructive}>
                  Remove
                </AppText>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => void pickShot()} style={styles.shotPick}>
              <AppText variant="label" color={colors.textMuted}>
                Attach a screenshot
              </AppText>
            </Pressable>
          )}

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
