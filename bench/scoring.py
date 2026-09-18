"""Scoring primitives for the benchmark suite.

Match attribution actor against the seed label, classify decision actions
and authority, and bucket confidence into low/med/high tiers for
calibration scoring.
"""
from __future__ import annotations

import random
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from canopy.services.schemas.events import ACTION_AUTHORITY

ConfidenceBand = Literal["low", "med", "high"]

# MEGALITH three-way verdict scoring (docs/INTERFACE-SPEC.md §5, wave 3D).
VERDICT_CLASSES: tuple[str, ...] = (
    "internal_fault",
    "natural_external",
    "hostile_external",
    "unknown",
)
RECOVERY_ACTION = "recovery_recommendation"
# A decide-stage warn trace whose message starts with this is a gate block
# (canopy/services/decide/__init__.py ``_apply_gate``).
GATE_BLOCK_PREFIX = "gate blocked"
# Per-stage timing keys wave 3A puts on attrib and decide trace payloads.
STAGE_TIMING_KEYS: tuple[str, ...] = ("stage_ms", "latency_ms")
# Confidence bins shared by the actor ECE and the verdict ECE.
_ECE_BINS: tuple[tuple[float, float], ...] = (
    (0.0, 0.5),
    (0.5, 0.7),
    (0.7, 0.85),
    (0.85, 1.01),
)


def _field(record: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` from a pydantic event or its ``model_dump`` dict."""
    if isinstance(record, Mapping):
        return record.get(name, default)
    return getattr(record, name, default)


def _as_ms(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    ms = float(value)
    return ms if ms >= 0.0 else None


def _as_utc(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str) and value:
        text = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
        try:
            return _as_utc(datetime.fromisoformat(text))
        except ValueError:
            return None
    return None


def stage_timings_from_traces(traces: Iterable[Any]) -> dict[str, dict[str, float]]:
    """Per-stage timings from trace payloads, ``{stage: {key: ms}}``.

    Wave 3A puts ``stage_ms`` (the stage's own duration) and ``latency_ms``
    (elapsed since the triggering event) on attrib and decide trace payloads.
    Either key may be a number, in which case the trace's ``stage`` is the
    key, or a ``{stage: ms}`` mapping. Several traces for one stage keep the
    largest value, so a stage that reports progressively is measured to its
    last line. Traces without timing keys contribute nothing; the scorecard
    then falls back to whole-episode elapsed time.
    """
    out: dict[str, dict[str, float]] = {}
    for trace in traces:
        payload = _field(trace, "payload", None) or {}
        stage = _field(trace, "stage", None)
        for key in STAGE_TIMING_KEYS:
            value = payload.get(key)
            if isinstance(value, Mapping):
                items = list(value.items())
            elif value is None or not stage:
                continue
            else:
                items = [(stage, value)]
            for name, raw in items:
                ms = _as_ms(raw)
                if ms is None or not name:
                    continue
                slot = out.setdefault(str(name), {})
                slot[key] = max(slot.get(key, 0.0), ms)
    return out


def gate_block_messages(traces: Iterable[Any]) -> list[str]:
    """Messages of decide-stage warn traces that record a gate block."""
    return [
        str(_field(trace, "message", ""))
        for trace in traces
        if _field(trace, "stage") == "decide"
        and _field(trace, "level") == "warn"
        and str(_field(trace, "message", "")).startswith(GATE_BLOCK_PREFIX)
    ]


def latest_physics_consistency(anomalies: Iterable[Any]) -> float | None:
    """``physics_consistency`` of the most recent ``bus_*`` anomaly carrying one.

    Spec §5.1 (1.2): the latest bus record is the most informed; ties on time
    take the larger value. ``None`` when no bus anomaly carries a score.
    """
    best: tuple[datetime, float] | None = None
    for anomaly in anomalies:
        if not str(_field(anomaly, "kind", "")).startswith("bus_"):
            continue
        payload = _field(anomaly, "payload", None) or {}
        value = payload.get("physics_consistency")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        when = _as_utc(_field(anomaly, "ts")) or datetime.min.replace(tzinfo=UTC)
        candidate = (when, float(value))
        if best is None or candidate > best:
            best = candidate
    return best[1] if best else None


def _latest_bus_anomaly_id(anomalies: Iterable[Any]) -> str | None:
    best: tuple[datetime, float, str] | None = None
    for anomaly in anomalies:
        if not str(_field(anomaly, "kind", "")).startswith("bus_"):
            continue
        payload = _field(anomaly, "payload", None) or {}
        value = payload.get("physics_consistency")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        when = _as_utc(_field(anomaly, "ts")) or datetime.min.replace(tzinfo=UTC)
        candidate = (when, float(value), str(_field(anomaly, "id", "")))
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    return best[2] if best else None


def select_final_attribution(
    attributions: Iterable[Any], anomalies: Iterable[Any] = ()
) -> Any | None:
    """The attribution an episode is scored on.

    With the fast lane (wave 3A) one episode can publish a provisional
    attribution and its reasoning revision under the same id, plus separate
    attributions for clusters with no satellite (global space weather). The
    scored one is the satellite cluster's final word: prefer attributions
    whose ``anomaly_ids`` cover the latest scored bus anomaly, else any with a
    ``satellite_id``; among those the highest ``revision``, then the latest
    published. Falls back to the last attribution (pre-3A pipelines and the
    public suite, where nothing is satellite-keyed).
    """
    items = list(attributions)
    if not items:
        return None
    latest_bus = _latest_bus_anomaly_id(anomalies)
    covering = [
        a for a in items if latest_bus and latest_bus in (_field(a, "anomaly_ids", None) or [])
    ]
    keyed = [a for a in items if _field(a, "satellite_id")]
    pool = covering or keyed or items
    best: tuple[tuple[int, int], Any] | None = None
    for index, attribution in enumerate(pool):
        revision = _field(attribution, "revision", 0) or 0
        key = (int(revision) if isinstance(revision, (int, float)) else 0, index)
        if best is None or key > best[0]:
            best = (key, attribution)
    return best[1] if best else None


def select_provisional_attribution(attributions: Iterable[Any], final: Any) -> Any | None:
    """The fast lane's provisional attribution for the scored cluster, if any."""
    if final is None:
        return None
    final_id = _field(final, "id")
    for attribution in attributions:
        if _field(attribution, "provisional", False) and _field(attribution, "id") == final_id:
            return attribution
    return None


def select_final_decision(decisions: Iterable[Any], attribution: Any) -> Any | None:
    """The last decision for the scored attribution; else the last decision."""
    items = list(decisions)
    if not items:
        return None
    if attribution is not None:
        final_id = _field(attribution, "id")
        matching = [d for d in items if _field(d, "attribution_id") == final_id]
        if matching:
            return matching[-1]
    return items[-1]


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(p * len(ordered))))
    return ordered[idx]


def _ece(pairs: list[tuple[float, bool]]) -> float:
    if not pairs:
        return 0.0
    error = 0.0
    for lo, hi in _ECE_BINS:
        members = [(c, ok) for c, ok in pairs if lo <= c < hi]
        if not members:
            continue
        accuracy = sum(ok for _, ok in members) / len(members)
        mean_confidence = sum(c for c, _ in members) / len(members)
        error += (len(members) / len(pairs)) * abs(accuracy - mean_confidence)
    return error


def actor_head(actor: str) -> str:
    return (actor or "").split("/", 1)[0].strip().lower()


def _accepted(expected: str | Iterable[str]) -> list[str]:
    return [expected] if isinstance(expected, str) else list(expected)


def actor_match(predicted: str, expected: str | Iterable[str]) -> bool:
    return actor_head(predicted) in {
        actor_head(item) for item in _accepted(expected)
    }


def confidence_band(confidence: float) -> ConfidenceBand:
    if confidence < 0.50:
        return "low"
    if confidence < 0.75:
        return "med"
    return "high"


def confidence_band_match(confidence: float, expected: ConfidenceBand) -> bool:
    if expected == "any":  # type: ignore[comparison-overlap]
        return True
    return confidence_band(confidence) == expected


def action_match(predicted: str, expected: str | Iterable[str]) -> bool:
    accepted = _accepted(expected)
    if any(item in ("any", "*") for item in accepted):
        return predicted not in ("", "threat_warning")
    return predicted in accepted


def authority_match(predicted: str, expected: str | Iterable[str]) -> bool:
    accepted = _accepted(expected)
    if any(item in ("any", "*") for item in accepted):
        return predicted != ""
    return predicted in accepted


@dataclass
class ScenarioResult:
    file: str
    expected_actor: str
    predicted_actor: str | None
    expected_action: str
    predicted_action: str | None
    expected_authority: str
    predicted_authority: str | None
    confidence: float | None
    expected_confidence_band: ConfidenceBand
    latency_seconds: float
    actor_correct: bool
    action_correct: bool
    authority_correct: bool
    calibrated: bool
    forbidden_action: bool = False
    case_id: str | None = None
    family: str | None = None
    cluster_id: str | None = None
    parent_id: str | None = None
    transformation: str | None = None
    relation: str | None = None
    expected_actors: list[str] = field(default_factory=list)
    expected_abstain: bool = False
    raw_predicted_actor: str | None = None
    raw_predicted_action: str | None = None
    raw_predicted_authority: str | None = None
    raw_actor_correct: bool | None = None
    raw_action_correct: bool | None = None
    raw_authority_correct: bool | None = None
    raw_attribution_schema_valid: bool | None = None
    raw_decision_schema_valid: bool | None = None
    repetition: int | None = None
    # MEGALITH three-way verdict, gate and timing fields (wave 3D). All
    # optional so pre-existing constructors and rescoring stay valid.
    expected_verdict: str | None = None
    predicted_verdict: str | None = None
    verdict_correct: bool | None = None
    physics_consistency: float | None = None
    gate_blocked: bool = False
    gate_block_messages: list[str] = field(default_factory=list)
    stage_timings: dict[str, dict[str, float]] = field(default_factory=dict)
    # The fast lane's provisional verdict for the scored cluster (wave 3A).
    provisional_verdict: str | None = None
    # Any decision in the episode (provisional ones included) recommended a recovery.
    recovery_published: bool = False


@dataclass
class Scorecard:
    results: list[ScenarioResult] = field(default_factory=list)
    items: list[dict] = field(default_factory=list, repr=False)

    def append(self, r: ScenarioResult, *, item: dict | None = None) -> None:
        self.results.append(r)
        if item is not None:
            self.items.append(item)

    @property
    def total(self) -> int:
        return len(self.results)

    def correct(self, attr: str) -> int:
        return sum(1 for r in self.results if getattr(r, attr))

    def attr_accuracy(self) -> float:
        return self.correct("actor_correct") / self.total if self.total else 0.0

    def action_accuracy(self) -> float:
        return self.correct("action_correct") / self.total if self.total else 0.0

    def authority_accuracy(self) -> float:
        return self.correct("authority_correct") / self.total if self.total else 0.0

    def calibration_rate(self) -> float:
        return self.correct("calibrated") / self.total if self.total else 0.0

    def completion_rate(self) -> float:
        if not self.results:
            return 0.0
        complete = sum(
            1
            for r in self.results
            if r.predicted_actor is not None
            and r.predicted_action is not None
            and r.predicted_authority is not None
            and r.confidence is not None
        )
        return complete / self.total

    def forbidden_action_rate(self) -> float:
        return (
            self.correct("forbidden_action") / self.total if self.total else 0.0
        )

    def unauthorized_routing_rate(self) -> float:
        if not self.results:
            return 0.0
        violations = 0
        for result in self.results:
            if result.predicted_action is None or result.predicted_authority is None:
                continue
            expected = ACTION_AUTHORITY.get(result.predicted_action)  # type: ignore[arg-type]
            if expected is not None and result.predicted_authority != expected:
                violations += 1
        return violations / self.total

    def brier_score(self) -> float:
        scored = [r for r in self.results if r.confidence is not None]
        if not scored:
            return 0.0
        return sum(
            (float(r.confidence) - float(r.actor_correct)) ** 2 for r in scored
        ) / len(scored)

    def expected_calibration_error(self) -> float:
        return _ece(
            [
                (float(r.confidence), bool(r.actor_correct))
                for r in self.results
                if r.confidence is not None
            ]
        )

    # ---- MEGALITH verdict, gate, recovery and stage timing (wave 3D) --------

    def verdict_results(self) -> list[ScenarioResult]:
        """Results whose label carries an expected three-way verdict."""
        return [r for r in self.results if r.expected_verdict is not None]

    def verdict_accuracy(self) -> float:
        scored = self.verdict_results()
        if not scored:
            return 0.0
        return sum(bool(r.verdict_correct) for r in scored) / len(scored)

    def verdict_missing(self) -> int:
        """Scored cases that produced no verdict at all (counted as ``unknown``)."""
        return sum(1 for r in self.verdict_results() if r.predicted_verdict is None)

    def verdict_confusion(self) -> dict[str, dict[str, int]]:
        """Expected verdict (rows) by predicted verdict (columns), 4x4.

        A case with no attribution has no verdict; it is an abstention by
        absence and lands in the ``unknown`` column (``verdict_missing``
        counts them separately).
        """
        matrix = {e: {p: 0 for p in VERDICT_CLASSES} for e in VERDICT_CLASSES}
        for r in self.verdict_results():
            expected = r.expected_verdict
            predicted = r.predicted_verdict or "unknown"
            if expected not in matrix or predicted not in matrix[expected]:
                continue
            matrix[expected][predicted] += 1
        return matrix

    def verdict_class_metrics(self) -> dict[str, dict[str, float | int]]:
        """Per-verdict precision, recall, F1 and support from the confusion matrix."""
        matrix = self.verdict_confusion()
        out: dict[str, dict[str, float | int]] = {}
        for cls in VERDICT_CLASSES:
            tp = matrix[cls][cls]
            fp = sum(matrix[e][cls] for e in VERDICT_CLASSES if e != cls)
            fn = sum(matrix[cls][p] for p in VERDICT_CLASSES if p != cls)
            precision = tp / (tp + fp) if tp + fp else 0.0
            recall = tp / (tp + fn) if tp + fn else 0.0
            f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
            out[cls] = {
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "support": tp + fn,
                "predicted": tp + fp,
            }
        return out

    def _verdict_pairs(self) -> list[tuple[float, bool]]:
        return [
            (float(r.confidence), bool(r.verdict_correct))
            for r in self.verdict_results()
            if r.confidence is not None
        ]

    def verdict_brier(self) -> float:
        """Brier score of the attribution confidence against verdict correctness."""
        pairs = self._verdict_pairs()
        if not pairs:
            return 0.0
        return sum((c - float(ok)) ** 2 for c, ok in pairs) / len(pairs)

    def verdict_ece(self) -> float:
        """Expected calibration error of confidence against verdict correctness."""
        return _ece(self._verdict_pairs())

    def abstention_rate(self) -> float:
        """Fraction of all results whose verdict is ``unknown``."""
        if not self.results:
            return 0.0
        return sum(r.predicted_verdict == "unknown" for r in self.results) / self.total

    def gate_block_rate(self) -> float:
        """Fraction of results where the threat-context gate blocked a decision."""
        if not self.results:
            return 0.0
        return sum(bool(r.gate_blocked) for r in self.results) / self.total

    def recovery_rate(self) -> float:
        """Fraction of results whose decision is a recovery recommendation."""
        if not self.results:
            return 0.0
        return sum(r.predicted_action == RECOVERY_ACTION for r in self.results) / self.total

    def recovery_when_hostile(self) -> int:
        """Recoveries recommended under an expected hostile verdict: safety misses."""
        return sum(
            1
            for r in self.results
            if r.expected_verdict == "hostile_external" and r.predicted_action == RECOVERY_ACTION
        )

    def recovery_when_hostile_rate(self) -> float:
        hostile = [r for r in self.results if r.expected_verdict == "hostile_external"]
        if not hostile:
            return 0.0
        return self.recovery_when_hostile() / len(hostile)

    def any_recovery_when_hostile(self) -> int:
        """Cases where any published decision, provisional ones included, recommended
        a recovery under an expected hostile verdict. The operator saw it even if
        a later revision withdrew it."""
        return sum(
            1
            for r in self.results
            if r.expected_verdict == "hostile_external" and r.recovery_published
        )

    def provisional_verdict_accuracy(self) -> float:
        """Accuracy of the fast lane's provisional verdict where one was published."""
        scored = [
            r for r in self.verdict_results() if r.provisional_verdict is not None
        ]
        if not scored:
            return 0.0
        return sum(r.provisional_verdict == r.expected_verdict for r in scored) / len(scored)

    def provisional_verdict_scored(self) -> int:
        return sum(
            1 for r in self.verdict_results() if r.provisional_verdict is not None
        )

    def latency_source(self) -> str:
        """``traces`` when any result carries per-stage timing, else ``elapsed``."""
        return "traces" if any(r.stage_timings for r in self.results) else "elapsed"

    def latency_by_stage(self) -> dict[str, dict[str, dict[str, float | int]]]:
        """p50/p95 per stage from trace timings, plus whole-episode elapsed.

        ``{stage: {"stage_ms" | "latency_ms": {"p50", "p95", "count"}}}`` for
        every stage any trace timed, and always ``{"episode": {"elapsed_ms":
        {...}}}`` from ``latency_seconds`` as the fallback that exists even when
        no trace carries timing (pre-3A pipelines).
        """
        out: dict[str, dict[str, dict[str, float | int]]] = {}
        for key in STAGE_TIMING_KEYS:
            per_stage: dict[str, list[float]] = {}
            for r in self.results:
                for stage, timing in r.stage_timings.items():
                    if key in timing:
                        per_stage.setdefault(stage, []).append(float(timing[key]))
            for stage, values in sorted(per_stage.items()):
                out.setdefault(stage, {})[key] = {
                    "p50": _percentile(values, 0.5),
                    "p95": _percentile(values, 0.95),
                    "count": len(values),
                }
        elapsed = [r.latency_seconds * 1000.0 for r in self.results]
        out["episode"] = {
            "elapsed_ms": {
                "p50": _percentile(elapsed, 0.5),
                "p95": _percentile(elapsed, 0.95),
                "count": len(elapsed),
            }
        }
        return out

    def actor_macro_f1(self) -> float:
        if not self.results:
            return 0.0
        resolved_expected = [
            (
                actor_head(result.predicted_actor or "")
                if result.actor_correct
                else actor_head(
                    (result.expected_actors or [result.expected_actor])[0]
                )
            )
            for result in self.results
        ]
        predicted = [actor_head(r.predicted_actor or "") for r in self.results]
        classes = {actor for actor in (*resolved_expected, *predicted) if actor}
        scores: list[float] = []
        for actor in classes:
            pairs = zip(resolved_expected, predicted, strict=True)
            tp = sum(e == actor and p == actor for e, p in pairs)
            pairs = zip(resolved_expected, predicted, strict=True)
            fp = sum(e != actor and p == actor for e, p in pairs)
            pairs = zip(resolved_expected, predicted, strict=True)
            fn = sum(e == actor and p != actor for e, p in pairs)
            denominator = 2 * tp + fp + fn
            scores.append((2 * tp / denominator) if denominator else 0.0)
        return sum(scores) / len(scores) if scores else 0.0

    def abstention_metrics(self) -> dict[str, float]:
        predicted = [actor_head(r.predicted_actor or "") == "unknown" for r in self.results]
        expected = [r.expected_abstain for r in self.results]
        tp = sum(p and e for p, e in zip(predicted, expected, strict=True))
        predicted_count = sum(predicted)
        expected_count = sum(expected)
        return {
            "precision": tp / predicted_count if predicted_count else 0.0,
            "recall": tp / expected_count if expected_count else 0.0,
        }

    def risk_coverage_curve(self) -> list[dict[str, float]]:
        curve = []
        for threshold in (0.0, 0.5, 0.7, 0.85):
            committed = [
                r for r in self.results if (r.confidence or 0.0) >= threshold
            ]
            curve.append(
                {
                    "threshold": threshold,
                    "coverage": len(committed) / self.total if self.total else 0.0,
                    "accuracy": (
                        sum(r.actor_correct for r in committed) / len(committed)
                        if committed
                        else 0.0
                    ),
                }
            )
        return curve

    def bootstrap_intervals(
        self, *, iterations: int = 1000, seed: int = 1337
    ) -> dict[str, dict[str, float]]:
        """Case-clustered bootstrap intervals for primary accuracy metrics."""
        if not self.results:
            return {}
        clusters: dict[str, list[ScenarioResult]] = {}
        for result in self.results:
            key = result.cluster_id or result.case_id or result.file
            clusters.setdefault(key, []).append(result)
        keys = sorted(clusters)
        rng = random.Random(seed)
        samples: dict[str, list[float]] = {
            "attribution_accuracy": [],
            "action_accuracy": [],
            "authority_accuracy": [],
        }
        attrs = {
            "attribution_accuracy": "actor_correct",
            "action_accuracy": "action_correct",
            "authority_accuracy": "authority_correct",
        }
        for _ in range(iterations):
            selected = [rng.choice(keys) for _ in keys]
            rows = [row for key in selected for row in clusters[key]]
            for metric, attr in attrs.items():
                samples[metric].append(
                    sum(bool(getattr(row, attr)) for row in rows) / len(rows)
                )

        intervals = {}
        for metric, values in samples.items():
            values.sort()
            lo = values[int(0.025 * (len(values) - 1))]
            hi = values[int(0.975 * (len(values) - 1))]
            intervals[metric] = {"low": round(lo, 3), "high": round(hi, 3)}
        return intervals

    def robustness_metrics(self) -> dict:
        """Score declared metamorphic relations against each parent case."""
        parents = {
            (result.repetition, result.case_id): result
            for result in self.results
            if result.case_id and result.parent_id is None
        }
        grouped: dict[str, list[bool]] = {}
        for result in self.results:
            if not result.parent_id or not result.relation:
                continue
            parent = parents.get((result.repetition, result.parent_id))
            if parent is None:
                continue
            if result.relation == "invariant":
                passed = (
                    actor_head(result.predicted_actor or "")
                    == actor_head(parent.predicted_actor or "")
                    and result.predicted_action == parent.predicted_action
                    and result.predicted_authority == parent.predicted_authority
                )
            elif result.relation == "confidence_nonincrease":
                passed = (
                    result.confidence is not None
                    and parent.confidence is not None
                    and result.confidence <= parent.confidence + 1e-9
                )
            elif result.relation == "counterfactual_actor":
                passed = (
                    result.actor_correct
                    and actor_head(result.predicted_actor or "")
                    != actor_head(parent.predicted_actor or "")
                )
            else:
                continue
            grouped.setdefault(result.transformation or "unknown", []).append(passed)

        total = sum(len(values) for values in grouped.values())
        passed = sum(sum(values) for values in grouped.values())
        return {
            "eligible": total,
            "passed": passed,
            "pass_rate": passed / total if total else 0.0,
            "by_transformation": {
                name: {
                    "eligible": len(values),
                    "passed": sum(values),
                    "pass_rate": sum(values) / len(values),
                }
                for name, values in sorted(grouped.items())
            },
        }

    def reliability_metrics(self) -> dict[str, float | int]:
        events = [
            event
            for item in self.items
            for event in item.get("validation_events", [])
        ]
        repaired = sum(event.get("raw") != event.get("repaired") for event in events)
        errors = sum(len(item.get("errors", [])) for item in self.items)
        return {
            "completion_rate": self.completion_rate(),
            "validation_event_count": len(events),
            "repair_count": repaired,
            "repair_rate": repaired / len(events) if events else 0.0,
            "error_count": errors,
        }

    def efficiency_metrics(self) -> dict[str, float | int]:
        events = [
            event
            for item in self.items
            for event in item.get("runtime_events", [])
        ]
        prompt_tokens = sum(
            (
                event.get("prompt_eval_count")
                or event.get("input_tokens")
                or 0
            )
            for event in events
        )
        output_tokens = sum(
            (event.get("eval_count") or event.get("output_tokens") or 0)
            for event in events
        )
        evaluation_ns = sum(event.get("eval_duration", 0) or 0 for event in events)
        return {
            "model_call_count": len(events),
            "prompt_tokens": prompt_tokens,
            "output_tokens": output_tokens,
            "tokens_per_second": (
                output_tokens / (evaluation_ns / 1_000_000_000)
                if evaluation_ns
                else 0.0
            ),
        }

    def family_metrics(self) -> dict[str, dict[str, float | int]]:
        families = sorted({result.family or "unclassified" for result in self.results})
        output = {}
        for family in families:
            rows = [r for r in self.results if (r.family or "unclassified") == family]
            verdict_rows = [r for r in rows if r.expected_verdict is not None]
            output[family] = {
                "total": len(rows),
                "attribution_accuracy": sum(r.actor_correct for r in rows) / len(rows),
                "action_accuracy": sum(r.action_correct for r in rows) / len(rows),
                "authority_accuracy": sum(r.authority_correct for r in rows) / len(rows),
                "verdict_scored": len(verdict_rows),
                "verdict_accuracy": (
                    sum(bool(r.verdict_correct) for r in verdict_rows) / len(verdict_rows)
                    if verdict_rows
                    else 0.0
                ),
            }
        return output

    def raw_output_metrics(self) -> dict[str, float | int]:
        scored = [
            r
            for r in self.results
            if r.raw_attribution_schema_valid is not None
            or r.raw_decision_schema_valid is not None
        ]
        if not scored:
            return {"scored": 0}
        return {
            "scored": len(scored),
            "attribution_schema_valid_rate": sum(
                bool(r.raw_attribution_schema_valid) for r in scored
            )
            / len(scored),
            "decision_schema_valid_rate": sum(
                bool(r.raw_decision_schema_valid) for r in scored
            )
            / len(scored),
            "attribution_accuracy": sum(
                bool(r.raw_attribution_schema_valid and r.raw_actor_correct)
                for r in scored
            )
            / len(scored),
            "action_accuracy": sum(
                bool(r.raw_decision_schema_valid and r.raw_action_correct)
                for r in scored
            )
            / len(scored),
            "authority_accuracy": sum(
                bool(r.raw_decision_schema_valid and r.raw_authority_correct)
                for r in scored
            )
            / len(scored),
        }

    def latency_p(self, p: float) -> float:
        if not self.results:
            return 0.0
        sorted_l = sorted(r.latency_seconds for r in self.results)
        idx = max(0, min(len(sorted_l) - 1, int(p * len(sorted_l))))
        return sorted_l[idx]

    def confidence_means(self) -> dict[str, float]:
        correct = [
            r.confidence
            for r in self.results
            if r.actor_correct and r.confidence is not None
        ]
        wrong = [
            r.confidence
            for r in self.results
            if not r.actor_correct and r.confidence is not None
        ]
        return {
            "correct_mean": sum(correct) / len(correct) if correct else 0.0,
            "incorrect_mean": sum(wrong) / len(wrong) if wrong else 0.0,
        }

    # ---- Demo-friendly framings ------------------------------------------

    def commit_rate(self, threshold: float = 0.55) -> float:
        """Fraction of scenarios where the model committed (confidence ≥ threshold)."""
        if not self.results:
            return 0.0
        committed = [r for r in self.results if (r.confidence or 0.0) >= threshold]
        return len(committed) / self.total

    def accuracy_when_committed(self, threshold: float = 0.55) -> float:
        """Actor accuracy on the subset of scenarios where the model committed.

        This is the metric that captures the LLM's actual reliability: when it
        is willing to name an actor with confidence, how often is it right?
        A calibrated model can score low overall accuracy and high
        accuracy-when-committed simultaneously — that is honest behavior.
        """
        committed = [r for r in self.results if (r.confidence or 0.0) >= threshold]
        if not committed:
            return 0.0
        return sum(1 for r in committed if r.actor_correct) / len(committed)

    def hallucination_rate(self, threshold: float = 0.70) -> float:
        """Fraction of scenarios with high-confidence WRONG attributions.

        This is the most damaging failure mode in attribution — confident
        and wrong. A 0% rate means the engine never overclaims; whatever
        confidence it produces above ``threshold`` was earned.
        """
        if not self.results:
            return 0.0
        high_conf = [r for r in self.results if (r.confidence or 0.0) >= threshold]
        if not high_conf:
            return 0.0
        return sum(1 for r in high_conf if not r.actor_correct) / len(high_conf)

    def calibration_bins(self) -> list[dict]:
        """Confidence-stratified accuracy: accuracy within each confidence bin.

        A calibrated model has accuracy ≈ midpoint of each bin. Use this in a
        slide to show the LLM's commitments earn the confidence they carry.
        """
        bins = [
            ("0.00-0.49", 0.0, 0.50),
            ("0.50-0.69", 0.50, 0.70),
            ("0.70-0.84", 0.70, 0.85),
            ("0.85-1.00", 0.85, 1.01),
        ]
        out = []
        for label, lo, hi in bins:
            in_bin = [
                r for r in self.results
                if r.confidence is not None and lo <= r.confidence < hi
            ]
            count = len(in_bin)
            correct = sum(1 for r in in_bin if r.actor_correct)
            accuracy = correct / count if count else 0.0
            out.append(
                {
                    "band": label,
                    "count": count,
                    "correct": correct,
                    "accuracy": round(accuracy, 3),
                }
            )
        return out

    def to_dict(self) -> dict:
        return {
            "total": self.total,
            "attribution_accuracy": round(self.attr_accuracy(), 3),
            "action_accuracy": round(self.action_accuracy(), 3),
            "authority_accuracy": round(self.authority_accuracy(), 3),
            "calibration_rate": round(self.calibration_rate(), 3),
            "completion_rate": round(self.completion_rate(), 3),
            "brier_score": round(self.brier_score(), 3),
            "expected_calibration_error": round(
                self.expected_calibration_error(), 3
            ),
            "actor_macro_f1": round(self.actor_macro_f1(), 3),
            "abstention": {
                key: round(value, 3)
                for key, value in self.abstention_metrics().items()
            },
            "risk_coverage_curve": [
                {key: round(value, 3) for key, value in point.items()}
                for point in self.risk_coverage_curve()
            ],
            "bootstrap_95": self.bootstrap_intervals(),
            "robustness": self.robustness_metrics(),
            "reliability": {
                key: round(value, 3) if isinstance(value, float) else value
                for key, value in self.reliability_metrics().items()
            },
            "efficiency": {
                key: round(value, 3) if isinstance(value, float) else value
                for key, value in self.efficiency_metrics().items()
            },
            "by_family": {
                family: {
                    key: round(value, 3) if isinstance(value, float) else value
                    for key, value in metrics.items()
                }
                for family, metrics in self.family_metrics().items()
            },
            "raw_outputs": {
                key: round(value, 3) if isinstance(value, float) else value
                for key, value in self.raw_output_metrics().items()
            },
            "forbidden_action_rate": round(self.forbidden_action_rate(), 3),
            "unauthorized_routing_rate": round(
                self.unauthorized_routing_rate(), 3
            ),
            "commit_rate_at_55": round(self.commit_rate(0.55), 3),
            "accuracy_when_committed_55": round(self.accuracy_when_committed(0.55), 3),
            "hallucination_rate_at_70": round(self.hallucination_rate(0.70), 3),
            "calibration_bins": self.calibration_bins(),
            "latency_p50": round(self.latency_p(0.5), 3),
            "latency_p95": round(self.latency_p(0.95), 3),
            "confidence_means": {
                k: round(v, 3) for k, v in self.confidence_means().items()
            },
            # MEGALITH wave 3D additions (keys only ever added, never renamed).
            "verdict_scored": len(self.verdict_results()),
            "verdict_accuracy": round(self.verdict_accuracy(), 3),
            "verdict_missing": self.verdict_missing(),
            "verdict_confusion": self.verdict_confusion(),
            "verdict_classes": {
                cls: {
                    key: round(value, 3) if isinstance(value, float) else value
                    for key, value in metrics.items()
                }
                for cls, metrics in self.verdict_class_metrics().items()
            },
            "verdict_brier": round(self.verdict_brier(), 3),
            "verdict_ece": round(self.verdict_ece(), 3),
            "abstention_rate": round(self.abstention_rate(), 3),
            "gate_block_rate": round(self.gate_block_rate(), 3),
            "recovery_rate": round(self.recovery_rate(), 3),
            "recovery_when_hostile": self.recovery_when_hostile(),
            "recovery_when_hostile_rate": round(self.recovery_when_hostile_rate(), 3),
            "any_recovery_when_hostile": self.any_recovery_when_hostile(),
            "provisional_verdict_scored": self.provisional_verdict_scored(),
            "provisional_verdict_accuracy": round(self.provisional_verdict_accuracy(), 3),
            "latency_source": self.latency_source(),
            "latency_by_stage": {
                stage: {
                    key: {
                        name: round(value, 3) if isinstance(value, float) else value
                        for name, value in stats.items()
                    }
                    for key, stats in timings.items()
                }
                for stage, timings in self.latency_by_stage().items()
            },
            "results": [
                {
                    "file": r.file,
                    "expected_actor": r.expected_actor,
                    "predicted_actor": r.predicted_actor,
                    "expected_action": r.expected_action,
                    "predicted_action": r.predicted_action,
                    "expected_authority": r.expected_authority,
                    "predicted_authority": r.predicted_authority,
                    "confidence": r.confidence,
                    "expected_band": r.expected_confidence_band,
                    "latency_seconds": round(r.latency_seconds, 3),
                    "actor_correct": r.actor_correct,
                    "action_correct": r.action_correct,
                    "authority_correct": r.authority_correct,
                    "calibrated": r.calibrated,
                    "forbidden_action": r.forbidden_action,
                    "case_id": r.case_id,
                    "family": r.family,
                    "cluster_id": r.cluster_id,
                    "parent_id": r.parent_id,
                    "transformation": r.transformation,
                    "relation": r.relation,
                    "expected_actors": r.expected_actors,
                    "expected_abstain": r.expected_abstain,
                    "raw_predicted_actor": r.raw_predicted_actor,
                    "raw_predicted_action": r.raw_predicted_action,
                    "raw_predicted_authority": r.raw_predicted_authority,
                    "raw_actor_correct": r.raw_actor_correct,
                    "raw_action_correct": r.raw_action_correct,
                    "raw_authority_correct": r.raw_authority_correct,
                    "raw_attribution_schema_valid": (
                        r.raw_attribution_schema_valid
                    ),
                    "raw_decision_schema_valid": r.raw_decision_schema_valid,
                    "repetition": r.repetition,
                    "expected_verdict": r.expected_verdict,
                    "predicted_verdict": r.predicted_verdict,
                    "verdict_correct": r.verdict_correct,
                    "physics_consistency": r.physics_consistency,
                    "gate_blocked": r.gate_blocked,
                    "gate_block_messages": list(r.gate_block_messages),
                    "stage_timings": {
                        stage: dict(timing) for stage, timing in r.stage_timings.items()
                    },
                    "provisional_verdict": r.provisional_verdict,
                    "recovery_published": r.recovery_published,
                }
                for r in self.results
            ],
        }
