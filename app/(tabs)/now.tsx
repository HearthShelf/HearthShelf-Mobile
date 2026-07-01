/**
 * Now Playing tab. Placeholder until the docked player surface lands (plan
 * section 6): if something is playing it points into the full player, otherwise
 * it shows a calm empty state. Kept minimal so the 5-tab nav is wired without
 * pretending the final player UI exists here yet.
 */
import { useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
import { AppText, Centered, PrimaryButton, Screen, icons } from '@/ui/primitives'
import { colors, spacing } from '@/ui/theme'
import { getState, subscribe } from '@/player/store'

export default function NowPlayingTab() {
  const router = useRouter()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)

  if (!nowPlaying) {
    return (
      <Screen>
        <Centered>
          <AppText variant="title">Nothing playing</AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            Start a book from your library and it will show up here.
          </AppText>
        </Centered>
      </Screen>
    )
  }

  return (
    <Screen>
      <Centered>
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <AppText variant="caption" color={colors.accent}>
            NOW PLAYING
          </AppText>
          <AppText variant="title" numberOfLines={2} style={{ textAlign: 'center' }}>
            {nowPlaying.title}
          </AppText>
          <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
            {nowPlaying.author}
          </AppText>
        </View>
        <PrimaryButton label="Open player" icon={icons.play} onPress={() => router.push('/player')} />
      </Centered>
    </Screen>
  )
}
