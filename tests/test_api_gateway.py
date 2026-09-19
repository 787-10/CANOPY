"""Smoke tests for the FastAPI gateway, plus the schema endpoint and the
generated TypeScript types it feeds (docs/C2-API.md)."""
from __future__ import annotations

import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import jsonschema
import pytest
from fastapi.testclient import TestClient

from canopy.api import app
from canopy.api.schemas import SCHEMA_MODES, event_schema, event_schemas
from canopy.services.bus import codec
from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    AttributionChallenge,
    Decision,
    EmbeddingPoint,
    OsintEmbeddingSnapshot,
    ReasoningTrace,
    Recommendation,
    RecoveryBlock,
    Signal,
    UIEvent,
    WithheldRecovery,
)

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import gen_ts_types  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["kb_entries"] >= 5


def test_list_scenarios(client: TestClient) -> None:
    response = client.get("/scenarios")
    assert response.status_code == 200
    scenarios = response.json()
    # We have 11 checked-in scenarios at the time of this test (4 canonical
    # beats + 4 army + 3 iran). Lower bound is more useful than exact match
    # so adding a scenario doesn't fail this test.
    assert len(scenarios) >= 11
    assert "beat47.jsonl" in scenarios
    assert "army_multidomain_attack_chain.jsonl" in scenarios


def test_scenario_registry_exposes_demo_metadata(client: TestClient) -> None:
    response = client.get("/scenario-registry")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == 1
    by_file = {case["file"]: case for case in payload["cases"]}
    assert by_file["beat47.jsonl"]["short_name"] == "SATCOM gateway"
    assert "demo" in by_file["beat47.jsonl"]["visibility"]


def test_replay_unknown_scenario_404(client: TestClient) -> None:
    response = client.post("/scenarios/does_not_exist.jsonl/replay")
    assert response.status_code == 404


def test_replay_known_scenario_returns_200(client: TestClient) -> None:
    response = client.post("/scenarios/beat47.jsonl/replay?speed=1000")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "replaying"
    assert body["scenario"] == "beat47.jsonl"


def test_websocket_receives_ui_event_after_replay(client: TestClient) -> None:
    """Connect WS, trigger a replay, assert a ui_event envelope arrives."""
    with client.websocket_connect("/ws") as ws:
        # Kick off a replay; the WS should start receiving envelopes.
        response = client.post("/scenarios/beat47.jsonl/replay?speed=1000")
        assert response.status_code == 200

        # Drain envelopes until we see a ui_event or run out of patience.
        # beat47 has 6 signals; with speed=1000 the replay completes in ms.
        # Stub LLM is sub-millisecond, so a ui_event should arrive promptly.
        saw_ui_event = False
        # OSINT clustering loads sentence-transformer weights on the
        # first OSINT signal (multi-second cold start) and
        # orbit.compute_close_approach iterates Skyfield SGP4 over 360
        # samples per call. Give the pipeline a generous budget so this
        # test isn't flaky on cold caches.
        deadline = time.time() + 60.0
        kinds_seen: list[str] = []
        while time.time() < deadline:
            envelope = ws.receive_json()
            kinds_seen.append(envelope.get("kind"))
            if envelope.get("kind") == "ui_event":
                saw_ui_event = True
                break
        assert saw_ui_event, f"no ui_event seen within deadline; kinds={kinds_seen}"


def test_replay_honours_speed_and_max_delay_s(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The console paces a run with ``speed=20&max_delay_s=6``; both reach the replay."""
    import canopy.api as api_module

    calls: list[dict[str, object]] = []

    class RecordingReplay:
        def __init__(
            self, bus, path, *, speed: float, max_delay_s: float | None,
            signal_filter=None, signal_transform=None,
        ) -> None:
            # The gateway applies the manifest record roles like the bench does:
            # oracle records never reach the bus, redacted observables are stripped.
            assert callable(signal_filter) and callable(signal_transform)
            calls.append({"file": Path(path).name, "speed": speed, "max_delay_s": max_delay_s})

        async def run(self) -> None:
            return None

    monkeypatch.setattr(api_module, "ScenarioReplayService", RecordingReplay)

    response = client.post("/scenarios/beat47.jsonl/replay?speed=20&max_delay_s=6")
    assert response.status_code == 200
    assert response.json() == {
        "status": "replaying", "scenario": "beat47.jsonl", "speed": 20.0, "max_delay_s": 6.0,
    }
    response = client.post("/scenarios/beat47.jsonl/replay")
    assert response.status_code == 200
    assert response.json()["speed"] == 5.0 and response.json()["max_delay_s"] == 0.5
    response = client.post("/scenarios/beat47.jsonl/replay?speed=1000")
    assert response.json()["max_delay_s"] == 0.5  # default kept when absent
    assert calls == [
        {"file": "beat47.jsonl", "speed": 20.0, "max_delay_s": 6.0},
        {"file": "beat47.jsonl", "speed": 5.0, "max_delay_s": 0.5},
        {"file": "beat47.jsonl", "speed": 1000.0, "max_delay_s": 0.5},
    ]
    # Out-of-range pacing is a client error, not a crashed replay task.
    assert client.post("/scenarios/beat47.jsonl/replay?max_delay_s=-1").status_code == 422
    assert client.post("/scenarios/beat47.jsonl/replay?speed=0").status_code == 422
    assert len(calls) == 3


def test_post_signal_publishes_to_bus(client: TestClient) -> None:
    payload = {
        "id": "test-sig-001",
        "ts": "2026-06-18T14:30:00Z",
        "domain": "rf_ew",
        "source": "test",
        "realism": "mock_operational",
        "confidence": 0.85,
        "location": {"label": "test"},
        "payload": {"event_type": "rf_interference", "summary": "test"},
        "provenance": {"source_id": "test"},
    }
    response = client.post("/signals", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"
    assert body["id"] == "test-sig-001"


# ---- GET /schemas: every kind, from the pydantic models -------------------------------

TS = datetime(2026, 9, 17, 14, 32, 12, tzinfo=UTC)
SAT = "ctb://centralblue.dev/leo-science-1"


def _sample_events() -> dict[str, object]:
    """One fully populated instance per registered kind."""
    signal = Signal.model_validate(
        {
            "id": "sig-1",
            "ts": TS,
            "domain": "bus_health",
            "source": "internal-diagnosis",
            "realism": "mock_operational",
            "confidence": 0.81,
            "location": {"label": "LEO-SCIENCE-1"},
            "payload": {
                "event_type": "link_margin_drop",
                "summary": "margin falling",
                "asset": "LEO-SCIENCE-1",
                "satellite_id": SAT,
                "observables": {"subsystem": "comms", "recommended_recovery": None},
            },
            "provenance": {"source_id": "internal-diagnosis", "generated_at": TS},
        }
    )
    anomaly = Anomaly(
        id="anom-1", ts=TS, kind="bus_link_margin", source_signal="sig-1",
        source_signal_ids=["sig-1"], severity=0.81, payload={"satellite_id": SAT},
    )
    attribution = Attribution(
        id="attr-1", ts=TS, anomaly_ids=["anom-1"], actor="Unknown", confidence=0.45,
        evidence=["e"], kb_citations=["kb-attribution-uncertainty-001"],
        verdict="hostile_external", physics_consistency=0.31, verdict_basis="rule",
        satellite_id=SAT, provisional=True,
    )
    challenge = AttributionChallenge(
        id="chal-1", ts=TS, primary_attribution_id="attr-1", alternative_actor=None,
        objections=["o"], confidence_delta=-0.1, rationale="r",
    )
    recovery = RecoveryBlock(
        action_id="switch_redundant_amplifier", target_subsystem="comms",
        requires_approval=True, rationale="r", satellite_id=SAT,
    )
    decision = Decision(
        id="dec-1", ts=TS, attribution_id="attr-1", action="threat_warning",
        target="brigade_commander", rationale="r", authority="local",
        withheld_recovery=WithheldRecovery(
            action_id="switch_redundant_amplifier", target_subsystem="comms",
            reason_code="verdict/hostile_external",
        ),
        revision=1,
        selectable_set=[
            "passive_defense", "threat_warning", "sda_tasking",
            "active_defense_escort", "space_link_interdiction_request",
        ],
        selection_basis="model-within-set",
    )
    recovery_decision = Decision(
        id="dec-2", ts=TS, attribution_id="attr-2", action="recovery_recommendation",
        target="LEO-SCIENCE-1", rationale="r", authority="local", recovery=recovery,
        selectable_set=["recovery_recommendation"], selection_basis="recovery-routed",
    )
    ui_event = UIEvent(
        id="uievt-dec-1", ts=TS, type="recommendation_created", severity="high",
        title="t", message="m", confidence=0.7, demoBeat="4.7",
        recommendation=Recommendation(id="rec-dec-1", summary="s"),
    )
    trace = ReasoningTrace(
        id="tr-1", ts=TS, stage="decide", level="warn",
        message="recovery withheld: switch_redundant_amplifier: verdict/hostile_external",
        ref_id="dec-1", payload={"reason_code": "verdict/hostile_external", "latency_ms": 12.5},
    )
    embedding = OsintEmbeddingSnapshot(
        id="emb-1", ts=TS,
        points=[EmbeddingPoint(signal_id="sig-o", summary="s", cluster_id=0, x=0.1, y=-0.2, ts=TS)],
        cluster_count=1, similarity_threshold=0.7, model_name="m", embedding_dim=384,
    )
    return {
        "signal": signal,
        "anomaly": anomaly,
        "attribution": attribution,
        "attribution_challenge": challenge,
        "decision": [decision, recovery_decision],
        "ui_event": ui_event,
        "trace": trace,
        "embedding": embedding,
    }


def _validator(schema: dict) -> jsonschema.Draft202012Validator:
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker())


def test_schemas_endpoint_returns_every_registered_kind(client: TestClient) -> None:
    response = client.get("/schemas")
    assert response.status_code == 200
    schemas = response.json()
    assert list(schemas) == list(codec.registered_kinds())
    assert set(schemas) == {
        "signal", "anomaly", "attribution", "attribution_challenge",
        "decision", "ui_event", "trace", "embedding",
    }
    for kind, schema in schemas.items():
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert schema["title"] == codec.class_for(kind).__name__
        assert schema["type"] == "object"


def test_each_schema_validates_a_sample_event_dumped_by_the_codec(client: TestClient) -> None:
    schemas = client.get("/schemas").json()
    samples = _sample_events()
    assert set(samples) == set(schemas)
    for kind, events in samples.items():
        validator = _validator(schemas[kind])
        for event in events if isinstance(events, list) else [events]:
            envelope = codec.envelope(f"{kind}.test", event)
            assert envelope["kind"] == kind
            validator.validate(envelope["data"])  # a full dump, nulls included


def test_serialization_schema_requires_every_declared_property(client: TestClient) -> None:
    schema = client.get("/schemas/decision").json()
    assert set(schema["required"]) == set(schema["properties"])
    assert "withheld_recovery" in schema["properties"]
    # Spec 1.4 bounded response: both nullable; the set is an array of Action.
    selectable = schema["properties"]["selectable_set"]["anyOf"]
    assert {member.get("type") for member in selectable} == {"array", "null"}
    assert schema["properties"]["selection_basis"]["anyOf"] == [{"type": "string"}, {"type": "null"}]
    assert schema["properties"]["withheld_recovery"]["anyOf"] == [
        {"$ref": "#/$defs/WithheldRecovery"},
        {"type": "null"},
    ]
    withheld = schema["$defs"]["WithheldRecovery"]
    assert set(withheld["required"]) == {"action_id", "target_subsystem", "reason_code", "source"}
    assert withheld["properties"]["source"] == {
        "const": "internal-diagnosis", "default": "internal-diagnosis", "title": "Source", "type": "string",
    }
    # A wire Decision missing a declared field is rejected in this mode ...
    partial = {"id": "d", "ts": "2026-09-17T14:32:12Z", "attribution_id": "a", "action": "threat_warning",
               "target": "t", "rationale": "r", "authority": "local"}
    assert list(jsonschema.Draft202012Validator(schema).iter_errors(partial))
    # ... and accepted by the validation-mode schema, which is what a client may send.
    validation = client.get("/schemas/decision?mode=validation").json()
    assert set(validation["required"]) == {"attribution_id", "action", "target", "rationale", "authority"}
    jsonschema.Draft202012Validator(validation).validate(partial)


def test_schema_kind_and_mode_errors(client: TestClient) -> None:
    missing = client.get("/schemas/nope")
    assert missing.status_code == 404
    assert "signal" in missing.json()["detail"]
    assert client.get("/schemas?mode=bogus").status_code == 400
    assert client.get("/schemas/signal?mode=bogus").status_code == 400
    assert client.get("/schemas/signal?mode=validation").status_code == 200
    with pytest.raises(ValueError):
        event_schema("signal", mode="bogus")  # type: ignore[arg-type]
    with pytest.raises(codec.CodecError):
        event_schema("nope")
    assert SCHEMA_MODES == ("serialization", "validation")


def test_signal_schema_matches_the_endpoint_for_the_post_route(client: TestClient) -> None:
    # What POST /signals accepts is the validation-mode signal schema: id and
    # ts may be omitted, the rest may not.
    schema = client.get("/schemas/signal?mode=validation").json()
    assert "id" not in schema["required"] and "ts" not in schema["required"]
    body = {
        "domain": "rf_ew", "source": "test", "realism": "mock_operational", "confidence": 0.5,
        "location": {"label": "x"}, "payload": {"event_type": "rf_interference", "summary": "s"},
        "provenance": {"source_id": "test"},
    }
    jsonschema.Draft202012Validator(schema).validate(body)
    assert client.post("/signals", json=body).status_code == 200


# ---- Generated TypeScript types: checked-in files equal a fresh generation --------------


def test_checked_in_schemas_fixture_equals_a_fresh_dump() -> None:
    fixture = json.loads(gen_ts_types.SCHEMAS_JSON.read_text(encoding="utf-8"))
    assert fixture == event_schemas(mode="serialization")
    assert gen_ts_types.SCHEMAS_JSON.read_text(encoding="utf-8") == gen_ts_types.schemas_json_text(fixture)


def test_checked_in_generated_types_equal_a_fresh_render() -> None:
    schemas_text, ts_text = gen_ts_types.generate()
    assert gen_ts_types.GEN_TS.read_text(encoding="utf-8") == ts_text, (
        f"stale generated types; run: {gen_ts_types.REGENERATE}"
    )
    assert f"{gen_ts_types.DIGEST_PREFIX}{gen_ts_types.digest(schemas_text)}" in ts_text
    assert gen_ts_types.main(["--check"]) == 0


def test_generated_types_cover_every_kind_and_the_withheld_block() -> None:
    _, ts_text = gen_ts_types.generate()
    for kind, cls in codec.registered_kinds().items():
        assert f"export type {cls.__name__} = {{" in ts_text, kind
        assert f"  {kind}: {cls.__name__}" in ts_text
    assert "export type WithheldRecovery = {" in ts_text
    assert "withheld_recovery: WithheldRecovery | null" in ts_text
    assert "selectable_set: Array<'passive_defense'" in ts_text
    assert "selection_basis: string | null" in ts_text
    assert "reason_code: string" in ts_text
    assert "source: 'internal-diagnosis'" in ts_text
    assert "action: 'passive_defense' | 'active_defense_escort'" in ts_text
    assert "export const EVENT_KINDS = [" in ts_text
    assert "GENERATED FILE" in ts_text.splitlines()[0]


def test_emitter_handles_the_shapes_it_claims() -> None:
    ts = gen_ts_types.ts_type
    assert ts({"type": "string"}) == "string"
    assert ts({"type": "integer"}) == "number"
    assert ts({"type": ["string", "null"]}) == "string | null"
    assert ts({"anyOf": [{"$ref": "#/$defs/RecoveryBlock"}, {"type": "null"}]}) == "RecoveryBlock | null"
    assert ts({"type": "array", "items": {"type": "string"}}) == "string[]"
    assert ts({"type": "array", "items": {"type": ["string", "null"]}}) == "Array<string | null>"
    assert ts({"type": "array"}) == "unknown[]"
    assert ts({"type": "object", "additionalProperties": True}) == "Record<string, unknown>"
    assert ts({"type": "object", "additionalProperties": {"type": "number"}}) == "Record<string, number>"
    assert ts({"type": "object", "additionalProperties": False}) == "Record<string, never>"
    assert ts({"enum": ["a", "b'c"]}) == "'a' | 'b\\'c'"
    assert ts({"const": 3}) == "3"
    assert ts({}) == "unknown"
    nested = ts({"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}, "b": {"type": "number"}}, "additionalProperties": False})
    assert nested == "{\n  a: string\n  b?: number\n}"
    with pytest.raises(gen_ts_types.SchemaError):
        ts({"$ref": "http://elsewhere/schema.json"})
