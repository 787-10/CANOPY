import { SignalTable } from '../components/SignalTable'
import { StressMode } from '../components/StressMode'
import { TopBar } from '../components/TopBar'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { useEventStore } from '../store/eventStore'

/** Every signal received, and the input-domain controls (stress mode).
 *  Captures S2 (through a row's card) and S7. */
export function SignalsPage() {
  useCanopySocket()
  const signals = useEventStore((state) => state.signals)
  return (
    <main className="page-shell signals-shell" data-testid="signals-page">
      <TopBar title="Signals" current="signals" />
      <section className="signals-page">
        <section className="panel signals-page__table" aria-labelledby="signals-title">
          <div className="panel__header">
            <h2 id="signals-title">Signals received</h2>
            <span>{signals.length} in this run</span>
          </div>
          <div className="signals-page__scroll">
            <SignalTable signals={signals} />
          </div>
        </section>
        <aside className="signals-page__inputs" aria-label="Input domains">
          <details className="page-intro page-intro--aside">
            <summary>What stress mode does</summary>
            <p>
              Deny a source and replay the run to see how the verdict degrades without it: with
              RF denied the same symptom is called <em>unknown</em> at low confidence instead of
              hostile, and the trace says which input was dropped.
            </p>
          </details>
          <StressMode />
        </aside>
      </section>
    </main>
  )
}
