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

// ---------------------------------------------------------------------------
// Wave 4D: bus-health signal (docs/INTERFACE-SPEC.md §3) for the card, the
// spacecraft page and the feed. Defaults are the spec's example record with
// the demo identity (SIM-01).
// ---------------------------------------------------------------------------

export const SIM01 = 'ctb://megalith.demo/sim-01'

export const BELIEF_BASIS =
  'belief:internal=0.81;external=0.08;unknown=0.10;top=amplifier_degradation:0.75;w_belief=0.60;shape=ramp;shape_support=0.80;fit_quality=1.00;row=link_margin_drop;rate=slope'

export const HOSTILE_BELIEF_BASIS =
  'belief:internal=0.11;external=0.79;unknown=0.10;top=uplink_interference:0.56;w_belief=0.60;shape=step;shape_support=0.25;fit_quality=1.00;row=link_margin_drop;rate=step_per_interval'

export function makeBusHealthSignal(
  id: string,
  {
    observables = {},
    payload = {},
    ...overrides
  }: Partial<Omit<Signal, 'payload'>> & {
    observables?: Record<string, unknown>
    payload?: Partial<Signal['payload']>
  } = {},
): Signal {
  return makeSignal(id, {
    domain: 'bus_health',
    source: 'internal-diagnosis',
    confidence: 0.81,
    location: { label: 'SIM-01' },
    payload: {
      event_type: 'link_margin_drop',
      summary:
        'SIM-01 downlink margin falling 0.42 dB/s since 14:32:10Z; consistent with amplifier degradation.',
      asset: 'SIM-01',
      satellite_id: SIM01,
      observables: {
        subsystem: 'comms',
        symptom: 'link_margin_db_drop',
        onset_ts: '2026-09-17T14:32:10Z',
        onset_clock_domain: 'simulation',
        sim_time_s: 812,
        rate_of_change: -0.42,
        rate_unit: 'dB/s',
        physics_consistency: 0.83,
        physics_basis: BELIEF_BASIS,
        shape: 'ramp',
        recommended_recovery: {
          action_id: 'switch_redundant_amplifier',
          target_subsystem: 'comms',
          requires_approval: true,
          rationale: 'Primary amplifier output trending down; redundant unit nominal.',
        },
        ...observables,
      },
      ...payload,
    },
    provenance: {
      source_id: 'internal-diagnosis',
      collector: 'megalith-bus-health-adapter',
      method: 'rule_fdir+belief',
    },
    ...overrides,
  })
}
