"""Provider preflight and reproducibility metadata for benchmark models."""
from __future__ import annotations

import os
import subprocess
from hashlib import sha256
from pathlib import Path
from typing import Any

from bench.specs import ModelSpec

ROOT = Path(__file__).resolve().parent.parent


def _file_hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def benchmark_provenance() -> dict[str, Any]:
    """Hash every static input that changes benchmark interpretation."""
    from canopy.services.attrib.prompts import (
        attribution_system_prompt,
        reconcile_system_prompt,
        redteam_system_prompt,
    )
    from canopy.services.decide.prompts import decision_system_prompt

    files = {
        "scenario_registry": ROOT / "scenarios" / "manifest.json",
        "variant_labels": ROOT / "bench" / "scenarios" / "labels.json",
        "model_specs": ROOT / "bench" / "models.yaml",
        "knowledge_base": ROOT / "data" / "kb_seed_entries.json",
    }
    file_hashes = {name: _file_hash(path) for name, path in files.items()}
    from bench.specs import load_scenario_registry

    scenario_hashes = {
        f"scenarios/{case.file}": _file_hash(case.scenario_path)
        for case in load_scenario_registry().cases
    }
    variants_root = ROOT / "bench" / "scenarios"
    variant_hashes = {
        str(path.relative_to(ROOT)): _file_hash(path)
        for path in sorted(variants_root.glob("*.jsonl"))
    }
    prompt_text = {
        "attribution": attribution_system_prompt(),
        "redteam": redteam_system_prompt(),
        "reconcile": reconcile_system_prompt(),
        "decision": decision_system_prompt(),
    }
    prompt_hashes = {
        name: sha256(text.encode("utf-8")).hexdigest()
        for name, text in prompt_text.items()
    }
    suite_inputs = {
        "scenario_registry": file_hashes["scenario_registry"],
        "variant_labels": file_hashes["variant_labels"],
        **scenario_hashes,
        **variant_hashes,
    }
    suite_material = "".join(
        f"{name}:{digest}\n" for name, digest in sorted(suite_inputs.items())
    )
    return {
        "suite_hash": sha256(suite_material.encode("ascii")).hexdigest(),
        "file_hashes": file_hashes,
        "scenario_hashes": scenario_hashes,
        "variant_hashes": variant_hashes,
        "prompt_hashes": prompt_hashes,
    }


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
