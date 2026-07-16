/**
 * Reading panel: the ebook reader's display preferences, bound live to the
 * shared readerPrefs store so changing a value here changes the reader (and the
 * reader's in-book settings panel writes the same store). Device-local, not
 * synced (the reader is a HearthShelf feature ABS knows nothing about).
 */
import { useSyncExternalStore } from 'react'
import {
  READER_SIZE_MIN,
  READER_SIZE_MAX,
  type ReaderTheme,
  type ReaderFont,
  type ReaderLh,
  type ReaderWidth,
  type ReaderAlign,
  type ReaderLayout,
} from '@hearthshelf/core'
import {
  getReaderPrefs,
  setReaderPref,
  subscribeReaderPrefs,
} from '@/reader/readerPrefs'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  Seg,
  SettingsSlider,
} from '@/ui/settingsControls'

export default function ReadingPanel() {
  const p = useSyncExternalStore(subscribeReaderPrefs, getReaderPrefs)

  return (
    <SettingsPanel>
      <SettingsLabel>Page</SettingsLabel>
      <SettingsGroup>
        <SettingsRow title="Reader theme" desc="Page colors while you read." stacked>
          <Seg<ReaderTheme>
            value={p.theme}
            onChange={(v) => setReaderPref('theme', v)}
            fill
            options={[
              { value: 'light', label: 'Light' },
              { value: 'sepia', label: 'Sepia' },
              { value: 'paper', label: 'Paper' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Layout" desc="Scroll continuously, or turn pages." stacked last>
          <Seg<ReaderLayout>
            value={p.layout}
            onChange={(v) => setReaderPref('layout', v)}
            fill
            options={[
              { value: 'scroll', label: 'Scroll' },
              { value: 'paged', label: 'Paged' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Text</SettingsLabel>
      <SettingsGroup>
        <SettingsRow title="Typeface" desc="The font the body text is set in." stacked>
          <Seg<ReaderFont>
            value={p.font}
            onChange={(v) => setReaderPref('font', v)}
            fill
            options={[
              { value: 'serif', label: 'Serif' },
              { value: 'sans', label: 'Sans' },
              { value: 'dyslexic', label: 'Dyslexic' },
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Text size" desc="How large the body text is set." stacked>
          <SettingsSlider
            value={p.size}
            min={READER_SIZE_MIN}
            max={READER_SIZE_MAX}
            step={1}
            onChange={(v) => setReaderPref('size', v)}
            formatLabel={(v) => `${v}px`}
          />
        </SettingsRow>
        <SettingsRow title="Line spacing" desc="Breathing room between lines." stacked>
          <Seg<ReaderLh>
            value={p.lh}
            onChange={(v) => setReaderPref('lh', v)}
            fill
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'normal', label: 'Normal' },
              { value: 'relaxed', label: 'Relaxed' },
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Page width" desc="How wide the column of text runs." stacked>
          <Seg<ReaderWidth>
            value={p.width}
            onChange={(v) => setReaderPref('width', v)}
            fill
            options={[
              { value: 'narrow', label: 'Narrow' },
              { value: 'medium', label: 'Medium' },
              { value: 'wide', label: 'Wide' },
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Justify text" desc="Align both edges, like a printed book." stacked last>
          <Seg<ReaderAlign>
            value={p.align}
            onChange={(v) => setReaderPref('align', v)}
            fill
            options={[
              { value: 'left', label: 'Ragged' },
              { value: 'justify', label: 'Justified' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPanel>
  )
}
