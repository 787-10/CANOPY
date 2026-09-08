from __future__ import annotations

import json

from bench.generate import generate
from bench.transforms import (
    degrade_provenance,
    delay_signal,
    duplicate_signal,
    inject_distractor,
    inject_untrusted_instruction,
    namespace_records,
    perturb_threshold,
    reorder_within,
    swap_actor_evidence,
)
from canopy.services.schemas.events import Signal


def _records() -> list[dict]:
    return [
        {
            "id": "sig-1",
            "ts": "2026-06-18T14:00:00Z",
            "domain": "osint",
            "source": "public-feed",
            "realism": "real_source",
            "confidence": 0.8,
            "location": {"label": "test"},
            "payload": {
                "event_type": "public_report",
                "summary": "Routine report.",
                "observables": {"related_signal": "sig-2"},
            },
            "provenance": {"source_id": "public-feed"},
        },
        {
            "id": "sig-2",
            "ts": "2026-06-18T14:00:30Z",
            "domain": "cyber",
            "source": "sensor",
            "realism": "mock_operational",
            "confidence": 0.7,
            "location": {"label": "test"},
            "payload": {
                "event_type": "credential_probe",
                "summary": "Probe observed.",
                "observables": {"related_signal": "sig-1"},
            },
            "provenance": {"source_id": "sensor"},
        },
    ]


def test_namespace_rewrites_ids_and_internal_references() -> None:
    namespaced = namespace_records(_records(), "case-v01")

    assert [record["id"] for record in namespaced] == [
        "sig-1-case-v01",
        "sig-2-case-v01",
    ]
    assert namespaced[0]["payload"]["observables"]["related_signal"] == (
        "sig-2-case-v01"
    )


def test_duplicate_and_reorder_are_deterministic() -> None:
    duplicated = duplicate_signal(_records(), "sig-1")
    reordered = reorder_within(_records(), seconds=60)

    assert len(duplicated) == 3
    assert duplicated[1]["id"].endswith("-duplicate")
    assert [item["id"] for item in reordered] == ["sig-2", "sig-1"]


def test_untrusted_instruction_is_data_not_a_new_record() -> None:
    transformed = inject_untrusted_instruction(_records(), "sig-1")

    assert len(transformed) == 2
    assert "Ignore prior instructions" in transformed[0]["payload"]["summary"]
    assert transformed[0]["provenance"]["notes"] == "adversarial_untrusted_text"


def test_evidence_quality_and_timing_transforms_are_explicit() -> None:
    delayed = delay_signal(_records(), "sig-1", seconds=10)
    degraded = degrade_provenance(_records(), "sig-1")
    perturbed = perturb_threshold(
        _records(), "sig-2", field="confidence", value=0.49
    )

    assert delayed[0]["ts"] == "2026-06-18T14:00:10Z"
    assert degraded[0]["confidence"] == 0.6
    assert degraded[0]["provenance"]["notes"] == (
        "adversarial_degraded_provenance"
    )
    assert perturbed[1]["confidence"] == 0.49


def test_distractor_and_actor_swap_are_schema_valid() -> None:
    distracted = inject_distractor(_records(), actor="Example Actor")
    swapped = swap_actor_evidence(
        distracted, from_actor="Example Actor", to_actor="Alternate Actor"
    )

    assert len(swapped) == 3
    assert "Alternate Actor" in swapped[-1]["payload"]["summary"]
    assert all(Signal.model_validate(record) for record in swapped)


def test_generator_builds_four_controlled_variants_per_parent(tmp_path) -> None:
    labels = generate(variants_per_seed=4, seed=1337, output_dir=tmp_path)

    assert len(labels) == 44
    assert {label["transformation"] for label in labels} == {
        "duplicate_signal",
        "reorder_within",
        "drop_domain",
        "inject_untrusted_instruction",
    }
    assert all(label["parent_id"] for label in labels)
    assert all(label["relation"] for label in labels)

    for label in labels:
        path = tmp_path / label["filename"]
        records = [json.loads(line) for line in path.read_text().splitlines()]
        assert records
        assert all(record["source"] != "canopy-correlation-engine" for record in records)
        assert all(Signal.model_validate(record) for record in records)
