/**
 * Goodreads import sheet. Launched from the Integrations panel (its own card, a
 * sibling of Hardcover). Replaces the old app/settings/import-goodreads route -
 * the whole pick -> match -> review -> confirm flow now lives in a bottom sheet,
 * matching the web app's GoodreadsImportDialog.
 *
 * Only rows on the Goodreads "read" shelf are imported. Matched rows link to a
 * library item; unmatched rows can be saved as history only.
 */
import { forwardRef, useEffect, useMemo, useState } from 'react'
import { StyleSheet } from 'react-native'
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { AppText, PrimaryButton, Sheet, Touchable } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { SettingsGroup, SettingsRow } from '@/ui/settingsControls'
import { getLibraries } from '@/api/abs'
import { importRows, matchRows, type ImportRow, type MatchRow } from '@/api/finishedBooks'
import { isReadRow, parseGoodreadsCsvText, type GoodreadsRow } from '@/lib/goodreadsCsv'

interface ReviewRow extends GoodreadsRow {
  status: MatchRow['status']
  candidates: MatchRow['candidates']
  resolvedLibraryItemId: string | null
  resolved: boolean
}

export const GoodreadsImportSheet = forwardRef<BottomSheetModal, { onDismiss?: () => void }>(
  function GoodreadsImportSheet({ onDismiss }, ref) {
    const colors = useColors()
    const styles = useMemo(() => makeStyles(colors), [colors])
    const [libraryId, setLibraryId] = useState<string | null>(null)
    const [csv, setCsv] = useState('')
    const [fileName, setFileName] = useState<string | null>(null)
    const [rows, setRows] = useState<ReviewRow[] | null>(null)
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)

    useEffect(() => {
      getLibraries()
        .then((libs) =>
          setLibraryId(libs.find((l) => l.mediaType === 'book')?.id ?? libs[0]?.id ?? null),
        )
        .catch(() => setLibraryId(null))
    }, [])

    const unresolved = useMemo(() => rows?.filter((r) => !r.resolved).length ?? 0, [rows])

    // Wipe the flow back to step one so reopening the sheet is a clean slate.
    function reset() {
      setCsv('')
      setFileName(null)
      setRows(null)
      setBusy(false)
      setMessage(null)
    }

    async function pickFile() {
      setMessage(null)
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel'],
        copyToCacheDirectory: true,
      })
      if (result.canceled) return
      const asset = result.assets[0]
      if (!asset) return
      try {
        const text = await new File(asset.uri).text()
        setCsv(text)
        setFileName(asset.name)
      } catch {
        setMessage('Could not read that file')
      }
    }

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

    function resolveRow(index: number, itemId: string | null) {
      setRows(
        (cur) =>
          cur?.map((r, i) =>
            i === index ? { ...r, resolvedLibraryItemId: itemId, resolved: true } : r,
          ) ?? null,
      )
    }

    function saveUnresolvedAsHistoryOnly() {
      setRows(
        (cur) =>
          cur?.map((r) =>
            !r.resolved ? { ...r, resolvedLibraryItemId: null, resolved: true } : r,
          ) ?? null,
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
        reset()
        setMessage(`Imported ${result.inserted + result.updated} books`)
      } catch {
        setMessage('Import failed')
      } finally {
        setBusy(false)
      }
    }

    return (
      <Sheet
        ref={ref}
        kicker="Goodreads"
        title="Import from Goodreads"
        snapPoints={['80%']}
        onDismiss={() => {
          reset()
          onDismiss?.()
        }}
      >
        <BottomSheetScrollView contentContainerStyle={styles.body}>
          {!rows ? (
            <>
              <AppText variant="meta" color={colors.textMuted}>
                Export your library from Goodreads, then upload the CSV here. Only books marked read
                are imported.
              </AppText>
              <Touchable onPress={() => void pickFile()} style={styles.fileBtn}>
                <AppText variant="label" color={fileName ? colors.text : colors.accent}>
                  {fileName ?? 'Choose CSV file'}
                </AppText>
              </Touchable>
              <PrimaryButton
                label={busy ? 'Matching...' : 'Review import'}
                onPress={busy || !csv.trim() ? undefined : () => void parseAndMatch()}
              />
            </>
          ) : (
            <>
              <SettingsGroup>
                {rows.map((r, i) => (
                  <SettingsRow
                    key={`${r.title}-${i}`}
                    title={r.title}
                    desc={`${r.author}${r.dateFinished ? ` - read ${r.dateFinished}` : ''}`}
                    last={i === rows.length - 1}
                    control={
                      r.status === 'ambiguous' && !r.resolved ? (
                        <Touchable
                          onPress={() => resolveRow(i, r.candidates[0]?.libraryItemId ?? null)}
                        >
                          <AppText variant="caption" color={colors.accent}>
                            Use best match
                          </AppText>
                        </Touchable>
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
                <Touchable onPress={saveUnresolvedAsHistoryOnly} style={styles.ghostBtn}>
                  <AppText variant="label" color={colors.accent}>
                    Save unresolved as history only
                  </AppText>
                </Touchable>
              ) : null}
              <PrimaryButton
                label={busy ? 'Importing...' : 'Confirm & import'}
                onPress={busy || unresolved > 0 ? undefined : () => void commit()}
              />
            </>
          )}
          {message ? (
            <AppText variant="caption" color={colors.textMuted} style={{ paddingHorizontal: spacing.xs }}>
              {message}
            </AppText>
          ) : null}
        </BottomSheetScrollView>
      </Sheet>
    )
  },
)

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    body: { gap: spacing.md, paddingBottom: spacing.xxl },
    fileBtn: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.card,
      padding: spacing.md,
      alignItems: 'center',
    },
    ghostBtn: { alignItems: 'center', paddingVertical: spacing.sm },
  })
