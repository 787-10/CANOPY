"""Archive routes: retrieval over the immutable demo run bundles (docs/C2-API.md §8).

A bundle is one directory ``<run-id>/`` written once by ``make demo-run``
(``megalith/scenarios/demo/bundle.py``) and made read-only: ``run.json``,
``scorecard_row.json``, ``timings.json``, ``SUMMARY.md``, ``inputs/*`` and
``outputs/*``. The bundle is the retention unit. This module indexes the
``run.json`` of every bundle under one directory and serves

* ``GET /archive``                         list, newest first, filtered by
                                           satellite, time window and verdict
* ``GET /archive/{run_id}``                ``run.json`` plus the scorecard row,
                                           the timings and the file list
* ``GET /archive/{run_id}/files/{path}``   one whitelisted file

The directory comes from ``MEGALITH_ARCHIVE_DIR``; unset, the checked-in
``docs/demo/runs`` at the MEGALITH root is used when the gateway runs inside
that checkout. Without a directory every route answers ``503`` (the archive
is a feature of the deployment, not of the engine). The index is built at
first use and rebuilt whenever the directory's mtime changes, which is what a
bundle being added or removed does; bundle contents never change, so nothing
inside a bundle is watched. Nothing here writes.

The response models live here, not in ``canopy.services.schemas.events``:
they describe stored bundles, not bus events, and are not part of the codec.
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

ARCHIVE_ENV = "MEGALITH_ARCHIVE_DIR"
# canopy/api/archive.py -> api -> canopy -> external/canopy -> external -> MEGALITH
_MEGALITH_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_ARCHIVE_DIR = _MEGALITH_ROOT / "docs" / "demo" / "runs"

DEFAULT_LIMIT = 100
MAX_LIMIT = 1000

# What a bundle may serve. Top-level names exactly; one plain file name under
# each listed directory. Anything else is 404, whether or not it exists.
TOP_LEVEL_FILES: frozenset[str] = frozenset(
    {"run.json", "scorecard_row.json", "timings.json", "SUMMARY.md"}
)
FILE_DIRS: frozenset[str] = frozenset({"inputs", "outputs"})
MEDIA_TYPES: Mapping[str, str] = {
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".md": "text/markdown; charset=utf-8",
}

# A run id is one directory name: no separators, no dot-only names.
_RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_FILE_NAME = re.compile(r"[A-Za-z0-9._-]+")


# ---- Response models -----------------------------------------------------------------------


class ArchiveLinks(BaseModel):
    detail: str
    files: str


class ArchiveRun(BaseModel):
    """One row of ``GET /archive``: the headline of a bundle's ``run.json``."""

    run_id: str
    run: str | None = None
    scenario_id: str | None = None
    satellite_id: str | None = None
    created_at: datetime
    provider: str | None = None
    model: str | None = None
    verdict: str | None = Field(
        default=None,
        description="summary.final.verdict, else the scorecard's predicted_verdict",
    )
    expected_verdict: str | None = None
    verdict_correct: bool | None = None
    decision: str | None = Field(default=None, description="summary.decision.action")
    links: ArchiveLinks


class ArchiveList(BaseModel):
    count: int
    runs: list[ArchiveRun]


class ArchiveFile(BaseModel):
    path: str
    bytes: int
    href: str


class ArchiveDetail(BaseModel):
    run_id: str
    run: dict[str, Any] = Field(description="run.json verbatim")
    scorecard_row: dict[str, Any] | None
    timings: dict[str, Any] | None
    files: list[ArchiveFile]


# ---- Reader ---------------------------------------------------------------------------------


def resolve_archive_dir(env: Mapping[str, str] | None = None) -> Path | None:
    """The archive directory: ``MEGALITH_ARCHIVE_DIR``, else the checked-in
    ``docs/demo/runs`` when this checkout has one, else None."""
    source = os.environ if env is None else env
    configured = (source.get(ARCHIVE_ENV) or "").strip()
    if configured:
        return Path(configured)
    if DEFAULT_ARCHIVE_DIR.is_dir():
        return DEFAULT_ARCHIVE_DIR
    return None


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("archive: cannot read %s: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def _get(mapping: Mapping[str, Any] | None, *keys: str) -> Any:
    current: Any = mapping
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def links_for(run_id: str) -> ArchiveLinks:
    return ArchiveLinks(detail=f"/archive/{run_id}", files=f"/archive/{run_id}/files/")


@dataclass(frozen=True)
class ArchiveEntry:
    run_id: str
    path: Path
    run: dict[str, Any]
    scorecard_row: dict[str, Any] | None
    timings: dict[str, Any] | None
    row: ArchiveRun


def _entry(bundle: Path) -> ArchiveEntry | None:
    run = _read_json(bundle / "run.json")
    if run is None:
        return None
    raw_created = run.get("created_at")
    try:
        created_at = _as_utc(datetime.fromisoformat(str(raw_created)))
    except (TypeError, ValueError):
        log.warning("archive: %s has no usable created_at (%r); skipped", bundle.name, raw_created)
        return None
    scorecard = _read_json(bundle / "scorecard_row.json") if (bundle / "scorecard_row.json").is_file() else None
    timings = _read_json(bundle / "timings.json") if (bundle / "timings.json").is_file() else None
    # The directory name is what a client addresses; run.json's own run_id
    # is the same string for every bundle the writer produces.
    run_id = bundle.name
    verdict_correct = _get(scorecard, "verdict_correct")
    if verdict_correct is None:
        verdict_correct = _get(run, "summary", "scored", "verdict_correct")
    row = ArchiveRun(
        run_id=run_id,
        run=_get(run, "run"),
        scenario_id=_get(run, "scenario_id"),
        satellite_id=_get(run, "satellite_id"),
        created_at=created_at,
        provider=_get(run, "provider"),
        model=_get(run, "model"),
        verdict=_get(run, "summary", "final", "verdict") or _get(scorecard, "predicted_verdict"),
        expected_verdict=_get(run, "summary", "expected", "verdict") or _get(scorecard, "expected_verdict"),
        verdict_correct=verdict_correct,
        decision=_get(run, "summary", "decision", "action"),
        links=links_for(run_id),
    )
    return ArchiveEntry(run_id=run_id, path=bundle, run=run, scorecard_row=scorecard, timings=timings, row=row)


class ArchiveReader:
    """Index of the bundles under ``root``; ``None`` when no archive is configured."""

    def __init__(self, root: Path | None) -> None:
        self.root = root
        self._stamp: int | None = None
        self._entries: dict[str, ArchiveEntry] = {}

    # -- availability --------------------------------------------------------------------

    @property
    def available(self) -> bool:
        return self.root is not None and self.root.is_dir()

    def require(self) -> None:
        if self.root is None:
            raise HTTPException(
                status_code=503,
                detail=f"archive unavailable: {ARCHIVE_ENV} is not set and no default archive directory exists",
            )
        if not self.root.is_dir():
            raise HTTPException(
                status_code=503, detail=f"archive unavailable: directory does not exist: {self.root}"
            )

    # -- index -----------------------------------------------------------------------------

    def refresh(self, *, force: bool = False) -> None:
        """Rebuild the index when the directory changed (one ``stat``)."""
        if self.root is None or not self.root.is_dir():
            self._stamp = None
            self._entries = {}
            return
        stamp = self.root.stat().st_mtime_ns
        if not force and stamp == self._stamp:
            return
        entries: dict[str, ArchiveEntry] = {}
        for child in sorted(self.root.iterdir()):
            if not child.is_dir() or not _RUN_ID.fullmatch(child.name):
                continue
            if not (child / "run.json").is_file():
                continue
            entry = _entry(child)
            if entry is not None:
                entries[entry.run_id] = entry
        self._entries = entries
        self._stamp = stamp
        log.info("archive: indexed %d bundle(s) under %s", len(entries), self.root)

    def entries(self) -> list[ArchiveEntry]:
        """Every bundle, newest ``created_at`` first (run id breaks ties, descending)."""
        self.refresh()
        return sorted(
            self._entries.values(), key=lambda e: (e.row.created_at, e.run_id), reverse=True
        )

    def get(self, run_id: str) -> ArchiveEntry | None:
        if not _RUN_ID.fullmatch(run_id):
            return None
        self.refresh()
        return self._entries.get(run_id)

    # -- files ------------------------------------------------------------------------------

    def files(self, entry: ArchiveEntry) -> list[ArchiveFile]:
        """The whitelisted files present in the bundle, sorted by path."""
        out: list[ArchiveFile] = []
        for name in sorted(TOP_LEVEL_FILES):
            path = entry.path / name
            if path.is_file():
                out.append(self._file_row(entry, name, path))
        for directory in sorted(FILE_DIRS):
            folder = entry.path / directory
            if not folder.is_dir():
                continue
            for path in sorted(folder.iterdir()):
                rel = f"{directory}/{path.name}"
                if self.file_path(entry, rel) is not None:
                    out.append(self._file_row(entry, rel, path))
        return out

    @staticmethod
    def _file_row(entry: ArchiveEntry, rel: str, path: Path) -> ArchiveFile:
        return ArchiveFile(path=rel, bytes=path.stat().st_size, href=f"/archive/{entry.run_id}/files/{rel}")

    @staticmethod
    def file_path(entry: ArchiveEntry, rel: str) -> Path | None:
        """The on-disk file for ``rel`` inside the bundle, or None.

        ``rel`` must be one of the top-level names or ``<inputs|outputs>/<name>``
        with a plain file name; and the resolved path (symlinks followed) must
        stay inside the resolved bundle directory. Both checks are needed: the
        first keeps the surface to the documented files, the second stops a
        symlink planted in a bundle from reaching out.
        """
        if not rel or rel.startswith(("/", "\\")) or rel.endswith("/") or "\\" in rel:
            return None
        parts = PurePosixPath(rel).parts
        if len(parts) == 1:
            if parts[0] not in TOP_LEVEL_FILES:
                return None
        elif len(parts) == 2:
            if parts[0] not in FILE_DIRS or not _FILE_NAME.fullmatch(parts[1]):
                return None
        else:
            return None
        bundle = entry.path.resolve()
        candidate = (entry.path / Path(*parts)).resolve()
        if candidate == bundle or not candidate.is_relative_to(bundle):
            return None
        if not candidate.is_file():
            return None
        return candidate


# ---- Filters --------------------------------------------------------------------------------


def filter_entries(
    entries: list[ArchiveEntry],
    *,
    satellite_id: str | None = None,
    from_: datetime | None = None,
    to: datetime | None = None,
    verdict: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> list[ArchiveEntry]:
    """Exact ``satellite_id`` and ``verdict``; inclusive ``created_at`` window."""
    lower = _as_utc(from_) if from_ is not None else None
    upper = _as_utc(to) if to is not None else None
    out: list[ArchiveEntry] = []
    for entry in entries:
        row = entry.row
        if satellite_id is not None and row.satellite_id != satellite_id:
            continue
        if verdict is not None and row.verdict != verdict:
            continue
        if lower is not None and row.created_at < lower:
            continue
        if upper is not None and row.created_at > upper:
            continue
        out.append(entry)
        if len(out) >= limit:
            break
    return out


# ---- Router ---------------------------------------------------------------------------------

router = APIRouter(prefix="/archive", tags=["archive"])


def _reader(request: Request) -> ArchiveReader:
    reader = getattr(request.app.state, "archive", None)
    if reader is None:
        reader = ArchiveReader(None)
    reader.require()
    return reader


@router.get("", response_model=ArchiveList)
async def list_archive(
    request: Request,
    satellite_id: str | None = Query(None, description="exact match on run.json satellite_id"),
    from_: datetime | None = Query(None, alias="from", description="ISO-8601; created_at >= from (naive = UTC)"),
    to: datetime | None = Query(None, description="ISO-8601; created_at <= to (naive = UTC)"),
    verdict: str | None = Query(None, description="exact match on the final verdict"),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> ArchiveList:
    reader = _reader(request)
    selected = filter_entries(
        reader.entries(), satellite_id=satellite_id, from_=from_, to=to, verdict=verdict, limit=limit
    )
    return ArchiveList(count=len(selected), runs=[entry.row for entry in selected])


def _entry_or_404(reader: ArchiveReader, run_id: str) -> ArchiveEntry:
    entry = reader.get(run_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"unknown run: {run_id}")
    return entry


@router.get("/{run_id}", response_model=ArchiveDetail)
async def get_archive_run(request: Request, run_id: str) -> ArchiveDetail:
    reader = _reader(request)
    entry = _entry_or_404(reader, run_id)
    return ArchiveDetail(
        run_id=entry.run_id,
        run=entry.run,
        scorecard_row=entry.scorecard_row,
        timings=entry.timings,
        files=reader.files(entry),
    )


@router.get("/{run_id}/files/{path:path}")
async def get_archive_file(request: Request, run_id: str, path: str) -> FileResponse:
    reader = _reader(request)
    entry = _entry_or_404(reader, run_id)
    target = reader.file_path(entry, path)
    if target is None:
        raise HTTPException(status_code=404, detail=f"no such file in run {run_id}: {path}")
    return FileResponse(
        target,
        media_type=MEDIA_TYPES.get(target.suffix, "application/octet-stream"),
        filename=target.name,
        content_disposition_type="inline",
    )
