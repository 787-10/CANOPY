from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Iterable, Mapping
import re
from dataclasses import dataclass

from canopy.services.kb import KB
from canopy.services.kb.models import KBEntry
from canopy.services.schemas.events import (
    Action,
    Anomaly,
    Attribution,
    AttributionChallenge,
    Authority,
    Decision,
    RecoveryBlock,
    Verdict,
)

log = logging.getLogger(__name__)

UNCERTAINTY_ENTRY = "kb-attribution-uncertainty-001"

__all__ = ["StubLLMClient", "StubVerdictOverride"]


# ---- Attribution templates -------------------------------------------------


@dataclass(frozen=True)
class _AttribTemplate:
    actor: str
    confidence: float
    evidence: list[str]
    predicted_next: str | None
    capability_lookups: list[str]


_KIND_TO_ATTRIBUTION: dict[str, _AttribTemplate] = {
    "rf_anomaly": _AttribTemplate(
        actor="Russia",
        confidence=0.74,
        evidence=[
            "RF interference signature is consistent with published Russian EW capabilities.",
            "Open-source attribution does not prove actor intent; assessment is confidence-scored.",
        ],
        predicted_next="Watch for paired co-orbital or cyber action inside the correlation window.",
        capability_lookups=["jamming_spoofing"],
    ),
    "gnss_spoof": _AttribTemplate(
        actor="Russia",
        confidence=0.78,
        evidence=[
            "GNSS bias and time-offset are consistent with documented spoof tradecraft.",
            "PNT confidence collapse is the cue; switch to multi-constellation fallback.",
        ],
        predicted_next="Expect concurrent RF or co-orbital action against linked space assets.",
        capability_lookups=["jamming_spoofing"],
    ),
    "cyber_probe_burst": _AttribTemplate(
        actor="Unknown",
        confidence=0.58,
        evidence=[
            "Probe pattern is consistent with credential-access tradecraft.",
            "Cyber attribution alone is uncertain; pair with RF or co-orbital cues before raising confidence.",
        ],
        predicted_next="Cyber probes may precede an RF or co-orbital phase.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "cyber_response_action": _AttribTemplate(
        actor="Unknown",
        confidence=0.45,
        evidence=[
            "Defensive orchestrator action is informational; not adversary attribution.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "satcom_degradation": _AttribTemplate(
        actor="Russia",
        confidence=0.66,
        evidence=[
            "SATCOM link degradation is consistent with documented uplink/downlink interference capabilities.",
            "Compound effect with concurrent RPO close-approach raises severity.",
        ],
        predicted_next="If RPO risk emerges in the same window, escalate to space-effect request.",
        capability_lookups=["satcom_jamming"],
    ),
    "drone_spoofing": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "UAS identity mismatch is consistent with coordinated probing; actor not yet attributable.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_lost_link": _AttribTemplate(
        actor="Unknown",
        confidence=0.50,
        evidence=[
            "Drone lost-link event; could indicate RF interference or platform issue.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_degraded": _AttribTemplate(
        actor="Unknown",
        confidence=0.50,
        evidence=[
            "Drone telemetry degradation; correlate with PNT/RF before raising confidence.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "humint_report": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "HUMINT report flagged for context; needs operational corroboration.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "orbital_rpo_risk": _AttribTemplate(
        actor="China",
        confidence=0.74,
        evidence=[
            "Close-approach geometry is consistent with documented Chinese RPO precedents (e.g., SJ-21 BeiDou relocation).",
            "Public RPO data does not prove hostile intent; the assessment is confidence-scored, not definitive.",
        ],
        predicted_next="If the friendly asset is mission-critical, draft a higher-authority space-effect request.",
        capability_lookups=["co_orbital_rpo"],
    ),
    "orbital_collection_risk": _AttribTemplate(
        actor="Unknown",
        confidence=0.50,
        evidence=[
            "Collection window opening; commercial or adversary tasking pending corroboration.",
        ],
        predicted_next=None,
        capability_lookups=["commercial_dependency"],
    ),
    "orbital_collection_overlap": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.55,
        evidence=[
            "Concurrent collection windows. Commercial overpass risk is part of the contested battlespace.",
        ],
        predicted_next=None,
        capability_lookups=["commercial_dependency"],
    ),
    "orbital_collection_correlated": _AttribTemplate(
        actor="Russia",
        confidence=0.78,
        evidence=[
            "RF or GNSS anomaly inside the collection window is consistent with coordinated multi-domain activity.",
            "Public reporting does not prove actor intent; the assessment is confidence-scored.",
        ],
        predicted_next="Anticipate escalation along the documented RF + co-orbital pairing pattern.",
        capability_lookups=["jamming_spoofing", "attribution_uncertainty"],
    ),
    "osint_close_approach_assessment": _AttribTemplate(
        actor="China",
        confidence=0.70,
        evidence=[
            "OSINT close-approach assessment correlates SATCOM degradation with synthetic RPO inject.",
        ],
        predicted_next="Recommend a higher-authority space-effect request to preserve mission BLOS.",
        capability_lookups=["co_orbital_rpo"],
    ),
    "osint_convergence": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.62,
        evidence=[
            "OSINT convergence assessment links multiple anomalies inside one operational window.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_commander_update": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.60,
        evidence=[
            "Mission cell escalation update; treat as operator-derived assessment, not direct sensor.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_campaign_assessment": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "Campaign-level OSINT assessment; pair with sensor cues before raising confidence.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_collection_cue": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.50,
        evidence=[
            "OSINT collection cue; informational context for upcoming overpass risk.",
        ],
        predicted_next=None,
        capability_lookups=["commercial_dependency"],
    ),
    # ---- RF / EW (extended) -----------------------------------------------
    "rf_gnss_jamming": _AttribTemplate(
        actor="Russia",
        confidence=0.78,
        evidence=[
            "Detected GNSS jamming signature is consistent with documented EW capabilities.",
            "Signature alone is informational; pair with PNT receiver effects to raise confidence.",
        ],
        predicted_next="If receivers report position drift, escalate to multi-constellation fallback.",
        capability_lookups=["jamming_spoofing"],
    ),
    "rf_uas_control_link": _AttribTemplate(
        actor="Unknown",
        confidence=0.62,
        evidence=[
            "RF emissions consistent with adversary UAS control link in the AOR.",
            "Public detection alone does not confirm operator; correlate with overhead cues.",
        ],
        predicted_next="Watch for follow-on UAS track or control-link bursts converging on protected nodes.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "rf_emission_posture_risk": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "Friendly emissions are at risk of detection during a hostile collection window.",
        ],
        predicted_next="Recommend emission-control posture for the duration of the overpass.",
        capability_lookups=["commercial_dependency"],
    ),
    "rf_telemetry_degradation": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "Telemetry degradation observed; correlate with RF or PNT cues before raising confidence.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    # ---- SDA --------------------------------------------------------------
    "sda_overhead_ir_cue": _AttribTemplate(
        actor="Unknown",
        confidence=0.62,
        evidence=[
            "Overhead IR cue is consistent with possible launch or hot-emitter activity in the AOR.",
            "Public assessment; correlate with regional posture before raising confidence.",
        ],
        predicted_next="Watch for follow-on RF or imagery cues that confirm a launch profile.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "sda_maritime_picture_shift": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.58,
        evidence=[
            "Maritime AIS / overhead imagery picture shifting in the watch box.",
            "Treat as commercial-dependency context until corroborated by direct sensors.",
        ],
        predicted_next=None,
        capability_lookups=["commercial_dependency"],
    ),
    "sda_catalog_match": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "SDA catalog match; informational track update.",
        ],
        predicted_next=None,
        capability_lookups=["commercial_dependency"],
    ),
    "sda_counterspace_context": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.62,
        evidence=[
            "Public counterspace capability context relevant to the AOR.",
            "Treat as background prior; not direct attribution.",
        ],
        predicted_next=None,
        # Background context only: no RPO lookup, or the citation would route
        # ``_select_decision`` to the escort template with no RPO anomaly in
        # the cluster (the held-out sensor-saturation hostile case). Escorts
        # are keyed on ``orbital_rpo_risk``, whose own template cites the RPO
        # entry. Scenarios whose signal ids index a KB entry never reach this
        # fallback.
        capability_lookups=["attribution_uncertainty"],
    ),
    # ---- Drone (protective autonomous actions and tracks) -----------------
    "drone_relay_handoff": _AttribTemplate(
        actor="Unknown",
        confidence=0.45,
        evidence=[
            "Autonomous drone relay handoff completed; ISR continuity preserved.",
            "Status update — not an adversary attribution.",
        ],
        predicted_next="Monitor relay mesh stability and degraded-mode traffic.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_relay_candidate_ready": _AttribTemplate(
        actor="Unknown",
        confidence=0.40,
        evidence=[
            "Relay candidate drone reports ready to take primary role.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_relay_mesh_status": _AttribTemplate(
        actor="Unknown",
        confidence=0.40,
        evidence=[
            "Drone relay mesh status update.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_fdir_recovery": _AttribTemplate(
        actor="Unknown",
        confidence=0.45,
        evidence=[
            "Drone FDIR recovery action executed; isolating spoofed navigation.",
            "Status update — autonomous response, not adversary attribution.",
        ],
        predicted_next="ISR continues with reduced confidence until alternate PNT confirmed.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_base_defense_posture": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "Base defense posture change consistent with elevated UAS or proxy risk.",
        ],
        predicted_next="Watch for UAS tracks or RF control links converging on the perimeter.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "drone_uas_track": _AttribTemplate(
        actor="Unknown",
        confidence=0.62,
        evidence=[
            "UAS track detected; correlate with RF and overhead cues before raising confidence.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    # ---- Terrain ----------------------------------------------------------
    "terrain_masking_risk": _AttribTemplate(
        actor="Unknown",
        confidence=0.45,
        evidence=[
            "Terrain masking risk along the route; affects relay geometry and link margins.",
        ],
        predicted_next="Pre-position relay or shift route to mitigate masking.",
        capability_lookups=["attribution_uncertainty"],
    ),
    # ---- OSINT (correlation outputs and contexts, extended) --------------
    "osint_multi_domain_attack": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.78,
        evidence=[
            "Cross-domain assessment is consistent with coordinated counter-C5ISR pressure.",
            "Public reporting does not prove a single actor; assessment is confidence-scored.",
        ],
        predicted_next="Anticipate continued pressure on space-enabled functions across the next contact cycle.",
        capability_lookups=["jamming_spoofing", "satcom_jamming", "co_orbital_rpo"],
    ),
    "osint_iran_c5isr_assessment": _AttribTemplate(
        actor="Iran",
        confidence=0.66,
        evidence=[
            "Pattern is consistent with Iran-aligned counter-C5ISR pressure on space-enabled functions.",
            "Public reporting only; not proof of intent.",
        ],
        predicted_next="Expect sustained pressure on PNT, SATCOM, and overhead distribution chains.",
        capability_lookups=["jamming_spoofing", "satcom_jamming", "attribution_uncertainty"],
    ),
    "osint_space_support_hold": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.70,
        evidence=[
            "Space-support functions degraded; recommend hold until fallbacks confirmed.",
        ],
        predicted_next="Resume movement only when alternate PNT and SATCOM fallback are validated.",
        capability_lookups=["satcom_jamming", "jamming_spoofing"],
    ),
    "osint_space_base_defense": _AttribTemplate(
        actor="Unknown",
        confidence=0.66,
        evidence=[
            "Space-enabled base defense assessment is consistent with elevated UAS / counterspace pressure.",
            "Confidence-scored; not proof of attribution.",
        ],
        predicted_next="Maintain perimeter sensor custody and cached overhead products through the window.",
        capability_lookups=["attribution_uncertainty", "satcom_jamming"],
    ),
    "osint_collection_risk": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.62,
        evidence=[
            "Collection risk assessment; commercial overpass and adversary tasking both relevant.",
        ],
        predicted_next="Recommend mask or timing change during the collection window.",
        capability_lookups=["commercial_dependency"],
    ),
    "osint_relay_resilience": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "Relay resilience assessment; the network adapted without operator intervention.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_fdir_assessment": _AttribTemplate(
        actor="Unknown",
        confidence=0.55,
        evidence=[
            "FDIR assessment; ISR preserved with reduced confidence after navigation isolation.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_blockade_notice": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.60,
        evidence=[
            "Public blockade timeline relevant to space-enabled convoy support.",
        ],
        predicted_next="Open a theater space-support watch window aligned with the announced timeline.",
        capability_lookups=["commercial_dependency"],
    ),
    "osint_missile_uas_context": _AttribTemplate(
        actor="Iran",
        confidence=0.60,
        evidence=[
            "Public missile / UAS capability context is consistent with regional pressure on US forces.",
        ],
        predicted_next=None,
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_militia_uas_context": _AttribTemplate(
        actor="Iran",
        confidence=0.58,
        evidence=[
            "Public militia / UAS risk context relevant to base space-support nodes.",
        ],
        predicted_next="Pair with overhead and RF cues before raising confidence.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "osint_semantic_cluster": _AttribTemplate(
        actor="Multi-actor",
        confidence=0.62,
        evidence=[
            "Multiple OSINT reports cluster on a single event via sentence-transformer embeddings.",
            "Clustered observations corroborate one another, raising confidence above the single-report floor.",
        ],
        predicted_next="Treat as one fused observation; pair with cross-domain cues before naming a single actor.",
        capability_lookups=["attribution_uncertainty"],
    ),
    # ---- Bus health (internal-diagnosis lane) -----------------------------
    # docs/INTERFACE-SPEC.md §3 / §5. These kinds describe a symptom on a
    # monitored spacecraft, not adversary activity, so the actor is "None"
    # (the actor used for internal_fault and natural_external verdicts).
    # Evidence names the subsystem and symptom in neutral language; the
    # verdict itself is set by the rule lane (wave 2A), not by these templates.
    "bus_link_margin": _AttribTemplate(
        actor="None",
        confidence=0.66,
        evidence=[
            "Comms subsystem reports a falling downlink link margin; onset, trend shape, and rate are recorded by the internal-diagnosis lane.",
            "The symptom is consistent with onboard amplifier or antenna degradation; an RF effect on the same satellite inside the look-back window would argue for an external cause.",
        ],
        predicted_next="Margin keeps falling at the reported rate until the redundant chain is selected or the trend reverses.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "bus_sensor_saturation": _AttribTemplate(
        actor="None",
        confidence=0.60,
        evidence=[
            "A sensor channel reports saturated readings; the affected subsystem and channel are carried in the anomaly payload.",
            "Saturation is consistent with sun-in-field-of-view geometry or elevated radiation; a directed-energy source would present the same reading.",
        ],
        predicted_next="Readings return to range once the geometry or radiation environment clears; persistence beyond that points to hardware.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "bus_attitude_disturbance": _AttribTemplate(
        actor="None",
        confidence=0.64,
        evidence=[
            "ADCS reports an attitude disturbance outside the expected pointing envelope; onset time and rate are recorded.",
            "A ramp-shaped disturbance is consistent with reaction-wheel friction or a momentum event; a step would argue for an external impulse.",
        ],
        predicted_next="Momentum management absorbs the disturbance if it is internal; a recurring step pattern warrants a co-orbital check.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "bus_unexpected_reset": _AttribTemplate(
        actor="None",
        confidence=0.58,
        evidence=[
            "Command-and-data-handling reports an unexpected processor reset with no matching ground command.",
            "Single-event upsets during elevated radiation and unauthorized commanding produce the same symptom; space-weather and cyber context inside the look-back window separate them.",
        ],
        predicted_next="A single reset is usually benign; repeated resets on one board indicate a degraded component.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "bus_power_thermal": _AttribTemplate(
        actor="None",
        confidence=0.63,
        evidence=[
            "Power or thermal subsystem reports an excursion outside its operating band; the trend shape distinguishes a step from a drift.",
            "Consistent with a degraded solar string, heater fault, or eclipse-season loading; a storm-driven heating event would present the same drift.",
        ],
        predicted_next="Load shedding or heater reconfiguration holds the bus inside limits while the trend is characterised.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "bus_orbit_decay": _AttribTemplate(
        actor="None",
        confidence=0.60,
        evidence=[
            "Orbit determination shows semi-major-axis decay faster than the modelled drag baseline.",
            "Storm-driven density increases and unintended thrust both raise the decay rate; the space-weather window and propulsion telemetry separate them.",
        ],
        predicted_next="Decay rate tracks the density profile if it is environmental; a persistent rate after the window closes points to propulsion.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "bus_safe_mode": _AttribTemplate(
        actor="None",
        confidence=0.60,
        evidence=[
            "The spacecraft entered safe mode; the triggering fault-protection rule and subsystem are carried in the anomaly payload.",
            "Safe-mode entry is a consequence, not a cause; attribution follows the underlying symptom in the same cluster.",
        ],
        predicted_next="Recovery from safe mode proceeds once the triggering symptom is understood and cleared.",
        capability_lookups=["attribution_uncertainty"],
    ),
    # ---- Space weather ----------------------------------------------------
    # docs/INTERFACE-SPEC.md §4. Global natural events with no actor.
    "space_weather_storm": _AttribTemplate(
        actor="None",
        confidence=0.66,
        evidence=[
            "Geomagnetic storm in progress: Kp at or above 5, with the validity window carried in the observables.",
            "Storm conditions raise drag, charging, and single-event-upset rates on every asset in the affected regime; this is a natural, global event, not attributable activity.",
        ],
        predicted_next="Expect storm-sensitive bus symptoms (orbit decay, resets, power or thermal excursions, safe-mode entries) on exposed assets during the validity window.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "space_weather_radio_burst": _AttribTemplate(
        actor="None",
        confidence=0.60,
        evidence=[
            "Solar radio burst reported by the space-weather feed; wideband noise rises across communication and navigation bands for the burst duration.",
            "A radio burst mimics uplink or downlink interference on sunlit passes; it is a natural event and carries no actor.",
        ],
        predicted_next="Link-margin and GNSS carrier-to-noise dips coincident with the burst window should be discounted as interference.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "space_weather_radiation": _AttribTemplate(
        actor="None",
        confidence=0.62,
        evidence=[
            "Radiation enhancement reported: proton flux at or above S1, with severity scaled from the S-scale.",
            "Elevated proton flux raises single-event-upset and sensor-noise rates; a natural event with no actor.",
        ],
        predicted_next="Expect unexpected resets and sensor saturation on assets in polar or high-altitude regimes during the enhancement.",
        capability_lookups=["attribution_uncertainty"],
    ),
    "space_weather_density": _AttribTemplate(
        actor="None",
        confidence=0.60,
        evidence=[
            "Storm-driven upper-atmosphere density increase reported; drag on low-orbit assets rises above baseline.",
            "Density enhancements produce orbit decay and attitude disturbances without any external actor.",
        ],
        predicted_next="Expect faster-than-baseline decay on low-orbit assets; re-plan station-keeping after the window closes.",
        capability_lookups=["attribution_uncertainty"],
    ),
}

_DEFAULT_ATTRIBUTION = _AttribTemplate(
    actor="Unknown",
    confidence=0.50,
    evidence=["Insufficient signal for confident attribution."],
    predicted_next=None,
    capability_lookups=["attribution_uncertainty"],
)


def _dominant_kind(anomalies: list[Anomaly]) -> str:
    """The kind whose template drives the stub's answer for this batch.

    Most common kind wins, ties by first appearance. Kinds whose template
    carries no actor (bus health, space weather) yield to actor-bearing kinds
    when the batch mixes them: a bus symptom clustered with an RF cue is
    attributed through the RF template, and the verdict lane (wave 2A)
    decides whether the cause is hostile. Batches made only of actor-less
    kinds are unchanged, as are the pre-existing scenarios, which contain no
    actor-less kinds.
    """
    counts = Counter(a.kind for a in anomalies)
    actor_bearing = {
        kind: n
        for kind, n in counts.items()
        if _KIND_TO_ATTRIBUTION.get(kind, _DEFAULT_ATTRIBUTION).actor != "None"
    }
    pool = actor_bearing or dict(counts)
    return Counter(pool).most_common(1)[0][0]


@dataclass(frozen=True)
class StubVerdictOverride:
    """Test knob: make ``reconcile`` propose a verdict for a dominant kind.

    Keyed by the batch's dominant kind in ``StubLLMClient(verdict_overrides=)``.
    With ``verdict_evidence`` the attribution service treats the change as a
    cited reasoning-lane departure; without it the change is repaired back to
    the rule verdict. Not used by any default template, so existing scenarios
    leave the verdict to the rule lane.
    """

    verdict: Verdict
    verdict_evidence: tuple[str, ...] = ()
    confidence: float | None = None


# ---- Decision templates ----------------------------------------------------


@dataclass(frozen=True)
class _DecisionTemplate:
    action: Action
    target: str
    rationale: str
    authority: Authority
    # Set only on recovery_recommendation (docs/INTERFACE-SPEC.md §6).
    recovery: RecoveryBlock | None = None


_DECISIONS: dict[str, _DecisionTemplate] = {
    "rpo_escort": _DecisionTemplate(
        action="active_defense_escort",
        target="threatened_geo_asset",
        rationale=(
            "Inspector approach is consistent with documented RPO precedent. "
            "Recommending orbital reposition request to CJFSCC."
        ),
        authority="request",
    ),
    "satcom_interdict": _DecisionTemplate(
        action="space_link_interdiction_request",
        target="satcom_link",
        rationale=(
            "SATCOM link degradation persists; requesting interdiction support to "
            "preserve the BLOS link."
        ),
        authority="request",
    ),
    "pnt_passive": _DecisionTemplate(
        action="passive_defense",
        target="affected_pnt_receivers",
        rationale=(
            "PNT confidence collapse; switching to multi-constellation fallback "
            "and hardening operator link. Local authority."
        ),
        authority="local",
    ),
    "rf_passive": _DecisionTemplate(
        action="passive_defense",
        target="affected_rf_segment",
        rationale="RF interference inside guard band; switching to hardened comms profile. Local authority.",
        authority="local",
    ),
    "commercial_passive": _DecisionTemplate(
        action="passive_defense",
        target="aor_assets",
        rationale=(
            "Commercial overpass risk; recommending mask of vulnerable assets "
            "during the collection window."
        ),
        authority="local",
    ),
    "cyber_warning": _DecisionTemplate(
        action="threat_warning",
        target="space-ops-c2",
        rationale=(
            "Probe activity is consistent with pre-RF/co-orbital tradecraft. "
            "Issuing watch alert."
        ),
        authority="local",
    ),
    "default_warning": _DecisionTemplate(
        action="threat_warning",
        target="space-ops-c2",
        rationale="Insufficient signal for direct action; routing as informational threat warning.",
        authority="local",
    ),
}


def _select_decision(
    attribution: Attribution, anomalies: Iterable[Anomaly] = ()
) -> _DecisionTemplate:
    """Pick the decision template for an attribution.

    Recovery routing comes first (docs/INTERFACE-SPEC.md §6): an internal or
    natural verdict whose cluster carries an internal-diagnosis
    ``recommended_recovery`` yields a local ``recovery_recommendation``
    carrying that block. ``anomalies`` is the cluster when the caller has it;
    otherwise the block is read from the context DecideService attaches to the
    attribution. Everything else is keyed on the KB citations.
    """
    # Imported here, as the live clients import their prompts: the decide
    # package pulls in the orbit service, which the stub's import graph
    # otherwise stays clear of.
    from canopy.services.decide.prompts import recovery_context, recovery_rationale

    recovery = recovery_context(attribution, anomalies)
    if recovery is not None:
        return _DecisionTemplate(
            action="recovery_recommendation",
            target=recovery.target,
            rationale=recovery_rationale(recovery, attribution),
            authority="local",
            recovery=recovery.block,
        )
    cset = set(attribution.kb_citations)
    actor = attribution.actor
    if "kb-rpo-ambiguity-001" in cset:
        return _DECISIONS["rpo_escort"]
    if "kb-satcom-jamming-001" in cset:
        return _DECISIONS["satcom_interdict"]
    if "kb-gps-jamming-001" in cset:
        return _DECISIONS["pnt_passive"]
    if "kb-commercial-space-001" in cset:
        return _DECISIONS["commercial_passive"]
    if cset == {UNCERTAINTY_ENTRY}:
        return _DECISIONS["cyber_warning"] if actor == "Unknown" else _DECISIONS["default_warning"]
    return _DECISIONS["default_warning"]


# ---- Red-team challenge templates -----------------------------------------


@dataclass(frozen=True)
class _RedTeamTemplate:
    alternative_actor: str | None
    objections: list[str]
    confidence_delta: float  # negative means primary looks overconfident
    rationale: str


_KIND_TO_REDTEAM: dict[str, _RedTeamTemplate] = {
    "rf_anomaly": _RedTeamTemplate(
        alternative_actor="China",
        objections=[
            "Russian EW signature overlaps with Chinese SIGINT-reported emitters in this band.",
            "Single-domain RF cue is insufficient to lock attribution at >0.7.",
        ],
        confidence_delta=-0.05,
        rationale=(
            "Primary jumped to Russia on a single RF burst. Chinese tactical "
            "EW gear shares the same waveform family; without a cyber or "
            "PNT corroborator we cannot rule out a deception cue."
        ),
    ),
    "gnss_spoof": _RedTeamTemplate(
        alternative_actor="Iran proxy",
        objections=[
            "Captured Russian GNSS spoof gear has been observed in Iranian inventories.",
            "Spoof timing pattern is shorter than typical Russian doctrine.",
        ],
        confidence_delta=-0.06,
        rationale=(
            "Could be Iran proxy operating captured Russian gear — the burst "
            "duration is closer to documented Iranian IRGC-EW windows than "
            "the longer-baseline Russian profile."
        ),
    ),
    "cyber_probe_burst": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Cyber probe alone is too generic to reattribute, but uncertainty floor must hold.",
        ],
        confidence_delta=-0.10,
        rationale=(
            "Generic credential-access tradecraft. Without an RF or PNT "
            "corroborator the confidence should remain in the uncertainty band."
        ),
    ),
    "satcom_degradation": _RedTeamTemplate(
        alternative_actor="China",
        objections=[
            "PRC SJ-21-class capabilities produce a similar SATCOM signature.",
            "Footprint timing aligns more closely with PRC overhead pass than Russian theater EW.",
        ],
        confidence_delta=-0.04,
        rationale=(
            "PRC satcom-jamming via SJ-21-family or co-orbital effects is a "
            "viable alternative; the footprint timing isn't unique to Russia."
        ),
    ),
    "orbital_rpo_risk": _RedTeamTemplate(
        alternative_actor="China",
        objections=[
            "RPO inspector-class behaviour matches PRC Shijian-series tradecraft.",
            "Russian co-orbital activity in this regime is rarer than PRC.",
        ],
        confidence_delta=-0.03,
        rationale=(
            "RPO inspector profile is more consistent with PRC Shijian-series "
            "than recent Russian co-orbital behaviour. Lock orbit-derived "
            "attribution to the dominant operator before declaring."
        ),
    ),
    "orbital_collection_risk": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Single collection window is informational; do not raise actor confidence on it alone.",
        ],
        confidence_delta=-0.02,
        rationale=(
            "Open collection window is a context cue, not a hostile act. "
            "Hold attribution confidence until cross-domain corroboration."
        ),
    ),
    "orbital_collection_overlap": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Multi-actor windows can overlap by chance during a busy theater.",
        ],
        confidence_delta=-0.02,
        rationale=(
            "Overlapping collection windows happen by chance in a contested "
            "theater; require an EW or cyber corroborator before locking."
        ),
    ),
    "drone_spoofing": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Identity mismatch can be benign — civil traffic re-IDs frequently.",
        ],
        confidence_delta=-0.04,
        rationale=(
            "Spoofed identity is a probe indicator at best; without RF or "
            "cyber paired evidence the uncertainty floor should hold."
        ),
    ),
    # ---- Bus health (internal-diagnosis lane) -----------------------------
    # The red team's job on a bus symptom is to name the hostile or natural
    # look-alike that produces the same reading, so the internal explanation
    # is not locked before the same-satellite context window is checked.
    "bus_link_margin": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "An uplink or downlink jammer on the same pass produces the same margin drop; an RF anomaly on this satellite inside the look-back window changes the reading.",
            "Trend shape alone does not separate slow amplifier ageing from a slowly ramped interference source.",
        ],
        confidence_delta=-0.04,
        rationale=(
            "Internal amplifier degradation is the simplest reading, but an "
            "external RF effect is not ruled out until the RF picture for this "
            "satellite and window is clear."
        ),
    ),
    "bus_sensor_saturation": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Directed-energy dazzle and sun-in-field-of-view geometry saturate the same detector.",
            "Saturation during a radiation enhancement is expected and carries no fault.",
        ],
        confidence_delta=-0.04,
        rationale=(
            "Saturation is ambiguous between a benign geometry event, a natural "
            "radiation enhancement, and deliberate dazzle; hold the internal "
            "reading until the context window is checked."
        ),
    ),
    "bus_attitude_disturbance": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "A co-orbital close approach or an unintended thrust event produces a disturbance with the same signature.",
            "Wheel friction usually ramps; a step-shaped disturbance argues for an external impulse.",
        ],
        confidence_delta=-0.05,
        rationale=(
            "The disturbance shape decides this: a ramp favors a wheel fault, a "
            "step favors an external impulse. Do not lock the internal reading "
            "on the symptom alone."
        ),
    ),
    "bus_unexpected_reset": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "An unauthorized command or a malformed uplink can trigger the same watchdog reset.",
            "Resets during a radiation enhancement are natural and should not be read as a fault.",
        ],
        confidence_delta=-0.05,
        rationale=(
            "A reset with no matching ground command is what both a single-event "
            "upset and an unauthorized command look like; the cyber and "
            "space-weather context decide it."
        ),
    ),
    "bus_power_thermal": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "A step-shaped excursion is as consistent with a commanded load change as with a hardware fault.",
            "Storm-driven heating produces a drift that resembles a slow thermal fault.",
        ],
        confidence_delta=-0.03,
        rationale=(
            "Power and thermal excursions have benign, natural, and hostile "
            "explanations with similar shapes; the internal reading should stay "
            "bounded until the context window is checked."
        ),
    ),
    "bus_orbit_decay": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "A storm-driven density increase raises decay rates without any fault.",
            "Unintended or induced thrust produces the same semi-major-axis change as drag.",
        ],
        confidence_delta=-0.05,
        rationale=(
            "Decay above the drag model is under-determined: a density "
            "enhancement, a propulsion fault, and induced thrust all fit. The "
            "space-weather window and propulsion telemetry separate them."
        ),
    ),
    "bus_safe_mode": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Safe mode is a downstream effect; attributing the entry without the triggering symptom over-reads the event.",
            "Fault protection can be tripped deliberately by a spoofed telemetry frame or a malformed command.",
        ],
        confidence_delta=-0.04,
        rationale=(
            "Safe-mode entry says only that fault protection fired. The verdict "
            "belongs to the triggering symptom in the same cluster, not to the "
            "entry itself."
        ),
    ),
    # ---- Space weather ----------------------------------------------------
    "space_weather_storm": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Storm indices are global; a storm does not by itself explain a single-satellite symptom.",
            "Hostile activity timed to a storm window would be masked by it; the same-satellite RF, cyber, and orbit check still applies.",
        ],
        confidence_delta=-0.03,
        rationale=(
            "A storm is a strong natural prior but not an alibi: keep the "
            "same-satellite hostile-domain check inside the window before "
            "crediting every symptom to the environment."
        ),
    ),
    "space_weather_radio_burst": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Radio bursts are short; a symptom that outlasts the burst window is not explained by it.",
            "Interference on a night-side pass cannot be a solar radio burst.",
        ],
        confidence_delta=-0.03,
        rationale=(
            "Credit a radio burst only for symptoms inside its window and on "
            "sunlit geometry; anything else keeps its original explanation."
        ),
    ),
    "space_weather_radiation": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "Radiation enhancements raise upset rates but do not cause every reset; check the reset timing against the flux profile.",
            "Shielded assets in low-inclination orbits see little of the enhancement.",
        ],
        confidence_delta=-0.03,
        rationale=(
            "The enhancement is a valid natural prior for resets and saturation "
            "on exposed assets only; it should not be applied to shielded or "
            "low-inclination assets."
        ),
    ),
    "space_weather_density": _RedTeamTemplate(
        alternative_actor=None,
        objections=[
            "A density enhancement affects every low-orbit object in the regime; a single asset decaying alone points elsewhere.",
            "Decay rate should track the storm profile; a rate that persists after the window is not drag.",
        ],
        confidence_delta=-0.03,
        rationale=(
            "Drag from a density enhancement is fleet-wide and time-bound; a "
            "lone asset or a persistent rate argues against the natural "
            "explanation."
        ),
    ),
}

_DEFAULT_REDTEAM = _RedTeamTemplate(
    alternative_actor=None,
    objections=["Insufficient cross-domain corroboration to lock attribution."],
    confidence_delta=-0.03,
    rationale=(
        "Primary attribution rests on a single cue; without a corroborating "
        "domain the confidence should be lowered."
    ),
)


# ---- Stub LLM client -------------------------------------------------------


class StubLLMClient:
    """Deterministic, hand-authored LLMClient for the foundation/scenario pass.

    Attribution selects a template by the dominant anomaly ``kind`` and pulls
    citations from the KB by ``scenario_signal_id`` first, then by
    ``capability_type``. Decisions are picked from the citation set so the
    decision logic stays grounded in the same KB the attribution cites.
    """

    def __init__(
        self,
        kb: KB,
        *,
        verdict_overrides: Mapping[str, StubVerdictOverride] | None = None,
    ) -> None:
        self._kb = kb
        self._verdict_overrides: dict[str, StubVerdictOverride] = dict(verdict_overrides or {})

    async def attribute(
        self, anomalies: list[Anomaly], kb_context: Iterable[KBEntry] = ()
    ) -> Attribution:
        return await self.attribute_primary(anomalies, kb_context)

    async def attribute_primary(
        self,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
        *,
        rule_verdict: object | None = None,
    ) -> Attribution:
        # ``rule_verdict`` is the provisional verdict the attribution service
        # passes to every client; the stub leaves ``verdict`` unset so the
        # service fills it from the rule lane.
        if not anomalies:
            raise ValueError("attribute() requires at least one anomaly")

        dominant_kind = _dominant_kind(anomalies)
        template = _KIND_TO_ATTRIBUTION.get(dominant_kind, _DEFAULT_ATTRIBUTION)

        source_ids = list(
            dict.fromkeys(sid for a in anomalies for sid in a.source_signal_ids)
        )

        citations: list[str] = []
        seen: set[str] = set()
        for sid in source_ids:
            for entry in self._kb.by_scenario_signal_id(sid):
                if entry.id not in seen:
                    citations.append(entry.id)
                    seen.add(entry.id)
        if not citations:
            for cap in template.capability_lookups:
                for entry in self._kb.by_capability(cap):
                    if entry.id not in seen:
                        citations.append(entry.id)
                        seen.add(entry.id)

        # Always-on caveat reference per the kb_seed guidance.
        if UNCERTAINTY_ENTRY in self._kb and UNCERTAINTY_ENTRY not in seen:
            citations.append(UNCERTAINTY_ENTRY)

        actor, evidence = self._name_for_kb(template.actor, list(template.evidence))
        return Attribution(
            anomaly_ids=[a.id for a in anomalies],
            actor=actor,
            confidence=template.confidence,
            doctrine_match=citations[0] if citations else None,
            evidence=evidence,
            predicted_next=template.predicted_next,
            kb_citations=citations,
            source_signal_ids=source_ids,
        )

    # The canned templates name real states, which CANOPY's own scenarios use.
    # A knowledge base that names only synthetic actors (the MEGALITH demo's
    # Actor-1; demo plan section 6, no real actor may reach the screen) gets
    # its own actor in place of the template's, in the actor field and in the
    # evidence lines. A knowledge base that knows the template's actor keeps it.
    _REAL_NAMES = ("Russian", "Russia", "Chinese", "China", "Iranian", "Iran", "North Korean", "North Korea")

    def _name_for_kb(self, actor: str | None, evidence: list[str]) -> tuple[str | None, list[str]]:
        # Only a real state's name is replaced: "Unknown" and "None" (no actor)
        # and any synthetic name pass through untouched.
        if not actor or actor not in self._REAL_NAMES:
            return actor, evidence
        known = self._kb.actors()
        if not known or actor in known:
            return actor, evidence
        stand_in = known[0]
        pattern = re.compile("|".join(re.escape(name) for name in self._REAL_NAMES))
        return stand_in, [pattern.sub(stand_in, line) for line in evidence]

    def _alternative_for_kb(self, alternative: str | None, primary_actor: str | None) -> str | None:
        if not alternative or alternative not in self._REAL_NAMES:
            return alternative
        known = self._kb.actors()
        if not known or alternative in known:
            return alternative
        others = [name for name in known if name != primary_actor]
        return others[0] if others else None

    async def attribute_redteam(
        self,
        primary: Attribution,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
    ) -> AttributionChallenge:
        if not anomalies:
            template = _DEFAULT_REDTEAM
        else:
            template = _KIND_TO_REDTEAM.get(_dominant_kind(anomalies), _DEFAULT_REDTEAM)

        # If primary already landed on Unknown, soften the challenge — the
        # red-team's job there is to defend the uncertainty floor, not invent
        # an alternative actor.
        if primary.actor == "Unknown":
            template = _RedTeamTemplate(
                alternative_actor=None,
                objections=[
                    "Primary held the uncertainty floor; do not raise without corroboration.",
                ],
                confidence_delta=0.0,
                rationale=(
                    "Primary correctly held the uncertainty floor; defend it "
                    "until cross-domain evidence accumulates."
                ),
            )

        alternative = self._alternative_for_kb(template.alternative_actor, primary.actor)
        _, objections = self._name_for_kb(template.alternative_actor, list(template.objections))
        _, rationale_lines = self._name_for_kb(template.alternative_actor, [template.rationale])
        return AttributionChallenge(
            primary_attribution_id=primary.id,
            alternative_actor=alternative,
            objections=objections,
            confidence_delta=template.confidence_delta,
            rationale=rationale_lines[0],
        )

    async def reconcile(
        self,
        primary: Attribution,
        challenge: AttributionChallenge,
        anomalies: list[Anomaly],
        kb_context: Iterable[KBEntry] = (),
        *,
        rule_verdict: object | None = None,
    ) -> Attribution:
        # Apply the red-team's confidence delta against the existing 0.49
        # uncertainty floor used by the rest of the engine.
        new_confidence = max(0.49, min(1.0, primary.confidence + challenge.confidence_delta))

        evidence = list(primary.evidence)
        evidence.append(f"Red-team review: {challenge.rationale}")
        for objection in challenge.objections:
            evidence.append(f"Red-team objection: {objection}")

        # Default templates leave the verdict to the rule lane. A registered
        # override (tests only) makes the stub propose one, with or without
        # cited evidence, so the §5.2 repair path can be exercised.
        override = (
            self._verdict_overrides.get(_dominant_kind(anomalies)) if anomalies else None
        )
        verdict_fields: dict[str, object] = {}
        if override is not None:
            verdict_fields = {
                "verdict": override.verdict,
                "verdict_evidence": list(override.verdict_evidence),
            }
            if override.confidence is not None:
                new_confidence = override.confidence

        return Attribution(
            anomaly_ids=list(primary.anomaly_ids),
            actor=primary.actor,
            confidence=round(new_confidence, 3),
            doctrine_match=primary.doctrine_match,
            evidence=evidence,
            predicted_next=primary.predicted_next,
            kb_citations=list(primary.kb_citations),
            source_signal_ids=list(primary.source_signal_ids),
            **verdict_fields,
        )

    async def decide(
        self, attribution: Attribution, anomalies: Iterable[Anomaly] = ()
    ) -> Decision:
        template = _select_decision(attribution, anomalies)
        request_packet = (
            {
                "to": "CJFSCC",
                "supporting_supported": "supported_by_USSF",
                "actor": attribution.actor,
                "confidence": attribution.confidence,
                "justification": attribution.evidence,
                "kb_citations": attribution.kb_citations,
            }
            if template.authority == "request"
            else None
        )
        return Decision(
            attribution_id=attribution.id,
            action=template.action,
            target=template.target,
            rationale=template.rationale,
            authority=template.authority,
            request_packet=request_packet,
            source_signal_ids=list(attribution.source_signal_ids),
            recovery=template.recovery,
        )
