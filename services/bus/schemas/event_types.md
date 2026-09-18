# CANOPY event types

Signal adapters use `payload.event_type`. Some prototype fusion tools also accept
legacy `payload.event` for compatibility, but new scenario feeds should stay on
the canonical Signal schema.

drone:
- `telemetry_update`
- `degraded_telemetry`
- `fdir_recovery_action`
- `relay_mesh_status`
- `relay_candidate_ready`
- `autonomous_relay_handoff`
- `uas_track_detected`
- `base_defense_posture_change`

rf_ew:
- `rf_interference`
- `satcom_rf_spike`
- `emission_posture_risk`
- `gnss_jamming_signature`
- `uas_control_link_detected`

pnt:
- `gps_spoof`

orbit:
- `orbital_setup`
- `screening_overlay`
- `overhead_collection_window`
- `rpo_close_approach`
- `proximity_operations`

satcom:
- `satcom_degradation`
- `satcom_link_margin_drop`

cyber:
- `ground_segment_baseline`
- `credential_probe`
- `credential_spray`

osint:
- `osint_context`
- `collection_cue`
- `blockade_notice`
- `maritime_traffic_collapse`
- `convoy_hold_recommendation`
- `militia_uas_risk_context`
- `uas_base_defense_assessment`
- `missile_uas_capability_context`
- `iran_counter_c5isr_assessment`
- `space_support_hold_recommendation`
- `space_enabled_base_defense_assessment`
- `fdir_assessment`
- `relay_resilience_assessment`
- `collection_risk_assessment`
- `multi_domain_attack_assessment`
- `campaign_assessment`
- `close_approach_assessment`

humint:
- `procurement_report`

sda:
- `sda_catalog_match`
- `maritime_space_picture_shift`
- `overhead_ir_cue`

terrain:
- `terrain_masking_risk`

bus_health (source `internal-diagnosis`; payload schema `payloads/bus_health.schema.json`;
docs/INTERFACE-SPEC.md §3):
- `link_margin_drop`
- `sensor_saturation`
- `attitude_disturbance`
- `unexpected_reset`
- `power_thermal_excursion`
- `orbit_decay`
- `safe_mode_entry`
- `nominal` (baseline; fusion ignores it)

space_weather (source `noaa-swpc` fixture or `noaa-swpc-live`; location label `geospace`,
no `satellite_id`; payload schema `payloads/space_weather.schema.json`; docs/INTERFACE-SPEC.md §4):
- `geomagnetic_storm`
- `solar_radio_burst`
- `radiation_enhancement`
- `density_enhancement`
- `quiet` (baseline; fusion ignores it)
