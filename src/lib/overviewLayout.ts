// Persisted collapse state of the overview's two side columns. Each column
// remembers its own state in localStorage (default expanded); storage that
// is missing, full or disabled never throws through to the page. Capture
// mode (the fixed 1920x1080 layout) forces both expanded and hides the
// toggles, see Brigade.tsx and CAPTURE_HIDES.
import { useCallback, useState } from 'react'

export type OverviewSide = 'left' | 'right'

export const OVERVIEW_LAYOUT_KEYS: Record<OverviewSide, string> = {
  left: 'megalith-overview-left',
  right: 'megalith-overview-right',
}

/** The viewport width under which the grid becomes one column and the
 *  columns cannot collapse. Mirrors the `@media (max-width: 1099px)` rule. */
export const OVERVIEW_ONE_COLUMN_MAX_WIDTH = 1099

/** Rail width of a collapsed column, in px. */
export const OVERVIEW_RAIL_WIDTH = 44

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** True (expanded) unless the stored value is exactly `collapsed`. */
export function readColumnExpanded(
  side: OverviewSide,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return true
  try {
    return storage.getItem(OVERVIEW_LAYOUT_KEYS[side]) !== 'collapsed'
  } catch {
    return true
  }
}

export function writeColumnExpanded(
  side: OverviewSide,
  expanded: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(OVERVIEW_LAYOUT_KEYS[side], expanded ? 'expanded' : 'collapsed')
  } catch {
    // Storage disabled or full: the state lives for this page only.
  }
}

/** One column's expanded flag, read from storage once and written on every
 *  change. `forceExpanded` (capture mode) overrides the stored value without
 *  touching it, so leaving capture mode restores the operator's choice. */
export function useColumnExpanded(
  side: OverviewSide,
  forceExpanded = false,
): [boolean, () => void] {
  const [stored, setStored] = useState(() => readColumnExpanded(side))
  const toggle = useCallback(() => {
    setStored((current) => {
      const next = !current
      writeColumnExpanded(side, next)
      return next
    })
  }, [side])
  return [forceExpanded || stored, toggle]
}
