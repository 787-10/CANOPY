"""Marking on every event (docs/INTERFACE-SPEC.md §1.1, spec 1.4, pre-submission C12).

Grammar and combination rule in ``canopy.services.schemas.events``: ``U`` <
``CUI`` < ``CUI//SP-*``, specified categories combine as a sorted union.
Propagation rule (a derived event's marking is never lower than the most
restrictive input) at the fusion correlator and along the attribution fast
lane: provisional and final attribution, decision and UI event. Traces carry
the default ``U`` and are not derived (a documented limitation).

The pipeline tests reuse the fast-lane fixtures (``tests/test_fast_lane.py``):
the toy rule, the zero-delay stub and ``_start(with_decide=True, with_ui=True)``.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from canopy.services.bus import InProcessBus
from canopy.services.fusion import FusionService
from canopy.services.schemas.events import (
    MARKING_CUI,
    MARKING_PATTERN,
    MARKING_UNCLASSIFIED,
    Anomaly,
    Location,
    Provenance,
    ReasoningTrace,
    Signal,
    marking_categories,
    most_restrictive,
    validate_marking,
)
from pydantic import ValidationError

from tests.test_fast_lane import _bus as _bus_anomaly
from tests.test_fast_lane import _rf as _rf_anomaly
from tests.test_fast_lane import _start

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "services" / "bus" / "schemas"
T0 = datetime(2026, 9, 17, 14, 30, tzinfo=UTC)
SAT = "ctb://centralblue.dev/leo-science-1"

ACCEPTED = ["U", "CUI", "CUI//SP-A", "CUI//SP-A/SP-B", "CUI//SP-B/SP-A", "CUI//SP-A-1/SP-B2"]
REJECTED = [
    "u",
    "cui",
    "CUI//",
    "CUI//SP-",
    "CUI//SP-a",
    "CUI/SP-A",
    "CUI//SP-A/",
    "CUI//SP-A/SP-A",  # repeated category
    "",
    " U",
    "U ",
    "SECRET",
]


# ---- Fixtures -----------------------------------------------------------------------


def _signal(
    *,
    id: str,
    domain: str,
    event_type: str,
    offset_s: float = 0.0,
    marking: str = MARKING_UNCLASSIFIED,
    confidence: float = 0.8,
) -> Signal:
    return Signal(
        id=id,
        ts=T0 + timedelta(seconds=offset_s),
        marking=marking,
        domain=domain,
        source="test",
        realism="mock_operational",
        confidence=confidence,
        location=Location(label="t"),
        payload={
            "event_type": event_type,
            "summary": "test",
            "satellite_id": SAT,
            "observables": {},
        },
        provenance=Provenance(source_id="t"),
    )


def _rf(id: str, offset_s: float, **kw) -> Signal:
    return _signal(id=id, domain="rf_ew", event_type="rf_interference", offset_s=offset_s, **kw)


def _bus(id: str, offset_s: float, **kw) -> Signal:
    return _signal(id=id, domain="bus_health", event_type="link_margin_drop", offset_s=offset_s, **kw)


async def _fuse(signals: list[Signal]) -> list[Anomaly]:
    """Publish ``signals`` in order through a live FusionService; return its anomalies."""
    bus = InProcessBus()
    fusion = FusionService(bus)
    received: list[Anomaly] = []

    async def sniff() -> None:
        async for _, event in bus.subscribe("anomalies.*"):
            if isinstance(event, Anomaly):
                received.append(event)

    tasks = [asyncio.create_task(sniff()), asyncio.create_task(fusion.run())]
    await asyncio.sleep(0)
    try:
        for signal in signals:
            await bus.publish(f"signals.{signal.domain}", signal)
        await asyncio.wait_for(bus.drain(), timeout=2.0)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bus.close()
    return received


def _by_source(anomalies: list[Anomaly], signal_id: str) -> Anomaly:
    return next(a for a in anomalies if a.source_signal == signal_id)


# ---- Grammar --------------------------------------------------------------------------


@pytest.mark.parametrize("marking", ACCEPTED)
def test_grammar_accepts(marking: str) -> None:
    assert validate_marking(marking) == marking
    assert _signal(id="s", domain="rf_ew", event_type="rf_interference", marking=marking).marking == marking


@pytest.mark.parametrize("marking", REJECTED)
def test_grammar_rejects(marking: str) -> None:
    with pytest.raises(ValueError, match="marking"):
        validate_marking(marking)
    with pytest.raises(ValidationError):
        _signal(id="s", domain="rf_ew", event_type="rf_interference", marking=marking)


def test_grammar_rejects_non_strings() -> None:
    with pytest.raises(ValueError, match="must be a string"):
        validate_marking(1)
    with pytest.raises(ValidationError):
        Anomaly.model_validate(
            {
                "kind": "rf_anomaly",
                "source_signal": "s",
                "source_signal_ids": ["s"],
                "severity": 0.5,
                "payload": {},
                "marking": None,
            }
        )


def test_categories_are_sorted_and_empty_for_the_unspecified_levels() -> None:
    assert marking_categories("U") == ()
    assert marking_categories("CUI") == ()
    assert marking_categories("CUI//SP-B/SP-A") == ("A", "B")


def test_published_schemas_carry_the_same_pattern_and_default() -> None:
    for name in ("signal", "anomaly"):
        schema = json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))
        prop = schema["properties"]["marking"]
        assert prop["pattern"] == MARKING_PATTERN, name
        assert prop["default"] == MARKING_UNCLASSIFIED, name
        assert "marking" not in schema.get("required", []), name


# ---- Ordering, union, empty ----------------------------------------------------------------


def test_default_is_unclassified_and_survives_a_round_trip() -> None:
    signal = _signal(id="s", domain="rf_ew", event_type="rf_interference")
    assert signal.marking == "U"
    assert Signal.model_validate_json(signal.model_dump_json()).marking == "U"
    assert signal.model_dump(mode="json")["marking"] == "U"
    assert ReasoningTrace(stage="fusion", message="x").marking == "U"
    assert Anomaly(kind="k", source_signal="s", source_signal_ids=["s"], severity=0.1, payload={}).marking == "U"


def test_ordering_u_below_cui_below_specified() -> None:
    assert most_restrictive(["U"]) == "U"
    assert most_restrictive(["U", "CUI"]) == "CUI"
    assert most_restrictive(["CUI", "U"]) == "CUI"
    assert most_restrictive(["CUI", "CUI//SP-A"]) == "CUI//SP-A"
    assert most_restrictive(["CUI//SP-A", "U", "CUI"]) == "CUI//SP-A"


def test_specified_categories_combine_as_a_sorted_union() -> None:
    assert most_restrictive(["CUI//SP-B", "CUI//SP-A"]) == "CUI//SP-A/SP-B"
    assert most_restrictive(["CUI//SP-B/SP-A", "CUI//SP-C", "CUI//SP-A"]) == "CUI//SP-A/SP-B/SP-C"
    assert most_restrictive(["CUI//SP-A", "CUI//SP-A"]) == "CUI//SP-A"


def test_no_inputs_give_unclassified() -> None:
    assert most_restrictive([]) == "U"
    assert most_restrictive(m for m in ()) == "U"


def test_every_input_is_validated() -> None:
    with pytest.raises(ValueError, match="marking"):
        most_restrictive(["U", "secret"])
    with pytest.raises(ValueError, match="repeats"):
        most_restrictive(["CUI//SP-A/SP-A"])


# ---- Fusion: a correlate's marking carries into the derived anomaly ----------------------------


async def test_an_anomaly_carries_the_marking_of_its_signal() -> None:
    anomalies = await _fuse([_rf("rf-u", 0), _rf("rf-c", 10, marking=MARKING_CUI)])
    assert _by_source(anomalies, "rf-u").marking == "U"
    assert _by_source(anomalies, "rf-c").marking == "CUI"


async def test_bus_anomaly_keeps_a_correlated_cue_marking() -> None:
    # A CUI RF cue, then an unmarked bus symptom on the same satellite 400 s
    # later (inside the 600 s bus_health look-back, spec §2): the bus anomaly
    # lists the cue and is never lower than it.
    anomalies = await _fuse([_rf("rf-1", 0, marking=MARKING_CUI), _bus("bus-1", 400)])

    bus = _by_source(anomalies, "bus-1")
    assert bus.kind == "bus_link_margin"
    assert bus.source_signal_ids == ["bus-1", "rf-1"]
    assert [c["id"] for c in bus.payload["correlated_events"]] == ["rf-1"]
    assert bus.marking == "CUI"
    assert _by_source(anomalies, "rf-1").marking == "CUI"


async def test_correlate_categories_union_on_the_derived_anomaly() -> None:
    anomalies = await _fuse(
        [
            _rf("rf-a", 0, marking="CUI//SP-A"),
            _rf("rf-b", 100, marking="CUI//SP-B"),
            _bus("bus-1", 400),
        ]
    )
    bus = _by_source(anomalies, "bus-1")
    assert set(bus.source_signal_ids) == {"bus-1", "rf-a", "rf-b"}
    assert bus.marking == "CUI//SP-A/SP-B"


async def test_unmarked_inputs_stay_unclassified() -> None:
    anomalies = await _fuse([_rf("rf-1", 0), _bus("bus-1", 400)])
    bus = _by_source(anomalies, "bus-1")
    assert bus.source_signal_ids == ["bus-1", "rf-1"]
    assert bus.marking == "U"


async def test_a_cue_outside_the_window_does_not_mark_the_bus_anomaly() -> None:
    # The marking follows the correlation, not time proximity: 700 s is
    # beyond the bus look-back, so the cue is not a correlate and not an input.
    anomalies = await _fuse([_rf("rf-1", 0, marking=MARKING_CUI), _bus("bus-1", 700)])
    bus = _by_source(anomalies, "bus-1")
    assert bus.source_signal_ids == ["bus-1"]
    assert bus.marking == "U"


# ---- Pipeline: anomaly -> provisional -> final -> decision -> UI event -----------------------------


async def _pipeline(rf_marking: str, bus_marking: str) -> dict[str, list]:
    """Run an RF cue and a bus symptom on one satellite through attrib, decide and UI events."""
    run = await _start(delay_s=0.0, window_s=0.5, with_decide=True, with_ui=True)
    try:
        rf = _rf_anomaly().model_copy(update={"marking": validate_marking(rf_marking)})
        bus = _bus_anomaly(0.3).model_copy(update={"marking": validate_marking(bus_marking)})
        await run.publish(rf)
        await asyncio.sleep(0.05)  # the cue waits in the legacy window
        await run.publish(bus)  # ...and joins the satellite cluster at once
        await run.wait_for(run.attributions, 2)
        await run.wait_for(run.decisions, 2)
        await run.wait_for(run.ui_events, 2)
        await run.attrib.flush()
        await run.bus.drain()
        assert run.attrib.errors == []
        return {
            "anomalies": [rf, bus],
            "attributions": [a for _, a in run.attributions],
            "decisions": [d for _, d in run.decisions],
            "ui_events": [u for _, u in run.ui_events],
            "traces": list(run.traces),
        }
    finally:
        await run.stop()


@pytest.mark.parametrize(
    ("rf_marking", "bus_marking", "expected"),
    [
        ("CUI", "U", "CUI"),  # one CUI signal among U
        ("U", "CUI", "CUI"),
        ("CUI//SP-A", "CUI//SP-B", "CUI//SP-A/SP-B"),
    ],
)
async def test_one_marked_anomaly_marks_every_derived_event(
    rf_marking: str, bus_marking: str, expected: str
) -> None:
    events = await _pipeline(rf_marking, bus_marking)
    rf, bus = events["anomalies"]

    provisional, final = events["attributions"][:2]
    assert provisional.provisional is True and final.provisional is False
    assert provisional.id == final.id
    assert provisional.anomaly_ids == [rf.id, bus.id]
    assert [a.marking for a in events["attributions"]] == [expected] * len(events["attributions"])
    assert [d.marking for d in events["decisions"]] == [expected] * len(events["decisions"])
    assert [u.marking for u in events["ui_events"]] == [expected] * len(events["ui_events"])
    assert all(d.attribution_id == final.id for d in events["decisions"])

    # Traces are not derived: they keep the default even when they refer to
    # the marked attribution (spec §1.1, known limitation).
    traces = events["traces"]
    assert any(t.ref_id == final.id for t in traces)
    assert {t.marking for t in traces} == {"U"}


async def test_all_unclassified_inputs_stay_unclassified_end_to_end() -> None:
    events = await _pipeline("U", "U")
    assert len(events["attributions"]) == 2
    assert {a.marking for a in events["attributions"]} == {"U"}
    assert {d.marking for d in events["decisions"]} == {"U"}
    assert {u.marking for u in events["ui_events"]} == {"U"}
    assert {t.marking for t in events["traces"]} == {"U"}
