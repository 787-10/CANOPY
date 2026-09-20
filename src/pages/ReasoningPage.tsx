import { ReasoningPanel } from '../components/ReasoningPanel'
import { TopBar } from '../components/TopBar'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { withCapture } from '../store/captureStore'

/** The engine's reasoning trace, full height: fusion, the fast lane's rule
 *  verdict, primary attribution, red-team challenge, reconciliation, decide.
 *  Capture S5. */
export function ReasoningPage() {
  useCanopySocket()
  return (
    <main className="page-shell reasoning-shell" data-testid="reasoning-page">
      <TopBar title="Reasoning trace" current="reasoning" />
      <details className="page-intro">
        <summary>What this page shows</summary>
        <p>
          Every step the engine took, in order: the rule lane's provisional verdict, the
          primary attribution, the red-team challenge, the reconciled final verdict and the
          decision. Knowledge-base citations resolve to cards on the{' '}
          <a href={withCapture('/verdict')}>Verdict page</a>.
        </p>
      </details>
      <section className="reasoning-page">
        <ReasoningPanel />
      </section>
    </main>
  )
}
