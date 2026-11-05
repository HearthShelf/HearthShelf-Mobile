/** A typed server folder with a check. Screens must not accept a path until the
 *  server has found it: the server creates a missing folder without complaint, so
 *  a typo would become an empty folder. */
import { useCallback, useRef, useState } from 'react'
import { View } from 'react-native'
import { checkLibraryFolder, type LibraryFolderCheck } from '@/api/admin/libraries'
import { spacing } from '@/ui/theme'
import { AdminButton } from './AdminButton'
import { AdminField } from './AdminField'

export type LibraryPathState = 'idle' | 'checking' | LibraryFolderCheck

export function useLibraryPathCheck() {
  const [state, setState] = useState<LibraryPathState>('idle')
  const latest = useRef(0)

  const reset = useCallback(() => {
    latest.current++
    setState('idle')
  }, [])

  const check = useCallback(async (path: string): Promise<LibraryPathState> => {
    const id = ++latest.current
    setState('checking')
    const result = await checkLibraryFolder(path)
    // The path changed while this was in flight, so the answer is about another path.
    if (id !== latest.current) return 'idle'
    setState(result)
    return result
  }, [])

  return { state, check, reset }
}

export function LibraryPathField({
  value,
  onChangeText,
  state,
  onSubmit,
  onBlur,
  label = 'Folder',
  actionLabel = 'Check',
  problem,
}: {
  value: string
  onChangeText: (value: string) => void
  state: LibraryPathState
  onSubmit: () => void
  onBlur?: () => void
  label?: string
  actionLabel?: string
  /** A reason from the screen, such as the path already being in the library. */
  problem?: string
}) {
  const error =
    problem ??
    (state === 'missing'
      ? 'Folder not found on the server. Use a full path, like /audiobooks.'
      : state === 'unknown'
        ? "We couldn't check this folder. Try again."
        : undefined)
  return (
    <View style={{ gap: spacing.sm }}>
      <AdminField
        label={label}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        onSubmitEditing={onSubmit}
        placeholder="/audiobooks"
        returnKeyType="done"
        error={error}
        hint={
          state === 'exists'
            ? 'Folder found on the server.'
            : 'The full path as the server sees it.'
        }
      />
      <AdminButton
        label={actionLabel}
        kind="secondary"
        icon="search"
        onPress={onSubmit}
        disabled={!value.trim()}
        busy={state === 'checking'}
      />
    </View>
  )
}
