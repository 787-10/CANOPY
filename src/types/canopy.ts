// Vocabulary mirrored from canopy/services/schemas/events.py. The Python
// `Literal[...]`s are the source of truth; DOMAINS / ACTIONS repeat their
// members in the same order and the union types are derived from them, so a
// member can't exist at runtime without also being part of the type (and
// vice versa). `canopy.parity.test.ts` checks the arrays against the Python
// file on disk.
export const DOMAINS = [
  'sda',
  'orbit',
  'osint',
  'humint',
  'rf_ew',
  'cyber',
  'pnt',
  'satcom',
  'drone',
  'terrain',
  'bus_health',
  'space_weather',
] as const satisfies readonly string[]

export type Domain = (typeof DOMAINS)[number]

export const ACTIONS = [
  'passive_defense',
  'active_defense_escort',
  'active_defense_counterattack',
  'orbital_strike_request',
  'terrestrial_strike_request',
  'space_link_interdiction_request',
  'sda_tasking',
  'threat_warning',
  'recovery_recommendation',
] as const satisfies readonly string[]

export type Action = (typeof ACTIONS)[number]

// Three-way verdict on an anomaly cluster (docs/INTERFACE-SPEC.md §5).
// `VerdictBasis` records whether the deterministic rule lane or the LLM
// reasoning lane set the final value.
export type Verdict =
  | 'internal_fault'
  | 'natural_external'
  | 'hostile_external'
  | 'unknown'

export type VerdictBasis = 'rule' | 'reasoning'

export type Realism =
  | 'real_source'
  | 'mock_operational'
  | 'synthetic_orbital_overlay'

export type UISeverity = 'low' | 'medium' | 'high' | 'critical'

export type Authority = 'local' | 'request'

export type SignalLocation = {
  label?: string
  lat?: number
  lng?: number
  alt_km?: number
  alt_m?: number
  ce_m?: number
  mgrs?: string
  area_wkt?: string
  [key: string]: unknown
}

export type SignalPayload = {
  event_type: string
  summary: string
  beat?: string
  asset?: string
  /** `ctb://<authority>/<spacecraft-id>` (docs/INTERFACE-SPEC.md §1). */
  satellite_id?: string | null
  observables?: Record<string, unknown>
  [key: string]: unknown
}

export type SignalProvenance = {
  source_id: string
  citation?: string | null
  collector?: string
  method?: string
  references?: string[]
  generated_at?: string
  notes?: string
  [key: string]: unknown
}

export type Signal = {
  id: string
  ts: string
  domain: Domain
  source: string
  realism: Realism
  confidence: number
  location: SignalLocation
  payload: SignalPayload
  provenance: SignalProvenance
}

export type Anomaly = {
  id: string
  ts: string
  kind: string
  source_signal: string
  source_signal_ids: string[]
  severity: number
  payload: Record<string, unknown>
}

export type Attribution = {
  id: string
  ts: string
  anomaly_ids: string[]
  actor: string
  confidence: number
  doctrine_match: string | null
  evidence: string[]
  predicted_next: string | null
  kb_citations: string[]
  source_signal_ids: string[]
  // Three-way verdict (docs/INTERFACE-SPEC.md §5). Optional so pre-existing
  // fixtures and scenarios stay valid; the engine serializes unset values as
  // null and `verdict_evidence` as an empty list.
  verdict?: Verdict | null
  /** 0..1, copied from the strongest bus anomaly in the cluster. */
  physics_consistency?: number | null
  verdict_basis?: VerdictBasis | null
  verdict_evidence?: string[]
  satellite_id?: string | null
  // Fast lane (wave 3A). A provisional attribution is the rule lane's call,
  // published before any LLM ran; the reasoning lane republishes the SAME id
  // with `provisional: false` and a higher `revision`. The store replaces an
  // entry by id, so a card updates in place. Optional so fixtures predating
  // the lane stay valid; the engine always serializes both (false / 0).
  provisional?: boolean
  revision?: number
}

// Recovery recommendation carried by a `recovery_recommendation` decision
// (docs/INTERFACE-SPEC.md §6). Mirrors the Python `RecoveryBlock`; the
// engine always sets `source` to "internal-diagnosis".
export type RecoveryBlock = {
  action_id: string
  target_subsystem: string
  requires_approval: boolean
  rationale: string
  source?: 'internal-diagnosis'
  satellite_id?: string | null
}

export type Decision = {
  id: string
  ts: string
  attribution_id: string
  action: Action
  target: string
  rationale: string
  authority: Authority
  request_packet: Record<string, unknown> | null
  source_signal_ids: string[]
  // Present only when `action === "recovery_recommendation"`; the engine
  // serializes it as null for every other action. A decision the
  // threat-context gate blocked is republished as `threat_warning` with
  // `recovery: null` and a `[gate:<reason_code>] ` rationale prefix (§7).
  recovery?: RecoveryBlock | null
  // Mirrors the revision of the attribution this decision was made for; the
  // decision id is stable across revisions (wave 3A).
  revision?: number
}

export type TraceStage =
  | 'fusion'
  | 'attrib_primary'
  | 'attrib_redteam'
  | 'attrib_reconcile'
  | 'decide'
  | 'tools'
  | 'stress'

export type TraceLevel = 'info' | 'decision' | 'tool' | 'warn'

export type ReasoningTrace = {
  id: string
  ts: string
  stage: TraceStage
  level: TraceLevel
  message: string
  ref_id: string | null
  payload: Record<string, unknown>
}

export type EmbeddingPoint = {
  signal_id: string
  summary: string
  cluster_id: number
  x: number
  y: number
  ts: string
}

export type OsintEmbeddingSnapshot = {
  id: string
  ts: string
  points: EmbeddingPoint[]
  cluster_count: number
  similarity_threshold: number
  model_name: string
  embedding_dim: number
}

export type Recommendation = {
  id: string
  summary: string
  approveLabel: string
}

export type UIEvent = {
  id: string
  ts: string
  source_signal_ids: string[]
  type: 'threat_updated' | 'recommendation_created' | 'status_update'
  timestamp: string
  severity: UISeverity
  title: string
  message: string
  confidence: number
  demoBeat?: string | null
  recommendation?: Recommendation | null
}

export type CanopyMessage =
  | { type: 'signal'; topic?: string; data: Signal }
  | { type: 'anomaly'; topic?: string; data: Anomaly }
  | { type: 'attribution'; topic?: string; data: Attribution }
  | { type: 'decision'; topic?: string; data: Decision }
  | { type: 'ui_event'; topic?: string; data: UIEvent }
  | { type: 'trace'; topic?: string; data: ReasoningTrace }
  | { type: 'embedding'; topic?: string; data: OsintEmbeddingSnapshot }

export type CanopySocketState = {
  signals: Signal[]
  anomalies: Anomaly[]
  attributions: Attribution[]
  decisions: Decision[]
  uiEvents: UIEvent[]
  traces: ReasoningTrace[]
  isConnected: boolean
  lastError: string | null
}

export type ConnectionStatus = 'connecting' | 'live' | 'fixture' | 'offline'

export type ViewMode = 'brigade' | 'operator'

export type KBEntry = {
  id: string
  actor: string
  capability_type: string
  title: string
  summary: string
  decision_implications?: string[]
  domains?: Domain[]
  scenario_signal_ids?: string[]
  [key: string]: unknown
}

export type RecommendedBurn = {
  sat?: string
  against?: string
  dv_m_s?: number
  t_burn_utc?: string
  lead_seconds?: number | null
  actual_lead_seconds?: number | null
}

export type RequestPacket = {
  recommended_burn?: RecommendedBurn
  pre_miss_km?: number
  post_miss_km?: number
  [key: string]: unknown
}

export type WSEnvelope =
  | { topic: string; kind: 'signal'; data: Signal }
  | { topic: string; kind: 'anomaly'; data: Anomaly }
  | { topic: string; kind: 'attribution'; data: Attribution }
  | { topic: string; kind: 'decision'; data: Decision }
  | { topic: string; kind: 'ui_event'; data: UIEvent }
  | { topic: string; kind: 'trace'; data: ReasoningTrace }
  | { topic: string; kind: 'embedding'; data: OsintEmbeddingSnapshot }
