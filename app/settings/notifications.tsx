/**
 * Notifications panel: release-notification preferences + the list of books and
 * series you're following. Toggles + the countdown window are account-scoped
 * settings (they sync across devices); the subscription list is the server-owned
 * follow list (src/player/subscriptions.ts).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { AppState, Linking, Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { coverHue, countdownLabel, resolveChannels } from '@hearthshelf/core'
import type { HSSubscription, NotifyChannel, NotifyType } from '@hearthshelf/core'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import {
  getSubscriptionsState,
  subscribeSubscriptions,
  refreshSubscriptions,
  unsubscribe,
} from '@/player/subscriptions'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsToggle,
  SettingsSlider,
  ChannelChips,
} from '@/ui/settingsControls'
import { AppText, Cover, IconButton, Loading, icons } from '@/ui/primitives'
import type { IconName } from '@/ui/icons'
import { EAS_PROJECT_ID } from '@/lib/config'
import { getPushStatus, subscribePushStatus } from '@/player/pushRegister'
import { spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** The three delivery channels, in the order they appear under Delivery. */
const CHANNEL_OPTIONS: { id: NotifyChannel; label: string }[] = [
  { id: 'inApp', label: 'In app' },
  { id: 'push', label: 'Push' },
  { id: 'email', label: 'Email' },
]

export default function NotificationsPanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const { subscriptions, loaded } = useSyncExternalStore(
    subscribeSubscriptions,
    getSubscriptionsState,
  )
  const colors = useColors()
  const router = useRouter()

  // Refresh the follow list whenever the panel opens.
  useEffect(() => {
    void refreshSubscriptions()
  }, [])

  // OS-level notification permission: when the user has release notifications on
  // in-app but the phone denied the permission, no push can arrive - so surface
  // an actionable Enable row that deep-links to system settings. Re-checked when
  // the panel regains focus (they may have just toggled it in Settings).
  const [osDenied, setOsDenied] = useState(false)
  const checkPermission = useCallback(() => {
    void (async () => {
      try {
        const Notifications = await import('expo-notifications')
        const { status, canAskAgain } = await Notifications.getPermissionsAsync()
        setOsDenied(status !== 'granted' && !canAskAgain)
      } catch {
        setOsDenied(false)
      }
    })()
  }, [])

  // The permission check above only catches a phone that REFUSED alerts. It says
  // nothing about the other way push dies: permission granted, but the build
  // could never mint a token, so the app looks correctly configured and nothing
  // ever arrives. pushStatus is the registration's own account of what happened.
  const pushStatus = useSyncExternalStore(subscribePushStatus, getPushStatus)
  useEffect(() => {
    checkPermission()
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') checkPermission()
    })
    return () => sub.remove()
  }, [checkPermission])

  const prefs = s.notifyPrefs
  const release = prefs.types.release
  const seriesSubs = subscriptions.filter((x) => x.kind === 'series')
  const bookSubs = subscriptions.filter((x) => x.kind === 'book')

  const setGlobal = (channel: NotifyChannel, on: boolean) => {
    const global = { ...prefs.global, [channel]: on }
    // Every channel off means "notify me nowhere", which reads as a bug rather
    // than a choice - keep the tray on as the floor.
    if (!global.inApp && !global.push && !global.email) global.inApp = true
    setSetting('notifyPrefs', { ...prefs, global })
  }

  const setTypeEnabled = (type: NotifyType, on: boolean) => {
    setSetting('notifyPrefs', {
      ...prefs,
      types: { ...prefs.types, [type]: { ...prefs.types[type], enabled: on } },
    })
  }

  // Per-type channel choice. The stored shape is an OVERRIDE of `global`, and a
  // type with no override inherits it - so the first edit has to materialize the
  // currently-resolved set, otherwise flipping one channel off would silently
  // re-pin the other two to today's global values.
  const setTypeChannel = (type: NotifyType, channel: NotifyChannel, on: boolean) => {
    const current = resolveChannels(prefs, type)
    const channels = { ...current, [channel]: on }
    setSetting('notifyPrefs', {
      ...prefs,
      types: { ...prefs.types, [type]: { ...prefs.types[type], channels } },
    })
  }

  // A channel switched off globally can't be turned on for one type - the global
  // row is the master. Say so on the chip instead of hiding it, so "why is this
  // not arriving" stays answerable from this screen.
  const lockedChannels = (type: NotifyType): Partial<Record<NotifyChannel, string>> => {
    const locks: Partial<Record<NotifyChannel, string>> = {}
    if (!prefs.global.inApp) locks.inApp = 'Turn on In app under Delivery first.'
    if (!prefs.global.push) locks.push = 'Turn on Mobile push under Delivery first.'
    if (!prefs.global.email) locks.email = 'Turn on Email under Delivery first.'
    // An invite you cannot see is an invite you cannot accept, which strands
    // both you and whoever sent it. The server floors this on regardless, so the
    // chip must not offer a choice it will not honour.
    if (type === 'clubInvite') locks.inApp = 'Invites always show in the app.'
    return locks
  }

  /** One notification type: its on/off switch plus which channels it uses. */
  const typeRow = (
    type: NotifyType,
    opts: { icon: IconName; title: string; desc: string; last?: boolean; note?: string },
  ) => {
    const enabled = prefs.types[type].enabled
    const channels = { ...resolveChannels(prefs, type) }
    // Mirror the server's floor so the chip shows what will actually happen.
    if (type === 'clubInvite') channels.inApp = true
    return (
      <SettingsRow
        icon={opts.icon}
        title={opts.title}
        desc={opts.desc}
        stacked
        last={opts.last}
        control={<SettingsToggle on={enabled} onChange={(value) => setTypeEnabled(type, value)} />}
      >
        {enabled ? (
          <View style={{ gap: spacing.xs }}>
            <ChannelChips
              options={CHANNEL_OPTIONS}
              selected={{ ...channels }}
              disabled={lockedChannels(type)}
              onToggle={(channel, next) => setTypeChannel(type, channel, next)}
            />
            {opts.note ? (
              <AppText variant="caption" color={colors.textMuted}>
                {opts.note}
              </AppText>
            ) : null}
          </View>
        ) : null}
      </SettingsRow>
    )
  }

  const setRelease = (patch: Partial<typeof release>) => {
    setSetting('notifyPrefs', {
      ...prefs,
      types: { ...prefs.types, release: { ...release, ...patch } },
    })
  }

  return (
    <SettingsPanel>
      <SettingsLabel>Delivery</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon={icons.bell}
          title="In app"
          desc="Show alerts in your HearthShelf notification tray."
          control={
            <SettingsToggle
              on={prefs.global.inApp}
              onChange={(value) => setGlobal('inApp', value)}
            />
          }
        />
        <SettingsRow
          icon={icons.bell}
          title="Mobile push"
          desc="Alert this phone even when HearthShelf is closed."
          control={
            <SettingsToggle on={prefs.global.push} onChange={(value) => setGlobal('push', value)} />
          }
        />
        <SettingsRow
          icon={icons.bell}
          title="Email"
          desc="Send alerts to the email on your server account."
          control={
            <SettingsToggle
              on={prefs.global.email}
              onChange={(value) => setGlobal('email', value)}
            />
          }
          last
        />
      </SettingsGroup>

      <SettingsLabel>Alert me about</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon={icons.bell}
          title="Release alerts"
          desc="Books and series you follow."
          control={
            <SettingsToggle
              on={release.enabled}
              onChange={(value) => setTypeEnabled('release', value)}
            />
          }
        />
        {typeRow('clubInvite', {
          icon: icons.people,
          title: 'Book club invites',
          desc: 'When someone invites you to join their book club.',
          note: 'Invites always appear in the app so you can accept them.',
        })}
        {typeRow('mention', {
          icon: icons.mention,
          title: 'Club mentions',
          desc: 'When someone @mentions you in a book club discussion.',
        })}
        {typeRow('reply', {
          icon: icons.chat,
          title: 'Comment replies',
          desc: 'When someone replies to one of your club comments.',
        })}
        {typeRow('lateNote', {
          icon: icons.chat,
          title: 'Comments on parts you’ve heard',
          desc: 'When someone comments on a spot you already listened past.',
        })}
        {typeRow('reaction', {
          icon: icons.thumbUp,
          title: 'Comment reactions',
          desc: 'When someone reacts to one of your club comments.',
        })}
        {typeRow('rating', {
          icon: icons.star,
          title: 'Rate a finished book',
          desc: 'Ask how it was when you finish a book.',
          last: true,
        })}
      </SettingsGroup>

      {release.enabled ? (
        <>
          <SettingsLabel>Release alerts</SettingsLabel>
          <SettingsGroup>
            <SettingsRow
              title="When it's in your library"
              desc="The moment a followed book is ready to play."
              control={
                <SettingsToggle
                  on={release.availableInLibrary}
                  onChange={(v) => setRelease({ availableInLibrary: v })}
                />
              }
            />
            <SettingsRow
              title="On release day"
              desc="When Audible says it's out, even before it syncs in."
              control={
                <SettingsToggle
                  on={release.onReleaseDate}
                  onChange={(v) => setRelease({ onReleaseDate: v })}
                />
              }
            />
            <SettingsRow
              title="Early reminder"
              desc={
                release.reminderDaysBefore > 0
                  ? `A heads-up ${release.reminderDaysBefore} day${release.reminderDaysBefore === 1 ? '' : 's'} before release.`
                  : 'No early reminder.'
              }
              stacked
              last
            >
              <SettingsSlider
                value={release.reminderDaysBefore}
                min={0}
                max={30}
                onChange={(v) => setRelease({ reminderDaysBefore: v })}
                formatLabel={(v) => (v === 0 ? 'Off' : `${v}d`)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      ) : null}

      {/* Actionable permission row: push is on, but the OS denied it. */}
      {prefs.global.push && !osDenied && pushStatus === 'active' ? (
        <SettingsGroup>
          <SettingsRow
            icon={icons.bell}
            title="Push is active on this device"
            desc="This phone is registered, so alerts can reach you even when HearthShelf is closed."
            last
          />
        </SettingsGroup>
      ) : null}

      {prefs.global.push &&
      !osDenied &&
      (pushStatus === 'unsupported' || pushStatus === 'unconfigured') ? (
        <SettingsGroup>
          <SettingsRow
            icon="notifications-off"
            title="Push isn't available on this device"
            desc="Your phone allows alerts, but this copy of the app can't receive them. Everything still shows up in the app and by email. Reinstalling the latest version from the store usually fixes it."
            danger
            last
          />
        </SettingsGroup>
      ) : null}

      {prefs.global.push && !osDenied && pushStatus === 'server-error' ? (
        <SettingsGroup>
          <SettingsRow
            icon="notifications-off"
            title="Couldn't finish setting up push"
            desc="This phone is ready, but your server didn't accept it. It'll try again next time the app connects."
            danger
            last
          />
        </SettingsGroup>
      ) : null}

      {prefs.global.push && osDenied ? (
        <Pressable onPress={() => void Linking.openSettings()}>
          <SettingsGroup>
            <SettingsRow
              icon="notifications-off"
              title="Turn on notifications for HearthShelf"
              desc="Your phone is blocking alerts, so nothing will buzz. Tap to open system settings."
              danger
              control={
                <View style={{ paddingHorizontal: spacing.md, paddingVertical: 4 }}>
                  <AppText variant="label" color={colors.accent}>
                    Enable
                  </AppText>
                </View>
              }
              last
            />
          </SettingsGroup>
        </Pressable>
      ) : null}

      <SettingsGroup>
        <SettingsRow
          icon={icons.schedule}
          title="Countdown on Home"
          desc={`Show a countdown starting ${prefs.countdownWindowDays} day${prefs.countdownWindowDays === 1 ? '' : 's'} before release.`}
          stacked
          last
        >
          <SettingsSlider
            value={prefs.countdownWindowDays}
            min={1}
            max={30}
            onChange={(v) => setSetting('notifyPrefs', { ...prefs, countdownWindowDays: v })}
            formatLabel={(v) => `${v}d`}
          />
        </SettingsRow>
      </SettingsGroup>

      {!EAS_PROJECT_ID && prefs.global.push ? (
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.md }}
        >
          Push notifications aren't set up on this build yet, so you'll still see the Home countdown
          but won't get a phone alert.
        </AppText>
      ) : null}

      <SettingsLabel>Following</SettingsLabel>
      {!loaded ? (
        <Loading />
      ) : subscriptions.length === 0 ? (
        <SettingsGroup>
          <SettingsRow
            icon="bookmark-add"
            title="Nothing followed yet"
            desc="Follow an upcoming book or a series and we'll tell you the moment it arrives."
          />
          <SettingsRow
            icon="search"
            title="Find upcoming books"
            desc="Search beyond your library for books to follow."
            onPress={() => router.push('/search?from=more')}
            last
          />
        </SettingsGroup>
      ) : (
        <>
          {seriesSubs.length > 0 && (
            <SettingsGroup>
              {seriesSubs.map((sub, i) => (
                <SubRow key={sub.id} sub={sub} last={i === seriesSubs.length - 1} />
              ))}
            </SettingsGroup>
          )}
          {bookSubs.length > 0 && (
            <SettingsGroup>
              {bookSubs.map((sub, i) => (
                <SubRow key={sub.id} sub={sub} last={i === bookSubs.length - 1} />
              ))}
            </SettingsGroup>
          )}
        </>
      )}
    </SettingsPanel>
  )
}

/** One followed book/series: a cover thumbnail, title + status, unfollow button.
 *  A self-contained row (not SettingsRow) so the cover sits inline cleanly. */
function SubRow({ sub, last }: { sub: HSSubscription; last?: boolean }) {
  const colors = useColors()
  const now = Date.now()
  const status =
    sub.kind === 'series'
      ? 'Series · new books tracked automatically'
      : sub.available
        ? 'Available now'
        : (countdownLabel(sub, now) ?? 'Coming soon')
  // Prefer the Audible cover stored on the sub; once a book is owned, fall back
  // to the ABS cover keyed by its (matched) item id if we ever store one.
  const cover = sub.coverArtUrl
  const subtitle = sub.kind === 'book' && sub.author ? `${sub.author} · ${status}` : status

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm + 2,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.hairline,
      }}
    >
      <Cover
        uri={cover}
        size={44}
        radius={6}
        fallback={{
          hue: coverHue(sub.asin ?? sub.seriesAsin ?? sub.id),
          initial: sub.title.charAt(0).toUpperCase(),
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="body" numberOfLines={1}>
          {sub.title}
        </AppText>
        <AppText
          variant="caption"
          color={colors.textMuted}
          numberOfLines={1}
          style={{ marginTop: 2 }}
        >
          {subtitle}
        </AppText>
      </View>
      <IconButton
        name={icons.close}
        size={20}
        color={colors.textMuted}
        onPress={() => void unsubscribe(sub.id).catch(() => {})}
      />
    </View>
  )
}
