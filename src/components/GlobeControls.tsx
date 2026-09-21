import '../styles/globe-controls.css'

export type GlobeControlsProps = {
  /** The camera is tracking a spacecraft. */
  following: boolean
  /** Follow has a target: a spacecraft is selected or pinned, or only one is loaded. */
  canFollow: boolean
  /** Display name of the spacecraft Follow would track (`SIM-01`), for the tooltip. */
  followTarget?: string | null
  onZoomIn: () => void
  onZoomOut: () => void
  onResetView: () => void
  onToggleFollow: () => void
}

/** The globe's camera controls, the cluster the module's dashboard and the original
 *  CANOPY map carry: zoom in and out, reset to the stream's home framing, and
 *  follow the selected spacecraft. While following the button reads "Stop
 *  following" and Esc does the same. Pure: the viewer work is the parent's;
 *  the tooltips name the keys. */
export function GlobeControls({
  following,
  canFollow,
  followTarget = null,
  onZoomIn,
  onZoomOut,
  onResetView,
  onToggleFollow,
}: GlobeControlsProps) {
  const followTitle = following
    ? 'Stop following (Esc)'
    : followTarget
      ? `Follow ${followTarget}: the camera tracks it (or double-click it on the globe)`
      : canFollow
        ? 'Follow the spacecraft: the camera tracks it (or double-click it on the globe)'
        : 'Pin or select a spacecraft to follow it'

  return (
    <div
      className="globe-controls"
      role="toolbar"
      aria-label="Globe controls"
      data-testid="globe-controls"
      data-following={following ? 'true' : 'false'}
    >
      <button
        type="button"
        className="globe-controls__btn"
        onClick={onZoomIn}
        aria-label="Zoom in"
        title="Zoom in (+)"
      >
        <span className="globe-controls__glyph" aria-hidden="true">
          +
        </span>
      </button>
      <button
        type="button"
        className="globe-controls__btn"
        onClick={onZoomOut}
        aria-label="Zoom out"
        title="Zoom out (−)"
      >
        <span className="globe-controls__glyph" aria-hidden="true">
          −
        </span>
      </button>
      <button
        type="button"
        className="globe-controls__btn"
        onClick={onResetView}
        aria-label="Reset view"
        title="Reset view: the stream's home framing (or double-click empty space)"
      >
        <span className="globe-controls__glyph" aria-hidden="true">
          ⟲
        </span>
        <span className="globe-controls__label">Reset</span>
      </button>
      <button
        type="button"
        className="globe-controls__btn globe-controls__btn--follow"
        onClick={onToggleFollow}
        aria-pressed={following}
        disabled={!following && !canFollow}
        title={followTitle}
        data-testid="globe-follow"
      >
        <span className="globe-controls__glyph" aria-hidden="true">
          {following ? '◉' : '◎'}
        </span>
        <span className="globe-controls__label">{following ? 'Stop following' : 'Follow'}</span>
      </button>
    </div>
  )
}
