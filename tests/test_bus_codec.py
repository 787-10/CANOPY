"""Round-trip tests for the bus envelope codec (docs/INTERFACE-SPEC.md §10)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from canopy.services.bus import codec
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    AttributionChallenge,
    Decision,
    EmbeddingPoint,
    Location,
    OsintEmbeddingSnapshot,
    Provenance,
    ReasoningTrace,
    Signal,
    UIEvent,
)
from pydantic import BaseModel

T0 = datetime(2026, 9, 17, 14, 30, 15, 123456, tzinfo=UTC)


def _signal() -> Signal:
    return Signal(
        ts=T0,
        domain="bus_health",
        source="internal-diagnosis",
        realism="mock_operational",
        confidence=0.81,
        location=Location(label="LEO", lat=1.5, lng=-2.25, orbit_regime="LEO"),
        payload={
            "event_type": "bus_link_margin",
            "summary": "link margin down 3 dB",
            "satellite_id": "ctb://centralblue.dev/leo-science-1",
            "observables": {"rate_of_change": -0.4, "onset_ts": T0.isoformat()},
            "extra_payload_field": [1, 2, 3],
        },
        provenance=Provenance(source_id="fdir-1", generated_at=T0 - timedelta(seconds=3)),
        extra_top_level="kept",
    )


def _anomaly() -> Anomaly:
    return Anomaly(
        ts=T0,
        kind="bus_link_margin",
        source_signal="sig-1",
        source_signal_ids=["sig-1", "sig-2"],
        severity=0.7,
        payload={"physics_consistency": 0.83, "onset_ts": "2026-09-17T14:30:00Z"},
        extra_field={"nested": True},
    )


def _attribution() -> Attribution:
    return Attribution(
        ts=T0,
        anomaly_ids=["a-1"],
        actor="Unknown",
        confidence=0.42,
        evidence=["e1"],
        verdict="internal_fault",
        physics_consistency=0.83,
        verdict_basis="rule",
        satellite_id="ctb://centralblue.dev/leo-science-1",
        summary="rule lane",
        extra_field="x",
    )


def _challenge() -> AttributionChallenge:
    return AttributionChallenge(
        ts=T0,
        primary_attribution_id="att-1",
        alternative_actor="Nature",
        objections=["storm"],
        confidence_delta=-0.1,
        rationale="Kp was 7",
        extra_field=1,
    )


def _decision() -> Decision:
    return Decision(
        ts=T0,
        attribution_id="att-1",
        action="threat_warning",
        target="leo-science-1",
        rationale="watch it",
        authority="local",
        request_packet={"why": "test"},
        selectable_set=["passive_defense", "threat_warning"],
        selection_basis="model-within-set",
        extra_field="kept",
    )


def _ui_event() -> UIEvent:
    return UIEvent(
        ts=T0,
        type="threat_updated",
        timestamp=T0,
        severity="high",
        title="t",
        message="m",
        confidence=0.5,
        demoBeat="beat1",
        extra_field="kept",
    )


def _trace() -> ReasoningTrace:
    return ReasoningTrace(
        ts=T0,
        stage="attrib_primary",
        level="info",
        message="hello",
        ref_id="att-1",
        payload={"challenge": _challenge().model_dump(mode="json"), "t_ms": 12.5},
        extra_field="kept",
    )


def _embedding() -> OsintEmbeddingSnapshot:
    return OsintEmbeddingSnapshot(
        ts=T0,
        points=[EmbeddingPoint(signal_id="s", summary="x", cluster_id=1, x=0.1, y=-0.2, ts=T0)],
        cluster_count=1,
        model_name="stub",
        embedding_dim=2,
        extra_field="kept",
    )


CASES = [
    ("signal", "signals.bus_health", _signal),
    ("anomaly", "anomalies.bus_link_margin", _anomaly),
    ("attribution", "attributions.Unknown", _attribution),
    ("attribution_challenge", "challenges.att-1", _challenge),
    ("decision", "decisions.local", _decision),
    ("ui_event", "ui_events.alert", _ui_event),
    ("trace", "traces.attrib", _trace),
    ("embedding", "embeddings.osint", _embedding),
]


def test_registry_covers_every_published_class() -> None:
    kinds = codec.registered_kinds()
    assert set(kinds) >= {kind for kind, _, _ in CASES}
    assert kinds["signal"] is Signal
    assert kinds["trace"] is ReasoningTrace
    assert kinds["embedding"] is OsintEmbeddingSnapshot
    for kind, cls in kinds.items():
        assert codec.kind_for(cls) == kind
        assert codec.class_for(kind) is cls


@pytest.mark.parametrize("kind,topic,make", CASES, ids=[c[0] for c in CASES])
def test_round_trip_preserves_class_fields_datetimes_and_extras(kind, topic, make) -> None:
    event = make()
    wire = codec.encode(topic, event)
    assert isinstance(wire, bytes)

    envelope = json.loads(wire)
    assert set(envelope) == {"kind", "topic", "data"}
    assert envelope["kind"] == kind
    assert envelope["topic"] == topic
    assert envelope["data"] == event.model_dump(mode="json")

    got_topic, got = codec.decode(wire)
    assert got_topic == topic
    assert type(got) is type(event)
    assert got.model_dump() == event.model_dump()
    assert got.ts == event.ts and got.ts.tzinfo is not None
    assert got.model_extra == event.model_extra
    assert got.model_extra  # every fixture carries at least one extra field


def test_signal_round_trip_keeps_nested_extras_and_datetimes() -> None:
    signal = _signal()
    _, got = codec.decode(codec.encode("signals.bus_health", signal))
    assert isinstance(got, Signal)
    assert got.location.model_extra == {"orbit_regime": "LEO"}
    assert got.payload.model_extra == {"extra_payload_field": [1, 2, 3]}
    assert got.model_extra == {"extra_top_level": "kept"}
    assert got.provenance.generated_at == T0 - timedelta(seconds=3)
    assert got.payload.observables == signal.payload.observables


def test_envelope_dict_matches_encoded_bytes() -> None:
    signal = _signal()
    assert codec.envelope("signals.bus_health", signal) == json.loads(
        codec.encode("signals.bus_health", signal)
    )
    assert codec.decode_envelope(codec.envelope("signals.bus_health", signal))[1] == signal


def test_subclass_resolves_to_its_registered_base() -> None:
    class SpecialSignal(Signal):
        pass

    special = SpecialSignal.model_validate(_signal().model_dump())
    assert codec.kind_for(special) == "signal"
    _, got = codec.decode(codec.encode("signals.x", special))
    assert type(got) is Signal


def test_unknown_class_and_kind_raise() -> None:
    class Stranger(BaseModel):
        x: int = 1

    with pytest.raises(codec.CodecError):
        codec.encode("t", Stranger())
    with pytest.raises(codec.CodecError):
        codec.decode(b'{"kind": "stranger", "topic": "t", "data": {}}')
    with pytest.raises(codec.CodecError):
        codec.decode(b"not json")
    with pytest.raises(codec.CodecError):
        codec.decode(b'{"kind": "signal", "topic": "t"}')
    with pytest.raises(codec.CodecError):
        codec.decode(b'{"kind": "signal", "topic": "t", "data": {"domain": "cyber"}}')


def test_register_is_idempotent_but_refuses_conflicts() -> None:
    class Stranger(BaseModel):
        x: int = 1

    codec.register("signal", Signal)  # same pair: no-op
    with pytest.raises(codec.CodecError):
        codec.register("signal", Stranger)
    with pytest.raises(codec.CodecError):
        codec.register("signal_again", Signal)
    with pytest.raises(codec.CodecError):
        codec.register("", Stranger)
