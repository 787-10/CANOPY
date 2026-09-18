import { useEffect, useMemo, useState } from 'react'
import { ActionLog } from '../components/ActionLog'
import { ApproveBanner } from '../components/ApproveBanner'
import { CollapsibleStackSection } from '../components/CollapsibleStackSection'
import { EmbeddingViz } from '../components/EmbeddingViz'
import { EventFeed } from '../components/EventFeed'
import { MapStage } from '../components/MapStage'
import { ReasoningPanel } from '../components/ReasoningPanel'
import { ScenarioRail } from '../components/ScenarioRail'
import { ScenarioTimeline } from '../components/ScenarioTimeline'
import { StressMode } from '../components/StressMode'
import { defaultScenario, scenarios } from '../data/scenarioLibrary'
import { useCanopyMissionState } from '../hooks/useCanopyMissionState'
import { useCanopySocket } from '../hooks/useCanopySocket'
import { triggerReplay } from '../hooks/useEngineSocket'
import { useEventStore } from '../store/eventStore'
import type { PlaybackStatus } from '../types/playback'
import type { Attribution, Decision, Signal } from '../types/canopy'

const fieldDurationFloorMs = 12 * 60 * 1000
const fieldDurationScale = 1
const playbackTickMs = 3000
const simulatedMsPerTick = 30 * 1000
const playbackScaleLabel = '3 SEC = 30 OPERATIONAL SEC'

const signalTimeMs = (signal: Signal | undefined) => {
  const time = Date.parse(signal?.ts ?? '')
  return Number.isFinite(time) ? time : null
}

const buildPlaybackTimeline = (signals: Signal[]) => {
  const times = signals
    .map(signalTimeMs)
    .filter((time): time is number => time !== null)
  const startMs = times.length ? Math.min(...times) : 0
  const endMs = times.length ? Math.max(...times) : startMs
  const realDurationMs = Math.max(endMs - startMs, 1)
  const durationMs = Math.max(
    fieldDurationFloorMs,
    realDurationMs * fieldDurationScale,
  )

  const offsets = signals.map((signal, index) => {
    const time = signalTimeMs(signal)
    if (time === null || realDurationMs <= 1) {
      return signals.length > 1
        ? (index / (signals.length - 1)) * durationMs
        : 0
    }
    return ((time - startMs) / realDurationMs) * durationMs
  })

  return { durationMs, offsets }
}

const nowMinus = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString()

const beatAttribution: Attribution = {
  id: 'att-ghost-lance',
  ts: nowMinus(1),
  anomaly_ids: ['ano-cross-domain-07'],
  actor: 'Ghost Lance cell',
  confidence: 0.84,
  doctrine_match: 'counter-C2 isolation before fires window',
  evidence: [
    'RF burst timing matches known pre-jam rehearsal pattern',
    'Credential replay is focused on the same BLOS relay under noise',
    'SDA custody shift aligns with PNT error widening on the north axis',
  ],
  predicted_next: 'open a 9 minute BLOS denial window',
  kb_citations: ['KB-17-044', 'KB-21-119'],
  source_signal_ids: ['sig-rf-001', 'sig-cy-014', 'sig-sda-042'],
}

const beatDecision: Decision = {
  id: 'dec-approve-009',
  ts: nowMinus(0),
  attribution_id: 'att-ghost-lance',
  action: 'active_defense_escort',
  target: 'SAT-BRAVO / north-axis BLOS relay',
  rationale:
    'Preemptive waveform shift and relay isolation are expected to preserve command links during the predicted denial window.',
  authority: 'request',
  request_packet: {
    packet_id: 'REQ-SAT-BRAVO-009',
    ttl_minutes: 6,
    commander_intent: 'preserve brigade C2',
  },
  source_signal_ids: ['sig-rf-001', 'sig-sat-023'],
}

export function Brigade() {
  const socketState = useCanopySocket()
  const [beatIndex] = useState(1)
  const [isMapAutoFocusEnabled, setIsMapAutoFocusEnabled] = useState(true)
  const [activeScenarioId, setActiveScenarioId] = useState(defaultScenario.id)
  const [simElapsedMs, setSimElapsedMs] = useState(0)
  const pendingApproval = useEventStore((state) => state.pendingApproval)
  const approvedEventIds = useEventStore((state) => state.approvedEventIds)
  const markApproved = useEventStore((state) => state.markApproved)
  // Collapse state for the three foldable side panels. Each tab handle
  // sits on the panel's outer edge and toggles the open/closed state.
  const [scenarioRailCollapsed, setScenarioRailCollapsed] = useState(false)
  const [decisionStackCollapsed, setDecisionStackCollapsed] = useState(false)
  const [eventFeedCollapsed, setEventFeedCollapsed] = useState(false)
  const activeScenario =
    scenarios.find((scenario) => scenario.id === activeScenarioId) ??
    defaultScenario
  const playbackTimeline = useMemo(
    () => buildPlaybackTimeline(activeScenario.signals),
    [activeScenario.signals],
  )
  const playbackStatus: PlaybackStatus = useMemo(() => {
    const nextOffsetMs =
      playbackTimeline.offsets.find((offset) => offset > simElapsedMs) ?? null
    const progress =
      playbackTimeline.durationMs > 0
        ? Math.min(1, simElapsedMs / playbackTimeline.durationMs)
        : 0
    return {
      durationMs: playbackTimeline.durationMs,
      elapsedMs: simElapsedMs,
      nextInjectMs: nextOffsetMs,
      progress,
      scaleLabel: playbackScaleLabel,
    }
  }, [playbackTimeline.durationMs, playbackTimeline.offsets, simElapsedMs])
  const activeScenarioSignals = useMemo(() => {
    const completedSignals = activeScenario.signals.filter((_, index) => {
      const offset = playbackTimeline.offsets[index] ?? 0
      return offset <= simElapsedMs
    })
    return [...(completedSignals.length ? completedSignals : activeScenario.signals.slice(0, 1))]
      .reverse()
  }, [activeScenario.signals, playbackTimeline.offsets, simElapsedMs])

  useEffect(() => {
    if (simElapsedMs >= playbackTimeline.durationMs) {
      return
    }

    const timer = window.setInterval(() => {
      setSimElapsedMs((current) =>
        Math.min(current + simulatedMsPerTick, playbackTimeline.durationMs),
      )
    }, playbackTickMs)

    return () => window.clearInterval(timer)
  }, [playbackTimeline.durationMs, simElapsedMs])

  const selectScenario = (scenarioId: string) => {
    setActiveScenarioId(scenarioId)
    setSimElapsedMs(0)

    // Fire the scenario through the live engine. The gateway cancels any
    // in-flight replay before starting the new one, so clicking through
    // scenarios rapidly is safe. We deliberately do NOT clear the trace
    // buffer here — the buffer survives both rapid scenario changes and
    // full-page navigations (it's persisted to sessionStorage), so the
    // operator gets a continuous reasoning log across the operational run.
    const scenario = scenarios.find((s) => s.id === scenarioId)
    if (scenario) {
      void triggerReplay(scenario.file, 5).catch(() => {
        // Local scenario playback remains authoritative for the GUI when the
        // engine API is offline; backend replay only enriches traces/decisions.
      })
    }
  }

  const signals = activeScenarioSignals
  const isEngineLive = socketState.isConnected
  const dataModeLabel = isEngineLive ? 'Engine live' : 'Feed'
  const latestAttribution =
    socketState.attributions[0] ?? (beatIndex >= 4 ? beatAttribution : null)
  const latestDecision =
    socketState.decisions[0] ?? (beatIndex >= 5 ? beatDecision : null)
  const latestUiEvent = socketState.uiEvents[0] ?? null
  const approvalEvent = pendingApproval ?? latestUiEvent
  const hasApprovalRequest =
    Boolean(
      pendingApproval?.recommendation ??
        latestUiEvent?.recommendation ??
        (latestDecision?.authority === 'request' ? latestDecision : null),
    ) &&
    !(
      approvalEvent?.id &&
      approvedEventIds instanceof Set &&
      approvedEventIds.has(approvalEvent.id)
    )
  const missionState = useCanopyMissionState(signals, socketState.uiEvents, {
    enableMapAutoFocus: isMapAutoFocusEnabled,
    mapFocusMinConfidence: 0,
  })

  return (
    <main className="brigade-shell">
      <header className="app-header">
        <div>
          <p className="app-header__eyebrow">CANOPY</p>
          <h1>Brigade COP</h1>
        </div>
        <div className="app-header__right">
          <span
            className={
              isEngineLive
                ? 'socket-status socket-status--online'
                : 'socket-status'
            }
          >
            {dataModeLabel}
          </span>
          <a href="/operator">Ops</a>
        </div>
      </header>

      <section className="command-workbench">
        <ScenarioRail
          activeScenarioId={activeScenario.id}
          attribution={latestAttribution}
          decision={latestDecision}
          latestSignal={signals[0] ?? null}
          onSelectScenario={selectScenario}
          scenarios={scenarios}
          signalCount={signals.length}
          uiEvent={latestUiEvent}
          offsets={playbackTimeline.offsets}
          playback={playbackStatus}
          collapsed={scenarioRailCollapsed}
        />
        <button
          type="button"
          className={`panel-tab panel-tab--left-edge${
            scenarioRailCollapsed ? ' panel-tab--at-edge' : ''
          }`}
          onClick={() => setScenarioRailCollapsed((c) => !c)}
          aria-label={
            scenarioRailCollapsed
              ? 'Open scenarios panel'
              : 'Collapse scenarios panel'
          }
          aria-expanded={!scenarioRailCollapsed}
        >
          <span className="panel-tab__arrow" aria-hidden="true">
            {scenarioRailCollapsed ? '▶' : '◀'}
          </span>
          <span className="panel-tab__label">SCENARIOS</span>
        </button>

        <section className="map-workspace" aria-label="Map and incoming reports">
          <MapStage
            correlatedSignalIds={missionState.correlatedSignalIds}
            focusSignalId={missionState.mapFocusSignalId}
            offsets={playbackTimeline.offsets}
            playback={playbackStatus}
            scenario={activeScenario}
            signals={signals}
          />

          <EventFeed
            isLive={isEngineLive}
            isMapAutoFocusEnabled={isMapAutoFocusEnabled}
            onToggleMapAutoFocus={() =>
              setIsMapAutoFocusEnabled((isEnabled) => !isEnabled)
            }
            signals={signals}
            collapsed={eventFeedCollapsed}
          />
          <button
            type="button"
            className={`panel-tab panel-tab--bottom-edge${
              eventFeedCollapsed ? ' panel-tab--at-edge' : ''
            }`}
            onClick={() => setEventFeedCollapsed((c) => !c)}
            aria-label={
              eventFeedCollapsed
                ? 'Open signal stream'
                : 'Collapse signal stream'
            }
            aria-expanded={!eventFeedCollapsed}
          >
            <span className="panel-tab__arrow" aria-hidden="true">
              {eventFeedCollapsed ? '▲' : '▼'}
            </span>
            <span className="panel-tab__label">SIGNAL STREAM</span>
          </button>
        </section>

        <aside
          className={`decision-stack${
            decisionStackCollapsed ? ' decision-stack--collapsed' : ''
          }`}
          aria-label="Commander decision stack"
          aria-hidden={decisionStackCollapsed}
        >
          {hasApprovalRequest ? (
            <CollapsibleStackSection title="Approval">
              <ApproveBanner
                decision={latestDecision}
                uiEvent={approvalEvent}
                onApprove={(id) => markApproved(id)}
              />
            </CollapsibleStackSection>
          ) : null}
          <CollapsibleStackSection title="Timeline">
            <ScenarioTimeline
              offsets={playbackTimeline.offsets}
              playback={playbackStatus}
              scenario={activeScenario}
              signals={signals}
            />
          </CollapsibleStackSection>
          <CollapsibleStackSection title="System actions" defaultOpen={false}>
            <ActionLog compact />
          </CollapsibleStackSection>
          <CollapsibleStackSection
            title="OSINT embedding space"
            defaultOpen={false}
          >
            <EmbeddingViz compact />
          </CollapsibleStackSection>
          <CollapsibleStackSection title="Reasoning trace" flexGrow>
            <ReasoningPanel />
          </CollapsibleStackSection>
          <CollapsibleStackSection title="Stress mode" defaultOpen={false}>
            <StressMode />
          </CollapsibleStackSection>
        </aside>
        <button
          type="button"
          className={`panel-tab panel-tab--right-edge${
            decisionStackCollapsed ? ' panel-tab--at-edge' : ''
          }`}
          onClick={() => setDecisionStackCollapsed((c) => !c)}
          aria-label={
            decisionStackCollapsed
              ? 'Open commander panel'
              : 'Collapse commander panel'
          }
          aria-expanded={!decisionStackCollapsed}
        >
          <span className="panel-tab__arrow" aria-hidden="true">
            {decisionStackCollapsed ? '◀' : '▶'}
          </span>
          <span className="panel-tab__label">COMMANDER</span>
        </button>
      </section>
    </main>
  )
}
