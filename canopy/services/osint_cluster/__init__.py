"""OSINT semantic clustering with sentence-transformers.

Subscribes to ``signals.osint`` and embeds each signal's payload summary
using a sentence-transformer model. Maintains a sliding window of recent
embeddings; new signals are assigned to existing clusters based on cosine
similarity ≥ ``similarity_threshold``, or seed a new cluster.

When a cluster crosses the 2-member threshold for the first time the
service publishes:

* a fusion-stage trace ``[fusion] osint cluster: N signals about "…" sim=0.XX``
* an anomaly ``osint_semantic_cluster`` carrying the contributing signal
  ids so the attribution agent sees one fused observation rather than N
  independent reports

After every signal it also publishes an :class:`OsintEmbeddingSnapshot`
on ``embeddings.osint`` containing the full current window with each
point projected to 2D via PCA — the frontend uses this to render a live
scatter plot of the embedding space.

Model loads lazily on the first OSINT signal. If sentence-transformers
isn't installed the service no-ops, so the engine still boots cleanly
in environments without the heavy dependency.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np

from canopy.services.bus import Bus
from canopy.services.schemas.events import (
    Anomaly,
    EmbeddingPoint,
    OsintEmbeddingSnapshot,
    Signal,
)
from canopy.services.traces import Tracer

log = logging.getLogger(__name__)

__all__ = ["OsintClusterService"]

DEFAULT_MODEL = "all-MiniLM-L6-v2"
# Empirical threshold for all-MiniLM-L6-v2 on short military prose.
# Genuinely related summaries land in the 0.35-0.55 range (e.g.,
# "C5ISR pressure" vs "counter-C5ISR pressure" ≈ 0.41); unrelated
# summaries land below 0.20. 0.40 separates the two cleanly.
DEFAULT_SIMILARITY_THRESHOLD = 0.40
DEFAULT_WINDOW_SIZE = 60  # signals (sliding cap)


@dataclass
class _WindowEntry:
    signal_id: str
    summary: str
    embedding: np.ndarray
    cluster_id: int
    ts: datetime


class OsintClusterService:
    """Embed OSINT signal summaries and cluster them by cosine similarity."""

    def __init__(
        self,
        bus: Bus,
        *,
        tracer: Tracer | None = None,
        model_name: str = DEFAULT_MODEL,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD,
        window_size: int = DEFAULT_WINDOW_SIZE,
        encoder_factory: Callable[[str], Any] | None = None,
    ) -> None:
        self._bus = bus
        self._tracer = tracer
        self._model_name = model_name
        self._similarity_threshold = similarity_threshold
        self._window_size = window_size
        self._encoder_factory = encoder_factory
        # Mutable state.
        self._encoder: Any | None = None
        self._encoder_dim: int = 0
        self._window: list[_WindowEntry] = []
        self._next_cluster_id: int = 0
        self._announced_clusters: set[int] = set()
        # Cached 2D PCA projection of the window. The SVD in _project_2d is
        # the heaviest per-signal cost but only feeds the UI scatter panel,
        # so recompute it lazily: _projection_dirty flips True whenever the
        # window mutates, and _publish_snapshot rebuilds _coords only then.
        self._projection_dirty: bool = True
        self._coords: np.ndarray = np.zeros((0, 2), dtype=np.float32)

    async def run(self) -> None:
        async for topic, event in self._bus.subscribe("signals.osint"):
            if not isinstance(event, Signal):
                log.warning("osint_cluster: non-Signal on %s: %r", topic, type(event))
                continue
            try:
                await self._handle(event)
            except Exception:
                log.exception("osint_cluster: failed to handle signal %s", event.id)

    # ---- Encoder ----------------------------------------------------------

    def _ensure_encoder(self) -> Any | None:
        """Lazily load the sentence-transformer model. Returns None if the
        library isn't installed — the service degrades to no-op rather
        than crashing the engine."""
        if self._encoder is not None:
            return self._encoder
        if self._encoder_factory is not None:
            self._encoder = self._encoder_factory(self._model_name)
        else:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError:
                log.warning(
                    "osint_cluster: sentence-transformers not installed; "
                    "OSINT clustering disabled"
                )
                return None
            log.info("osint_cluster: loading model %s", self._model_name)
            self._encoder = SentenceTransformer(self._model_name)
        # Probe dimension so the snapshot can carry it.
        sample = self._encoder.encode("probe", normalize_embeddings=True)
        self._encoder_dim = int(sample.shape[-1])
        log.info(
            "osint_cluster: encoder ready (dim=%d, model=%s)",
            self._encoder_dim,
            self._model_name,
        )
        return self._encoder

    # ---- Per-signal handling ---------------------------------------------

    async def _handle(self, signal: Signal) -> None:
        # Loading the sentence-transformer takes 1-2s the first time —
        # do it in a thread so the asyncio event loop keeps spinning
        # (decide / ui_events services need to fan out concurrently).
        encoder = await asyncio.to_thread(self._ensure_encoder)
        if encoder is None:
            return
        summary = signal.payload.summary or signal.payload.event_type or signal.id
        # normalize_embeddings=True returns L2-normalized vectors so cosine
        # similarity reduces to a dot product. encode() is CPU-bound;
        # offload to a worker thread to avoid blocking the event loop.
        emb = await asyncio.to_thread(
            lambda: np.asarray(
                encoder.encode(summary, normalize_embeddings=True),
                dtype=np.float32,
            )
        )

        cluster_id, best_similarity = self._assign_cluster(emb)
        entry = _WindowEntry(
            signal_id=signal.id,
            summary=summary,
            embedding=emb,
            cluster_id=cluster_id,
            ts=signal.ts,
        )
        self._window.append(entry)
        self._projection_dirty = True
        if len(self._window) > self._window_size:
            # Drop oldest. Note: cluster ids are not garbage-collected so a
            # cluster that ages out of the window stays visible in
            # downstream consumers' history (which is what we want for the
            # demo — the trace shouldn't lie about what happened).
            self._window.pop(0)
            self._projection_dirty = True

        # If this is the second member of a previously-unannounced cluster,
        # emit the fusion trace + semantic-cluster anomaly.
        members = [e for e in self._window if e.cluster_id == cluster_id]
        if (
            len(members) >= 2
            and cluster_id not in self._announced_clusters
        ):
            self._announced_clusters.add(cluster_id)
            await self._announce_cluster(cluster_id, members, best_similarity)

        await self._publish_snapshot()

    def _assign_cluster(self, embedding: np.ndarray) -> tuple[int, float]:
        """Find the closest existing cluster head; otherwise seed a new one.

        Returns ``(cluster_id, similarity_to_best_match)``. For a new
        cluster the similarity is reported as 1.0 (self-similarity).
        """
        if not self._window:
            cluster_id = self._next_cluster_id
            self._next_cluster_id += 1
            return cluster_id, 1.0

        # Compare against every existing entry; pick the highest-similarity
        # match across all of them. Cluster heads aren't tracked separately
        # — any member counts. This is robust to chained additions.
        best_idx = -1
        best_sim = -1.0
        for idx, entry in enumerate(self._window):
            sim = float(np.dot(embedding, entry.embedding))
            if sim > best_sim:
                best_sim = sim
                best_idx = idx

        if best_sim >= self._similarity_threshold and best_idx >= 0:
            return self._window[best_idx].cluster_id, best_sim

        cluster_id = self._next_cluster_id
        self._next_cluster_id += 1
        return cluster_id, best_sim

    async def _announce_cluster(
        self,
        cluster_id: int,
        members: list[_WindowEntry],
        similarity: float,
    ) -> None:
        signal_ids = [m.signal_id for m in members]
        # Trim the synthesized headline to keep the trace readable.
        headline = members[0].summary
        if len(headline) > 80:
            headline = headline[:77] + "…"

        if self._tracer is not None:
            await self._tracer.emit(
                "fusion",
                "info",
                f"osint cluster: {len(members)} signals about "
                f"\"{headline}\" sim={similarity:.2f}",
                ref_id=f"osint-cluster-{cluster_id}",
                cluster_id=cluster_id,
                similarity=similarity,
                member_signal_ids=signal_ids,
            )

        anomaly = Anomaly(
            id=f"anom-osint_semantic_cluster-{cluster_id}",
            ts=members[-1].ts,
            kind="osint_semantic_cluster",
            source_signal=members[-1].signal_id,
            source_signal_ids=signal_ids,
            severity=min(0.5 + 0.1 * len(members), 0.9),
            payload={
                "cluster_id": cluster_id,
                "member_count": len(members),
                "mean_similarity": similarity,
                "summary": headline,
                "model": self._model_name,
                "embedding_dim": self._encoder_dim,
                "signal_ids": signal_ids,
            },
        )
        await self._bus.publish(f"anomalies.{anomaly.kind}", anomaly)
        log.info(
            "osint_cluster: announced cluster %d with %d members (sim=%.2f)",
            cluster_id,
            len(members),
            similarity,
        )

    # ---- 2D projection + snapshot ----------------------------------------

    def _project_2d(self) -> np.ndarray:
        """PCA-project the current window to 2D for visualization.

        Uses SVD on the centered embedding matrix. With a single point we
        return a degenerate (0, 0). With two points we project along the
        single discriminating axis and return (±d, 0) so the scatter
        renders sensibly even before the window has 3+ members.
        """
        n = len(self._window)
        if n == 0:
            return np.zeros((0, 2), dtype=np.float32)
        if n == 1:
            return np.zeros((1, 2), dtype=np.float32)

        X = np.stack([entry.embedding for entry in self._window], axis=0)
        Xc = X - X.mean(axis=0, keepdims=True)
        try:
            _, _, vt = np.linalg.svd(Xc, full_matrices=False)
        except np.linalg.LinAlgError:
            log.warning("osint_cluster: SVD failed; returning zeros")
            return np.zeros((n, 2), dtype=np.float32)
        components = vt[: min(2, vt.shape[0])]
        projected = Xc @ components.T  # (n, k≤2)
        if projected.shape[1] == 1:
            zeros = np.zeros((n, 1), dtype=projected.dtype)
            projected = np.concatenate([projected, zeros], axis=1)
        return projected.astype(np.float32)

    async def _publish_snapshot(self) -> None:
        # Only re-run the SVD when the window actually changed since the
        # last projection; otherwise reuse the cached coords.
        if self._projection_dirty:
            self._coords = self._project_2d()
            self._projection_dirty = False
        coords = self._coords
        points = [
            EmbeddingPoint(
                signal_id=entry.signal_id,
                summary=entry.summary,
                cluster_id=entry.cluster_id,
                x=float(coords[i, 0]) if i < coords.shape[0] else 0.0,
                y=float(coords[i, 1]) if i < coords.shape[0] else 0.0,
                ts=entry.ts,
            )
            for i, entry in enumerate(self._window)
        ]
        snapshot = OsintEmbeddingSnapshot(
            points=points,
            cluster_count=self._next_cluster_id,
            similarity_threshold=self._similarity_threshold,
            model_name=self._model_name,
            embedding_dim=self._encoder_dim,
        )
        await self._bus.publish("embeddings.osint", snapshot)
