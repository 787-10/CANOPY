"""Scoring primitives for the benchmark suite.

Match attribution actor against the seed label, classify decision actions
and authority, and bucket confidence into low/med/high tiers for
calibration scoring.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ConfidenceBand = Literal["low", "med", "high"]


def actor_head(actor: str) -> str:
    return (actor or "").split("/", 1)[0].strip().lower()


def actor_match(predicted: str, expected: str) -> bool:
    return actor_head(predicted) == actor_head(expected)


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


def action_match(predicted: str, expected: str) -> bool:
    if expected in ("any", "*"):
        return predicted not in ("", "threat_warning")
    return predicted == expected


def authority_match(predicted: str, expected: str) -> bool:
    if expected in ("any", "*"):
        return predicted != ""
    return predicted == expected


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


@dataclass
class Scorecard:
    results: list[ScenarioResult] = field(default_factory=list)

    def append(self, r: ScenarioResult) -> None:
        self.results.append(r)

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
                }
                for r in self.results
            ],
        }
