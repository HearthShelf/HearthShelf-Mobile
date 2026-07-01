/**
 * My Settings hub. Reached from the profile card on More. Sections mirror the
 * WebApp/self-hosted SettingsPage nav (Appearance / Playback / Sleep timer /
 * Reading / Connections / My servers), collapsed into accordions here rather
 * than a side-nav (no room on a phone). "Queue" is folded under Listening
 * alongside Playback/Sleep since the DS ask grouped them together.
 *
 * Reading has no in-app ebook reader yet (mobile or the hosted WebApp) - the
 * self-hosted app's reader prefs (theme/typeface/size/spacing/width/justify)
 * are shown as an honest "Coming soon" list of the same rows, not omitted, so
 * this screen already documents the full settings surface a mobile reader
 * will need to satisfy.
 */
import { useUser } from '@clerk/expo'
import { useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AppText, IconButton, Screen } from '@/ui/primitives'
import { colors, radius, spacing } from '@/ui/theme'
import { icons } from '@/ui/icons'
import {
  SectionAccordion,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  Seg,
  SettingsToggle,
  SettingsSlider,
  ChipRow,
} from '@/ui/settingsControls'
import {
  getSettingsState,
  subscribeSettings,
  setSetting,
  setQueueMode,
  toggleAutoRule,
} from '@/store/settings'
import { QUEUE_MODES, QUEUE_MODE_SUB, AUTO_RULE_COPY } from '@/player/queue'

const SKIP_FWD_OPTIONS = [15, 30, 60] as const
const SKIP_BACK_OPTIONS = [10, 15, 30] as const
const SPEED_OPTIONS = [0.75, 1, 1.5, 2] as const

const HAPTIC_SUBTITLE: Record<'off' | 'minimal' | 'all', string> = {
  off: 'Off',
  minimal: 'Minimal',
  all: 'All the things',
}

function fmtRewind(sec: number): string {
  if (sec === 0) return 'Off'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

export default function SettingsScreen() {
  const router = useRouter()
  const { user } = useUser()
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
        <AppText variant="title">My settings</AppText>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Current user card -> Account & HearthShelf Account (not yet built) */}
        <Pressable
          onPress={() => router.push('/settings/account')}
          style={({ pressed }) => [styles.userCard, pressed && styles.userCardPressed]}
        >
          <View style={styles.avatar}>
            <AppText variant="mono" color={colors.brandHearth} style={{ fontSize: 19 }}>
              {initial}
            </AppText>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label" numberOfLines={1}>
              {displayName}
            </AppText>
            {email ? (
              <AppText
                variant="caption"
                color={colors.textMuted}
                numberOfLines={1}
                style={{ marginTop: 2 }}
              >
                {email}
              </AppText>
            ) : null}
          </View>
          <IconButton name={icons.chevronRight} color={colors.textMuted} />
        </Pressable>

        <SectionAccordion icon="palette" title="Appearance">
          <SettingsGroup>
            <SettingsRow
              icon="dark-mode"
              title="Theme"
              desc="Dark is home; OLED goes pure black."
              control={
                <Seg
                  value={s.theme}
                  onChange={(v) => setSetting('theme', v)}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'oled', label: 'OLED' },
                  ]}
                />
              }
            />
            <SettingsRow
              icon="crop"
              title="Cover shape"
              desc="How book covers are cropped in lists and the player. Doesn't change the home spotlight background."
              control={
                <Seg
                  value={s.coverAspect}
                  onChange={(v) => setSetting('coverAspect', v)}
                  options={[
                    { value: 'square', label: 'Square' },
                    { value: 'portrait', label: 'Portrait' },
                  ]}
                />
              }
            />
            <SettingsRow
              icon="blur-on"
              title="Cover glow style"
              desc="Gradient blooms live; Image is the lighter-weight option."
              last
              control={
                <Seg
                  value={s.glowMode}
                  onChange={(v) => setSetting('glowMode', v)}
                  options={[
                    { value: 'gradient', label: 'Gradient' },
                    { value: 'image', label: 'Image' },
                  ]}
                />
              }
            />
          </SettingsGroup>
        </SectionAccordion>

        <SettingsLabel>Listening</SettingsLabel>

        <SectionAccordion
          icon="speed"
          title="Playback"
          subtitle={`Default ${s.defaultSpeed.toFixed(2).replace(/\.?0+$/, '')}x · skip ${s.skipBack}s/${s.skipForward}s`}
        >
          <SettingsGroup>
            <SettingsRow title="Default speed" stacked>
              <ChipRow
                value={s.defaultSpeed as (typeof SPEED_OPTIONS)[number]}
                options={[...SPEED_OPTIONS]}
                onChange={(v) => setSetting('defaultSpeed', v)}
                unit="x"
              />
            </SettingsRow>
            <SettingsRow title="Skip forward" desc="How far the forward button jumps." stacked>
              <ChipRow
                value={s.skipForward as (typeof SKIP_FWD_OPTIONS)[number]}
                options={[...SKIP_FWD_OPTIONS]}
                onChange={(v) => setSetting('skipForward', v)}
                unit="s"
              />
            </SettingsRow>
            <SettingsRow title="Skip back" desc="How far the back button jumps." stacked>
              <ChipRow
                value={s.skipBack as (typeof SKIP_BACK_OPTIONS)[number]}
                options={[...SKIP_BACK_OPTIONS]}
                onChange={(v) => setSetting('skipBack', v)}
                unit="s"
              />
            </SettingsRow>
            <SettingsRow
              title="Progress bar"
              desc="Scrub against the current chapter, or the whole book."
              control={
                <Seg
                  value={s.scrubber}
                  onChange={(v) => setSetting('scrubber', v)}
                  options={[
                    { value: 'chapter', label: 'Chapter' },
                    { value: 'book', label: 'Book' },
                  ]}
                />
              }
            />
            <SettingsRow
              title="Hearth background"
              desc="Show the cozy hearth artwork behind the full-screen player."
              control={
                <SettingsToggle
                  on={s.hearthBgPlayer}
                  onChange={(v) => setSetting('hearthBgPlayer', v)}
                />
              }
            />
            <SettingsRow
              title="Player buttons"
              desc="Choose which action buttons show on the player, tuck into More, or hide."
              onPress={() => router.push('/settings/player-buttons')}
              last
            />
          </SettingsGroup>

          <SettingsLabel>Queue</SettingsLabel>
          <SettingsGroup>
            <SettingsRow
              title="When a book ends"
              desc={QUEUE_MODE_SUB[s.queueMode]}
              stacked
              last={s.queueMode !== 'auto'}
            >
              <Seg
                value={s.queueMode}
                onChange={setQueueMode}
                options={QUEUE_MODES.map((m) => ({ value: m.v, label: m.label }))}
              />
            </SettingsRow>
            {s.queueMode === 'auto' && (
              <View style={styles.autoRules}>
                <AppText
                  variant="caption"
                  color={colors.textMuted}
                  style={{ marginBottom: spacing.sm }}
                >
                  Auto-queue rules
                </AppText>
                {s.queueAutoRules.map((r, i) => {
                  const copy = AUTO_RULE_COPY[r.id]
                  return (
                    <SettingsRow
                      key={r.id}
                      title={copy.label}
                      desc={copy.desc}
                      last={i === s.queueAutoRules.length - 1}
                      control={<SettingsToggle on={r.on} onChange={() => toggleAutoRule(r.id)} />}
                    />
                  )
                })}
              </View>
            )}
          </SettingsGroup>
        </SectionAccordion>

        <SectionAccordion
          icon="bedtime"
          title="Sleep timer"
          subtitle={s.sleepFade ? `Fades over ${s.sleepFadeLen}s` : 'No fade'}
        >
          <SettingsGroup>
            <SettingsRow
              title="Rewind on wake"
              desc="Jump back this far when the timer pauses, so you don't lose your place."
              stacked
            >
              <SettingsSlider
                value={s.sleepRewindSec}
                min={0}
                max={120}
                step={5}
                onChange={(v) => setSetting('sleepRewindSec', v)}
                formatLabel={fmtRewind}
              />
            </SettingsRow>
            <SettingsRow
              title="Stay within the chapter"
              desc="When rewinding, don't cross back into the previous chapter."
              control={
                <SettingsToggle
                  on={s.sleepChapterBarrier}
                  onChange={(v) => setSetting('sleepChapterBarrier', v)}
                />
              }
            />
            <SettingsRow
              title="Fade out"
              desc="Gradually lower the volume before the timer pauses."
              control={
                <SettingsToggle on={s.sleepFade} onChange={(v) => setSetting('sleepFade', v)} />
              }
              last={!s.sleepFade}
            />
            {s.sleepFade && (
              <SettingsRow title="Fade length" desc="How long the fade-out takes." stacked last>
                <SettingsSlider
                  value={s.sleepFadeLen}
                  min={5}
                  max={60}
                  step={5}
                  onChange={(v) => setSetting('sleepFadeLen', v)}
                  formatLabel={(v) => `${v}s`}
                />
              </SettingsRow>
            )}
          </SettingsGroup>
        </SectionAccordion>

        <SectionAccordion icon="vibration" title="Haptics" subtitle={HAPTIC_SUBTITLE[s.haptics]}>
          <SettingsGroup>
            <SettingsRow
              title="Feedback"
              stacked
              last={s.haptics === 'off'}
              control={
                <Seg
                  value={s.haptics}
                  onChange={(v) => setSetting('haptics', v)}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'minimal', label: 'Minimal' },
                    { value: 'all', label: 'All the things' },
                  ]}
                />
              }
            />
            {s.haptics !== 'off' && (
              <SettingsRow
                title="Intensity"
                last
                control={
                  <Seg
                    value={s.hapticIntensity}
                    onChange={(v) => setSetting('hapticIntensity', v)}
                    options={[
                      { value: 'light', label: 'Light' },
                      { value: 'medium', label: 'Medium' },
                    ]}
                  />
                }
              />
            )}
          </SettingsGroup>
        </SectionAccordion>

        <SettingsLabel>Reading</SettingsLabel>

        <SectionAccordion icon="menu-book" title="Reading">
          <ReadingComingSoon />
        </SectionAccordion>

        <SettingsLabel>HearthShelf</SettingsLabel>

        <SectionAccordion icon="hub" title="Connections">
          <ConnectionsComingSoon />
        </SectionAccordion>

        <SectionAccordion icon="dns" title="My servers">
          <SettingsGroup>
            <SettingsRow
              title="Manage linked servers"
              desc="See every server you're connected to and switch between them."
              onPress={() => router.push('/settings/servers')}
              last
            />
          </SettingsGroup>
        </SectionAccordion>
      </ScrollView>
    </Screen>
  )
}

/** Reading: no ebook reader yet on mobile (or the hosted WebApp) - the
 *  self-hosted app's reader prefs are the target shape, shown here disabled so
 *  this screen already covers what a mobile reader will need to expose. */
function ReadingComingSoon() {
  const rows: { label: string; desc: string }[] = [
    { label: 'Reader theme', desc: 'Dark, sepia, or light page colors.' },
    { label: 'Typeface', desc: 'Serif, sans, or a dyslexia-friendly face.' },
    { label: 'Text size', desc: 'How large the body text is set.' },
    { label: 'Line spacing', desc: 'Breathing room between lines.' },
    { label: 'Page width', desc: 'How wide the column of text runs.' },
    { label: 'Justify text', desc: 'Align both edges, like a printed book.' },
  ]
  return (
    <View style={{ gap: spacing.md }}>
      <AppText variant="caption" color={colors.textMuted}>
        HearthShelf Mobile doesn't have an ebook reader yet. When it does, these will match the
        self-hosted app's reader settings.
      </AppText>
      <SettingsGroup style={{ opacity: 0.5 }}>
        {rows.map((r, i) => (
          <SettingsRow key={r.label} title={r.label} desc={r.desc} last={i === rows.length - 1} />
        ))}
      </SettingsGroup>
    </View>
  )
}

/** Connections: mirrors the self-hosted app's Connections section (Hardcover
 *  personal-token sync + admin-managed integrations note). No per-user token
 *  UI yet on mobile - shown as an honest note, not a fake connect button. */
function ConnectionsComingSoon() {
  return (
    <SettingsGroup>
      <SettingsRow
        title="Hardcover"
        desc="Sync finished books to your Hardcover reading history. Connect this from the self-hosted app for now - mobile support is coming."
      />
      <SettingsRow
        title="External book links"
        desc="Goodreads, Audible, Hardcover search links are managed by your server admin."
        last
      />
    </SettingsGroup>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { padding: spacing.lg, paddingBottom: 140, gap: spacing.lg },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  userCardPressed: { opacity: 0.7 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accentTile,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoRules: { paddingTop: spacing.sm },
})
