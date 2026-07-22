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
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import * as Sentry from '@sentry/react-native'
import { useUser } from '@clerk/expo'
import { AppText, Chip, PrimaryButton, Screen, SectionHeader } from '@/ui/primitives'
import { Icon, iconFor } from '@/ui/icons'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { useContentInset } from '@/ui/useContentInset'
import { FULL_VERSION, SENTRY_DSN } from '@/lib/config'

type Kind = 'bug' | 'idea' | 'other'

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

  const canSend = message.trim().length >= 5 && !sending

  const send = () => {
    if (!canSend) return
    if (!SENTRY_DSN) {
      showToast("Feedback isn't set up in this build.")
      return
    }
    setSending(true)
    try {
      Sentry.captureFeedback({
        message: message.trim(),
        name: user?.username ?? user?.fullName ?? undefined,
        email: email.trim() || undefined,
        source: 'mobile-feedback-tab',
        tags: {
          feedback_kind: kind,
          app_version: FULL_VERSION || 'unknown',
          platform: Platform.OS,
        },
      })
      haptics.success()
      setMessage('')
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
  })
}
