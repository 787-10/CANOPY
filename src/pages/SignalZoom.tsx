import { BusHealthCard } from '../components/BusHealthCard'
import { EpisodeReports } from '../components/EpisodeReports'
import { DecisionSummaryCard, VerdictSummaryCard } from '../components/SummaryCards'
import { TopBar } from '../components/TopBar'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { spacecraftDisplayName } from '../lib/commanderLanguage'
import { withCapture } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

type SignalZoomProps = {
  /** `?id=` of the signal to show; the latest bus-health signal otherwise. */
  signalId?: string | null
}

/** One bus-health signal in full (capture S2), laid out like the console:
 *  the card on the left, and on the right the episode it belongs to, the
 *  verdict and decision summaries and the other reports on the same
 *  spacecraft, each a click away. */
export function SignalZoom({ signalId = null }: SignalZoomProps) {
  useCanopySocket()
  const signals = useEventStore((s) => s.signals)
  const signalsById = useEventStore((s) => s.signalsById)
  const decisions = useEventStore((s) => s.decisions)
  const attributions = useEventStore((s) => s.attributions)

  const signal =
    (signalId ? signalsById[signalId] : undefined) ??
    signals.find((candidate) => candidate.domain === 'bus_health') ??
    null
  const satelliteId = signal?.payload.satellite_id ?? null
  const attribution = satelliteId
    ? attributions.find((candidate) => candidate.satellite_id === satelliteId) ?? null
    : null
  const decision = attribution
    ? decisions.find((candidate) => candidate.attribution_id === attribution.id) ?? null
    : null
  const name = satelliteId ? spacecraftDisplayName(satelliteId) : signal?.payload.asset ?? ''

  return (
    <main className="signal-shell" data-testid="signal-zoom">
      <TopBar title={signal ? `Bus-health signal · ${name}` : 'Bus-health signal'} current="signal" />
      {signal ? (
        <section className="signal-page">
          <div className="signal-page__card">
            <BusHealthCard signal={signal} zoomed decision={decision} />
          </div>
          <aside className="signal-page__context" aria-label="Episode context" data-testid="signal-context">
            <VerdictSummaryCard attribution={attribution} />
            <DecisionSummaryCard decision={decision} actions={false} />
            <EpisodeReports satelliteId={satelliteId} currentSignalId={signal.id} />
            <a className="side-column__link" href={withCapture('/brigade')}>← Back to the console</a>
          </aside>
        </section>
      ) : (
        <section className="signal-zoom">
          <div className="panel signal-zoom__empty">
            <h2>No bus-health signal to show</h2>
            <p>
              Pass <code>?id=&lt;signal id&gt;</code> or replay a scenario so an internal-diagnosis
              record arrives.
            </p>
            <a href={withCapture('/brigade')}>Back to the Brigade view</a>
          </div>
        </section>
      )}
    </main>
  )
}
