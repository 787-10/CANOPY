"""``/archive`` (docs/C2-API.md §8): retrieval over immutable demo run bundles.

Most tests mount the router on a bare FastAPI app over ``tmp_path`` bundles
(no engine boot). The lifespan wiring, the bearer middleware and the default
directory are checked on the real gateway, once each, and one test reads the
checked-in bundles under ``docs/demo/runs`` (skipped when none are there).
"""
from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from canopy.api import archive as arch
from canopy.api.archive import (
    ARCHIVE_ENV,
    DEFAULT_ARCHIVE_DIR,
    ArchiveReader,
    filter_entries,
    resolve_archive_dir,
    router,
)

SIM01 = "ctb://megalith.demo/sim-01"
SIM02 = "ctb://megalith.demo/sim-02"
T0 = datetime(2026, 9, 18, 22, 0, tzinfo=UTC)


@pytest.fixture(scope="module", autouse=True)
def _no_osint():
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("CANOPY_DISABLE_OSINT", "1")
    yield
    monkeypatch.undo()


# ---- Bundle factory -----------------------------------------------------------------------------


def write_bundle(
    root: Path,
    run_id: str,
    *,
    run: str = "A",
    satellite_id: str = SIM01,
    created_at: datetime = T0,
    verdict: str | None = "internal_fault",
    expected: str = "internal_fault",
    provider: str = "ollama",
    model: str = "demo-model",
    decision: str = "recovery_recommendation",
    with_scorecard: bool = True,
    scorecard_verdict: str | None = None,
) -> Path:
    bundle = root / run_id
    (bundle / "inputs").mkdir(parents=True)
    (bundle / "outputs").mkdir()
    final: dict = {"actor": "None", "confidence": 0.8}
    if verdict is not None:
        final["verdict"] = verdict
    run_json = {
        "run_id": run_id,
        "run": run,
        "scenario_id": f"demo-{run.lower()}",
        "scenario_file": f"megalith_{run.lower()}.jsonl",
        "satellite_id": satellite_id,
        "created_at": created_at.isoformat(),
        "provider": provider,
        "model": model,
        "commits": {"megalith": {"sha": "0" * 40, "short": "0000000", "dirty": False}},
        "bench": {"kb_path": "data/kb_megalith_demo.json"},
        "summary": {
            "final": final,
            "expected": {"verdict": expected},
            "decision": {"action": decision, "authority": "local"},
            "scored": {"verdict_correct": verdict == expected},
        },
    }
    (bundle / "run.json").write_text(json.dumps(run_json, indent=2), encoding="utf-8")
    if with_scorecard:
        row = {
            "predicted_verdict": scorecard_verdict if scorecard_verdict is not None else verdict,
            "expected_verdict": expected,
            "verdict_correct": (scorecard_verdict or verdict) == expected,
            "latency_seconds": 12.5,
            "gate_blocked": False,
        }
        (bundle / "scorecard_row.json").write_text(json.dumps(row), encoding="utf-8")
    (bundle / "timings.json").write_text(json.dumps({"elapsed_s": 12.5}), encoding="utf-8")
    (bundle / "SUMMARY.md").write_text(f"# {run_id}\n", encoding="utf-8")
    (bundle / "inputs" / "case.json").write_text("{}", encoding="utf-8")
    (bundle / "outputs" / "decisions.jsonl").write_text('{"action": "%s"}\n' % decision, encoding="utf-8")
    (bundle / "outputs" / "notes.txt").write_text("plain\n", encoding="utf-8")
    for path in bundle.rglob("*"):
        if path.is_file():
            path.chmod(0o444)
    return bundle


@pytest.fixture
def archive_root(tmp_path: Path) -> Path:
    root = tmp_path / "runs"
    root.mkdir()
    write_bundle(root, "20260918T220000Z-run-a-ollama", run="A", created_at=T0)
    write_bundle(
        root,
        "20260918T221000Z-run-b-ollama",
        run="B",
        created_at=T0 + timedelta(minutes=10),
        verdict="hostile_external",
        expected="hostile_external",
        decision="passive_defense",
    )
    write_bundle(
        root,
        "20260918T222000Z-run-c-ollama",
        run="C",
        satellite_id=SIM02,
        created_at=T0 + timedelta(minutes=20),
        verdict="natural_external",
        expected="natural_external",
    )
    write_bundle(
        root,
        "20260918T223000Z-run-b-anthropic",
        run="B",
        created_at=T0 + timedelta(minutes=30),
        verdict="unknown",
        expected="hostile_external",
        provider="anthropic",
        model="demo-hosted",
        decision="threat_warning",
    )
    # Not a bundle: no run.json. Ignored, never a 500.
    (root / "notes").mkdir()
    (root / "README.md").write_text("bundles live here\n", encoding="utf-8")
    return root


def light_app(root: Path | None) -> FastAPI:
    app = FastAPI()
    app.state.archive = ArchiveReader(root)
    app.include_router(router)
    return app


@pytest.fixture
def client(archive_root: Path) -> TestClient:
    return TestClient(light_app(archive_root))


# ---- Listing ----------------------------------------------------------------------------------------


def test_list_is_newest_first_with_the_documented_row_shape(client: TestClient) -> None:
    response = client.get("/archive")
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 4
    ids = [row["run_id"] for row in body["runs"]]
    assert ids == [
        "20260918T223000Z-run-b-anthropic",
        "20260918T222000Z-run-c-ollama",
        "20260918T221000Z-run-b-ollama",
        "20260918T220000Z-run-a-ollama",
    ]
    newest = body["runs"][0]
    assert set(newest) == {
        "run_id", "run", "scenario_id", "satellite_id", "created_at", "provider", "model",
        "verdict", "expected_verdict", "verdict_correct", "decision", "links",
    }
    assert newest["run"] == "B"
    assert newest["provider"] == "anthropic"
    assert newest["model"] == "demo-hosted"
    assert newest["verdict"] == "unknown"
    assert newest["expected_verdict"] == "hostile_external"
    assert newest["verdict_correct"] is False
    assert newest["decision"] == "threat_warning"
    assert newest["links"] == {
        "detail": "/archive/20260918T223000Z-run-b-anthropic",
        "files": "/archive/20260918T223000Z-run-b-anthropic/files/",
    }
    assert datetime.fromisoformat(newest["created_at"]) == T0 + timedelta(minutes=30)
    oldest = body["runs"][-1]
    assert oldest["verdict_correct"] is True and oldest["decision"] == "recovery_recommendation"


def test_filter_by_satellite_id_is_exact(client: TestClient) -> None:
    body = client.get("/archive", params={"satellite_id": SIM02}).json()
    assert body["count"] == 1
    assert body["runs"][0]["run"] == "C"
    assert client.get("/archive", params={"satellite_id": SIM01}).json()["count"] == 3
    assert client.get("/archive", params={"satellite_id": "ctb://megalith.demo/sim"}).json()["count"] == 0


def test_filter_by_time_window_is_inclusive_and_naive_means_utc(client: TestClient) -> None:
    lower = (T0 + timedelta(minutes=10)).isoformat()
    upper = (T0 + timedelta(minutes=20)).isoformat()
    body = client.get("/archive", params={"from": lower, "to": upper}).json()
    assert [row["run"] for row in body["runs"]] == ["C", "B"]
    # Naive timestamps are read as UTC: the same window without the offset.
    naive = client.get(
        "/archive", params={"from": lower.replace("+00:00", ""), "to": upper.replace("+00:00", "")}
    ).json()
    assert [row["run_id"] for row in naive["runs"]] == [row["run_id"] for row in body["runs"]]
    # Open-ended on either side.
    assert client.get("/archive", params={"from": upper}).json()["count"] == 2
    assert client.get("/archive", params={"to": lower}).json()["count"] == 2
    # Garbage is a validation error, not a 500.
    assert client.get("/archive", params={"from": "yesterday"}).status_code == 422


def test_filter_by_verdict_is_exact(client: TestClient) -> None:
    body = client.get("/archive", params={"verdict": "hostile_external"}).json()
    assert body["count"] == 1 and body["runs"][0]["run_id"] == "20260918T221000Z-run-b-ollama"
    assert client.get("/archive", params={"verdict": "hostile"}).json()["count"] == 0
    assert client.get("/archive", params={"verdict": "unknown"}).json()["count"] == 1


def test_filters_combine_and_limit_caps_after_ordering(client: TestClient) -> None:
    body = client.get("/archive", params={"satellite_id": SIM01, "limit": 2}).json()
    assert body["count"] == 2
    assert [row["run"] for row in body["runs"]] == ["B", "B"]
    assert body["runs"][0]["provider"] == "anthropic"
    assert client.get("/archive", params={"limit": 0}).status_code == 422
    assert client.get("/archive", params={"limit": 10_000}).status_code == 422
    combined = client.get(
        "/archive", params={"satellite_id": SIM01, "verdict": "internal_fault", "to": T0.isoformat()}
    ).json()
    assert combined["count"] == 1 and combined["runs"][0]["run"] == "A"


def test_verdict_falls_back_to_the_scorecard_when_the_summary_has_none(tmp_path: Path) -> None:
    root = tmp_path / "runs"
    root.mkdir()
    write_bundle(root, "r-no-final", verdict=None, scorecard_verdict="natural_external", expected="natural_external")
    write_bundle(root, "r-no-scorecard", verdict=None, with_scorecard=False, created_at=T0 + timedelta(minutes=1))
    rows = {row["run_id"]: row for row in TestClient(light_app(root)).get("/archive").json()["runs"]}
    assert rows["r-no-final"]["verdict"] == "natural_external"
    assert rows["r-no-final"]["verdict_correct"] is True
    assert rows["r-no-scorecard"]["verdict"] is None
    # verdict_correct falls back to run.json's own scored block.
    assert rows["r-no-scorecard"]["verdict_correct"] is False


def test_index_refreshes_when_a_bundle_is_added_or_removed(archive_root: Path) -> None:
    reader = ArchiveReader(archive_root)
    assert len(reader.entries()) == 4
    write_bundle(archive_root, "20260918T224000Z-run-a-ollama", created_at=T0 + timedelta(minutes=40))
    # Adding a directory bumps the parent's mtime; on a coarse-mtime file
    # system two writes in one tick would not, so make the change visible.
    stamp = archive_root.stat().st_mtime_ns + 1_000
    os.utime(archive_root, ns=(stamp, stamp))
    entries = reader.entries()
    assert len(entries) == 5 and entries[0].run_id == "20260918T224000Z-run-a-ollama"
    for path in sorted((archive_root / "20260918T220000Z-run-a-ollama").rglob("*"), reverse=True):
        path.chmod(0o644) if path.is_file() else None
        path.unlink() if path.is_file() else path.rmdir()
    (archive_root / "20260918T220000Z-run-a-ollama").rmdir()
    os.utime(archive_root, ns=(stamp + 1_000, stamp + 1_000))
    assert {e.run_id for e in reader.entries()} == {
        "20260918T224000Z-run-a-ollama",
        "20260918T223000Z-run-b-anthropic",
        "20260918T222000Z-run-c-ollama",
        "20260918T221000Z-run-b-ollama",
    }
    # Unchanged directory: the stamp short-circuits and the index is reused.
    before = reader._entries
    reader.refresh()
    assert reader._entries is before


def test_a_bundle_without_a_readable_created_at_is_skipped_not_fatal(tmp_path: Path) -> None:
    root = tmp_path / "runs"
    root.mkdir()
    write_bundle(root, "good")
    bad = root / "bad"
    bad.mkdir()
    (bad / "run.json").write_text(json.dumps({"run_id": "bad", "created_at": "not a date"}), encoding="utf-8")
    worse = root / "worse"
    worse.mkdir()
    (worse / "run.json").write_text("{not json", encoding="utf-8")
    body = TestClient(light_app(root)).get("/archive").json()
    assert [row["run_id"] for row in body["runs"]] == ["good"]


# ---- Detail -------------------------------------------------------------------------------------------


def test_detail_returns_run_json_scorecard_timings_and_files(client: TestClient) -> None:
    response = client.get("/archive/20260918T221000Z-run-b-ollama")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"run_id", "run", "scorecard_row", "timings", "files"}
    assert body["run_id"] == "20260918T221000Z-run-b-ollama"
    assert body["run"]["summary"]["final"]["verdict"] == "hostile_external"
    assert body["run"]["commits"]["megalith"]["short"] == "0000000"
    assert body["scorecard_row"]["predicted_verdict"] == "hostile_external"
    assert body["timings"] == {"elapsed_s": 12.5}
    assert [f["path"] for f in body["files"]] == [
        "SUMMARY.md",
        "run.json",
        "scorecard_row.json",
        "timings.json",
        "inputs/case.json",
        "outputs/decisions.jsonl",
        "outputs/notes.txt",
    ]
    decisions = next(f for f in body["files"] if f["path"] == "outputs/decisions.jsonl")
    assert decisions["href"] == "/archive/20260918T221000Z-run-b-ollama/files/outputs/decisions.jsonl"
    assert decisions["bytes"] == len('{"action": "passive_defense"}\n')


def test_detail_404_for_unknown_ids_and_ids_that_are_not_directory_names(client: TestClient) -> None:
    assert client.get("/archive/nope").status_code == 404
    assert client.get("/archive/nope").json() == {"detail": "unknown run: nope"}
    assert client.get("/archive/..").status_code == 404
    assert client.get("/archive/notes").status_code == 404  # a directory without run.json
    assert client.get("/archive/README.md").status_code == 404  # a file, not a bundle


# ---- Files ---------------------------------------------------------------------------------------------


def test_files_are_served_with_media_types(client: TestClient) -> None:
    run = client.get("/archive/20260918T220000Z-run-a-ollama/files/run.json")
    assert run.status_code == 200
    assert run.headers["content-type"] == "application/json"
    assert run.json()["run_id"] == "20260918T220000Z-run-a-ollama"
    assert run.headers.get("content-disposition", "").startswith("inline")
    decisions = client.get("/archive/20260918T220000Z-run-a-ollama/files/outputs/decisions.jsonl")
    assert decisions.status_code == 200
    assert decisions.headers["content-type"] == "application/x-ndjson"
    assert decisions.text == '{"action": "recovery_recommendation"}\n'
    summary = client.get("/archive/20260918T220000Z-run-a-ollama/files/SUMMARY.md")
    assert summary.headers["content-type"].startswith("text/markdown")
    assert summary.text.startswith("# 20260918T220000Z-run-a-ollama")
    plain = client.get("/archive/20260918T220000Z-run-a-ollama/files/outputs/notes.txt")
    assert plain.status_code == 200 and plain.headers["content-type"] == "application/octet-stream"
    inputs = client.get("/archive/20260918T220000Z-run-a-ollama/files/inputs/case.json")
    assert inputs.status_code == 200 and inputs.json() == {}


@pytest.mark.parametrize(
    "path",
    [
        "missing.json",  # whitelisted shape, no such file
        "outputs/missing.jsonl",
        "other.json",  # not whitelisted
        "inputs",  # a directory
        "outputs/",
        "outputs/sub/deeper.json",  # too deep
        "logs/anything.txt",  # directory not whitelisted
        "../20260918T221000Z-run-b-ollama/run.json",  # sibling bundle
        "../../secret.txt",  # outside the archive
        "..%2F..%2Fsecret.txt",
        "%2e%2e/%2e%2e/secret.txt",
        "outputs/..%2F..%2F..%2Fsecret.txt",
        "/etc/hosts",
        "%2Fetc%2Fhosts",
        "outputs/%00.json",
    ],
)
def test_unknown_and_traversal_paths_are_404(client: TestClient, archive_root: Path, path: str) -> None:
    (archive_root.parent / "secret.txt").write_text("nope\n", encoding="utf-8")
    response = client.get(f"/archive/20260918T220000Z-run-a-ollama/files/{path}")
    assert response.status_code == 404, (path, response.status_code, response.text[:200])
    assert "nope" not in response.text


def test_files_for_an_unknown_run_are_404_before_any_path_check(client: TestClient) -> None:
    assert client.get("/archive/nope/files/run.json").status_code == 404
    assert client.get("/archive/../files/run.json").status_code == 404


def test_symlink_out_of_the_bundle_is_refused_and_not_listed(archive_root: Path) -> None:
    secret = archive_root.parent / "secret.txt"
    secret.write_text("nope\n", encoding="utf-8")
    bundle = archive_root / "20260918T220000Z-run-a-ollama"
    (bundle / "outputs" / "escape.jsonl").symlink_to(secret)
    (bundle / "outputs" / "inside.jsonl").symlink_to(bundle / "outputs" / "decisions.jsonl")
    client = TestClient(light_app(archive_root))
    assert client.get("/archive/20260918T220000Z-run-a-ollama/files/outputs/escape.jsonl").status_code == 404
    # A symlink that stays inside the bundle is fine.
    inside = client.get("/archive/20260918T220000Z-run-a-ollama/files/outputs/inside.jsonl")
    assert inside.status_code == 200
    files = [f["path"] for f in client.get("/archive/20260918T220000Z-run-a-ollama").json()["files"]]
    assert "outputs/escape.jsonl" not in files
    assert "outputs/inside.jsonl" in files


def test_reader_file_path_guard_directly(archive_root: Path) -> None:
    reader = ArchiveReader(archive_root)
    entry = reader.get("20260918T220000Z-run-a-ollama")
    assert entry is not None
    assert reader.file_path(entry, "run.json") == (entry.path / "run.json").resolve()
    assert reader.file_path(entry, "outputs/decisions.jsonl") is not None
    # "outputs/../run.json" is checked here, not over HTTP: the HTTP client
    # normalises dot segments before the server sees them.
    for rel in ("", ".", "..", "../x", "/run.json", "\\run.json", "outputs\\x.json", "run.json/",
                "a/b/c", "inputs/../../x", "outputs/../run.json", "outputs/../../other/run.json"):
        assert reader.file_path(entry, rel) is None, rel
    assert reader.get("../20260918T220000Z-run-a-ollama") is None
    assert reader.get("") is None


# ---- Filters as a pure function ---------------------------------------------------------------------


def test_filter_entries_pure(archive_root: Path) -> None:
    entries = ArchiveReader(archive_root).entries()
    assert [e.row.run for e in filter_entries(entries, verdict="unknown")] == ["B"]
    assert [e.row.run for e in filter_entries(entries, satellite_id=SIM01, limit=1)] == ["B"]
    window = filter_entries(entries, from_=T0, to=T0)
    assert [e.row.run for e in window] == ["A"]
    assert filter_entries(entries, from_=T0 + timedelta(hours=1)) == []


# ---- Absent directory -----------------------------------------------------------------------------------


def test_absent_directory_is_503_on_every_route(tmp_path: Path) -> None:
    for root in (None, tmp_path / "does-not-exist"):
        client = TestClient(light_app(root))
        for path in ("/archive", "/archive/x", "/archive/x/files/run.json"):
            response = client.get(path)
            assert response.status_code == 503, (root, path)
            assert response.json()["detail"].startswith("archive unavailable")
    # An existing but empty directory is an empty list, not an error.
    empty = tmp_path / "empty"
    empty.mkdir()
    assert TestClient(light_app(empty)).get("/archive").json() == {"count": 0, "runs": []}


def test_router_without_a_reader_on_app_state_is_503() -> None:
    app = FastAPI()
    app.include_router(router)
    assert TestClient(app).get("/archive").status_code == 503


def test_resolve_archive_dir_prefers_the_environment(tmp_path: Path) -> None:
    assert resolve_archive_dir({ARCHIVE_ENV: str(tmp_path)}) == tmp_path
    assert resolve_archive_dir({ARCHIVE_ENV: "  "}) == (DEFAULT_ARCHIVE_DIR if DEFAULT_ARCHIVE_DIR.is_dir() else None)
    assert resolve_archive_dir({}) == (DEFAULT_ARCHIVE_DIR if DEFAULT_ARCHIVE_DIR.is_dir() else None)
    assert DEFAULT_ARCHIVE_DIR.parts[-3:] == ("docs", "demo", "runs")
    # The default is inside the MEGALITH checkout, four levels above canopy/api.
    assert DEFAULT_ARCHIVE_DIR.parent.parent.parent == Path(arch.__file__).resolve().parents[4]


# ---- Real gateway -----------------------------------------------------------------------------------------


def test_gateway_reads_the_env_var_in_its_lifespan_and_the_token_covers_the_routes(
    archive_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from canopy.api import create_app

    monkeypatch.setenv(ARCHIVE_ENV, str(archive_root))
    token = "archive-token"
    with TestClient(create_app(api_token=token)) as client:
        assert client.get("/archive").status_code == 401
        assert client.get("/archive/20260918T220000Z-run-a-ollama").status_code == 401
        assert client.get("/archive/20260918T220000Z-run-a-ollama/files/run.json").status_code == 401
        headers = {"Authorization": f"Bearer {token}"}
        body = client.get("/archive", headers=headers).json()
        assert body["count"] == 4
        detail = client.get(body["runs"][0]["links"]["detail"], headers=headers)
        assert detail.status_code == 200
        assert detail.json()["run"]["run_id"] == body["runs"][0]["run_id"]
        for file in detail.json()["files"]:
            assert client.get(file["href"], headers=headers).status_code == 200


def test_checked_in_bundles_are_served_from_the_default_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    """The four bundles under docs/demo/runs, as the demo gateway sees them."""
    from canopy.api import create_app

    monkeypatch.delenv(ARCHIVE_ENV, raising=False)
    bundles = sorted(p for p in DEFAULT_ARCHIVE_DIR.iterdir() if p.is_dir()) if DEFAULT_ARCHIVE_DIR.is_dir() else []
    if not bundles:
        pytest.skip("no bundles checked in (they are regenerated after the code commit)")
    with TestClient(create_app(api_token=None)) as client:
        body = client.get("/archive").json()
        assert body["count"] == len(bundles)
        stamps = [row["created_at"] for row in body["runs"]]
        assert stamps == sorted(stamps, reverse=True)
        for row in body["runs"]:
            assert row["satellite_id"] == SIM01
            assert row["run"] in {"A", "B", "C"}
            assert row["verdict"] in {"internal_fault", "hostile_external", "natural_external", "unknown"}
            assert row["expected_verdict"] in {"internal_fault", "hostile_external", "natural_external"}
            assert row["provider"] in {"ollama", "anthropic"}
            assert row["decision"]
            detail = client.get(row["links"]["detail"])
            assert detail.status_code == 200
            paths = {f["path"] for f in detail.json()["files"]}
            assert {"run.json", "scorecard_row.json", "timings.json", "SUMMARY.md", "inputs/case.json"} <= paths
            assert any(p.startswith("outputs/") for p in paths)
            served = client.get(f"/archive/{row['run_id']}/files/run.json")
            assert served.status_code == 200
            assert served.json() == json.loads((DEFAULT_ARCHIVE_DIR / row["run_id"] / "run.json").read_text())
        assert client.get("/archive", params={"satellite_id": SIM01}).json()["count"] == len(bundles)
        assert client.get("/archive", params={"satellite_id": SIM02}).json()["count"] == 0
