import { useEffect, useMemo, useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { AppText } from '@/ui/primitives'
import { spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { getLibraries } from '@/api/abs'
import { importRows, matchRows, type ImportRow, type MatchRow } from '@/api/finishedBooks'
import { isReadRow, parseGoodreadsCsvText, type GoodreadsRow } from '@/lib/goodreadsCsv'

interface ReviewRow extends GoodreadsRow {
  status: MatchRow['status']
  candidates: MatchRow['candidates']
  resolvedLibraryItemId: string | null
  resolved: boolean
}

export default function ImportGoodreadsScreen() {
  const colors = useColors()
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const [csv, setCsv] = useState('')
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    getLibraries()
      .then((libs) => setLibraryId(libs.find((l) => l.mediaType === 'book')?.id ?? libs[0]?.id ?? null))
      .catch(() => setLibraryId(null))
  }, [])

  const unresolved = useMemo(() => rows?.filter((r) => !r.resolved).length ?? 0, [rows])

  async function parseAndMatch() {
    setBusy(true)
    setMessage(null)
    setRows(null)
    try {
      if (!libraryId) throw new Error('No library selected')
      const readRows = parseGoodreadsCsvText(csv).filter(isReadRow)
      const { matches } = await matchRows(
        libraryId,
        readRows.map((r) => ({ title: r.title, author: r.author, isbn: r.isbn ?? r.isbn13 })),
      )
      setRows(
        readRows.map((r, i) => {
          const m = matches[i]
          const auto = m.status === 'auto' ? (m.candidates[0]?.libraryItemId ?? null) : null
          return {
            ...r,
            status: m.status,
            candidates: m.candidates,
            resolvedLibraryItemId: auto,
            resolved: m.status !== 'ambiguous',
          }
        }),
      )
      setMessage(`Found ${readRows.length} read book${readRows.length === 1 ? '' : 's'}.`)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not parse that CSV')
    } finally {
      setBusy(false)
    }
  }

  function resolveRow(index: number, libraryItemId: string | null) {
    setRows((cur) =>
      cur?.map((r, i) =>
        i === index ? { ...r, resolvedLibraryItemId: libraryItemId, resolved: true } : r,
      ) ?? null,
    )
  }

  function saveUnresolvedAsHistoryOnly() {
    setRows((cur) =>
      cur?.map((r) => (!r.resolved ? { ...r, resolvedLibraryItemId: null, resolved: true } : r)) ??
      null,
    )
  }

  async function commit() {
    if (!rows || unresolved > 0) return
    setBusy(true)
    setMessage(null)
    try {
      const payload: ImportRow[] = rows.map((r) => ({
        title: r.title,
        author: r.author || null,
        isbn: r.isbn ?? r.isbn13,
        dateFinished: r.dateFinished,
        rating: r.rating,
        libraryItemId: r.resolvedLibraryItemId,
      }))
      const result = await importRows(payload)
      setRows(null)
      setCsv('')
      setMessage(`Imported ${result.inserted + result.updated} books`)
    } catch {
      setMessage('Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsPanel>
      {!rows ? (
        <>
          <SettingsLabel>Goodreads CSV</SettingsLabel>
          <SettingsGroup>
            <View style={{ padding: spacing.lg, gap: spacing.md }}>
              <AppText variant="caption" color={colors.textMuted}>
                Paste the contents of your Goodreads export CSV. Only rows on the read shelf are imported.
              </AppText>
              <TextInput
                value={csv}
                onChangeText={setCsv}
                multiline
                placeholder="Title,Author,ISBN,ISBN13,My Rating,Date Read,Exclusive Shelf..."
                placeholderTextColor={colors.textFaint}
                style={{
                  minHeight: 180,
                  color: colors.text,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 10,
                  padding: spacing.sm,
                  textAlignVertical: 'top',
                }}
              />
              <Pressable onPress={() => void parseAndMatch()} disabled={busy || !csv.trim()}>
                <AppText variant="label" color={colors.accent}>
                  {busy ? 'Matching...' : 'Review import'}
                </AppText>
              </Pressable>
            </View>
          </SettingsGroup>
        </>
      ) : (
        <>
          <SettingsLabel>Review</SettingsLabel>
          <SettingsGroup>
            {rows.map((r, i) => (
              <SettingsRow
                key={`${r.title}-${i}`}
                title={r.title}
                desc={`${r.author}${r.dateFinished ? ` - read ${r.dateFinished}` : ''}`}
                last={i === rows.length - 1}
                control={
                  r.status === 'ambiguous' && !r.resolved ? (
                    <Pressable onPress={() => resolveRow(i, r.candidates[0]?.libraryItemId ?? null)}>
                      <AppText variant="caption" color={colors.accent}>
                        Use best match
                      </AppText>
                    </Pressable>
                  ) : (
                    <AppText variant="caption" color={colors.textMuted}>
                      {r.resolvedLibraryItemId ? 'Matched' : 'History only'}
                    </AppText>
                  )
                }
              />
            ))}
          </SettingsGroup>
          {unresolved > 0 ? (
            <Pressable onPress={saveUnresolvedAsHistoryOnly}>
              <AppText variant="label" color={colors.accent}>
                Save unresolved as history only
              </AppText>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void commit()} disabled={busy || unresolved > 0}>
            <AppText variant="label" color={colors.accent}>
              {busy ? 'Importing...' : 'Confirm import'}
            </AppText>
          </Pressable>
        </>
      )}
      {message ? (
        <AppText variant="caption" color={colors.textMuted} style={{ paddingHorizontal: spacing.xs }}>
          {message}
        </AppText>
      ) : null}
    </SettingsPanel>
  )
}
