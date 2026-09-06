/**
 * Playback panel: speed, skip amounts, progress bar, player background and
 * artwork, the player-button editor link, finishing rules, and the up-next
 * queue behaviour.
 *
 * The rows themselves live in PlayerSettingsContent, which the in-player
 * More > Player settings sheet renders too, so the two surfaces always offer
 * the same controls. This screen only supplies the scroll container.
 */
import { useRouter } from 'expo-router'
import { SettingsPanel } from '@/ui/settingsControls'
import { PlayerSettingsContent } from '@/player/PlayerSettingsContent'

export default function PlaybackPanel() {
  const router = useRouter()
  return (
    <SettingsPanel>
      <PlayerSettingsContent onNavigate={(href) => router.push(href)} />
    </SettingsPanel>
  )
}
