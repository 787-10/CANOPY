// GENERATED FILE. Do not edit by hand.
// Source: the pydantic event models in canopy/services/schemas/events.py, served by
//   GET /schemas (canopy/api/schemas.py) in serialization mode: every declared field
//   is present on the wire, null when unset, so nothing here is optional.
// Regenerate: cd external/canopy && uv run --no-sync python scripts/gen_ts_types.py
// Fixture: src/types/canopy.schemas.json (the schemas this file was generated from).
// Schema digest: sha256:eac9bfa87704642fbb68753a76c8cde1a736a86c3f22cf23b65e11ad6f9406df

/** Where the signal applies. Must include at least one localizer. */
export type Location = {
  label: string | null
  lat: number | null
  lng: number | null
  alt_km: number | null
  alt_m: number | null
  ce_m: number | null
  mgrs: string | null
  area_wkt: string | null
  [key: string]: unknown
}

/** Domain-specific observation. Carries the canonical event_type/summary. */
export type Payload = {
  event_type: string
  summary: string
  beat: string | null
  asset: string | null
  satellite_id: string | null
  candidate_satellite_ids: string[] | null
  observables: Record<string, unknown> | null
  [key: string]: unknown
}

/** Source traceability for a signal. */
export type Provenance = {
  source_id: string
  citation: string | null
  collector: string | null
  method: string | null
  references: string[]
  generated_at: string | null
  notes: string | null
  [key: string]: unknown
}

/** Canonical CANOPY Signal — matches services/bus/schemas/signal.schema.json. */
export type Signal = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  domain: 'sda' | 'orbit' | 'osint' | 'humint' | 'rf_ew' | 'cyber' | 'pnt' | 'satcom' | 'drone' | 'terrain' | 'bus_health' | 'space_weather'
  source: string
  realism: 'real_source' | 'mock_operational' | 'synthetic_orbital_overlay'
  confidence: number
  location: Location
  payload: Payload
  provenance: Provenance
  [key: string]: unknown
}

/** Canonical CANOPY Anomaly — matches services/bus/schemas/anomaly.schema.json. */
export type Anomaly = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  kind: string
  source_signal: string
  source_signal_ids: string[]
  severity: number
  payload: Record<string, unknown>
  [key: string]: unknown
}

/** Provenance of the knowledge base an attribution was reasoned against. Stamped on every published ``Attribution`` (docs/INTERFACE-SPEC.md §5.3). ``path`` is the knowledge-base file as configured (``CANOPY_KB_PATH``), ``resolved`` its absolute path and ``sha256`` the digest of the file bytes; a knowledge base built in memory has neither path and hashes the canonical JSON of its entries. ``actor_entry_count`` counts every entry other than the uncertainty anchor; when it is zero the attrib stage withholds any named actor at publish. */
export type KBRef = {
  path: string | null
  resolved: string | null
  sha256: string
  entry_count: number
  actor_entry_count: number
  [key: string]: unknown
}

/** Attribution assessment for an anomaly cluster. */
export type Attribution = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  anomaly_ids: string[]
  actor: string
  confidence: number
  doctrine_match: string | null
  evidence: string[]
  predicted_next: string | null
  kb_citations: string[]
  kb_ref: KBRef | null
  source_signal_ids: string[]
  verdict: 'internal_fault' | 'natural_external' | 'hostile_external' | 'unknown' | null
  physics_consistency: number | null
  verdict_basis: 'rule' | 'reasoning' | null
  verdict_evidence: string[]
  satellite_id: string | null
  candidate_satellite_ids: string[] | null
  provisional: boolean
  revision: number
  [key: string]: unknown
}

/** Red-team agent's critique of a primary attribution. Emitted as part of the multi-agent attribution loop: primary → red-team → reconciler. Lives on the bus only as a trace payload (i.e., as the structured input to the reconciler); it is *not* published as a top-level bus event so downstream services that listen on ``attributions.*`` see only the final reconciled attribution. */
export type AttributionChallenge = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  primary_attribution_id: string
  alternative_actor: string | null
  objections: string[]
  confidence_delta: number
  rationale: string
  [key: string]: unknown
}

/** The internal-diagnosis recovery a ``recovery_recommendation`` carries. Copied from the ``recommended_recovery`` observable of the bus-health anomaly that triggered it (docs/INTERFACE-SPEC.md §3, §6). ``source`` is fixed: only the internal-diagnosis lane proposes recoveries. */
export type RecoveryBlock = {
  action_id: string
  target_subsystem: string
  requires_approval: boolean
  rationale: string
  source: 'internal-diagnosis'
  satellite_id: string | null
  [key: string]: unknown
}

/** A recovery the internal diagnosis recommended and the decide stage withheld. Set on a Decision whose cluster carries a ``recommended_recovery`` but whose action is not ``recovery_recommendation`` (docs/INTERFACE-SPEC.md §6, wave 4B): the verdict is ``hostile_external`` or ``unknown``, or a threat-context gate rule (§7) would block the recovery. ``reason_code`` is one of ``threat/uplink_jamming_active``, ``threat/hostile_close_approach``, ``verdict/hostile_external``, ``verdict/unknown``; the console renders a label for it. Never coexists with ``recovery``. */
export type WithheldRecovery = {
  action_id: string
  target_subsystem: string
  reason_code: string
  source: 'internal-diagnosis'
  [key: string]: unknown
}

/** Recommended action for an attribution. */
export type Decision = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  attribution_id: string
  action: 'passive_defense' | 'active_defense_escort' | 'active_defense_counterattack' | 'orbital_strike_request' | 'terrestrial_strike_request' | 'space_link_interdiction_request' | 'sda_tasking' | 'threat_warning' | 'recovery_recommendation'
  target: string
  rationale: string
  authority: 'local' | 'request'
  request_packet: Record<string, unknown> | null
  source_signal_ids: string[]
  recovery: RecoveryBlock | null
  withheld_recovery: WithheldRecovery | null
  revision: number
  selectable_set: Array<'passive_defense' | 'active_defense_escort' | 'active_defense_counterattack' | 'orbital_strike_request' | 'terrestrial_strike_request' | 'space_link_interdiction_request' | 'sda_tasking' | 'threat_warning' | 'recovery_recommendation'> | null
  selection_basis: string | null
  [key: string]: unknown
}

/** Optional recommendation surfaced to the operator on a UIEvent. */
export type Recommendation = {
  id: string
  summary: string
  approveLabel: string
  [key: string]: unknown
}

/** Frontend-facing event — matches data/expected_ui_events.json shape. Field names use camelCase where the existing fixture does (demoBeat, approveLabel) so the frontend can read either source interchangeably. */
export type UIEvent = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  source_signal_ids: string[]
  type: 'threat_updated' | 'recommendation_created' | 'status_update'
  /** ISO-8601 date-time (UTC). */
  timestamp: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  title: string
  message: string
  confidence: number
  demoBeat: string | null
  recommendation: Recommendation | null
  [key: string]: unknown
}

/** A single line of agent / tool reasoning. Streams in real time on the bus topic ``traces.{stage}`` and is rendered by the frontend's terminal-styled reasoning panel. Every visible step that contributes to an attribution or decision should produce one trace so the resulting log is the auditable explanation of why the engine arrived at its assessment. */
export type ReasoningTrace = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  stage: 'fusion' | 'attrib_primary' | 'attrib_redteam' | 'attrib_reconcile' | 'decide' | 'tools' | 'stress'
  level: 'info' | 'decision' | 'tool' | 'warn'
  message: string
  ref_id: string | null
  payload: Record<string, unknown>
  [key: string]: unknown
}

/** A single OSINT signal projected to 2D via PCA for visualization. */
export type EmbeddingPoint = {
  signal_id: string
  summary: string
  cluster_id: number
  x: number
  y: number
  /** ISO-8601 date-time (UTC). */
  ts: string
  [key: string]: unknown
}

/** A snapshot of the OSINT semantic clustering window. Emitted every time a new OSINT signal is ingested and clustered. Carries the entire current sliding window — points, cluster assignments, and PCA-projected (x, y) coordinates — so the frontend can render a complete scatter plot from a single event without needing to maintain its own incremental projection. */
export type OsintEmbeddingSnapshot = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  points: EmbeddingPoint[]
  cluster_count: number
  similarity_threshold: number
  model_name: string
  embedding_dim: number
  [key: string]: unknown
}

/** An engine-owned position sample for one spacecraft (spec §10, 1.4.4). ``ts`` is the *scenario* time of the state. The engine propagates the same circular model the synthetic track files come from (``elements`` is the file's defining pass) and publishes a sample on a cadence while a replay is in progress, so the console draws what the engine states rather than what it computes itself; the console's own port is the fallback with no run. Synthetic spacecraft only: never a TLE, never a catalogue number. */
export type Ephemeris = {
  id: string
  /** ISO-8601 date-time (UTC). */
  ts: string
  /** Marking: U, CUI or CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]; a derived event carries the most restrictive marking of its inputs (docs/INTERFACE-SPEC.md 1.1). */
  marking: string
  satellite_id: string
  source: 'circular-model'
  lat: number
  lng: number
  alt_km: number
  speed_km_s: number
  elements: Record<string, unknown>
  /** ISO-8601 date-time (UTC). */
  published_at: string
  [key: string]: unknown
}

/** Bus codec kinds: the `kind` tag of every WebSocket envelope. */
export const EVENT_KINDS = [
  'signal',
  'anomaly',
  'attribution',
  'attribution_challenge',
  'decision',
  'ui_event',
  'trace',
  'embedding',
  'ephemeris',
] as const

export type EventKind = (typeof EVENT_KINDS)[number]

export type EventByKind = {
  signal: Signal
  anomaly: Anomaly
  attribution: Attribution
  attribution_challenge: AttributionChallenge
  decision: Decision
  ui_event: UIEvent
  trace: ReasoningTrace
  embedding: OsintEmbeddingSnapshot
  ephemeris: Ephemeris
}

/** The WebSocket envelope (docs/INTERFACE-SPEC.md §10): `{kind, topic, data}`. */
export type Envelope<K extends EventKind = EventKind> = K extends EventKind
  ? { kind: K; topic: string; data: EventByKind[K] }
  : never
