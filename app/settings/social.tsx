/**
 * Social panel: what other people can see about you, and how noisy the app's
 * community features are on this device.
 *
 * - Listening now (account): tri-state. "Follow default" means you never chose,
 *   so the server's community default (which ships OFF for presence) decides.
 *   "Share" / "Hide" are your explicit choice and always win.
 * - Note pops (device): whether crossing a Book Club note shows a toast here.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { getCommunityConfig } from '@/api/social'
import { setCarNotePopsEnabled } from '@/social/carNotePrefs'
import { SettingsPanel, SettingsGroup, SettingsLabel, SettingsRow, Seg, SettingsToggle } from '@/ui/settingsControls'

/** The tri-state presence choice as a segment value. 'default' = null (unset). */
type ShareChoice = 'default' | 'share' | 'hide'

function choiceFromValue(v: boolean | null): ShareChoice {
  if (v === true) return 'share'
  if (v === false) return 'hide'
  return 'default'
}
function valueFromChoice(c: ShareChoice): boolean | null {
  if (c === 'share') return true
  if (c === 'hide') return false
  return null
}

export default function SocialPanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const [defaultShareListening, setDefaultShareListening] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    getCommunityConfig()
      .then((c) => {
        if (!cancelled) setDefaultShareListening(c.defaultShareListening)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const choice = choiceFromValue(s.shareCurrentlyListening)
  const readChoice = choiceFromValue(s.shareReadBooks)
  // Copy for the "Follow default" state names what that default currently is.
  const defaultLabel =
    defaultShareListening == null
      ? 'Follows the server default.'
      : defaultShareListening
        ? 'The server shares this by default.'
        : 'The server keeps this private by default.'
  const desc =
    choice === 'default'
      ? `Let others see when you're listening to a book. ${defaultLabel}`
      : choice === 'share'
        ? "Others can see when you're listening to a book, on that book's page."
        : "Nobody sees when you're listening."

  return (
    <SettingsPanel>
      <SettingsLabel>People</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="Reading list"
          desc={
            readChoice === 'default'
              ? 'Appear on server reading lists using the server default until you choose.'
              : readChoice === 'share'
                ? 'Other listeners can see your finished reading history on shared server surfaces.'
                : 'Your finished reading history stays hidden from shared server surfaces.'
          }
          stacked
        >
          <Seg
            value={readChoice}
            onChange={(c) => setSetting('shareReadBooks', valueFromChoice(c))}
            fill
            options={[
              { value: 'default', label: 'Default' },
              { value: 'share', label: 'Share' },
              { value: 'hide', label: 'Hide' },
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Listening now" desc={desc} stacked last>
          <Seg
            value={choice}
            onChange={(c) => setSetting('shareCurrentlyListening', valueFromChoice(c))}
            fill
            options={[
              { value: 'default', label: 'Default' },
              { value: 'share', label: 'Share' },
              { value: 'hide', label: 'Hide' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Book Club</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="Note pops"
          desc="Alert you when your playback reaches a club note - a toast in the app, a notification when it's in the background or in the car. This device only."
          control={
            <SettingsToggle
              on={s.notePops}
              onChange={(v) => {
                setSetting('notePops', v)
                // Mirror the master on/off to the native car service so car-side
                // note pops honor it too (see src/social/carNotePrefs.ts).
                setCarNotePopsEnabled(v)
              }}
            />
          }
          last
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}
