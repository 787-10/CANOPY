import { useEffect, useState } from 'react'
import { TopBar } from '../components/TopBar'
import {
  DEMO_RUNS,
  REPLAY_MAX_DELAY_S,
  REPLAY_SPEED,
  parseRun,
  startDemoRun,
  type DemoRun,
} from '../lib/demoRuns'
import { withCapture } from '../store/captureStore'

type DemoLauncherProps = {
  run?: string | null
  /** `?autostart=1`: start without a click. */
  autostart?: boolean
  fetchImpl?: typeof fetch
  navigate?: (url: string) => void
}

/** `/demo?run=A|B|C`: minimal launcher for the recording. */
export function DemoLauncher({
  run: requested = null,
  autostart = false,
  fetchImpl,
  navigate,
}: DemoLauncherProps) {
  const [run, setRun] = useState<DemoRun>(parseRun(requested) ?? 'A')
  const [status, setStatus] = useState<'idle' | 'starting' | 'started' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const spec = DEMO_RUNS[run]

  const start = async () => {
    setStatus('starting')
    setError(null)
    try {
      await startDemoRun(run, { fetchImpl, navigate })
      setStatus('started')
    } catch (cause) {
      setStatus('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    if (autostart && parseRun(requested)) {
      void start()
    }
    // Autostart fires once for the run in the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="demo-shell" data-testid="demo-launcher">
      <TopBar title="Demo launcher" current="demo" subsystems={false} />
      <section className="panel demo-launcher" aria-label="Demo run launcher">
        <div className="demo-launcher__runs" role="radiogroup" aria-label="Run">
          {(Object.keys(DEMO_RUNS) as DemoRun[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === run}
              className={`demo-launcher__run${candidate === run ? ' is-active' : ''}`}
              onClick={() => setRun(candidate)}
              disabled={status === 'starting'}
            >
              <span>Run {candidate}</span>
              <strong>{DEMO_RUNS[candidate].title.split(' · ')[1]}</strong>
            </button>
          ))}
        </div>
        <h2 data-testid="demo-title">{spec.title}</h2>
        <dl className="demo-launcher__facts">
          <div>
            <dt>Scenario</dt>
            <dd>
              <code data-testid="demo-stem">{spec.stem}</code>
            </dd>
          </div>
          <div>
            <dt>Ground truth</dt>
            <dd>{spec.groundTruth}</dd>
          </div>
          <div>
            <dt>Expected</dt>
            <dd>{spec.expectedVerdict}</dd>
          </div>
          <div>
            <dt>Pacing</dt>
            <dd>
              speed {REPLAY_SPEED}x, gaps capped at {REPLAY_MAX_DELAY_S} s
            </dd>
          </div>
        </dl>
        <div className="demo-launcher__actions">
          <button
            type="button"
            className="demo-launcher__start"
            onClick={() => void start()}
            disabled={status === 'starting' || status === 'started'}
            data-testid="demo-start"
          >
            {status === 'starting'
              ? 'Starting…'
              : status === 'started'
                ? 'Started'
                : `Start run ${run} and open the console`}
          </button>
          <a href={withCapture('/brigade', true)}>Console only</a>
        </div>
        {error ? (
          <p className="demo-launcher__error" role="alert" data-testid="demo-error">
            {error}
          </p>
        ) : null}
        <p className="demo-launcher__note">
          Starting clears the console buffers, posts the replay to the gateway and opens the
          Brigade view in capture mode.
        </p>
      </section>
    </main>
  )
}
