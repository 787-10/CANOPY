from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from canopy.services.kb import KB
from canopy.services.kb.loader import load_kb_json
from canopy.services.kb.models import KBEntry

KB_FILE = Path(__file__).resolve().parent.parent / "data" / "kb_seed_entries.json"


def test_load_canonical_kb_file() -> None:
    entries = load_kb_json(KB_FILE)
    assert all(isinstance(e, KBEntry) for e in entries)
    assert len(entries) >= 5


def test_no_duplicate_ids() -> None:
    entries = load_kb_json(KB_FILE)
    ids = [e.id for e in entries]
    assert len(ids) == len(set(ids))


def test_facade_indexes_by_scenario_signal_id() -> None:
    kb = KB.load_from_json(KB_FILE)
    russia = kb.by_scenario_signal_id("canopy-beat2-001")
    assert russia, "expected at least one KB entry for beat2-001"
    assert russia[0].actor == "Russia"

    rpo = kb.by_scenario_signal_id("canopy-beat47-002")
    assert rpo, "expected at least one KB entry for beat47-002"
    assert rpo[0].capability_type == "co_orbital_rpo"


def test_facade_by_capability_and_actor() -> None:
    kb = KB.load_from_json(KB_FILE)
    assert kb.by_capability("jamming_spoofing")
    assert kb.by_capability("co_orbital_rpo")
    assert kb.by_actor("Russia")
    assert kb.by_actor("China")


def test_facade_get_and_membership() -> None:
    kb = KB.load_from_json(KB_FILE)
    assert "kb-attribution-uncertainty-001" in kb
    entry = kb.get("kb-attribution-uncertainty-001")
    assert entry is not None
    assert entry.capability_type == "attribution_uncertainty"
    assert kb.get("does_not_exist") is None


def test_loader_rejects_duplicate_ids(tmp_path: Path) -> None:
    file = tmp_path / "kb.json"
    file.write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "id": "dup",
                        "title": "A",
                        "actor": "X",
                        "domain": [],
                        "capability_type": "x",
                        "summary": "x",
                    },
                    {
                        "id": "dup",
                        "title": "B",
                        "actor": "X",
                        "domain": [],
                        "capability_type": "x",
                        "summary": "x",
                    },
                ]
            }
        )
    )
    with pytest.raises(ValueError, match="duplicate KB entry id"):
        load_kb_json(file)


def test_loader_accepts_bare_list(tmp_path: Path) -> None:
    file = tmp_path / "kb.json"
    file.write_text(
        json.dumps(
            [
                {
                    "id": "x",
                    "title": "X",
                    "actor": "Y",
                    "domain": [],
                    "capability_type": "x",
                    "summary": "x",
                }
            ]
        )
    )
    assert len(load_kb_json(file)) == 1


# ---- Provenance (docs/INTERFACE-SPEC.md §5.3) --------------------------------

DEMO_KB_FILE = KB_FILE.parent / "kb_megalith_demo.json"


def test_loader_records_path_hash_and_counts_for_the_demo_kb() -> None:
    kb = KB.load_from_json(DEMO_KB_FILE)
    payload = json.loads(DEMO_KB_FILE.read_text(encoding="utf-8"))["entries"]
    assert kb.source.path == str(DEMO_KB_FILE)
    assert kb.source.resolved == str(DEMO_KB_FILE.resolve())
    assert Path(kb.source.resolved).is_absolute()
    assert kb.source.sha256 == hashlib.sha256(DEMO_KB_FILE.read_bytes()).hexdigest()
    assert kb.source.entry_count == len(payload) == len(kb)
    # The anchor is the only entry that does not count as an actor entry.
    assert "kb-attribution-uncertainty-001" in kb
    assert kb.source.actor_entry_count == len(payload) - 1


def test_loader_keeps_a_relative_path_as_given(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    file = tmp_path / "kb.json"
    file.write_bytes(DEMO_KB_FILE.read_bytes())
    monkeypatch.chdir(tmp_path)
    kb = KB.load_from_json("kb.json")
    assert kb.source.path == "kb.json"
    assert kb.source.resolved == str(file.resolve())
    # The hash is of the bytes, so a byte-identical copy elsewhere shares it.
    assert kb.source.sha256 == KB.load_from_json(DEMO_KB_FILE).source.sha256


def test_hash_changes_when_the_file_changes(tmp_path: Path) -> None:
    file = tmp_path / "kb.json"
    file.write_bytes(DEMO_KB_FILE.read_bytes())
    before = KB.load_from_json(file).source.sha256
    payload = json.loads(file.read_text(encoding="utf-8"))
    payload["entries"][1]["summary"] += " (edited)"
    file.write_text(json.dumps(payload), encoding="utf-8")
    after = KB.load_from_json(file).source
    assert after.sha256 != before
    assert after.entry_count == len(payload["entries"])


def test_in_memory_kb_has_no_path_and_hashes_its_entries() -> None:
    empty = KB(entries=[])
    assert empty.source.path is None and empty.source.resolved is None
    assert empty.source.sha256 == hashlib.sha256(b"[]").hexdigest()
    assert empty.source.entry_count == 0 and empty.source.actor_entry_count == 0

    entries = load_kb_json(DEMO_KB_FILE)
    forward = KB(entries=entries).source
    backward = KB(entries=list(reversed(entries))).source
    assert forward.path is None
    assert forward.sha256 == backward.sha256  # canonical: sorted by id
    assert forward.entry_count == len(entries)
    assert forward.actor_entry_count == len(entries) - 1
    # Same entries, but the file hash is of the bytes, not of the entries.
    assert forward.sha256 != KB.load_from_json(DEMO_KB_FILE).source.sha256


def test_anchor_only_kb_has_zero_actor_entries() -> None:
    anchor = [e for e in load_kb_json(DEMO_KB_FILE) if e.id == "kb-attribution-uncertainty-001"]
    kb = KB(entries=anchor)
    assert kb.source.entry_count == 1
    assert kb.source.actor_entry_count == 0
