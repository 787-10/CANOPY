import { useEffect } from 'react'
import { MapStage } from '../components/MapStage'
import { StatusBanner } from '../components/StatusBanner'
import { DecisionSummaryCard, LatestReports, VerdictSummaryCard } from '../components/SummaryCards'
import { TopBar } from '../components/TopBar'
import { useCanopyMissionState } from '../hooks/useCanopyMissionState'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { useEpisode } from '../hooks/useEpisode'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'
import { startPendingReplay } from '../lib/demoRuns'
import { useEventStore } from '../store/eventStore'

/** The MEGALITH console overview: one status line, the globe, and three
 *  short cards (verdict, decision, latest reports) that link to their pages.
 *  Everything on this page is engine output received over the socket. */
export function Brigade() {
  const socket = useCanopySocket()
  useKnowledgeBase()
  const { signals, report, attribution, decision } = useEpisode()
  const uiEvents = useEventStore((state) => state.uiEvents)
  const missionState = useCanopyMissionState(signals, uiEvents, {
    enableMapAutoFocus: true,
    mapFocusMinConfidence: 0,
  })

  // The launcher leaves the replay pending and navigates here; it starts once
  // this page's socket is open so the first record is not published to nobody.
  useEffect(() => {
    if (!socket.isConnected) return
    void startPendingReplay().catch(() => {
      // the gateway refused: the console stays up with whatever arrives
    })
  }, [socket.isConnected])

  return (
    <main className="brigade-shell">
      <TopBar title="Console" current="brigade" />
      <StatusBanner report={report} attribution={attribution} />
      <section className="overview">
        <MapStage
          correlatedSignalIds={missionState.correlatedSignalIds}
          focusSignalId={missionState.mapFocusSignalId}
          signals={signals}
          report={report}
        />
        <div className="overview__cards">
          <VerdictSummaryCard attribution={attribution} />
          <DecisionSummaryCard decision={decision} />
          <LatestReports signals={signals} />
        </div>
      </section>
    </main>
  )
}
