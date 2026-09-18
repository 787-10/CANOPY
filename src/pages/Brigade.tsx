import { useEffect } from 'react'
import { CollapsibleStackSection } from '../components/CollapsibleStackSection'
import { EventFeed } from '../components/EventFeed'
import { MapStage } from '../components/MapStage'
import { OperatorActionPanel } from '../components/OperatorActionPanel'
import { ReasoningPanel } from '../components/ReasoningPanel'
import { StressMode } from '../components/StressMode'
import { TopBar } from '../components/TopBar'
import { VerdictPanel } from '../components/VerdictPanel'
import { useCanopyMissionState } from '../hooks/useCanopyMissionState'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'
import { startPendingReplay } from '../lib/demoRuns'
import { selectEpisodeAttribution } from '../lib/episode'
import { useEventStore } from '../store/eventStore'

/** The MEGALITH console (demo plan section 2). Three zones: the fused
 *  picture on the globe with the latest report over it, the verdict and the
 *  decision beside it with the reasoning trace and stress mode folded until
 *  asked, and the signal stream below. Everything on this page is engine
 *  output received over the socket; the store de-duplicates by id and
 *  survives a reload. */
export function Brigade() {
  const socket = useCanopySocket()
  useKnowledgeBase()
  // The launcher leaves the replay pending and navigates here; it starts once
  // this page's socket is open so the first record is not published to nobody.
  useEffect(() => {
    if (!socket.isConnected) return
    void startPendingReplay().catch(() => {
      // the gateway refused: the console stays up with whatever arrives
    })
  }, [socket.isConnected])
  const signals = useEventStore((state) => state.signals)
  const anomalies = useEventStore((state) => state.anomalies)
  const attributions = useEventStore((state) => state.attributions)
  const decisions = useEventStore((state) => state.decisions)
  const uiEvents = useEventStore((state) => state.uiEvents)

  // The episode's verdict is the satellite cluster's final revision, not the
  // newest attribution received (INTERFACE-SPEC section 5.0).
  const attribution = selectEpisodeAttribution(attributions, anomalies)
  // The decision shown beside it is the one taken on that attribution
  // (newest first, so a gate-republished threat warning wins over the
  // recovery it replaced), not simply the newest decision: the natural run's
  // global space-weather cluster publishes a decision of its own.
  const decision = attribution
    ? (decisions.find((candidate) => candidate.attribution_id === attribution.id) ?? null)
    : null
  const missionState = useCanopyMissionState(signals, uiEvents, {
    enableMapAutoFocus: true,
    mapFocusMinConfidence: 0,
  })

  return (
    <main className="brigade-shell">
      <TopBar title="Console" current="brigade" />

      <section className="command-workbench">
        <section className="map-workspace" aria-label="Map and incoming reports">
          <MapStage
            correlatedSignalIds={missionState.correlatedSignalIds}
            focusSignalId={missionState.mapFocusSignalId}
            signals={signals}
          />
          <EventFeed signals={signals} decision={decision} />
        </section>

        <aside className="decision-stack" aria-label="Verdict and decision">
          <CollapsibleStackSection title="Verdict">
            <VerdictPanel attribution={attribution} compact />
          </CollapsibleStackSection>
          {decision ? (
            <CollapsibleStackSection title="Decision">
              <OperatorActionPanel decision={decision} />
            </CollapsibleStackSection>
          ) : null}
          <CollapsibleStackSection title="Reasoning trace" flexGrow defaultOpen={false}>
            <ReasoningPanel />
          </CollapsibleStackSection>
          <CollapsibleStackSection title="Stress mode" defaultOpen={false}>
            <StressMode />
          </CollapsibleStackSection>
        </aside>
      </section>
    </main>
  )
}
