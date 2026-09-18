import type { Domain, Signal } from '../types/canopy'

export type SignalEffectState = 'nominal' | 'watch' | 'danger'

const dangerEvents = new Set([
  'gps_spoof',
  'pnt_spoofing',
  'gnss_jamming_signature',
  'rf_interference',
  'satcom_degradation',
  'satcom_link_margin_drop',
  'rpo_close_approach',
  'proximity_operations',
  'credential_probe',
  'credential_spray',
  'uas_control_link_detected',
  'overhead_ir_cue',
  'multi_domain_attack_assessment',
  'iran_counter_c5isr_assessment',
  'space_enabled_base_defense_assessment',
])

const watchEvents = new Set([
  'alternate_pnt_check',
  'backup_link_check',
  'collection_cue',
  'collection_risk_assessment',
  'custody_quality_change',
  'emission_cluster_detected',
  'emission_posture_risk',
  'gateway_latency_rise',
  'line_of_sight_forecast',
  'overhead_collection_window',
  'overhead_warning_quality_drop',
  'satcom_queue_pressure',
  'terrain_masking_risk',
])

export const signalEffectState = (signal: Signal | null): SignalEffectState => {
  if (!signal) {
    return 'nominal'
  }

  if (dangerEvents.has(signal.payload.event_type) || signal.confidence >= 0.9) {
    return 'danger'
  }

  if (watchEvents.has(signal.payload.event_type) || signal.confidence >= 0.78) {
    return 'watch'
  }

  return 'nominal'
}

export const signalEffectLabel = (signal: Signal | null) => {
  if (!signal) {
    return 'Mission building picture'
  }

  const byDomain: Record<Domain, string> = {
    orbit: 'Satellite support risk',
    sda: 'Space custody change',
    rf_ew: 'Jamming / interference',
    cyber: 'Mission system probe',
    osint: 'Threat picture update',
    humint: 'Human report cue',
    pnt: 'GPS / timing risk',
    satcom: 'SATCOM path degraded',
    drone: 'ISR relay change',
    terrain: 'Terrain masking risk',
    bus_health: 'Spacecraft health change',
    space_weather: 'Space weather activity',
  }

  return byDomain[signal.domain]
}
