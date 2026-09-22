import type { ClockMode, FlightRate } from '../store/clockStore'
import { FLIGHT_RATES } from '../store/clockStore'
import '../styles/globe-controls.css'

/** The flight clock's controls (docs/MEGALITH-Flight-Plan.md §2.4): the view
 *  toggle, pause, and the rate. The rate is a property of the run, so it is
 *  locked while one is live (decision 2). */
export type GlobeFlightControls = {
  view: 'pass' | 'flight'
  mode: ClockMode
  rate: number
  rateLocked: boolean
  onToggleView: () => void
  onSetRate: (rate: FlightRate) => void
  onTogglePause: () => void
  /** Holding or stale: fly on from the held time. Falls back to onTogglePause. */
  onPlay?: () => void
}

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
  /** The flight clock, when the globe offers it; absent keeps the camera cluster alone. */
  flight?: GlobeFlightControls | null
}

/** The globe's camera controls, the cluster the module's dashboard and the original
 *  CANOPY map carry: zoom in and out, reset to the stream's home framing, and
 *  follow the selected spacecraft. While following the button reads "Stop
 *  following" and Esc does the same. Pure: the viewer work is the parent's;
 *  the tooltips name the keys. With `flight`, a second cluster above it holds
 *  the flight clock: Flight / Pass view, Pause (P), and the rate. */
export function GlobeControls({
  following,
  canFollow,
  followTarget = null,
  onZoomIn,
  onZoomOut,
  onResetView,
  onToggleFollow,
  flight = null,
}: GlobeControlsProps) {
  // Holding (the run ended) or stale (its stream is gone): the clock is not
  // advancing, so no rate reads as engaged and the pause button offers Play.
  const held = flight?.mode === 'holding' || flight?.mode === 'stale'
  const followTitle = following
    ? 'Stop following (Esc)'
    : followTarget
      ? `Follow ${followTarget}: the camera tracks it (or double-click it on the globe)`
      : canFollow
        ? 'Follow the spacecraft: the camera tracks it (or double-click it on the globe)'
        : 'Pin or select a spacecraft to follow it'

  return (
    <>
      {flight ? (
        <div
          className="globe-controls globe-controls--flight"
          role="toolbar"
          aria-label="Flight controls"
          data-testid="flight-controls"
          data-view={flight.view}
          data-mode={flight.mode}
        >
          <button
            type="button"
            className="globe-controls__btn"
            onClick={flight.onToggleView}
            aria-pressed={flight.view === 'flight'}
            title={
              flight.view === 'flight'
                ? 'Pass view: the spacecraft pinned at their pass, the picture the stills use'
                : 'Flight: the spacecraft fly their orbits on the scenario clock'
            }
            data-testid="flight-view"
          >
            <span className="globe-controls__glyph" aria-hidden="true">
              {flight.view === 'flight' ? '◔' : '◌'}
            </span>
            <span className="globe-controls__label">{flight.view === 'flight' ? 'Flight' : 'Pass view'}</span>
          </button>
          <button
            type="button"
            className="globe-controls__btn"
            onClick={held ? (flight.onPlay ?? flight.onTogglePause) : flight.onTogglePause}
            aria-pressed={flight.mode === 'paused'}
            disabled={flight.view !== 'flight'}
            title={
              held
                ? 'Play (P): the run has ended, fly on from its last time at the rate shown'
                : flight.mode === 'paused'
                  ? 'Resume (P): a run rejoins the stream at its time'
                  : 'Pause the flight clock (P); the stream continues'
            }
            data-testid="flight-pause"
          >
            <span className="globe-controls__glyph" aria-hidden="true">
              {held || flight.mode === 'paused' ? '▶' : '‖'}
            </span>
            <span className="globe-controls__label">{held ? 'Play' : flight.mode === 'paused' ? 'Resume' : 'Pause'}</span>
          </button>
          {FLIGHT_RATES.map((rate) => (
            <button
              key={rate}
              type="button"
              className="globe-controls__btn globe-controls__btn--rate"
              onClick={() => flight.onSetRate(rate)}
              aria-pressed={flight.rate === rate && !held}
              disabled={flight.view !== 'flight' || flight.rateLocked}
              title={
                flight.rateLocked
                  ? `${rate}×: the rate is the run's, chosen when it started`
                  : `${rate}× scenario time (, and . step the rate)`
              }
              data-testid={`flight-rate-${rate}`}
            >
              <span className="globe-controls__label">{rate}×</span>
            </button>
          ))}
        </div>
      ) : null}
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
    </>
  )
}
