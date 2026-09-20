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
  /** Closely-spaced objects (§5.4): the identities a cue could belong to when it names no satellite. */
  candidate_satellite_ids?: string[] | null
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
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4): `U`, `CUI` or
   *  `CUI//SP-<CATEGORY>[/SP-<CATEGORY>...]`, combined by
   *  `lib/marking.ts`. The engine sets it on every event; optional so
   *  fixtures predating it stay valid. */
  marking?: string
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
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4); optional so fixtures predating it stay valid. */
  marking?: string
  kind: string
  source_signal: string
  source_signal_ids: string[]
  severity: number
  payload: Record<string, unknown>
}

// Knowledge-base provenance (docs/INTERFACE-SPEC.md §5.3). Mirrors the
// Python `KBRef`: the knowledge-base file an attribution's citations resolve
// against. The same record is served by `GET /health` (`kb`).
export type KBRef = {
  /** `CANOPY_KB_PATH` as configured; null for a knowledge base built in memory. */
  path: string | null
  /** Absolute form of `path`; null for an in-memory knowledge base. */
  resolved: string | null
  /** Hex SHA-256 of the file bytes (of the canonical entry JSON when in memory). */
  sha256: string
  entry_count: number
  /** Entries other than the uncertainty anchor; 0 means no actor may be named. */
  actor_entry_count: number
}

export type Attribution = {
  id: string
  ts: string
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4); optional so fixtures predating it stay valid. */
  marking?: string
  anomaly_ids: string[]
  actor: string
  confidence: number
  doctrine_match: string | null
  evidence: string[]
  predicted_next: string | null
  kb_citations: string[]
  // Knowledge-base provenance (1.4): the engine sets it on every published
  // attribution; optional so fixtures predating it stay valid.
  kb_ref?: KBRef | null
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
  // Closely-spaced objects (docs/INTERFACE-SPEC.md §5.4, spec 1.4): set only
  // on an attribution the engine could not key to one satellite, from the
  // candidate sets of the cues in its batch; the panel reads "A or B,
  // unresolved" from it. Optional so fixtures predating it stay valid.
  candidate_satellite_ids?: string[] | null
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

// A recovery the internal diagnosis recommended that the decide stage did
// not route (docs/INTERFACE-SPEC.md §6, spec 1.3 / wave 4B). Set when the
// cluster carries a `recommended_recovery` but the decision is not a
// recovery: the verdict is hostile or unknown, or a gate rule would block
// it. `reason_code` is one of `verdict/hostile_external`, `verdict/unknown`,
// `threat/uplink_jamming_active`, `threat/hostile_close_approach`.
export type WithheldRecovery = {
  action_id: string
  target_subsystem: string
  reason_code: string
  source?: 'internal-diagnosis'
}

export type Decision = {
  id: string
  ts: string
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4); optional so fixtures predating it stay valid. */
  marking?: string
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
  // Recovery recommended by the internal diagnosis but withheld by the
  // decide stage (§6). Null or absent when nothing was withheld.
  withheld_recovery?: WithheldRecovery | null
  // Mirrors the revision of the attribution this decision was made for; the
  // decision id is stable across revisions (wave 3A).
  revision?: number
  // Bounded response (docs/INTERFACE-SPEC.md §6, spec 1.4): the actions this
  // decision was legitimately drawn from and why that set applied. The basis
  // is one of `recovery-routed`, `model-within-set`,
  // `model-outside-set-repaired`, `gate-withheld:<reason_code>`. Null or
  // absent on decisions recorded before 1.4.
  selectable_set?: Action[] | null
  selection_basis?: string | null
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
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4); optional so fixtures predating it stay valid. */
  marking?: string
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
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4); optional so fixtures predating it stay valid. */
  marking?: string
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
  /** Marking (docs/INTERFACE-SPEC.md §1.1, spec 1.4); optional so fixtures predating it stay valid. */
  marking?: string
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
