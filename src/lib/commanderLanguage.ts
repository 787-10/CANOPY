import type {
  Attribution,
  Domain,
  ReasoningTrace,
  Signal,
  UIEvent,
  Verdict,
  VerdictBasis,
  WithheldRecovery,
} from '../types/canopy'

const domainCopy: Record<
  Domain,
  { label: string; meaning: string; commanderQuestion: string }
> = {
  orbit: {
    label: 'Satellite proximity',
    meaning: 'A satellite or nearby object may affect friendly space support.',
    commanderQuestion: 'Could this disrupt ISR, warning, or communications?',
  },
  sda: {
    label: 'Satellite custody',
    meaning: 'Space tracking or overhead warning changed.',
    commanderQuestion: 'Does the brigade need space support attention?',
  },
  rf_ew: {
    label: 'EW interference',
    meaning: 'Enemy jamming or interference may be affecting links.',
    commanderQuestion: 'Are radios, drones, or SATCOM starting to degrade?',
  },
  cyber: {
    label: 'Cyber access probe',
    meaning: 'A command, fires, or space-support system is being probed.',
    commanderQuestion: 'Should automated handoffs be slowed or checked?',
  },
  osint: {
    label: 'Threat context',
    meaning: 'Open or correlated reporting changed the threat picture.',
    commanderQuestion: 'Does this change the commander’s risk estimate?',
  },
  humint: {
    label: 'Human report',
    meaning: 'A human-source report adds collection or targeting context.',
    commanderQuestion: 'Does this support a pause, mask, or emit less order?',
  },
  pnt: {
    label: 'GPS / timing risk',
    meaning: 'Position, navigation, or timing may not be trustworthy.',
    commanderQuestion: 'Can we trust coordinates for movement or fires?',
  },
  satcom: {
    label: 'SATCOM degradation',
    meaning: 'Beyond-line-of-sight communications are degrading.',
    commanderQuestion: 'Do we need a backup path or space-link request?',
  },
  drone: {
    label: 'UAS / relay status',
    meaning: 'UAS or relay behavior changed at the edge.',
    commanderQuestion: 'Is ISR still reaching the brigade?',
  },
  terrain: {
    label: 'Masking risk',
    meaning: 'Terrain may block line-of-sight or relay coverage.',
    commanderQuestion: 'Should the relay geometry change?',
  },
  bus_health: {
    label: 'Spacecraft health',
    meaning: 'Onboard telemetry shows a satellite subsystem degrading or faulting.',
    commanderQuestion: 'Is this an internal fault or something acting on the satellite?',
  },
  space_weather: {
    label: 'Space weather',
    meaning: 'Solar or geomagnetic activity may be affecting satellites, links, or GPS.',
    commanderQuestion: 'Could the environment explain this before assuming attack?',
  },
}

// ---------------------------------------------------------------------------
// Event-type copy for the two spacecraft-environment domains
// (docs/INTERFACE-SPEC.md §3 and §4). Domain copy above is the fallback for
// event types not listed here. `tier` is the map-effect severity the event
// deserves on its own (signalEffects.ts consumes danger/watch sets); the
// wording stays neutral: a bus symptom or a storm is never described as an
// attack, that call belongs to the verdict.
// ---------------------------------------------------------------------------

export type EventTypeCopy = {
  label: string
  meaning: string
  commanderQuestion: string
  tier: 'nominal' | 'watch' | 'danger'
}

export const BUS_HEALTH_EVENT_TYPES = [
  'link_margin_drop',
  'sensor_saturation',
  'attitude_disturbance',
  'unexpected_reset',
  'power_thermal_excursion',
  'orbit_decay',
  'safe_mode_entry',
] as const

export type BusHealthEventType = (typeof BUS_HEALTH_EVENT_TYPES)[number]

export const SPACE_WEATHER_EVENT_TYPES = [
  'geomagnetic_storm',
  'solar_radio_burst',
  'radiation_enhancement',
  'density_enhancement',
] as const

export type SpaceWeatherEventType = (typeof SPACE_WEATHER_EVENT_TYPES)[number]

const busHealthEventCopy: Record<BusHealthEventType, EventTypeCopy> = {
  link_margin_drop: {
    label: 'Link margin drop',
    meaning:
      'Downlink or uplink margin is falling faster than the pass geometry explains.',
    commanderQuestion:
      'Is the transmitter degrading, or is something on the ground or in the environment eating the margin?',
    tier: 'watch',
  },
  sensor_saturation: {
    label: 'Sensor saturation',
    meaning:
      'A sensor is pinned at its limit and its readings cannot be trusted.',
    commanderQuestion:
      'Is the sensor itself failing, or is it being flooded by a bright or noisy source?',
    tier: 'watch',
  },
  attitude_disturbance: {
    label: 'Attitude disturbance',
    meaning:
      'The spacecraft pointing moved in a way the control loop did not command.',
    commanderQuestion:
      'Is a wheel or thruster misbehaving, or is an outside force acting on the vehicle?',
    tier: 'watch',
  },
  unexpected_reset: {
    label: 'Unexpected reset',
    meaning: 'A flight computer or subsystem rebooted without a command.',
    commanderQuestion:
      'Did a component fault, a radiation hit, or an outside command cause the reset?',
    tier: 'danger',
  },
  power_thermal_excursion: {
    label: 'Power / thermal excursion',
    meaning: 'Bus power or temperature moved outside its expected band.',
    commanderQuestion:
      'Is a battery, panel, or heater failing, or is the environment driving it?',
    tier: 'watch',
  },
  orbit_decay: {
    label: 'Orbit decay',
    meaning: 'Altitude is dropping faster than the predicted drag.',
    commanderQuestion:
      'Is atmospheric density up, or is the spacecraft venting or thrusting on its own?',
    tier: 'watch',
  },
  safe_mode_entry: {
    label: 'Safe mode entry',
    meaning:
      'The spacecraft dropped to a minimal protective mode; mission support from it is paused.',
    commanderQuestion:
      'What tripped safe mode, and how long until support from this satellite returns?',
    tier: 'danger',
  },
}

const spaceWeatherEventCopy: Record<SpaceWeatherEventType, EventTypeCopy> = {
  geomagnetic_storm: {
    label: 'Geomagnetic storm',
    meaning:
      'A geomagnetic storm is in progress; drag, spacecraft charging, and GPS accuracy all degrade during it.',
    commanderQuestion:
      'Could the storm explain satellite, GPS, or link symptoms before anything else is assumed?',
    tier: 'watch',
  },
  solar_radio_burst: {
    label: 'Solar radio burst',
    meaning:
      'The Sun is emitting strong radio noise; GPS and some links degrade on the sunlit side.',
    commanderQuestion:
      'Are link or GPS symptoms on the sunlit side lining up with this burst?',
    tier: 'watch',
  },
  radiation_enhancement: {
    label: 'Radiation enhancement',
    meaning:
      'Energetic particle flux is elevated; single-event upsets and resets become more likely.',
    commanderQuestion:
      'Could a radiation hit explain a reset or sensor problem on the affected satellite?',
    tier: 'watch',
  },
  density_enhancement: {
    label: 'Atmospheric density increase',
    meaning:
      'Upper-atmosphere density is elevated, so low-orbit drag and decay increase.',
    commanderQuestion:
      'Does this account for faster orbit decay before anything else is assumed?',
    tier: 'watch',
  },
}

const eventTypeCopyTable: Record<string, EventTypeCopy> = {
  ...busHealthEventCopy,
  ...spaceWeatherEventCopy,
}

/** Event-type copy for the bus_health and space_weather vocabularies; null
 *  for every other event type (callers fall back to domain copy). */
export function eventTypeCopy(eventType: string): EventTypeCopy | null {
  return eventTypeCopyTable[eventType] ?? null
}

/** Map-effect tier an event type earns on its own, independent of
 *  confidence. Only the spacecraft-environment event types are tiered here;
 *  the legacy danger/watch sets live in signalEffects.ts. */
export function eventTypeWatchTier(eventType: string): EventTypeCopy['tier'] {
  return eventTypeCopyTable[eventType]?.tier ?? 'nominal'
}

/** The question a commander should be asking about this report. Event-type
 *  copy wins over the domain default. */
export function commanderQuestion(signal: Signal): string {
  return (
    eventTypeCopy(signal.payload.event_type)?.commanderQuestion ??
    domainCopy[signal.domain].commanderQuestion
  )
}

const meaningOverrides = (
  table: Record<string, EventTypeCopy>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(table).map(([eventType, copy]) => [eventType, copy.meaning]),
  )

const eventTypeOverrides: Record<string, string> = {
  ...meaningOverrides(busHealthEventCopy),
  ...meaningOverrides(spaceWeatherEventCopy),
  alternate_pnt_check: 'Non-GPS navigation check completed.',
  alternate_pnt_restored: 'Alternate navigation is stable enough for limited movement.',
  approach_masking_check: 'Terrain creates a low-altitude approach gap.',
  attack_chain_commander_update: 'Commander update recommends defensive hold.',
  attack_chain_correlation: 'Cross-domain anomalies form a developing attack chain.',
  autonomous_relay_handoff: 'Drone relay switched to preserve ISR flow.',
  aor_commander_update: 'AOR update recommends degraded but manageable operations.',
  backup_asset_ready: 'Backup drone is ready if the primary degrades.',
  backup_link_check: 'Backup SATCOM path is available at limited capacity.',
  base_defense_posture_change: 'Base defense posture changed under degraded space support.',
  base_defense_recovery_update: 'Base warning and track custody held through degradation.',
  blockade_notice: 'Theater warning starts the convoy space-support clock.',
  c5isr_commander_update: 'Degraded C5ISR operating recommendation issued.',
  close_approach_assessment: 'Space object proximity and SATCOM degradation are linked.',
  commander_orbit_cue: 'Orbit cue framed for commander action.',
  commander_update: 'Commander update escalates the convergence picture.',
  concealment_route_check: 'Covered movement route reduces overhead exposure.',
  collection_cue: 'Collection cue aligns with the operating window.',
  collection_risk_assessment: 'MEGALITH recommends reducing collection exposure.',
  convergence: 'Cross-domain anomalies converged in one window.',
  counterspace_capability_context: 'Known counterspace capability is relevant to this fight.',
  credential_probe: 'A key command or support system is being probed.',
  credential_spray: 'Login attacks are rising against a mission system.',
  cross_sensor_position_check: 'Drone sensors confirm GPS is the suspect input.',
  custody_quality_change: 'Space custody quality changed.',
  custody_update: 'Space custody remains inside the watch geometry.',
  cyber_response_action: 'Mission system moved into a hardened profile.',
  degraded_telemetry: 'Drone telemetry is degraded.',
  drone_spoofing: 'Drone identity or track does not look trustworthy.',
  drone_track_custody_split: 'Local sensors keep custody of an unreliable UAS track.',
  emission_cluster_detected: 'Active emitters remain inside collection footprint.',
  emission_posture_risk: 'Active emitters raise overhead collection risk.',
  ew_bearing_refined: 'EW bearing narrowed the interference area.',
  fdir_assessment: 'MEGALITH believes this is interference, not drone failure.',
  fdir_mission_update: 'FDIR update keeps ISR moving with backup staged.',
  fdir_recovery_action: 'Drone isolated bad navigation input and recovered.',
  gateway_config_probe: 'Gateway configuration service is being probed.',
  gateway_latency_rise: 'Gateway latency is rising during the watch window.',
  gateway_pressure_assessment: 'Gateway pressure is multi-domain but defensive.',
  gateway_recovery_assessment: 'Gateway stayed connected in protected mode.',
  gnss_jamming_signature: 'GPS jamming pattern detected.',
  gps_spoof: 'GPS position appears false or shifted.',
  imagery_request_update: 'Imagery request urgency increased collection risk.',
  isr_product_quality_gate: 'ISR stays connected but coordinates are low confidence.',
  line_of_sight_forecast: 'Relay line of sight will degrade soon.',
  local_cache_confirmed: 'Local overhead-warning cache is confirmed.',
  local_route_report: 'Local route congestion is affecting convoy timing.',
  low_rate_mode_active: 'Gateway entered protected low-rate mode.',
  maintenance_api_rate_limit: 'Gateway API rate limits are protecting access.',
  maritime_space_picture_shift: 'Space-derived maritime picture changed.',
  militia_uas_risk_context: 'Militia UAS threat context raises base-defense posture.',
  multi_domain_attack_assessment: 'MEGALITH fused the multi-domain attack chain.',
  observer_feed_quality_drop: 'Observer video quality is starting to drop.',
  overhead_collection_window: 'Adversary collection window is opening overhead.',
  overhead_ir_cue: 'Overhead warning detected possible inbound UAS activity.',
  overhead_warning_quality_drop: 'Overhead warning refresh rate is slowing.',
  orbital_context_shift: 'Orbital phasing now matters to the ground picture.',
  orbital_setup: 'Baseline orbital pass geometry established.',
  pnt_spoofing: 'GPS timing or position appears manipulated.',
  post_pass_collection_update: 'Post-pass update shows exposure controls worked.',
  priority_path_confirmed: 'Priority SATCOM path is keeping updates moving.',
  process_anomaly: 'Mission endpoint process behavior changed.',
  procurement_report: 'Human report indicates imagery demand over the support area.',
  proximity_operations: 'Nearby space object is maneuvering close to friendly support.',
  public_report: 'Public disruption reporting adds context.',
  receiver_holdover_active: 'Gateway timing switched to holdover.',
  relay_commander_update: 'Relay update confirms observer feed restoration.',
  relay_candidate_ready: 'A better drone relay is ready.',
  relay_mesh_status: 'Drone relay mesh status changed.',
  relay_resilience_assessment: 'MEGALITH confirms relay resilience held.',
  response_action: 'Mission cell hardened the gateway profile.',
  rf_bearing_crosscheck: 'EW bearing cross-check narrowed the affected area.',
  rpo_close_approach: 'Nearby space object entered the protected watch box.',
  route_chokepoint_check: 'Route chokepoints raise PNT-dependent convoy risk.',
  satcom_degradation: 'SATCOM link quality is degrading.',
  satcom_link_margin_drop: 'SATCOM link margin dropped.',
  satcom_priority_queue: 'SATCOM shifted to priority message queue.',
  satcom_queue_pressure: 'SATCOM queue delay is an early warning.',
  satcom_rf_spike: 'RF spike overlaps SATCOM backup routing.',
  satcom_route_shed: 'SATCOM shed nonessential traffic to preserve command updates.',
  sda_catalog_match: 'Orbital catalog match supports collection risk.',
  screening_overlay: 'Space screening overlay entered the watch shell.',
  space_support_option: 'Alternate space-support pass is available soon.',
  space_enabled_base_defense_assessment: 'MEGALITH fused the base-defense space-support problem.',
  space_support_hold_recommendation: 'MEGALITH recommends a space-support hold.',
  terrain_masking_risk: 'Terrain may block the current relay path.',
  telemetry_degradation: 'Telemetry quality is degrading.',
  telemetry_update: 'Drone telemetry baseline established.',
  track_handoff_success: 'Track handoff preserved local sensor custody.',
  uas_control_link_detected: 'Possible UAS control link detected.',
  convoy_release_update: 'MEGALITH recommends limited convoy release.',
  ground_segment_baseline: 'Gateway baseline established.',
  iran_counter_c5isr_assessment: 'MEGALITH fused the counter-C5ISR event set.',
  missile_uas_capability_context: 'Missile and UAS capability context added.',
  osint_context: 'Public reporting adds context to the watch item.',
  pnt_rf_alignment: 'GPS and RF anomalies align on the same route.',
}

const actionByDomain: Record<Domain, string> = {
  orbit: 'Notify space support cell and protect backup comms.',
  sda: 'Keep overhead warning and custody feeds in the commander update.',
  rf_ew: 'Reduce emissions where possible and shift to hardened comms.',
  cyber: 'Hold automated tasking and verify mission-system access.',
  osint: 'Use as context, not proof; keep watching the next window.',
  humint: 'Confirm with other feeds before changing movement.',
  pnt: 'Do not trust GPS-only coordinates for movement or fires.',
  satcom: 'Prepare alternate BLOS path or request space-link support.',
  drone: 'Keep ISR moving through the healthiest relay node.',
  terrain: 'Move relay geometry or raise the drone if needed.',
  bus_health: 'Route to the space support cell for spacecraft recovery; do not assume attack.',
  space_weather: 'Treat as environmental context; check GPS, SATCOM, and satellite health against it.',
}

const sourceAliases: Record<string, string> = {
  'base-gnss-monitor': 'Base GPS monitor',
  'brigade-pnt-monitor': 'Brigade GPS monitor',
  'brigade-satcom-controller': 'Brigade SATCOM controller',
  'brigade-siem': 'Brigade cyber sensor',
  'brigade-spectrum-team': 'Brigade EW team',
  'bde-spectrum-team': 'Brigade EW team',
  'bde-siem': 'Brigade cyber sensor',
  'cached-aor-terrain': 'Terrain model',
  'canopy-correlation-engine': 'MEGALITH mission cell',
  'convoy-pnt-health-monitor': 'Convoy GPS monitor',
  'gateway-siem': 'Gateway cyber sensor',
  'gnss-integrity-fusion': 'GPS integrity fusion',
  'gnss-integrity-monitor': 'GPS integrity monitor',
  'gnss-monitor-guam': 'Guam GPS monitor',
  'gnss-monitor-luzon': 'Luzon GPS monitor',
  'joint-spectrum-operations-cell': 'Joint EW cell',
  'leo-custody-track': 'LEO custody track',
  'leo-telemetry-downlink': 'LEO telemetry monitor',
  'orbit-pass-screen': 'Space tracking cell',
  'rpo-close-approach-overlay': 'Space tracking cell',
  'satcom-network-controller': 'SATCOM controller',
  'space-track-cache': 'Space tracking cell',
  'spectrum-monitor-guam': 'Guam EW monitor',
  'telemetry-quality-monitor': 'Telemetry monitor',
  'uas-swarm-controller': 'UAS swarm controller',
}

const locationAliases: Record<string, string> = {
  'Brigade support area collection cone': 'Collection window',
  'CANOPY-LEO-07 downlink footprint': 'LEO downlink',
  'CANOPY-LEO-07 ground track': 'LEO support pass',
  'CANOPY-LEO-07 pass footprint': 'LEO pass',
  'CANOPY-LEO-07 relative motion frame': 'LEO close approach',
  'Division support area orbital track': 'LEO watch track',
  'Friendly LEO support architecture': 'LEO support',
  'Friendly LEO support relative motion frame': 'LEO close approach',
  'LEO pass over brigade support area': 'Overhead pass',
  'Base western perimeter': 'West sensors',
  'Overhead watch box west of base': 'Overhead warning area',
  'Western Pacific orbital custody box': 'LEO custody box',
  'Western Iraq base approach sector': 'Masked west approach',
}

const assetAliases: Record<string, string> = {
  'BASE-CUAS-SENSOR-NET': 'Base C-UAS sensors',
  'BDE-C2-GATEWAY': 'Brigade C2 gateway',
  'BDE-SATCOM-1': 'Brigade SATCOM',
  'BDE-UAS-MESH': 'Brigade drone mesh',
  'CANOPY-MISSION-CELL': 'MEGALITH mission cell',
  'GNSS-MON-LUZON-2': 'Luzon GPS monitor',
  'SPACE-PNT-SUPPORT': 'GPS support cell',
  'UAS-LINK-GROUP-B': 'UAS link group B',
}

export function domainLabel(domain: Domain): string {
  return domainCopy[domain].label
}

export function signalKindLabel(signal: Signal): string {
  if (signal.domain === 'rf_ew' && signal.payload.event_type === 'telemetry_degradation') {
    return 'Ground link frame loss'
  }
  if (signal.domain === 'rf_ew' && signal.payload.event_type === 'rf_interference') {
    return 'RF interference'
  }
  const typed = eventTypeCopy(signal.payload.event_type)
  if (typed) {
    return typed.label
  }

  switch (signal.payload.event_type) {
  case 'approach_masking_check':
    return 'Masked UAS lane'
  case 'attack_chain_correlation':
  case 'convergence':
    return 'Attack chain'
  case 'backup_link_check':
  case 'priority_path_confirmed':
    return 'Backup comms'
  case 'blockade_notice':
  case 'public_report':
  case 'osint_context':
    return 'Public report'
  case 'collection_cue':
  case 'collection_risk_assessment':
  case 'overhead_collection_window':
  case 'sda_catalog_match':
    return 'Collection risk'
  case 'counterspace_capability_context':
    return 'Counterspace threat'
  case 'credential_probe':
  case 'credential_spray':
  case 'gateway_config_probe':
  case 'maintenance_api_rate_limit':
  case 'process_anomaly':
    return 'Access probe'
  case 'custody_quality_change':
  case 'custody_update':
    return 'Satellite custody'
  case 'emission_cluster_detected':
  case 'emission_posture_risk':
    return 'Emission risk'
  case 'gnss_jamming_signature':
  case 'gps_spoof':
  case 'pnt_spoofing':
  case 'receiver_holdover_active':
    return 'GPS / timing risk'
  case 'maritime_space_picture_shift':
    return 'Maritime tracking'
  case 'militia_uas_risk_context':
  case 'missile_uas_capability_context':
    return 'Threat context'
  case 'orbital_setup':
  case 'space_support_option':
    return 'Satellite pass'
  case 'overhead_ir_cue':
  case 'overhead_warning_quality_drop':
    return 'Overhead warning'
  case 'proximity_operations':
  case 'rpo_close_approach':
  case 'screening_overlay':
    return 'Space object watch'
  case 'rf_bearing_crosscheck':
  case 'rf_interference':
  case 'ew_bearing_refined':
  case 'satcom_rf_spike':
  case 'uas_control_link_detected':
    return 'EW interference'
  case 'satcom_degradation':
  case 'satcom_link_margin_drop':
  case 'satcom_priority_queue':
  case 'satcom_queue_pressure':
  case 'satcom_route_shed':
    return 'SATCOM degraded'
  case 'terrain_masking_risk':
  case 'line_of_sight_forecast':
    return 'Relay masking risk'
  case 'track_handoff_success':
  case 'drone_track_custody_split':
    return 'UAS custody'
  case 'telemetry_update':
  case 'telemetry_degradation':
  case 'degraded_telemetry':
  case 'drone_spoofing':
  case 'autonomous_relay_handoff':
    return 'UAS / relay status'
  default:
    return domainLabel(signal.domain)
  }
}

export function plainEventName(signal: Signal): string {
  if (signal.payload.event_type === signal.domain) {
    return `${domainCopy[signal.domain].label} report`
  }

  return (
    eventTypeOverrides[signal.payload.event_type] ??
    signal.payload.event_type.replaceAll('_', ' ')
  )
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

const numberValue = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const compactAssetSubject = (assets: string[]) => {
  if (!assets.length) {
    return 'Affected system'
  }

  const droneCount = assets.filter((asset) => asset.startsWith('DRONE-')).length
  if (droneCount === assets.length) {
    return droneCount === 1 ? assets[0] : `${droneCount} drones`
  }

  return assets.length === 1 ? assets[0] : `${assets.length} assets`
}

const clampOneLine = (value: string, maxLength = 112) => {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }

  const clipped = trimmed.slice(0, maxLength - 1)
  return `${clipped.slice(0, clipped.lastIndexOf(' '))}.`
}

const titleCaseSlug = (value: string) =>
  value
    .replace(/^bde\b/i, 'brigade')
    .replace(/^gnss\b/i, 'gps')
    .replace(/^uas\b/i, 'drone')
    .replaceAll(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .replace(/\bGps\b/g, 'GPS')
    .replace(/\bEw\b/g, 'EW')
    .replace(/\bUas\b/g, 'UAS')
    .replace(/\bLeo\b/g, 'LEO')
    .replace(/\bSatcom\b/g, 'SATCOM')
    .replace(/\bSiem\b/g, 'SIEM')

const shortActionByDomain: Record<Domain, string> = {
  orbit: 'watch space support',
  sda: 'keep custody in view',
  rf_ew: 'shift to hardened comms',
  cyber: 'verify access',
  osint: 'use as context',
  humint: 'corroborate first',
  pnt: 'avoid GPS-only decisions',
  satcom: 'protect backup path',
  drone: 'preserve ISR relay',
  terrain: 'adjust geometry',
  bus_health: 'check spacecraft recovery',
  space_weather: 'weigh environmental cause',
}

const friendlySourceLabel = (signal: Signal) => {
  const asset = signal.payload.asset
  if (typeof asset === 'string') {
    return assetAliases[asset] ?? titleCaseSlug(asset)
  }

  return sourceAliases[signal.source] ?? titleCaseSlug(signal.source)
}

const friendlyLocationLabel = (signal: Signal) => {
  const rawLabel =
    typeof signal.location.label === 'string' ? signal.location.label : null
  if (!rawLabel) {
    return sourceAliases[signal.source] ?? titleCaseSlug(signal.source)
  }

  const aliased = locationAliases[rawLabel]
  if (aliased) {
    return aliased
  }

  return rawLabel
    .replace(/\brelative motion frame\b/gi, 'close approach')
    .replace(/\bcollection cone\b/gi, 'collection window')
    .replace(/\bpass footprint\b/gi, 'pass')
    .replace(/\boperating area\b/gi, 'AO')
    .replace(/\bsupport area\b/gi, 'support AO')
    .replace(/\bsupport node\b/gi, 'node')
    .replace(/\bground gateway\b/gi, 'gateway')
    .replace(/\bmonitoring shell\b/gi, 'watch shell')
}

const oneLineForSignal = (signal: Signal) => {
  // Demo-scenario records carry their own operator-facing sentence, and the
  // generic domain copy would mislabel them: a station's frame-loss report is
  // not a drone relay message, and a nominal bus record calls for no recovery.
  if (
    signal.domain === 'rf_ew' &&
    (signal.payload.event_type === 'rf_interference' ||
      signal.payload.event_type === 'telemetry_degradation') &&
    signal.payload.summary
  ) {
    return signal.payload.summary
  }
  if (signal.domain === 'bus_health' && signal.payload.event_type === 'nominal' && signal.payload.summary) {
    return signal.payload.summary
  }
  const observables = signal.payload.observables ?? {}
  const affectedAssets = stringArray(observables.affected_assets)
  const affectedSystems = stringArray(observables.affected_systems)
  const affectedSubject = compactAssetSubject(
    affectedAssets.length ? affectedAssets : affectedSystems,
  )
  const affectedCount = affectedAssets.length
    ? affectedAssets.length
    : affectedSystems.length
  const affectedVerb = affectedCount <= 1 ? 'shows' : 'show'
  const deltaMeters =
    numberValue(observables.delta_meters) ??
    numberValue(observables.position_shift_m)
  const missDistanceKm = numberValue(observables.miss_distance_km)
  const newPrimary =
    typeof observables.new_primary === 'string' ? observables.new_primary : null
  const linkMarginDb = numberValue(observables.link_margin_db)
  const packetLossPct = numberValue(observables.packet_loss_pct)
  const queueDelaySeconds = numberValue(observables.queue_delay_s)
  const refreshIntervalSeconds = numberValue(observables.refresh_interval_s)
  const timeToPerimeterSeconds = numberValue(observables.time_to_perimeter_s)
  const availableKbps = numberValue(observables.available_kbps)
  const emissionCount = numberValue(observables.emission_count)
  const exposureReductionPct = numberValue(observables.exposure_reduction_pct)

  const oneLine = (() => {
    switch (signal.payload.event_type) {
    case 'gps_spoof':
      return `${affectedSubject} ${affectedVerb} GPS drift${deltaMeters ? ` of ${Math.round(deltaMeters)}m` : ''}; verify coordinates before movement or fires.`
    case 'pnt_spoofing':
      return `GPS time or position is biased${deltaMeters ? ` ${Math.round(deltaMeters)}m` : ''}; confirm with non-GPS nav.`
    case 'gnss_jamming_signature':
      return `GPS jamming is degrading timing; use alternate navigation.`
    case 'alternate_pnt_check':
      return 'Non-GPS nav agrees; keep GPS-only coordinates out of fires.'
    case 'alternate_pnt_restored':
      return 'Alternate nav is stable; limited movement can continue.'
    case 'receiver_holdover_active':
      return 'Gateway timing is on holdover; GPS position remains degraded.'
    case 'rf_interference':
      return `EW interference is degrading ${affectedSubject.toLowerCase()}; shift to hardened comms.`
    case 'ew_bearing_refined':
    case 'rf_bearing_crosscheck':
      return 'EW bearing narrowed the affected corridor; route traffic around it.'
    case 'pnt_rf_alignment':
      return 'GPS bias and EW bearing align on the priority route; keep routing defensive.'
    case 'emission_cluster_detected':
      return `${emissionCount ? `${Math.round(emissionCount)} emitters` : 'Emitters'} active in collection footprint; reduce emissions.`
    case 'emission_posture_risk':
      return 'Brigade emitters are still active; reduce exposure before the pass.'
    case 'satcom_degradation':
      return `SATCOM is degrading${packetLossPct ? ` with ${packetLossPct.toFixed(1)}% loss` : ''}; prepare alternate BLOS routing.`
    case 'satcom_link_margin_drop':
      return `SATCOM link margin is low${linkMarginDb ? ` at ${linkMarginDb.toFixed(1)} dB` : ''}; protect the backup route.`
    case 'satcom_queue_pressure':
      return `SATCOM queue delay${queueDelaySeconds ? ` is ${Math.round(queueDelaySeconds)}s` : ' is rising'}; move bulk data to cache.`
    case 'satcom_priority_queue':
      return 'SATCOM is priority-only; keep commander updates moving.'
    case 'satcom_route_shed':
      return 'SATCOM shed nonessential traffic; command updates are preserved.'
    case 'priority_path_confirmed':
      return 'Priority SATCOM text path works; hold bulk imagery.'
    case 'backup_link_check':
      return `${availableKbps ? `${Math.round(availableKbps)} kbps` : 'Low-rate'} backup SATCOM is available for command updates.`
    case 'low_rate_mode_active':
      return 'Gateway is in protected low-rate mode; commander updates continue.'
    case 'satcom_rf_spike':
      return 'RF energy is hitting the SATCOM backup window; watch route acquisition.'
    case 'autonomous_relay_handoff':
      return `Drone relay shifted${newPrimary ? ` to ${newPrimary}` : ''}; ISR feed remains connected.`
    case 'backup_asset_ready':
      return 'Backup drone is staged; primary ISR can degrade without going blind.'
    case 'cross_sensor_position_check':
      return 'Drone sensors agree; GPS is the suspect input.'
    case 'degraded_telemetry':
    case 'telemetry_degradation':
      return 'Drone telemetry is degraded; keep ISR but lower coordinate trust.'
    case 'drone_spoofing':
      return 'UAS track identity is unreliable; hold custody with radar and EO.'
    case 'fdir_recovery_action':
      return `${signal.payload.asset ?? 'Drone'} isolated bad GPS input; ISR continues with reduced coordinate confidence.`
    case 'fdir_assessment':
      return 'MEGALITH sees spoofing, not drone failure; keep ISR moving.'
    case 'fdir_mission_update':
      return 'Continue route ISR on non-GPS nav; backup drone is staged.'
    case 'observer_feed_quality_drop':
      return 'Observer video is dropping; relay handoff is needed soon.'
    case 'relay_candidate_ready':
      return 'DRONE-06 is a cleaner relay; prepare handoff.'
    case 'relay_resilience_assessment':
    case 'relay_commander_update':
      return 'Relay handoff restored observer video and commander updates.'
    case 'isr_product_quality_gate':
      return 'ISR feed is live; target coordinates stay low confidence.'
    case 'drone_track_custody_split':
      return 'Radar and EO keep UAS custody after remote ID becomes unreliable.'
    case 'track_handoff_success':
      return `${timeToPerimeterSeconds ? `${Math.round(timeToPerimeterSeconds)}s to perimeter; ` : ''}sensor handoff preserved UAS track custody.`
    case 'base_defense_posture_change':
      return 'Base warning is out; local sensors hold custody under degraded GPS.'
    case 'credential_probe':
    case 'credential_spray':
      return 'Mission-system logins are being probed; verify access before automated tasking.'
    case 'gateway_config_probe':
      return 'Gateway config API is being probed; freeze changes.'
    case 'maintenance_api_rate_limit':
      return 'Gateway API rate limits are active; command data is protected.'
    case 'process_anomaly':
      return 'Endpoint process looks abnormal; keep gateway hardened.'
    case 'rpo_close_approach':
      return `Object is inside the satellite watch box${missDistanceKm ? ` at ${missDistanceKm.toFixed(1)} km` : ''}; watch support degradation.`
    case 'proximity_operations':
      return 'Nearby space object maneuvered near friendly support; request space-cell attention.'
    case 'close_approach_assessment':
      return 'SATCOM degradation aligns with a close satellite approach; plan protective options.'
    case 'custody_update':
    case 'custody_quality_change':
      return 'Space custody is changing; keep the support asset on watch.'
    case 'space_support_option':
      return 'Alternate space-support pass is available; preserve priority traffic.'
    case 'overhead_warning_quality_drop':
      return `Warning refresh slowed${refreshIntervalSeconds ? ` to ${Math.round(refreshIntervalSeconds)}s` : ''}; cache products locally.`
    case 'overhead_ir_cue':
      return 'Overhead IR cue is late but usable; push warning to local sensors.'
    case 'overhead_collection_window':
      return 'Adversary overhead collection window is opening; mask movement and emissions.'
    case 'sda_catalog_match':
      return 'Satellite pass supports collection-risk watch.'
    case 'collection_cue':
      return 'Collection cue overlaps the operation; reduce visible movement.'
    case 'collection_risk_assessment':
      return 'MEGALITH recommends pause plus emission reduction.'
    case 'imagery_request_update':
      return 'Imagery request urgency increased; delay exposed movement.'
    case 'post_pass_collection_update':
      return 'Post-pass check is clean; resume limited movement.'
    case 'concealment_route_check':
      return `${exposureReductionPct ? `${Math.round(exposureReductionPct)}% lower exposure; ` : ''}use covered route during the pass.`
    case 'procurement_report':
      return 'Human report flags imagery demand; corroborate before moving.'
    case 'route_chokepoint_check':
      return 'Route chokepoints make GPS timing riskier; prep alternate route.'
    case 'convoy_timing_risk':
      return 'Convoy timing risk is rising; hold GPS-dependent movement until cross-checks agree.'
    case 'local_route_report':
      return 'Route congestion is building; decide hold or release soon.'
    case 'convoy_release_update':
      return 'Limited convoy release is viable on alternate route.'
    case 'space_support_hold_recommendation':
      return 'Hold convoy until SAR, backup comms, and non-GPS nav are ready.'
    case 'terrain_masking_risk':
      return 'Terrain may block the relay path; adjust drone altitude or relay geometry.'
    case 'line_of_sight_forecast':
      return 'Relay line of sight will degrade; hand off before the feed drops.'
    case 'approach_masking_check':
      return 'Low-altitude approach gap found; cue alternate sensor.'
    case 'local_cache_confirmed':
      return 'Overhead-warning cache is local; use it while SATCOM is degraded.'
    case 'attack_chain_correlation':
    case 'convergence':
      return 'EW, GPS, cyber, and SATCOM now form one attack chain.'
    case 'multi_domain_attack_assessment':
    case 'attack_chain_commander_update':
      return 'Hold automation; preserve ISR and backup comms.'
    case 'iran_counter_c5isr_assessment':
    case 'c5isr_commander_update':
      return 'Operate degraded: preserve ISR, text comms, and human fires review.'
    case 'gateway_pressure_assessment':
      return 'Gateway is under RF, cyber, GPS, and UAS pressure; stay defensive.'
    case 'gateway_recovery_assessment':
      return 'Gateway stayed connected; hold protected mode until link recovers.'
    case 'aor_commander_update':
      return 'AOR is degraded but manageable; keep priority routing.'
    case 'base_defense_recovery_update':
    case 'space_enabled_base_defense_assessment':
      return 'Base warning and sensor custody held through degraded space support.'
    case 'commander_orbit_cue':
      return 'Orbit cue is a watch item, not attribution; protect routing.'
    case 'orbital_setup':
      return 'Baseline satellite pass is established; watch for support changes.'
    case 'screening_overlay':
      return 'Space screening object entered the watch shell; protect support routing.'
    case 'orbital_context_shift':
      return 'Satellite geometry now matters to the ground operation; refresh support timing.'
    case 'telemetry_update':
      return 'Drone telemetry baseline is established; watch for drift or dropouts.'
    case 'ground_segment_baseline':
      return 'Gateway baseline is established; compare new anomalies against this state.'
    case 'public_report':
    case 'osint_context':
      return 'Public reporting adds context; do not treat it as proof.'
    case 'response_action':
      return 'Gateway hardening is active; keep automated changes frozen.'
    case 'missile_uas_capability_context':
      return 'Missile/UAS threat raises need for warning, GPS, ISR, and SATCOM.'
    case 'counterspace_capability_context':
      return 'Counterspace risk is relevant; watch EW, cyber, GPS, and SATCOM.'
    case 'militia_uas_risk_context':
      return 'Militia UAS risk raised; cue base defense and space support.'
    case 'maritime_space_picture_shift':
      return 'Maritime picture is compressing; refresh space-derived tracking.'
    case 'blockade_notice':
      return 'Theater warning starts the convoy space-support clock.'
    default:
      return (
        spacecraftEnvironmentOneLine(signal) ??
        `${signal.payload.summary}; ${shortActionByDomain[signal.domain]}.`
      )
    }
  })()

  return clampOneLine(oneLine)
}

/** Subsystem ids from docs/INTERFACE-SPEC.md §3 in operator spelling. */
export function subsystemLabel(subsystem: string | null | undefined): string {
  switch (subsystem) {
  case 'adcs':
    return 'ADCS'
  case 'cdh':
    return 'C&DH'
  case 'comms':
    return 'Comms'
  case 'power':
    return 'Power'
  case 'thermal':
    return 'Thermal'
  case 'propulsion':
    return 'Propulsion'
  case 'payload':
    return 'Payload'
  default:
    return subsystem ? titleCaseSlug(subsystem) : 'Unknown subsystem'
  }
}

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

/** Row-level facts for the two spacecraft-environment domains: what the
 *  event feed shows beside the one-liner. Empty for every other domain. */
export function spacecraftEnvironmentFacts(
  signal: Signal,
): Array<{ key: string; label: string; value: string }> {
  const observables = signal.payload.observables ?? {}

  if (signal.domain === 'bus_health') {
    const subsystem = stringValue(observables.subsystem)
    const symptom = stringValue(observables.symptom)
    const physicsConsistency = numberValue(observables.physics_consistency)
    return [
      {
        key: 'subsystem',
        label: 'subsystem',
        value: subsystemLabel(subsystem),
      },
      {
        key: 'symptom',
        label: 'symptom',
        value: symptom ? symptom.replaceAll('_', ' ') : 'not stated',
      },
      {
        key: 'physics',
        label: 'physics',
        value:
          physicsConsistency === null
            ? 'not scored'
            : physicsConsistency.toFixed(2),
      },
    ]
  }

  if (signal.domain === 'space_weather') {
    const kp = numberValue(observables.kp)
    return [
      {
        key: 'event',
        label: 'event',
        value:
          eventTypeCopy(signal.payload.event_type)?.label ??
          signal.payload.event_type.replaceAll('_', ' '),
      },
      { key: 'kp', label: 'Kp', value: kp === null ? 'n/a' : kp.toFixed(1) },
    ]
  }

  return []
}

const spacecraftEnvironmentOneLine = (signal: Signal): string | null => {
  const copy = eventTypeCopy(signal.payload.event_type)
  if (!copy) {
    return null
  }

  const observables = signal.payload.observables ?? {}

  if (signal.domain === 'bus_health') {
    const asset = stringValue(signal.payload.asset) ?? 'Spacecraft'
    const subsystem = stringValue(observables.subsystem)
    const rate = numberValue(observables.rate_of_change)
    const rateUnit = stringValue(observables.rate_unit)
    const physicsConsistency = numberValue(observables.physics_consistency)
    const where = subsystem ? ` in ${subsystemLabel(subsystem).toLowerCase()}` : ''
    const trend =
      rate !== null && rateUnit ? ` at ${rate.toFixed(2)} ${rateUnit}` : ''
    const physics =
      physicsConsistency === null
        ? shortActionByDomain.bus_health
        : `physics consistency ${physicsConsistency.toFixed(2)}`
    return `${asset}: ${copy.label.toLowerCase()}${where}${trend}; ${physics}.`
  }

  const kp = numberValue(observables.kp)
  const dst = numberValue(observables.dst_nt)
  const readings = [
    kp === null ? null : `Kp ${kp.toFixed(1)}`,
    dst === null ? null : `Dst ${Math.round(dst)} nT`,
  ].filter((reading): reading is string => reading !== null)
  const withReadings = readings.length ? ` with ${readings.join(', ')}` : ''
  return `${copy.label}${withReadings}; ${shortActionByDomain.space_weather}.`
}

export function commanderSignalSummary(signal: Signal): {
  label: string
  headline: string
  oneLine: string
  detail: string
  whyItMatters: string
  action: string
  location: string
  confidenceLabel: string
  sourceLabel: string
} {
  const copy = domainCopy[signal.domain]
  const confidence = Math.round(signal.confidence * 100)
  const observables = signal.payload.observables
  const operationalAction =
    typeof observables?.demo_action === 'string'
      ? observables.demo_action.replaceAll('_', ' ')
      : null
  const spaceDependency =
    typeof observables?.space_dependency === 'string'
      ? observables.space_dependency
      : null
  const action = operationalAction ?? actionByDomain[signal.domain]
  const typedCopy = eventTypeCopy(signal.payload.event_type)

  return {
    label: signalKindLabel(signal),
    headline: signal.payload.summary,
    oneLine: oneLineForSignal(signal),
    detail: plainEventName(signal),
    whyItMatters: spaceDependency ?? typedCopy?.meaning ?? copy.meaning,
    action,
    location: friendlyLocationLabel(signal),
    confidenceLabel: `${confidence}% confidence`,
    sourceLabel: friendlySourceLabel(signal),
  }
}

export function commanderEventSummary(event: UIEvent | null): {
  state: 'White' | 'Amber' | 'Red'
  headline: string
  body: string
  action: string
  urgency: string
} {
  if (!event) {
    return {
      state: 'White',
      headline: 'MEGALITH is building the picture',
      body: 'Signals are arriving. No commander-facing threat package is ready yet.',
      action: 'Keep monitoring',
      urgency: 'No immediate action',
    }
  }

  const state =
    event.severity === 'critical' || event.severity === 'high' ? 'Red' : 'Amber'

  return {
    state,
    headline: event.title,
    body: event.message,
    action: event.recommendation?.summary ?? 'No commander approval required yet',
    urgency:
      event.type === 'recommendation_created'
        ? 'Commander decision requested'
        : 'Awareness update',
  }
}

// ---------------------------------------------------------------------------
// Verdict, basis, gate and recovery copy (docs/INTERFACE-SPEC.md §5 to §7).
// One place for the wording so the verdict panel, the operator action panel
// and the reasoning trace agree on what each state is called.
// ---------------------------------------------------------------------------

export type VerdictCopy = {
  label: string
  meaning: string
}

export const verdictCopy: Record<Verdict, VerdictCopy> = {
  internal_fault: {
    label: 'Internal fault',
    meaning:
      'The physics of the symptom match an onboard failure. Nothing outside the spacecraft needs to be acting on it.',
  },
  natural_external: {
    label: 'Natural external',
    meaning:
      'The space environment accounts for the symptom: storm, radiation, or drag, not a component and not an actor.',
  },
  hostile_external: {
    label: 'Hostile external',
    meaning:
      'Onboard physics do not explain the symptom and it lines up with activity attributed to an actor.',
  },
  unknown: {
    label: 'Unknown',
    meaning:
      'Evidence points both ways or is too thin to call. Treat the cause as unresolved.',
  },
}

export const noVerdictCopy: VerdictCopy = {
  label: 'No verdict yet',
  meaning:
    'This attribution carries no fault-versus-attack call; only the actor pattern and its evidence are available.',
}

export function verdictLabel(verdict: Verdict | null | undefined): string {
  return verdict ? verdictCopy[verdict].label : noVerdictCopy.label
}

export const verdictBasisCopy: Record<VerdictBasis, VerdictCopy> = {
  rule: {
    label: 'Rule lane',
    meaning:
      'The deterministic fast lane set this verdict from physics consistency and threat context; no model judgement is involved.',
  },
  reasoning: {
    label: 'Reasoning lane',
    meaning:
      'The model changed the rule verdict and cited the evidence below for the change.',
  },
}

/** Headline an analyst reads first: verdict-aware, and the legacy
 *  actor-pattern sentence for attributions without a verdict. */
export function verdictHeadline(attribution: Attribution): string {
  const verdict = attribution.verdict ?? null
  if (!verdict) {
    return `${attribution.actor} pattern under review`
  }
  if (verdict === 'hostile_external') {
    const actor = attribution.actor
    return actor && actor !== 'Unknown' && actor !== 'None'
      ? `Hostile external: pattern consistent with ${actor}`
      : 'Hostile external: actor not yet attributed'
  }
  const subject = attribution.satellite_id
    ? spacecraftDisplayName(attribution.satellite_id)
    : 'the affected spacecraft'
  return `${verdictCopy[verdict].label} on ${subject}`
}

/** `ctb://<authority>/<spacecraft-id>` -> `<spacecraft-id>` in upper case;
 *  anything else is returned as given (docs/INTERFACE-SPEC.md §1). */
export function spacecraftDisplayName(satelliteId: string): string {
  const match = satelliteId.match(/^ctb:\/\/[^/]+\/(.+)$/)
  return match ? match[1].toUpperCase() : satelliteId
}

export type GateRationale = {
  /** `threat/uplink_jamming_active` style reason code, null when not gated. */
  reasonCode: string | null
  /** The rationale with the `[gate:<code>] ` prefix removed. */
  text: string
}

/** Split a decision rationale that the threat-context gate prefixed with
 *  `[gate:<reason_code>] ` (docs/INTERFACE-SPEC.md §7). */
export function parseGateRationale(rationale: string): GateRationale {
  const match = rationale.match(/^\[gate:([^\]]+)\]\s*([\s\S]*)$/)
  if (!match) {
    return { reasonCode: null, text: rationale }
  }
  return { reasonCode: match[1].trim(), text: match[2].trim() }
}

// Gate reason codes (docs/INTERFACE-SPEC.md §7) and the two verdict codes a
// withheld recovery can carry (§6, spec 1.3). The exported list is what the
// chip tests iterate; a code outside it falls back to a title-cased tail.
export const GATE_REASON_CODES = [
  'threat/uplink_jamming_active',
  'threat/hostile_close_approach',
  'policy/unselectable_action',
  'policy/authority_mismatch',
  'verdict/hostile_external',
  'verdict/unknown',
] as const

export type GateReasonCode = (typeof GATE_REASON_CODES)[number]

const gateReasonLabels: Record<GateReasonCode, string> = {
  'threat/uplink_jamming_active': 'Active jamming detected',
  'threat/hostile_close_approach': 'Hostile close approach',
  'policy/unselectable_action': 'Action not selectable',
  'policy/authority_mismatch': 'Authority mismatch',
  'verdict/hostile_external': 'Verdict: hostile external',
  'verdict/unknown': 'Verdict: unknown',
}

export function gateReasonLabel(reasonCode: string): string {
  const known = (gateReasonLabels as Record<string, string | undefined>)[reasonCode]
  if (known) {
    return known
  }
  const tail = reasonCode.split('/').pop() ?? reasonCode
  return titleCaseSlug(tail)
}

/** "Recovery withheld: <action> on <subsystem>: <reason label>" for the
 *  chip on the verdict and operator panels (docs/INTERFACE-SPEC.md §6). */
export function withheldRecoveryLabel(withheld: WithheldRecovery): string {
  return `Recovery withheld: ${recoveryActionLabel(withheld.action_id)} on ${subsystemLabel(
    withheld.target_subsystem,
  )}: ${gateReasonLabel(withheld.reason_code)}`
}

/** `switch_redundant_amplifier` -> `Switch redundant amplifier`. */
export function recoveryActionLabel(actionId: string): string {
  const spaced = actionId.replaceAll(/[-_]+/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : actionId
}

const VERDICTS: readonly Verdict[] = [
  'internal_fault',
  'natural_external',
  'hostile_external',
  'unknown',
]

export const isVerdict = (value: unknown): value is Verdict =>
  typeof value === 'string' && (VERDICTS as readonly string[]).includes(value)

export type TraceAnnotations = {
  verdict: Verdict | null
  physicsConsistency: number | null
  /** Reason code of a gate block, null for every other trace. */
  gateReasonCode: string | null
}

/** Reason code of a withheld recovery: the decide-stage warn whose message
 *  is `recovery withheld: <action_id>: <reason_code>` (docs/INTERFACE-SPEC.md
 *  §6). A `reason_code` payload field wins over parsing the message. Null
 *  for every other trace. */
export function withheldTraceReasonCode(trace: ReasoningTrace): string | null {
  if (
    trace.stage !== 'decide' ||
    trace.level !== 'warn' ||
    !trace.message.startsWith('recovery withheld')
  ) {
    return null
  }
  const payload = trace.payload ?? {}
  if (typeof payload.reason_code === 'string' && payload.reason_code) {
    return payload.reason_code
  }
  return trace.message.match(/:\s*(\S+)\s*$/)?.[1] ?? 'withheld'
}

/** Attrib traces carry the verdict and physics score in their payload
 *  (docs/INTERFACE-SPEC.md §5); the gate's block trace is a decide-stage
 *  warn whose message starts with "gate blocked <action>: <reason_code>"
 *  (§7). A `reason_code` payload field wins over parsing the message. */
export function traceAnnotations(trace: ReasoningTrace): TraceAnnotations {
  const payload = trace.payload ?? {}
  const verdict = isVerdict(payload.verdict) ? payload.verdict : null
  const physicsConsistency =
    typeof payload.physics_consistency === 'number' &&
    Number.isFinite(payload.physics_consistency)
      ? payload.physics_consistency
      : null
  const blocked =
    trace.stage === 'decide' &&
    trace.level === 'warn' &&
    trace.message.startsWith('gate blocked')
  const gateReasonCode = blocked
    ? typeof payload.reason_code === 'string' && payload.reason_code
      ? payload.reason_code
      : (trace.message.match(/:\s*(\S+)\s*$/)?.[1] ?? 'gate')
    : null
  return { verdict, physicsConsistency, gateReasonCode }
}
