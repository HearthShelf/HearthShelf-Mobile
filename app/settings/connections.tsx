/**
 * Connections panel. Mirrors the self-hosted app's Connections section (Hardcover
 * personal-token sync + admin-managed integrations note). No per-user token UI on
 * mobile yet - shown as an honest note, not a fake connect button.
 */
import { SettingsPanel, SettingsGroup, SettingsRow } from '@/ui/settingsControls'

export default function ConnectionsPanel() {
  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRow
          icon="link"
          title="Hardcover"
          desc="Sync finished books to your Hardcover reading history. Connect this from the self-hosted app for now - mobile support is coming."
        />
        <SettingsRow
          icon="hub"
          title="External book links"
          desc="Goodreads, Audible, and Hardcover search links are managed by your server admin."
          last
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}
