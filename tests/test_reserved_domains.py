"""The reserved domains (docs/INTERFACE-SPEC.md §12.1) are accepted nowhere.

``imagery_detection``, ``video_event`` and ``radar_track`` have their payload
shapes, priority classes and look-backs fixed in the spec so that activating
one is a vocabulary change, not a design exercise. Until then every site that
enumerates domains must refuse them: a scenario file, a ``POST /signals`` body
or an ingest builder naming one fails exactly as an unknown domain does.

This file pins the "not yet" side; ``tests/test_megalith_vocab.py`` pins that
every site agrees with the ``Domain`` literal. Activation is therefore: add
the name to ``Domain``, follow the checklist in §12.1 until the vocab test is
green, and delete the name from ``RESERVED`` below.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from canopy.api import _ALLOWED_DOMAINS
from canopy.services.schemas.events import Domain, Signal

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import validate_scenarios  # noqa: E402
from services.ingest import common as ingest_common  # noqa: E402

SIGNAL_SCHEMA = ROOT / "services" / "bus" / "schemas" / "signal.schema.json"
# external/canopy -> external -> MEGALITH. Absent when CANOPY is checked out alone.
SPEC = ROOT.parents[1] / "docs" / "INTERFACE-SPEC.md"
SPEC_HEADING = "### 12.1 Reserved domains"

RESERVED = ("imagery_detection", "video_event", "radar_track")


def _schema_enum() -> set[str]:
    schema = json.loads(SIGNAL_SCHEMA.read_text(encoding="utf-8"))
    return set(schema["properties"]["domain"]["enum"])


SITES = {
    "canopy/services/schemas/events.py Domain": lambda: set(get_args(Domain)),
    "canopy.api._ALLOWED_DOMAINS": lambda: set(_ALLOWED_DOMAINS),
    "services/ingest/common.py ALLOWED_DOMAINS": lambda: set(ingest_common.ALLOWED_DOMAINS),
    "scripts/validate_scenarios.py ALLOWED_DOMAINS": lambda: set(validate_scenarios.ALLOWED_DOMAINS),
    "services/bus/schemas/signal.schema.json enum": _schema_enum,
}


# ---- Absent from every domain site -------------------------------------------------------


@pytest.mark.parametrize("site", sorted(SITES))
def test_reserved_domains_are_absent_from_every_domain_site(site: str) -> None:
    accepted = sorted(set(RESERVED) & SITES[site]())
    assert not accepted, (
        f"{site} accepts reserved domain(s) {accepted}; they are reserved, not active "
        "(docs/INTERFACE-SPEC.md §12.1). Activating one means the checklist there, "
        "then removing the name from RESERVED in this file."
    )


def _body(domain: str) -> dict:
    """A Signal body that is valid in every respect but, possibly, its domain."""
    return {
        "domain": domain,
        "source": "reserved-domain-guard",
        "realism": "mock_operational",
        "confidence": 0.5,
        "location": {"label": "Site A", "lat": -26.0, "lng": 127.0},
        "payload": {"event_type": "guard", "summary": "reserved-domain guard body"},
        "provenance": {"source_id": "reserved-domain-guard"},
    }


@pytest.mark.parametrize("domain", RESERVED)
def test_signal_model_refuses_a_reserved_domain_on_the_domain_field_alone(domain: str) -> None:
    with pytest.raises(ValidationError) as excinfo:
        Signal.model_validate(_body(domain))
    locations = {tuple(error["loc"]) for error in excinfo.value.errors()}
    assert locations == {("domain",)}, excinfo.value.errors()


def test_the_guard_body_is_otherwise_valid() -> None:
    """The control: the same body under an accepted domain validates, so the
    rejections above are the domain's doing and nothing else's."""
    signal = Signal.model_validate(_body("sda"))
    assert signal.domain == "sda"


# ---- Present in the spec -------------------------------------------------------------------


def _spec_section() -> str:
    if not SPEC.is_file():
        pytest.skip(f"interface spec not in this checkout: {SPEC}")
    text = SPEC.read_text(encoding="utf-8")
    start = text.find(SPEC_HEADING)
    assert start >= 0, f"{SPEC_HEADING!r} not found in {SPEC}"
    rest = text[start + len(SPEC_HEADING):]
    # The subsection ends at the next heading or at the horizontal rule before the changelog.
    end = re.search(r"^(#{1,3} |---\s*$)", rest, flags=re.MULTILINE)
    return rest if end is None else rest[: end.start()]


@pytest.mark.parametrize("domain", RESERVED)
def test_spec_reserves_the_domain(domain: str) -> None:
    section = _spec_section()
    assert f"`{domain}`" in section, f"{domain} is not named in {SPEC_HEADING}"


def test_spec_says_the_reserved_domains_are_not_accepted() -> None:
    section = _spec_section()
    assert "not accepted anywhere" in section
    assert "tests/test_reserved_domains.py" in section
