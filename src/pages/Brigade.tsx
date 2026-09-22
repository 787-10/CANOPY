import { useEffect } from 'react'
import { MapStage } from '../components/MapStage'
import { StatusBanner } from '../components/StatusBanner'
import { TopBar } from '../components/TopBar'
import { ReportsStrip } from '../components/overview/ReportsStrip'
import { ResponseColumn } from '../components/overview/ResponseColumn'
import { SideColumn } from '../components/overview/SideColumn'
import { SituationColumn } from '../components/overview/SituationColumn'
import { useCanopyMissionState } from '../hooks/useCanopyMissionState'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { useEpisode } from '../hooks/useEpisode'
import { useKnowledgeBase } from '../hooks/useKnowledgeBase'
import { spacecraftDisplayName } from '../lib/commanderLanguage'
import { startPendingReplay } from '../lib/demoRuns'
import { OVERVIEW_RAIL_WIDTH, useColumnExpanded } from '../lib/overviewLayout'
import { useCaptureStore } from '../store/captureStore'
import { useEventStore } from '../store/eventStore'

const LEFT_WIDTH_PX = 320
const RIGHT_WIDTH_PX = 360

/** The MEGALITH console overview: one status line, then a grid with the
 *  globe in the middle, the Situation column on the left (which incident to
 *  focus on, the spacecraft, the environment), the Response column on the
 *  right (approve or deny, the verdict and decision summaries) and the
 *  Reports strip along the bottom. Both columns collapse into 44px rails;
 *  capture mode holds them open. Everything on this page is engine output
 *  received over the socket. */
export function Brigade() {
  const socket = useCanopySocket()
  useKnowledgeBase()
  const capture = useCaptureStore((s) => s.enabled)
  const { signals, report, attribution, decision, pinnedSatelliteId } = useEpisode()
  // The globe's target: the fleet row or Theaters pin the operator chose (lib/fleet.ts).
  const followedSatelliteId = useEventStore((s) => s.followedSatelliteId)
  const anomalies = useEventStore((state) => state.anomalies)
  const uiEvents = useEventStore((state) => state.uiEvents)
  const missionState = useCanopyMissionState(signals, uiEvents, {
    enableMapAutoFocus: true,
    mapFocusMinConfidence: 0,
  })
  const [leftExpanded, toggleLeft] = useColumnExpanded('left', capture)
  const [rightExpanded, toggleRight] = useColumnExpanded('right', capture)

  // The launcher leaves the replay pending and navigates here; it starts once
  // this page's socket is open so the first record is not published to nobody.
  useEffect(() => {
    if (!socket.isConnected) return
    void startPendingReplay().catch(() => {
      // the gateway refused: the console stays up with whatever arrives
    })
  }, [socket.isConnected])

  const satelliteId = attribution?.satellite_id ?? pinnedSatelliteId
  // A pinned spacecraft takes the globe's focus: its newest report is the
  // focus mark and the camera flies to it; "Follow latest" hands it back.
  const pinnedFocusId = pinnedSatelliteId
    ? signals.find((signal) => signal.payload.satellite_id === pinnedSatelliteId)?.id ?? null
    : null

  return (
    <main className="brigade-shell">
      <TopBar title="Console" current="brigade" />
      <StatusBanner report={report} attribution={attribution} />
      <section
        className="overview"
        data-testid="overview"
        data-left={leftExpanded ? 'expanded' : 'collapsed'}
        data-right={rightExpanded ? 'expanded' : 'collapsed'}
        style={{
          ['--left-w' as string]: `${leftExpanded ? LEFT_WIDTH_PX : OVERVIEW_RAIL_WIDTH}px`,
          ['--right-w' as string]: `${rightExpanded ? RIGHT_WIDTH_PX : OVERVIEW_RAIL_WIDTH}px`,
        }}
      >
        <SideColumn side="left" label="Situation" expanded={leftExpanded} onToggle={toggleLeft} capture={capture}>
          <SituationColumn satelliteId={satelliteId} />
        </SideColumn>
        <MapStage
          correlatedSignalIds={missionState.correlatedSignalIds}
          focusSignalId={pinnedFocusId ?? missionState.mapFocusSignalId}
          signals={signals}
          report={report}
          pinnedSatellite={followedSatelliteId ? spacecraftDisplayName(followedSatelliteId) : null}
        />
        <SideColumn side="right" label="Response" expanded={rightExpanded} onToggle={toggleRight} capture={capture}>
          <ResponseColumn attribution={attribution} decision={decision} />
        </SideColumn>
        <ReportsStrip signals={signals} anomalies={anomalies} />
      </section>
    </main>
  )
}
