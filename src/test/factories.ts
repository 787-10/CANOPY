// Shared, fully-typed fixture factories for the frontend unit suites. Each
// returns a complete object built on the project's canonical types with
// sensible defaults that any field can override via a Partial.
//
// `id` is positional because most call sites care about a specific id (ring
// buffers, lookup maps, correlation). Suites that want auto-generated ids wrap
// these with a small local counter.
import type {
  Anomaly,
  Attribution,
  Decision,
  Domain,
  KBEntry,
  OsintEmbeddingSnapshot,
  ReasoningTrace,
  Recommendation,
  Signal,
  UIEvent,
} from '../types/canopy'
import type { ManeuverDemo } from '../store/eventStore'

const TS = '2026-05-30T00:00:00.000Z'

export function makeSignal(id: string, overrides: Partial<Signal> = {}): Signal {
  // event_type defaults to the domain so commanderLanguage resolves a stable
  // `${domainLabel} report` detail string.
  const domain: Domain = overrides.domain ?? 'orbit'
  return {
    id,
    ts: TS,
    domain,
    source: 'test',
    realism: 'mock_operational',
    confidence: 0.5,
    location: { label: 'LEO', lat: 0, lng: 0, alt_km: 550 },
    payload: { event_type: domain, summary: `signal ${id}` },
    provenance: { source_id: `src-${id}` },
    ...overrides,
  }
}

export function makeAnomaly(id: string, overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id,
    ts: TS,
    kind: 'maneuver',
    source_signal: `sig-${id}`,
    source_signal_ids: [`sig-${id}`],
    severity: 3,
    payload: {},
    ...overrides,
  }
}

export function makeAttribution(
  id: string,
  overrides: Partial<Attribution> = {},
): Attribution {
  return {
    id,
    ts: TS,
    anomaly_ids: [`anom-${id}`],
    actor: 'RED',
    confidence: 0.75,
    doctrine_match: null,
    evidence: [],
    predicted_next: null,
    kb_citations: [],
    source_signal_ids: [],
    ...overrides,
  }
}

export function makeDecision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    ts: TS,
    attribution_id: `attr-${id}`,
    action: 'active_defense_escort',
    target: 'FRIENDLY-1',
    rationale: `rationale ${id}`,
    authority: 'request',
    request_packet: null,
    source_signal_ids: [],
    ...overrides,
  }
}

export function makeTrace(
  id: string,
  overrides: Partial<ReasoningTrace> = {},
): ReasoningTrace {
  return {
    id,
    ts: TS,
    stage: 'fusion',
    level: 'info',
    message: `trace ${id}`,
    ref_id: null,
    payload: {},
    ...overrides,
  }
}

export function makeRecommendation(
  id: string,
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    id,
    summary: `recommendation ${id}`,
    approveLabel: 'Approve',
    ...overrides,
  }
}

export function makeUIEvent(id: string, overrides: Partial<UIEvent> = {}): UIEvent {
  return {
    id,
    ts: TS,
    source_signal_ids: [],
    type: 'status_update',
    timestamp: TS,
    severity: 'medium',
    title: `event ${id}`,
    message: `message ${id}`,
    confidence: 0.6,
    recommendation: null,
    ...overrides,
  }
}

export function makeRecommendationEvent(
  id: string,
  overrides: Partial<UIEvent> = {},
): UIEvent {
  return makeUIEvent(id, {
    type: 'recommendation_created',
    recommendation: makeRecommendation(`rec-${id}`),
    ...overrides,
  })
}

export function makeEmbeddingSnapshot(
  id: string,
  overrides: Partial<OsintEmbeddingSnapshot> = {},
): OsintEmbeddingSnapshot {
  return {
    id,
    ts: TS,
    points: [
      { signal_id: 's1', summary: 'p1', cluster_id: 0, x: 0.1, y: 0.2, ts: TS },
    ],
    cluster_count: 1,
    similarity_threshold: 0.42,
    model_name: 'all-MiniLM',
    embedding_dim: 384,
    ...overrides,
  }
}

export function makeKBEntry(id: string, overrides: Partial<KBEntry> = {}): KBEntry {
  return {
    id,
    actor: 'RED',
    capability_type: 'co-orbital',
    title: `kb ${id}`,
    summary: `summary ${id}`,
    ...overrides,
  }
}

export function makeManeuverDemo(overrides: Partial<ManeuverDemo> = {}): ManeuverDemo {
  return {
    decisionId: 'dec-1',
    startedAt: 1_700_000_000_000,
    durationMs: 8000,
    preMissKm: 12,
    postMissKm: 80,
    dvMs: 5,
    demoType: 'evasion',
    ...overrides,
  }
}
