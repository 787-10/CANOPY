import { useMemo, useState } from 'react'
import { ApproveBanner } from '../components/ApproveBanner'
import { EventFeed } from '../components/EventFeed'
import { MapStage } from '../components/MapStage'
import { MissionSummary } from '../components/MissionSummary'
import { ScenarioRail } from '../components/ScenarioRail'
import { useCanopyMissionState } from '../hooks/useCanopyMissionState'
import { useCanopySocket } from '../hooks/useCanopySocket'
import type { Attribution, Decision, Signal } from '../types/canopy'

const nowMinus = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString()

type MockSignalInput = Omit<
  Signal,
  'realism' | 'location' | 'payload' | 'provenance'
> & {
  location?: Signal['location']
  payload: Record<string, unknown>
}

const makeBeatSignal = (signal: MockSignalInput): Signal => ({
  ...signal,
  realism: 'mock_operational',
  location: signal.location ?? { label: signal.source },
  payload: {
    event_type: signal.domain,
    summary: signal.source,
    ...signal.payload,
  } as Signal['payload'],
  provenance: {
    source_id: 'frontend-mock-beat',
    method: 'ui_fallback',
  },
})

const beatSignals: Signal[] = [
  makeBeatSignal({
    id: 'sig-rf-001',
    ts: nowMinus(26),
    domain: 'rf_ew',
    source: 'EW-17 spectrum sweep',
    location: { lat: 34.39, lng: 36.32, alt_m: 260, label: 'Route ridgeline' },
    payload: { band: 'L', bearing: '041', emitter: 'burst uplink' },
    confidence: 0.82,
  }),
  makeBeatSignal({
    id: 'sig-cy-014',
    ts: nowMinus(21),
    domain: 'cyber',
    source: 'Tactical gateway IDS',
    location: { lat: 34.51, lng: 36.41, label: 'Brigade C2 gateway' },
    payload: { vector: 'credential replay', node: 'BLOS relay east' },
    confidence: 0.77,
  }),
  makeBeatSignal({
    id: 'sig-sda-042',
    ts: nowMinus(16),
    domain: 'sda',
    source: 'LEO custody track',
    location: { lat: 34.8, lng: 36.8, alt_km: 548, label: 'LEO custody arc' },
    payload: { object: 'RSO-8841', maneuver: 'proximity drift' },
    confidence: 0.91,
  }),
  makeBeatSignal({
    id: 'sig-pnt-011',
    ts: nowMinus(10),
    domain: 'pnt',
    source: 'Blue PNT mesh',
    location: { lat: 34.66, lng: 36.58, alt_m: 285, label: 'PNT drift box' },
    payload: { error: '42m', trend: 'widening', sector: 'north axis' },
    confidence: 0.74,
  }),
  makeBeatSignal({
    id: 'sig-sat-023',
    ts: nowMinus(4),
    domain: 'satcom',
    source: 'BLOS waveform monitor',
    location: { lat: 34.5, lng: 36.4, alt_m: 250, label: 'BLOS relay node' },
    payload: { link: 'SAT-BRAVO', noise: '+18db', status: 'degrading' },
    confidence: 0.88,
  }),
  makeBeatSignal({
    id: 'sig-os-108',
    ts: nowMinus(2),
    domain: 'osint',
    source: 'Regional language scrape',
    location: { lat: 34.6, lng: 36.52, label: 'Brigade operating area' },
    payload: { phrase: 'window opens', channel: 'gray forum' },
    confidence: 0.69,
  }),
]

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
  action: 'Authorize SATCOM hardening package',
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
  const [beatIndex] = useState(beatSignals.length)
  const [isApproved, setIsApproved] = useState(false)

  const mockSignals = useMemo(
    () =>
      beatSignals
        .slice(0, beatIndex)
        .map((signal, index) => ({
          ...signal,
          ts: nowMinus((beatIndex - index) * 4),
        }))
        .reverse(),
    [beatIndex],
  )

  const signals = socketState.signals.length ? socketState.signals : mockSignals
  const latestAttribution =
    socketState.attributions[0] ?? (beatIndex >= 4 ? beatAttribution : null)
  const latestDecision =
    socketState.decisions[0] ?? (beatIndex >= 5 ? beatDecision : null)
  const latestUiEvent = socketState.uiEvents[0] ?? null
  const missionState = useCanopyMissionState(signals, socketState.uiEvents)

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
              socketState.isConnected
                ? 'socket-status socket-status--online'
                : 'socket-status'
            }
          >
            {socketState.isConnected ? 'Live data' : 'Demo data'}
          </span>
          <a href="/operator">Ops</a>
        </div>
      </header>

      <section className="command-workbench">
        <ScenarioRail />

        <section className="map-workspace" aria-label="Map and incoming reports">
          <MapStage
            correlatedSignalIds={missionState.correlatedSignalIds}
            focusSignalId={missionState.mapFocusSignalId}
            signals={signals}
          />

          <EventFeed signals={signals} />
        </section>

        <aside className="decision-stack" aria-label="Commander decision stack">
          <MissionSummary
            attribution={latestAttribution}
            decision={latestDecision}
            uiEvent={latestUiEvent}
            signalCount={signals.length}
          />
          <ApproveBanner
            decision={latestDecision}
            uiEvent={latestUiEvent}
            isApproved={isApproved}
            onApprove={() => setIsApproved(true)}
          />
        </aside>
      </section>
    </main>
  )
}
