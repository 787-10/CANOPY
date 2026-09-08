"""Scoring primitives for the benchmark suite.

Match attribution actor against the seed label, classify decision actions
and authority, and bucket confidence into low/med/high tiers for
calibration scoring.
"""
from __future__ import annotations

import random
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

from canopy.services.schemas.events import ACTION_AUTHORITY

ConfidenceBand = Literal["low", "med", "high"]


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
        scored = [r for r in self.results if r.confidence is not None]
        if not scored:
            return 0.0
        bins = ((0.0, 0.5), (0.5, 0.7), (0.7, 0.85), (0.85, 1.01))
        error = 0.0
        for lo, hi in bins:
            members = [r for r in scored if lo <= float(r.confidence) < hi]
            if not members:
                continue
            accuracy = sum(r.actor_correct for r in members) / len(members)
            mean_confidence = sum(float(r.confidence) for r in members) / len(members)
            error += (len(members) / len(scored)) * abs(
                accuracy - mean_confidence
            )
        return error

    def actor_macro_f1(self) -> float:
        if not self.results:
            return 0.0
        classes = {
            actor_head(actor)
            for result in self.results
            for actor in (result.expected_actor, result.predicted_actor or "")
            if actor
        }
        scores: list[float] = []
        for actor in classes:
            tp = sum(
                actor_head(r.expected_actor) == actor
                and actor_head(r.predicted_actor or "") == actor
                for r in self.results
            )
            fp = sum(
                actor_head(r.expected_actor) != actor
                and actor_head(r.predicted_actor or "") == actor
                for r in self.results
            )
            fn = sum(
                actor_head(r.expected_actor) == actor
                and actor_head(r.predicted_actor or "") != actor
                for r in self.results
            )
            denominator = 2 * tp + fp + fn
            scores.append((2 * tp / denominator) if denominator else 0.0)
        return sum(scores) / len(scores) if scores else 0.0

    def abstention_metrics(self) -> dict[str, float]:
        predicted = [actor_head(r.predicted_actor or "") == "unknown" for r in self.results]
        expected = [actor_head(r.expected_actor) == "unknown" for r in self.results]
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
            result.case_id: result
            for result in self.results
            if result.case_id and result.parent_id is None
        }
        grouped: dict[str, list[bool]] = {}
        for result in self.results:
            if not result.parent_id or not result.relation:
                continue
            parent = parents.get(result.parent_id)
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

    def latency_p(self, p: float) -> float:
        if not self.results:
            return 0.0
        sorted_l = sorted(r.latency_seconds for r in self.results)
        idx = max(0, min(len(sorted_l) - 1, int(p * len(sorted_l))))
        return sorted_l[idx]

    def confidence_means(self) -> dict[str, float]:
        correct = [r.confidence for r in self.results if r.actor_correct and r.confidence is not None]
        wrong = [r.confidence for r in self.results if not r.actor_correct and r.confidence is not None]
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
                }
                for r in self.results
            ],
        }
