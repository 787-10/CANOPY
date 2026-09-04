"""Versioned benchmark scenario and model specifications."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, model_validator

from canopy.services.schemas.events import Action, Authority, Domain, Signal

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SCENARIO_REGISTRY = ROOT / "scenarios" / "manifest.json"
DEFAULT_MODEL_SPECS = ROOT / "bench" / "models.yaml"

RecordRole = Literal["stimulus", "context", "oracle", "display_only"]
Visibility = Literal["demo", "public_eval", "heldout"]


class RecordRoleRule(BaseModel):
    role: RecordRole
    source: str | None = None
    signal_ids: list[str] = Field(default_factory=list)
    event_types: list[str] = Field(default_factory=list)
    excluded_sources: list[str] = Field(default_factory=list)

    def matches(self, signal: Signal) -> bool:
        checks = []
        if self.source is not None:
            checks.append(signal.source == self.source)
        if self.signal_ids:
            checks.append(signal.id in self.signal_ids)
        if self.event_types:
            checks.append(signal.payload.event_type in self.event_types)
        if self.excluded_sources:
            checks.append(signal.source not in self.excluded_sources)
        return bool(checks) and all(checks)


class ExpectedOutcome(BaseModel):
    actors: list[str] = Field(min_length=1)
    actions: list[Action] = Field(min_length=1)
    authorities: list[Authority] = Field(min_length=1)
    confidence_band: Literal["low", "med", "high"]
    abstain: bool = False
    forbidden_actions: list[Action] = Field(default_factory=list)
    required_citations: list[str] = Field(default_factory=list)
    required_tools: list[str] = Field(default_factory=list)


class ScenarioSpec(BaseModel):
    id: str = Field(min_length=1)
    version: int = Field(ge=1)
    file: str = Field(min_length=1)
    name: str
    short_name: str
    family: str = Field(min_length=1, pattern=r"^[a-z][a-z0-9_-]*$")
    theater: str
    objective: str
    domains: list[Domain]
    visibility: list[Visibility]
    split: Literal["dev", "test", "heldout"] = "test"
    tags: list[str] = Field(default_factory=list)
    checkpoint: Literal["final"] = "final"
    record_roles: list[RecordRoleRule] = Field(default_factory=list)
    redacted_observable_fields: list[str] = Field(default_factory=list)
    expected: ExpectedOutcome
    oracle_notes: str

    @property
    def scenario_path(self) -> Path:
        path = (ROOT / "scenarios" / self.file).resolve()
        scenarios_root = (ROOT / "scenarios").resolve()
        if path.parent != scenarios_root:
            raise ValueError(f"scenario file must be directly under {scenarios_root}")
        return path

    def role_for(self, signal: Signal) -> RecordRole:
        for rule in self.record_roles:
            if rule.matches(signal):
                return rule.role
        return "oracle"

    def includes_as_input(self, signal: Signal) -> bool:
        return self.role_for(signal) in {"stimulus", "context"}

    def sanitize_input(self, signal: Signal) -> Signal:
        sanitized = signal.model_copy(deep=True)
        for field_name in self.redacted_observable_fields:
            sanitized.payload.observables.pop(field_name, None)
        return sanitized


class ScenarioRegistry(BaseModel):
    schema_version: int = Field(ge=1)
    common_record_roles: list[RecordRoleRule] = Field(default_factory=list)
    redacted_observable_fields: list[str] = Field(default_factory=list)
    cases: list[ScenarioSpec]

    @model_validator(mode="after")
    def _unique_cases(self) -> "ScenarioRegistry":
        ids = [case.id for case in self.cases]
        files = [case.file for case in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("scenario ids must be unique")
        if len(files) != len(set(files)):
            raise ValueError("scenario files must be unique")
        for case in self.cases:
            combined_rules = [*case.record_roles, *self.common_record_roles]
            case.record_roles = list(
                {
                    json.dumps(rule.model_dump(mode="json"), sort_keys=True): rule
                    for rule in combined_rules
                }.values()
            )
            case.redacted_observable_fields = list(
                dict.fromkeys(
                    [
                        *case.redacted_observable_fields,
                        *self.redacted_observable_fields,
                    ]
                )
            )
        return self

    def demo_cases(self) -> list[ScenarioSpec]:
        return [case for case in self.cases if "demo" in case.visibility]

    def benchmark_cases(self) -> list[ScenarioSpec]:
        return [case for case in self.cases if "public_eval" in case.visibility]

    def by_file(self, filename: str) -> ScenarioSpec:
        try:
            return next(case for case in self.cases if case.file == filename)
        except StopIteration as exc:
            raise KeyError(filename) from exc


class ModelSpec(BaseModel):
    id: str = Field(min_length=1)
    provider: Literal["stub", "ollama", "anthropic"]
    model: str
    endpoint: str | None = None
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    seed: int = 1337
    timeout_s: float = Field(default=180.0, gt=0)
    quantization: str | None = None
    repetitions: int = Field(default=1, ge=1)


def load_scenario_registry(
    path: str | Path = DEFAULT_SCENARIO_REGISTRY,
) -> ScenarioRegistry:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    registry = ScenarioRegistry.model_validate(payload)
    missing = [case.file for case in registry.cases if not case.scenario_path.exists()]
    if missing:
        raise ValueError(f"scenario registry references missing files: {missing}")
    return registry


def load_model_specs(
    path: str | Path = DEFAULT_MODEL_SPECS,
) -> dict[str, ModelSpec]:
    payload = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    specs = [ModelSpec.model_validate(item) for item in payload["models"]]
    by_id = {spec.id: spec for spec in specs}
    if len(by_id) != len(specs):
        raise ValueError("model spec ids must be unique")
    return by_id
