from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from canopy.services.kb.loader import (
    UNCERTAINTY_ANCHOR_ID,
    load_kb,
    load_kb_json,
    memory_kb_ref,
)
from canopy.services.kb.models import KBEntry, SourceRef
from canopy.services.schemas.events import KBRef

__all__ = ["KB", "KBEntry", "KBRef", "SourceRef", "UNCERTAINTY_ANCHOR_ID", "load_kb_json"]


class KB:
    """In-memory knowledge-base facade.

    Built from data/kb_seed_entries.json. Indexes entries by id, scenario
    signal id, capability type, actor, and domain so attribution can retrieve
    relevant context fast. ``source`` records where the entries came from
    (path, SHA-256, counts; docs/INTERFACE-SPEC.md §5.3): the loader's record
    for a file-backed knowledge base, a hash of the entries for one built in
    memory.
    """

    def __init__(self, entries: list[KBEntry], *, source: KBRef | None = None) -> None:
        self._by_id: dict[str, KBEntry] = {}
        self._by_scenario_id: dict[str, list[KBEntry]] = defaultdict(list)
        self._by_capability: dict[str, list[KBEntry]] = defaultdict(list)
        self._by_actor: dict[str, list[KBEntry]] = defaultdict(list)
        self._by_domain: dict[str, list[KBEntry]] = defaultdict(list)
        for entry in entries:
            self._by_id[entry.id] = entry
            for sid in entry.scenario_signal_ids:
                self._by_scenario_id[sid].append(entry)
            self._by_capability[entry.capability_type].append(entry)
            self._by_actor[entry.actor].append(entry)
            for dom in entry.domain:
                self._by_domain[dom].append(entry)
        self.source: KBRef = source if source is not None else memory_kb_ref(entries)

    @classmethod
    def load_from_json(cls, path: str | Path = "data/kb_seed_entries.json") -> "KB":
        loaded = load_kb(path)
        return cls(loaded.entries, source=loaded.ref)

    def get(self, entry_id: str) -> KBEntry | None:
        return self._by_id.get(entry_id)

    def by_scenario_signal_id(self, signal_id: str) -> list[KBEntry]:
        return list(self._by_scenario_id.get(signal_id, ()))

    def by_capability(self, capability_type: str) -> list[KBEntry]:
        return list(self._by_capability.get(capability_type, ()))

    def by_actor(self, actor: str) -> list[KBEntry]:
        return list(self._by_actor.get(actor, ()))

    def by_domain(self, domain: str) -> list[KBEntry]:
        return list(self._by_domain.get(domain, ()))

    def all_entries(self) -> list[KBEntry]:
        return list(self._by_id.values())

    def __len__(self) -> int:
        return len(self._by_id)

    def __contains__(self, entry_id: object) -> bool:
        return isinstance(entry_id, str) and entry_id in self._by_id
