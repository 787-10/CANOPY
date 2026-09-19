import { OperatorActionPanel } from '../components/OperatorActionPanel'
import { TopBar } from '../components/TopBar'
import { VerdictPanel } from '../components/VerdictPanel'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { useEpisode } from '../hooks/useEpisode'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'

/** Why fault versus attack, in full, beside the decision taken on it.
 *  Captures S3, S4 and S6. */
export function VerdictPage() {
  useCanopySocket()
  useKnowledgeBase()
  const { attribution, decision } = useEpisode()
  return (
    <main className="page-shell verdict-shell" data-testid="verdict-page">
      <TopBar title="Verdict and decision" current="verdict" />
      <section className="verdict-page">
        <div className="verdict-page__verdict">
          <VerdictPanel attribution={attribution} />
        </div>
        <div className="verdict-page__decision">
          {decision ? (
            <OperatorActionPanel decision={decision} />
          ) : (
            <section className="panel panel--placeholder">
              <div className="panel__header"><h2>Decision</h2><span>pending</span></div>
              <p>The decide stage takes the verdict and either recommends a recovery on the spacecraft or routes a defensive response to the authority that can act on it.</p>
            </section>
          )}
        </div>
      </section>
    </main>
  )
}
