"""Provider preflight and reproducibility metadata for benchmark models."""
from __future__ import annotations

import os
import subprocess
from typing import Any

from bench.specs import ModelSpec


def hardware_snapshot() -> dict[str, Any]:
    """Capture GPU identity and memory if NVIDIA tooling is available."""
    command = [
        "nvidia-smi",
        "--query-gpu=name,driver_version,memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
    ]
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "error": str(exc)}
    devices = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 5:
            return {
                "available": False,
                "error": f"unexpected nvidia-smi output: {line!r}",
            }
        name, driver, total, used, free = parts
        devices.append(
            {
                "name": name,
                "driver": driver,
                "memory_total_mib": int(total),
                "memory_used_mib": int(used),
                "memory_free_mib": int(free),
            }
        )
    return {"available": bool(devices), "devices": devices}


def preflight_model(
    spec: ModelSpec, *, transport: Any | None = None
) -> dict[str, Any]:
    """Verify a declared model is callable without silently substituting it."""
    base = {
        "model_spec_id": spec.id,
        "provider": spec.provider,
        "model": spec.model,
        "endpoint": spec.endpoint,
        "temperature": spec.temperature,
        "seed": spec.seed,
        "timeout_s": spec.timeout_s,
        "declared_quantization": spec.quantization,
    }
    if spec.provider == "stub":
        return {**base, "available": True, "runtime": "in-process"}
    if spec.provider == "anthropic":
        available = bool(os.environ.get("ANTHROPIC_API_KEY"))
        return {
            **base,
            "available": available,
            "error": None if available else "ANTHROPIC_API_KEY is not set",
        }

    import httpx

    endpoint = (spec.endpoint or "http://localhost:11434").rstrip("/")
    kwargs: dict[str, Any] = {"timeout": min(spec.timeout_s, 10.0)}
    if transport is not None:
        kwargs["transport"] = transport
    try:
        with httpx.Client(**kwargs) as client:
            response = client.get(f"{endpoint}/api/tags")
            response.raise_for_status()
            models = response.json().get("models", [])
    except Exception as exc:  # noqa: BLE001 - returned as preflight evidence
        return {**base, "available": False, "error": str(exc)}

    match = next(
        (item for item in models if item.get("name") == spec.model), None
    )
    if match is None:
        installed = sorted(item.get("name", "") for item in models)
        return {
            **base,
            "available": False,
            "error": f"model {spec.model!r} is not installed",
            "installed_models": installed,
        }
    details = match.get("details") or {}
    return {
        **base,
        "available": True,
        "digest": match.get("digest"),
        "size_bytes": match.get("size"),
        "quantization": details.get("quantization_level"),
        "runtime": "ollama",
    }
