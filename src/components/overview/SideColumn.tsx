import type { ReactNode } from 'react'
import { OVERVIEW_RAIL_WIDTH, type OverviewSide } from '../../lib/overviewLayout'
import '../../styles/fit.css'

type SideColumnProps = {
  side: OverviewSide
  /** Column name: shown as the vertical rail label while collapsed. */
  label: string
  expanded: boolean
  onToggle: () => void
  /** Capture mode: the toggle is hidden (`data-capture-hide`) and the
   *  column is expanded by the page regardless of the stored state. */
  capture?: boolean
  children: ReactNode
}

/** A side column of the overview grid. The column is itself a grid of two
 *  tracks: the content box and a 22px handle track on the inner edge
 *  (towards the globe) that holds the toggle, so the toggle never sits over
 *  content or the globe's controls. Collapsed, the column is a 44px rail:
 *  the vertical label in the top row, the handle in the row below it. The
 *  toggle is a button (keyboard reachable) with `aria-expanded` and
 *  `aria-controls`; its focus ring is drawn inset so nothing clips it. */
export function SideColumn({
  side,
  label,
  expanded,
  onToggle,
  capture = false,
  children,
}: SideColumnProps) {
  const bodyId = `overview-${side}-column`
  return (
    <aside
      className={[
        'side-column',
        `side-column--${side}`,
        expanded ? 'side-column--expanded' : 'side-column--collapsed',
      ].join(' ')}
      aria-label={label}
      data-testid={`side-column-${side}`}
      data-expanded={expanded ? 'true' : 'false'}
      style={{ ['--rail-w' as string]: `${OVERVIEW_RAIL_WIDTH}px` }}
    >
      <div id={bodyId} className="side-column__body" data-testid={`side-body-${side}`} hidden={!expanded}>
        {children}
      </div>
      <span className="side-column__rail-label" aria-hidden="true" hidden={expanded}>
        {label}
      </span>
      <button
        type="button"
        className="side-column__toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
        title={expanded ? `Collapse ${label}` : `Expand ${label}`}
        onClick={onToggle}
        data-capture-hide
        data-testid={`side-toggle-${side}`}
        disabled={capture}
      >
        <span className="side-column__chevron" aria-hidden="true" />
      </button>
    </aside>
  )
}
