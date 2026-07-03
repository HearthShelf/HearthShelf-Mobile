/**
 * Multi-select state for a set of books, shared by the Library Books view and
 * the Series detail page so long-press-to-select behaves the same everywhere.
 *
 * A long-press on any book enters select mode and selects that book; further
 * taps toggle. Clearing (or emptying) the selection exits select mode. Mirrors
 * the WebApp's `selected`/`selectMode`/`toggleSel`/`selectAll`/`clearSel` set.
 */
import { useCallback, useMemo, useState } from 'react'
import { haptics } from './haptics'

export interface BookSelection {
  /** True once a long-press has entered select mode (checkboxes visible). */
  selecting: boolean
  selected: Set<string>
  count: number
  isSelected: (id: string) => boolean
  /** Enter select mode (via long-press) and select this book. */
  begin: (id: string) => void
  toggle: (id: string) => void
  selectAll: (ids: string[]) => void
  clear: () => void
}

export function useBookSelection(): BookSelection {
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // Emptying the selection by tapping leaves select mode.
      if (next.size === 0) setSelecting(false)
      return next
    })
  }, [])

  const begin = useCallback((id: string) => {
    haptics.longPress()
    setSelecting(true)
    setSelected((s) => {
      const next = new Set(s)
      next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback((ids: string[]) => {
    setSelecting(true)
    setSelected(new Set(ids))
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set())
    setSelecting(false)
  }, [])

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  return useMemo(
    () => ({
      selecting,
      selected,
      count: selected.size,
      isSelected,
      begin,
      toggle,
      selectAll,
      clear,
    }),
    [selecting, selected, isSelected, begin, toggle, selectAll, clear],
  )
}
