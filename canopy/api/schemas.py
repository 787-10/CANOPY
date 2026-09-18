"""JSON Schemas for every bus event kind, generated from the pydantic models.

``GET /schemas`` and ``GET /schemas/{kind}`` serve these, and
``scripts/gen_ts_types.py`` turns them into ``src/types/canopy.gen.ts``. The
kinds are the bus codec's registry keys (docs/INTERFACE-SPEC.md §10), so the
WebSocket envelope tag, the NATS payload and the schema name never disagree.

Two modes:

* ``serialization`` (default): what the gateway emits. The codec dumps every
  declared field (``model_dump(mode="json")`` without ``exclude_none``), so a
  field that is unset arrives as ``null`` rather than being absent. pydantic
  still lists only default-less fields under ``required``; this module marks
  every declared property required in this mode so the schema is truthful
  about the wire, and the generated TypeScript needs no ``?`` on fields the
  engine always sends.
* ``validation``: what a client may send, for example to ``POST /signals``.
  pydantic's own view: fields with defaults (``id``, ``ts``, ...) are optional.
"""
from __future__ import annotations

from typing import Any, Literal, get_args

from canopy.services.bus import codec

__all__ = ["SCHEMA_MODES", "SchemaMode", "event_schema", "event_schemas"]

SchemaMode = Literal["serialization", "validation"]
SCHEMA_MODES: tuple[str, ...] = get_args(SchemaMode)

_DRAFT = "https://json-schema.org/draft/2020-12/schema"


def _require_all_declared(schema: dict[str, Any]) -> None:
    """Mark every declared property required, on the root and every ``$defs`` entry."""
    for node in (schema, *schema.get("$defs", {}).values()):
        properties = node.get("properties")
        if isinstance(properties, dict) and properties:
            node["required"] = list(properties)


def event_schema(kind: str, *, mode: SchemaMode = "serialization") -> dict[str, Any]:
    """The JSON Schema (draft 2020-12) of the event class registered as ``kind``.

    Raises :class:`codec.CodecError` for an unknown kind and ``ValueError`` for
    an unknown mode.
    """
    if mode not in SCHEMA_MODES:
        raise ValueError(f"unknown schema mode {mode!r}; expected one of {SCHEMA_MODES}")
    cls = codec.class_for(kind)
    schema = cls.model_json_schema(mode=mode)
    if mode == "serialization":
        _require_all_declared(schema)
    return {"$schema": _DRAFT, **schema}


def event_schemas(*, mode: SchemaMode = "serialization") -> dict[str, dict[str, Any]]:
    """Every registered kind's schema, keyed by kind, in registry order."""
    return {kind: event_schema(kind, mode=mode) for kind in codec.registered_kinds()}
