#!/usr/bin/env python
"""Generate ``src/types/canopy.gen.ts`` from the event JSON Schemas.

The schemas come from :func:`canopy.api.schemas.event_schemas` (what ``GET
/schemas`` serves, serialization mode), so the generated TypeScript describes
exactly what the WebSocket envelope's ``data`` carries for every kind. A small
JSON-Schema-to-TypeScript emitter lives here on purpose: objects, arrays,
string enums, unions with null, ``$ref`` to nested models. No external tool.

Usage, from ``external/canopy``::

    uv run --no-sync python scripts/gen_ts_types.py            # write both files
    uv run --no-sync python scripts/gen_ts_types.py --check    # exit 1 when stale
    uv run --no-sync python scripts/gen_ts_types.py --stdout   # print the .ts only

Writes two files next to each other:

* ``src/types/canopy.gen.ts``: the types. Its header carries the SHA-256 of
  the schemas file, which ``src/types/canopy.gen.parity.test.ts`` checks.
* ``src/types/canopy.schemas.json``: the schemas the types were generated
  from, checked in as the fixture that lets the frontend test run without a
  Python environment. ``tests/test_api_gateway.py`` asserts it equals a fresh
  ``event_schemas()``.

Do not edit ``canopy.gen.ts`` by hand; the hand-maintained vocabulary mirror
is ``src/types/canopy.ts`` and stays separate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from canopy.api.schemas import event_schemas  # noqa: E402

GEN_TS = ROOT / "src" / "types" / "canopy.gen.ts"
SCHEMAS_JSON = ROOT / "src" / "types" / "canopy.schemas.json"
DIGEST_PREFIX = "// Schema digest: sha256:"
REGENERATE = "cd external/canopy && uv run --no-sync python scripts/gen_ts_types.py"

_IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
_SIMPLE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$<>\[\], ]*$")


class SchemaError(ValueError):
    """A schema shape the emitter does not handle."""


# ---- Schemas ------------------------------------------------------------------


def schemas_json_text(schemas: dict[str, Any]) -> str:
    """The canonical text of the schemas fixture (what gets digested)."""
    return json.dumps(schemas, indent=2, ensure_ascii=False) + "\n"


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---- Emitter --------------------------------------------------------------------


def _literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    text = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{text}'"


def _union(members: list[str]) -> str:
    seen: list[str] = []
    for member in members:
        if member not in seen:
            seen.append(member)
    return " | ".join(seen) if seen else "unknown"


def _ref_name(ref: str) -> str:
    if not ref.startswith("#/$defs/"):
        raise SchemaError(f"unsupported $ref {ref!r}; only #/$defs/<Name> is handled")
    return ref.rsplit("/", 1)[-1]


def _doc(text: str | None, indent: str) -> list[str]:
    if not text:
        return []
    clean = " ".join(text.replace("*/", "*\\/").split())
    return [f"{indent}/** {clean} */"]


def ts_type(schema: dict[str, Any], indent: str = "") -> str:
    """The TypeScript type expression for a JSON Schema fragment."""
    if "$ref" in schema:
        return _ref_name(schema["$ref"])
    if "const" in schema:
        return _literal(schema["const"])
    if "enum" in schema:
        return _union([_literal(v) for v in schema["enum"]])
    for key in ("anyOf", "oneOf"):
        if key in schema:
            return _union([ts_type(member, indent) for member in schema[key]])
    if "allOf" in schema:
        return " & ".join(ts_type(member, indent) for member in schema["allOf"]) or "unknown"
    kind = schema.get("type")
    if isinstance(kind, list):
        return _union([ts_type({**schema, "type": member}, indent) for member in kind])
    if kind == "string":
        return "string"
    if kind in ("number", "integer"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "array":
        items = schema.get("items")
        inner = ts_type(items, indent) if isinstance(items, dict) else "unknown"
        return f"{inner}[]" if _SIMPLE.match(inner) and " | " not in inner else f"Array<{inner}>"
    if kind == "object" or "properties" in schema:
        return _object(schema, indent)
    if kind is None:
        return "unknown"
    raise SchemaError(f"unsupported schema type {kind!r}")


def _object(schema: dict[str, Any], indent: str) -> str:
    properties = schema.get("properties") or {}
    additional = schema.get("additionalProperties", True)
    if not properties:
        if additional is False:
            return "Record<string, never>"
        if isinstance(additional, dict):
            return f"Record<string, {ts_type(additional, indent)}>"
        return "Record<string, unknown>"
    required = set(schema.get("required") or [])
    inner = indent + "  "
    lines = ["{"]
    for name, prop in properties.items():
        lines.extend(_doc(_prop_doc(prop), inner))
        key = name if _IDENT.match(name) else _literal(name)
        optional = "" if name in required else "?"
        lines.append(f"{inner}{key}{optional}: {ts_type(prop, inner)}")
    if additional is not False:
        extra = ts_type(additional, inner) if isinstance(additional, dict) else "unknown"
        lines.append(f"{inner}[key: string]: {extra}")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def _prop_doc(prop: dict[str, Any]) -> str | None:
    parts: list[str] = []
    if prop.get("description"):
        parts.append(str(prop["description"]))
    fmt = prop.get("format")
    if fmt == "date-time":
        parts.append("ISO-8601 date-time (UTC).")
    elif fmt:
        parts.append(f"format: {fmt}")
    return " ".join(parts) or None


def render(schemas: dict[str, Any], *, schemas_digest: str) -> str:
    """The full ``canopy.gen.ts`` text for ``schemas`` (kind -> JSON Schema)."""
    out: list[str] = [
        "// GENERATED FILE. Do not edit by hand.",
        "// Source: the pydantic event models in canopy/services/schemas/events.py, served by",
        "//   GET /schemas (canopy/api/schemas.py) in serialization mode: every declared field",
        "//   is present on the wire, null when unset, so nothing here is optional.",
        f"// Regenerate: {REGENERATE}",
        "// Fixture: src/types/canopy.schemas.json (the schemas this file was generated from).",
        f"{DIGEST_PREFIX}{schemas_digest}",
        "",
    ]
    emitted: dict[str, dict[str, Any]] = {}
    type_names: dict[str, str] = {}
    for kind, schema in schemas.items():
        for name, definition in (schema.get("$defs") or {}).items():
            _emit_named(out, name, definition, emitted)
        root = {k: v for k, v in schema.items() if k not in ("$defs", "$schema")}
        name = str(root.get("title") or _pascal(kind))
        _emit_named(out, name, root, emitted)
        type_names[kind] = name

    kinds = list(type_names)
    out.append("/** Bus codec kinds: the `kind` tag of every WebSocket envelope. */")
    out.append("export const EVENT_KINDS = [")
    out.extend(f"  {_literal(kind)}," for kind in kinds)
    out.append("] as const")
    out.append("")
    out.append("export type EventKind = (typeof EVENT_KINDS)[number]")
    out.append("")
    out.append("export type EventByKind = {")
    out.extend(f"  {kind}: {type_names[kind]}" for kind in kinds)
    out.append("}")
    out.append("")
    out.append("/** The WebSocket envelope (docs/INTERFACE-SPEC.md §10): `{kind, topic, data}`. */")
    out.append("export type Envelope<K extends EventKind = EventKind> = K extends EventKind")
    out.append("  ? { kind: K; topic: string; data: EventByKind[K] }")
    out.append("  : never")
    out.append("")
    return "\n".join(out)


def _emit_named(
    out: list[str], name: str, schema: dict[str, Any], emitted: dict[str, dict[str, Any]]
) -> None:
    if not _IDENT.match(name):
        raise SchemaError(f"{name!r} is not a valid TypeScript identifier")
    previous = emitted.get(name)
    if previous is not None:
        if previous != schema:
            raise SchemaError(f"two different schemas want the type name {name!r}")
        return
    emitted[name] = schema
    out.extend(_doc(schema.get("description"), ""))
    body = ts_type({k: v for k, v in schema.items() if k not in ("title", "description")})
    out.append(f"export type {name} = {body}")
    out.append("")


def _pascal(kind: str) -> str:
    return "".join(part[:1].upper() + part[1:] for part in kind.split("_"))


# ---- Entry point ----------------------------------------------------------------


def generate() -> tuple[str, str]:
    """``(schemas_json_text, gen_ts_text)`` for the current models."""
    schemas = event_schemas(mode="serialization")
    schemas_text = schemas_json_text(schemas)
    return schemas_text, render(schemas, schemas_digest=digest(schemas_text))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if the checked-in files are stale")
    parser.add_argument("--stdout", action="store_true", help="print the TypeScript instead of writing")
    args = parser.parse_args(argv)
    schemas_text, ts_text = generate()
    if args.stdout:
        sys.stdout.write(ts_text)
        return 0
    if args.check:
        stale = [
            str(path.relative_to(ROOT))
            for path, text in ((SCHEMAS_JSON, schemas_text), (GEN_TS, ts_text))
            if not path.exists() or path.read_text(encoding="utf-8") != text
        ]
        if stale:
            print(f"stale: {', '.join(stale)}; run: {REGENERATE}", file=sys.stderr)
            return 1
        print("src/types/canopy.gen.ts and canopy.schemas.json are up to date")
        return 0
    SCHEMAS_JSON.write_text(schemas_text, encoding="utf-8")
    GEN_TS.write_text(ts_text, encoding="utf-8")
    print(f"wrote {GEN_TS.relative_to(ROOT)} and {SCHEMAS_JSON.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
