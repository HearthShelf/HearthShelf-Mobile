/** Library settings: display, scanning, and when a book counts as finished. */
import { PODCAST_REGIONS, type LibraryDraftSettings } from '@hearthshelf/core'
import { AdminField } from '@/admin/AdminField'
import {
  libraryDraftProblems,
  patchLibrarySettings,
  type LibraryDraftState,
} from '@/admin/LibraryDraft'
import { LibraryDraftScreen } from '@/admin/LibraryDraftScreen'
import { LibraryPicker, withCurrentOption } from '@/admin/LibraryPicker'
import {
  Seg,
  SettingsGroup,
  SettingsLabel,
  SettingsPanel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'

type ToggleKey = {
  [K in keyof LibraryDraftSettings]: LibraryDraftSettings[K] extends boolean ? K : never
}[keyof LibraryDraftSettings]

const SHARED_TOGGLES: { key: ToggleKey; title: string; desc?: string }[] = [
  { key: 'squareCovers', title: 'Square covers', desc: 'Show covers as squares, not book shape.' },
  { key: 'enableWatcher', title: 'Watch for new files', desc: 'Scan new files as they arrive.' },
]

const BOOK_TOGGLES: { key: ToggleKey; title: string; desc?: string }[] = [
  { key: 'audiobooksOnly', title: 'Audiobooks only', desc: 'Skip ebook files when scanning.' },
  { key: 'skipAsin', title: 'Skip matching books with an ASIN' },
  { key: 'skipIsbn', title: 'Skip matching books with an ISBN' },
  {
    key: 'hideSingleBookSeries',
    title: 'Hide single book series',
    desc: "Don't show series with only one book.",
  },
  {
    key: 'onlyLaterBooks',
    title: 'Only later books in Continue Series',
    desc: "Skip books before the furthest one you've read.",
  },
  {
    key: 'epubsScripted',
    title: 'Allow scripts in EPUBs',
    desc: 'Lets ebooks run code in the reader. Less safe.',
  },
]

export default function LibrarySettingsScreen() {
  return <LibraryDraftScreen>{(state) => <Settings state={state} />}</LibraryDraftScreen>
}

function Settings({ state }: { state: LibraryDraftState }) {
  const isBook = state.library.mediaType === 'book'
  const settings = state.draft.settings
  const toggles = isBook ? [...SHARED_TOGGLES, ...BOOK_TOGGLES] : SHARED_TOGGLES
  const percent = settings.markAsFinishedWhen === 'percentComplete'

  return (
    <SettingsPanel>
      <SettingsGroup>
        {toggles.map((toggle, i) => (
          <SettingsRow
            key={toggle.key}
            title={toggle.title}
            desc={toggle.desc}
            last={isBook && i === toggles.length - 1}
            control={
              <SettingsToggle
                on={settings[toggle.key]}
                onChange={(on) => patchLibrarySettings({ [toggle.key]: on })}
              />
            }
          />
        ))}
        {isBook ? null : (
          <LibraryPicker
            title="Podcast search region"
            value={settings.podcastSearchRegion}
            options={withCurrentOption(
              PODCAST_REGIONS.map((r) => ({ value: r, label: r.toUpperCase() })),
              settings.podcastSearchRegion,
            )}
            onChange={(podcastSearchRegion) => patchLibrarySettings({ podcastSearchRegion })}
            last
          />
        )}
      </SettingsGroup>

      <SettingsLabel>Mark as finished</SettingsLabel>
      <Seg
        fill
        label="Mark as finished when"
        value={settings.markAsFinishedWhen}
        onChange={(markAsFinishedWhen) => patchLibrarySettings({ markAsFinishedWhen })}
        options={[
          { value: 'timeRemaining', label: 'Time left' },
          { value: 'percentComplete', label: 'Percent done' },
        ]}
      />
      <AdminField
        label={percent ? 'Percent done' : 'Seconds left'}
        hint={
          percent
            ? 'A book counts as finished once this much has been played.'
            : 'A book counts as finished with this much left to play.'
        }
        error={libraryDraftProblems(state).settings}
        keyboardType="number-pad"
        value={settings.markAsFinishedValue}
        onChangeText={(value) =>
          patchLibrarySettings({ markAsFinishedValue: value.replace(/[^0-9]/g, '') })
        }
      />
    </SettingsPanel>
  )
}
