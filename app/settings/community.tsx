/**
 * Community panel: what other people can see about you, and how noisy the app's
 * community features are on this device. (Renamed from the old "Social" panel.)
 *
 * - Reading list / Listening now (account): Share/Hide only. Until the user
 *   picks explicitly, the row shows and stores the server's community default
 *   (which ships ON for reading list, OFF for presence).
 * - Book Club: master on/off, player shortcut, and note pops (device).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { getCommunityConfig } from '@/api/social'
import { setCarNotePopsEnabled } from '@/social/carNotePrefs'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  Seg,
  SettingsToggle,
} from '@/ui/settingsControls'

type ShareChoice = 'share' | 'hide'

function choiceFromValue(v: boolean | null, fallback: boolean): ShareChoice {
  const resolved = v ?? fallback
  return resolved ? 'share' : 'hide'
}
function valueFromChoice(c: ShareChoice): boolean {
  return c === 'share'
}

export default function CommunityPanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const [defaultShare, setDefaultShare] = useState(true)
  const [defaultShareListening, setDefaultShareListening] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCommunityConfig()
      .then((c) => {
        if (!cancelled) {
          setDefaultShare(c.defaultShare)
          setDefaultShareListening(c.defaultShareListening)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const choice = choiceFromValue(s.shareCurrentlyListening, defaultShareListening)
  const readChoice = choiceFromValue(s.shareReadBooks, defaultShare)
  const desc =
    choice === 'share'
      ? "Others can see when you're listening to a book, on that book's page."
      : "Nobody sees when you're listening."

  return (
    <SettingsPanel>
      <SettingsLabel>Sharing</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="Reading list"
          desc={
            readChoice === 'share'
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
              { value: 'share', label: 'Share' },
              { value: 'hide', label: 'Hide' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Book Club</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title="Enable book clubs"
          desc="Read along with others, share notes, and race your progress. Turn off to hide book clubs everywhere in the app."
          control={
            <SettingsToggle on={s.clubsEnabled} onChange={(v) => setSetting('clubsEnabled', v)} />
          }
        />
        {s.clubsEnabled ? (
          <>
            <SettingsRow
              title="Club button on player"
              desc="Show a shortcut on the player to open the club when you're listening to a club's current book."
              control={
                <SettingsToggle
                  on={s.clubPlayerButton}
                  onChange={(v) => setSetting('clubPlayerButton', v)}
                />
              }
            />
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
          </>
        ) : null}
      </SettingsGroup>
    </SettingsPanel>
  )
}
