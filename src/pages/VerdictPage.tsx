import { useEffect, useState } from 'react'
import { EpisodeReports } from '../components/EpisodeReports'
import { OperatorActionPanel } from '../components/OperatorActionPanel'
import { TopBar } from '../components/TopBar'
import { VerdictPanel } from '../components/VerdictPanel'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { useEpisode } from '../hooks/useEpisode'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'
import '../styles/fit.css'

/** The page is a fixed-height layout (the window minus the top bar) and
 *  nothing on it scrolls, so the lists that grow with the episode show a
 *  few lines and fold the rest behind "+k more". A window at least this
 *  tall (the 1080 capture) shows the taller budget; anything shorter (a
 *  1440x900 laptop) the compact one. */
const TALL_WINDOW_PX = 1000

type FitBudget = {
  /** Lines of "Cited for the verdict" shown before the fold. */
  cited: number
  /** Evidence lines shown before the fold. */
  evidence: number
  /** Report rows shown before the fold. */
  reports: number
}

const TALL_BUDGET: FitBudget = { cited: 3, evidence: 5, reports: 6 }
const SHORT_BUDGET: FitBudget = { cited: 2, evidence: 3, reports: 4 }

const budgetFor = (windowHeight: number): FitBudget =>
  windowHeight >= TALL_WINDOW_PX ? TALL_BUDGET : SHORT_BUDGET

/** The fit budget for the current window height, updated on resize. */
function useFitBudget(): FitBudget {
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined' ? TALL_WINDOW_PX : window.innerHeight,
  )
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return budgetFor(height)
}

/** Why fault versus attack, in full, beside the decision taken on it and
 *  the reports it rests on. Captures S3, S4 and S6. */
export function VerdictPage() {
  useCanopySocket()
  useKnowledgeBase()
  const { attribution, decision } = useEpisode()
  const budget = useFitBudget()
  return (
    <main className="page-shell verdict-shell" data-testid="verdict-page">
      <TopBar title="Verdict and decision" current="verdict" />
      <section className="verdict-page" data-fit={budget === TALL_BUDGET ? 'tall' : 'short'}>
        <div className="verdict-page__verdict">
          <VerdictPanel
            attribution={attribution}
            citedLimit={budget.cited}
            evidenceLimit={budget.evidence}
          />
        </div>
        <div className="verdict-page__decision">
          {decision ? (
            <OperatorActionPanel decision={decision} attributionRevision={attribution?.revision ?? null} />
          ) : (
            <section className="panel panel--placeholder">
              <div className="panel__header"><h2>Decision</h2></div>
              <p className="summary-card__state">Pending · computed when the verdict lands</p>
            </section>
          )}
          <EpisodeReports satelliteId={attribution?.satellite_id ?? null} limit={budget.reports} />
        </div>
      </section>
    </main>
  )
}
