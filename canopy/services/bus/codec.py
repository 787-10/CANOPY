"""Bus envelope codec: the one kind → class registry for every wire format.

Every event that crosses a process boundary (the WebSocket fan-out in
:mod:`canopy.api`, the NATS backend in ``megalith.bus``) travels as the
docs/INTERFACE-SPEC.md §10 envelope::

    {"kind": <registry key>, "topic": <bus topic>, "data": model_dump(mode="json")}

``kind`` is the registry key of the event's pydantic class, so a consumer
can rebuild the exact class with :func:`decode`. The keys are the tags the
frontend already switches on (``src/types/canopy.ts``: ``signal``,
``anomaly`` …); ``attribution_challenge`` is registered even though it only
rides inside trace payloads today, so a future publisher needs no new code.

The registry is process-global and seeded at import with every event class
CANOPY publishes. :func:`register` adds more; re-registering the same pair is
a no-op, while re-binding a kind or a class to something else is an error so
two subsystems cannot silently disagree about a tag.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel, ValidationError

from canopy.services.schemas.events import (
    Anomaly,
    Attribution,
    AttributionChallenge,
    Decision,
    Ephemeris,
    OsintEmbeddingSnapshot,
    ReasoningTrace,
    Signal,
    UIEvent,
)

__all__ = [
    "CodecError",
    "class_for",
    "decode",
    "decode_envelope",
    "encode",
    "envelope",
    "kind_for",
    "register",
    "registered_kinds",
]


class CodecError(ValueError):
    """An event class or kind the registry does not know, or a bad envelope."""


_KIND_TO_CLASS: dict[str, type[BaseModel]] = {}
_CLASS_TO_KIND: dict[type[BaseModel], str] = {}


def register(kind: str, cls: type[BaseModel]) -> None:
    """Bind *kind* ↔ *cls*. Idempotent for the same pair; conflicts raise."""
    if not kind or not isinstance(kind, str):
        raise CodecError(f"kind must be a non-empty string, got {kind!r}")
    if not (isinstance(cls, type) and issubclass(cls, BaseModel)):
        raise CodecError(f"{cls!r} is not a pydantic BaseModel class")
    bound_cls = _KIND_TO_CLASS.get(kind)
    if bound_cls is not None and bound_cls is not cls:
        raise CodecError(
            f"kind {kind!r} is already bound to {bound_cls.__qualname__}, "
            f"refusing to rebind it to {cls.__qualname__}"
        )
    bound_kind = _CLASS_TO_KIND.get(cls)
    if bound_kind is not None and bound_kind != kind:
        raise CodecError(
            f"{cls.__qualname__} is already registered as {bound_kind!r}, "
            f"refusing to register it again as {kind!r}"
        )
    _KIND_TO_CLASS[kind] = cls
    _CLASS_TO_KIND[cls] = kind


def registered_kinds() -> Mapping[str, type[BaseModel]]:
    """Read-only view of the registry."""
    return MappingProxyType(_KIND_TO_CLASS)


def kind_for(event: BaseModel | type[BaseModel]) -> str:
    """Registry key for an event instance or class (nearest registered base)."""
    cls = event if isinstance(event, type) else type(event)
    for base in cls.__mro__:
        kind = _CLASS_TO_KIND.get(base)  # type: ignore[arg-type]
        if kind is not None:
            return kind
    raise CodecError(f"no bus kind registered for {cls.__qualname__}")


def class_for(kind: str) -> type[BaseModel]:
    try:
        return _KIND_TO_CLASS[kind]
    except KeyError:
        raise CodecError(f"unknown bus kind {kind!r}") from None


def envelope(topic: str, event: BaseModel) -> dict[str, Any]:
    """The spec §10 envelope as a JSON-ready dict."""
    return {
        "kind": kind_for(event),
        "topic": topic,
        "data": event.model_dump(mode="json"),
    }


def encode(topic: str, event: BaseModel) -> bytes:
    """Serialize ``(topic, event)`` to the UTF-8 JSON envelope."""
    return json.dumps(
        envelope(topic, event), separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def decode_envelope(payload: Mapping[str, Any]) -> tuple[str, BaseModel]:
    """Rebuild ``(topic, event)`` from an already-parsed envelope dict."""
    if not isinstance(payload, Mapping):
        raise CodecError(f"envelope must be an object, got {type(payload).__name__}")
    missing = [key for key in ("kind", "topic", "data") if key not in payload]
    if missing:
        raise CodecError(f"envelope missing {missing}")
    kind = payload["kind"]
    topic = payload["topic"]
    if not isinstance(kind, str) or not isinstance(topic, str):
        raise CodecError("envelope kind and topic must be strings")
    cls = class_for(kind)
    try:
        event = cls.model_validate(payload["data"])
    except ValidationError as exc:
        raise CodecError(f"invalid {kind} payload on {topic}: {exc}") from exc
    return topic, event


def decode(data: bytes | bytearray | memoryview | str) -> tuple[str, BaseModel]:
    """Parse a JSON envelope produced by :func:`encode`."""
    try:
        payload = json.loads(data)
    except (ValueError, TypeError) as exc:
        raise CodecError(f"envelope is not valid JSON: {exc}") from exc
    return decode_envelope(payload)


# Every class CANOPY publishes today (grep for ``.publish(`` under
# canopy/services) plus the trace-embedded challenge. Keys match the
# WebSocket envelope tags the frontend already consumes.
for _kind, _cls in (
    ("signal", Signal),
    ("anomaly", Anomaly),
    ("attribution", Attribution),
    ("attribution_challenge", AttributionChallenge),
    ("decision", Decision),
    ("ui_event", UIEvent),
    ("trace", ReasoningTrace),
    ("embedding", OsintEmbeddingSnapshot),
    # Engine-owned position samples (spec §10, 1.4.4): topics ``ephemeris.*``.
    ("ephemeris", Ephemeris),
):
    register(_kind, _cls)
del _kind, _cls
