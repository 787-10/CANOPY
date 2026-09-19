from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from pathlib import Path
from typing import NamedTuple

from canopy.services.kb.models import KBEntry
from canopy.services.schemas.events import KBRef

# The caveat-only entry every attribution cites. It names no actor, so it is
# left out of ``KBRef.actor_entry_count``: a knowledge base holding only the
# anchor cannot support naming an adversary (docs/INTERFACE-SPEC.md §5.3).
UNCERTAINTY_ANCHOR_ID = "kb-attribution-uncertainty-001"


class LoadedKB(NamedTuple):
    """Entries read from a knowledge-base file plus their provenance record."""

    entries: list[KBEntry]
    ref: KBRef


def parse_kb_json(text: str, *, origin: str = "<memory>") -> list[KBEntry]:
    """Parse knowledge-base entries from JSON text.

    The document is either ``{"entries": [...]}`` or a bare list; each entry
    validates against :class:`KBEntry` (unknown keys are kept). Duplicate ids
    raise ``ValueError``. ``origin`` names the source in error messages.
    """
    raw = json.loads(text)
    if isinstance(raw, dict):
        items = raw.get("entries", [])
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError(f"unexpected KB JSON shape in {origin}: {type(raw).__name__}")

    entries: list[KBEntry] = []
    seen: set[str] = set()
    for item in items:
        entry = KBEntry.model_validate(item)
        if entry.id in seen:
            raise ValueError(f"duplicate KB entry id: {entry.id}")
        seen.add(entry.id)
        entries.append(entry)
    return entries


def count_actor_entries(entries: Iterable[KBEntry]) -> int:
    """Entries other than the uncertainty anchor."""
    return sum(1 for entry in entries if entry.id != UNCERTAINTY_ANCHOR_ID)


def load_kb(path: str | Path) -> LoadedKB:
    """Read a knowledge-base file and record where it came from.

    ``path`` is used as given (a relative path resolves against the current
    working directory, ``external/canopy`` for the gateway and the bench);
    the record keeps it verbatim next to its absolute form and the SHA-256 of
    the file bytes, so a bundle or a ``/health`` reading identifies the exact
    file the engine reasoned against.
    """
    data = Path(path).read_bytes()
    entries = parse_kb_json(data.decode("utf-8"), origin=str(path))
    ref = KBRef(
        path=str(path),
        resolved=str(Path(path).resolve()),
        sha256=hashlib.sha256(data).hexdigest(),
        entry_count=len(entries),
        actor_entry_count=count_actor_entries(entries),
    )
    return LoadedKB(entries, ref)


def load_kb_json(path: str | Path) -> list[KBEntry]:
    """Load knowledge-base entries from a JSON file matching kb_seed_entries.json shape.

    The file is expected to have a top-level ``entries`` array; if a bare list
    is supplied that's accepted too. Each entry validates against KBEntry.
    Duplicate ids raise ValueError. :func:`load_kb` also returns the
    provenance record.
    """
    return load_kb(path).entries


def memory_kb_ref(entries: Iterable[KBEntry]) -> KBRef:
    """The provenance record of a knowledge base built without a file.

    The hash is the SHA-256 of the canonical JSON of the entries: sorted by
    id, keys sorted, no whitespace, UTF-8 (``ensure_ascii=False``). Two
    in-memory knowledge bases with the same entries share a hash whatever
    order they were built in.
    """
    ordered = sorted(entries, key=lambda entry: entry.id)
    canonical = json.dumps(
        [entry.model_dump(mode="json") for entry in ordered],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return KBRef(
        path=None,
        resolved=None,
        sha256=hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        entry_count=len(ordered),
        actor_entry_count=count_actor_entries(ordered),
    )
