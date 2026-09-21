"""FastAPI gateway exposing the in-process CANOPY engine to browser clients.

Endpoints:

* ``GET  /health``                     — liveness (never needs a token)
* ``GET  /scenarios``                  — list checked-in scenario JSONL filenames
* ``POST /scenarios/{name}/replay``    — start a ScenarioReplayService for that beat
                                         (``speed``, ``max_delay_s`` query parameters)
* ``POST /reset``                      — cancel a running replay and clear every
                                         service's in-process state between runs Every connected WebSocket then receives a ``reset`` control envelope
  (``{"kind": "reset", "topic": "control.reset", ...}``) so consoles clear their state.
  A run's timeline is announced the same way: a ``replay`` control envelope
  (``started`` before the first signal, ``finished`` or ``cancelled`` after,
  and a snapshot to every new connection) is the authority for the console's
  flight clock (docs/INTERFACE-SPEC.md §2 and §10, 1.4.3).
* ``POST /signals``                    — accept a Signal and publish to the bus
* ``GET  /schemas``                    — JSON Schema of every event kind, from the
                                         pydantic models (``canopy.api.schemas``)
* ``GET  /schemas/{kind}``             — one kind's schema
* ``WS   /ws``                         — fan out every bus event as a JSON envelope:
                                         ``{topic, kind, data}`` (the spec §10
                                         envelope from ``canopy.services.bus.codec``)

The app boots an engine in its lifespan; every connected WebSocket gets the
same firehose. Brigade vs Operator filtering is the client's job. The bus
backend follows ``CANOPY_BUS`` (``memory``, the default, or ``nats`` with
``CANOPY_NATS_URL``), mirroring the CLI's ``--bus`` / ``--nats-url``.

Access control is opt-in so local demos keep working (docs/C2-API.md):

* ``CANOPY_API_TOKEN``: when set, every REST route except ``GET /health``
  requires ``Authorization: Bearer <token>`` and the WebSocket requires
  ``?token=<token>`` (or the same header). When unset the gateway is open and
  logs one warning at startup.
* ``CANOPY_CORS_ORIGINS``: comma-separated allow-list, replacing the default
  Vite dev-server origins (``http://localhost:5173``, ``http://127.0.0.1:5173``).
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
from collections.abc import Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import EllipsisType
from typing import Any, get_args

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from canopy._engine import (
    Engine,
    DEFAULT_KB_PATH,
    build_engine,
    resolve_bus_backend,
    resolve_provider,
    start_engine_tasks,
)
from canopy.api import archive
from canopy.api.schemas import SCHEMA_MODES, event_schema, event_schemas
from canopy.services.bus import codec
from canopy.services.scenario_replay import ScenarioReplayService, load_scenario_signals
from canopy.services.schemas.events import Domain, Signal
from bench.specs import load_scenario_registry

log = logging.getLogger(__name__)

TOKEN_ENV = "CANOPY_API_TOKEN"
CORS_ENV = "CANOPY_CORS_ORIGINS"
DEFAULT_CORS_ORIGINS: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
# REST paths served without a token even when one is configured.
OPEN_PATHS: frozenset[str] = frozenset({"/health"})
# WebSocket close code for a rejected handshake (RFC 6455 policy violation).
WS_POLICY_VIOLATION = 1008
# Replay pacing defaults (``POST /scenarios/{name}/replay``).
DEFAULT_REPLAY_SPEED = 5.0
DEFAULT_REPLAY_MAX_DELAY_S = 0.5

ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = ROOT / "scenarios"
SCENARIO_REGISTRY = load_scenario_registry()

# Domains that POST /stress may block. Derived from the ``Domain`` literal so
# the gateway cannot drift from the schema vocabulary again (a hand-typed copy
# here once lagged the literal by two domains).
_ALLOWED_DOMAINS: frozenset[str] = frozenset(get_args(Domain))

# Topic patterns we forward to clients. The ``kind`` tag in the envelope
# comes from the event's class through the bus codec registry, so the
# WebSocket and the NATS backend can never disagree about a tag.
_FANOUT_PATTERNS: tuple[str, ...] = (
    "signals.*",
    "anomalies.*",
    "attributions.*",
    "decisions.*",
    "ui_events.*",
    "traces.*",
    "embeddings.*",
)


def resolve_api_token(env: Mapping[str, str] | None = None) -> str | None:
    """The bearer token from ``CANOPY_API_TOKEN``, or None when unset or blank."""
    source = os.environ if env is None else env
    token = (source.get(TOKEN_ENV) or "").strip()
    return token or None


def resolve_cors_origins(env: Mapping[str, str] | None = None) -> list[str]:
    """The CORS allow-list from ``CANOPY_CORS_ORIGINS``; the Vite origins when unset."""
    source = os.environ if env is None else env
    raw = source.get(CORS_ENV)
    if raw is None:
        return list(DEFAULT_CORS_ORIGINS)
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or list(DEFAULT_CORS_ORIGINS)


def _bearer_token(authorization: str | None) -> str | None:
    """The credential in an ``Authorization: Bearer <token>`` header, or None."""
    if not authorization:
        return None
    scheme, _, credential = authorization.strip().partition(" ")
    if scheme.lower() != "bearer":
        return None
    credential = credential.strip()
    return credential or None


def _token_matches(expected: str, presented: str | None) -> bool:
    if presented is None:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), presented.encode("utf-8"))


async def cancel_replay(task: asyncio.Task | None) -> bool:
    """Cancel an in-flight replay task and wait for it; True if one was running."""
    if task is None or task.done():
        return False
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001 - a replay error is not ours
        pass
    return True


def _log_replay_outcome(task: asyncio.Task) -> None:
    """Done-callback for the replay task: log a replay that raised.

    Nothing else reads the task's outcome. The route that started it answered
    ``replaying`` long before, and ``cancel_replay`` returns early on a task
    that is already done without touching its exception, so a scenario that
    failed half-way (a record the input transform rejects, a bus error) left
    no line in the log while the console simply stopped receiving events.
    Reading the exception here also keeps asyncio from reporting it as never
    retrieved at garbage collection, minutes later.
    """
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error(
            "%s failed: %s: %s", task.get_name(), type(exc).__name__, exc, exc_info=exc
        )


def _announce_replay_done(app: FastAPI):
    """Done-callback: a run that completes announces ``finished``; one that
    raised announces ``cancelled``. A cancelled task says nothing, because the
    route or reset that cancelled it already announced. A task that is no
    longer the current one (superseded under the lock) says nothing either.
    """

    def callback(task: asyncio.Task) -> None:
        if task.cancelled() or app.state.replay_task is not task:
            return
        new_state = "finished" if task.exception() is None else "cancelled"
        asyncio.ensure_future(_announce_replay(app, new_state))

    return callback


RESET_DRAIN_TIMEOUT_S = 3.0


async def _drain_bounded(engine: Engine, timeout_s: float) -> bool:
    """Drain the bus, but never wait longer than ``timeout_s``.

    An in-flight LLM decide call can hold a queue item for a minute on a
    local model; an unbounded drain would stall ``/reset`` behind it.
    """
    try:
        await asyncio.wait_for(engine.bus.drain(), timeout_s)
    except TimeoutError:
        log.warning("engine reset: bus did not settle within %.1fs; continuing", timeout_s)
        return False
    return True


def _control_lock(app: FastAPI) -> asyncio.Lock:
    """One lock serialises /reset and /replay so neither orphans a replay task."""
    lock = getattr(app.state, "control_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app.state.control_lock = lock
    return lock


async def reset_engine(engine: Engine) -> dict[str, dict[str, int]]:
    """Clear every service's in-process state so the next run starts clean.

    The attrib stage cancels its in-flight reasoning tasks and window timer
    first, the bus is given a bounded moment to settle, and every stage forgets
    its run state
    (fusion's windows, correlates and seen signals; attrib's per-satellite
    context, buffer and clusters; decide's anomaly cache and decision ids; the
    UI-event caches). Subscriptions, the knowledge base, the LLM client and
    the blocked-domain set are untouched. Returns what each stage cleared.
    """
    # Attrib first: it is the source of new attributions (window timer and
    # fast-lane reasoning tasks). Then a bounded settle, then the rest. Decide
    # drops any LLM result that started before the reset (generation counter).
    # attrib first: it cancels the in-flight reasoning tasks, which is what a
    # slow local model would otherwise make the whole reset wait for. Fusion
    # next, so nothing new reaches attrib during the drain. attrib once more
    # at the end: anomalies fusion had already emitted before its reset are
    # consumed during the drain and would otherwise refill attrib's arrival
    # marks and context with the previous take's deterministic ids.
    cleared: dict[str, dict[str, int]] = {"attrib": await engine.attrib.reset()}
    cleared["fusion"] = engine.fusion.reset()
    await _drain_bounded(engine, RESET_DRAIN_TIMEOUT_S)
    cleared["decide"] = engine.decide.reset()
    cleared["ui_events"] = engine.ui_events.reset()
    # The shared tracer's first-wins arrival marks are keyed by anomaly id,
    # which repeats between replays of one scenario: without this a retake
    # measures latency_ms from the previous take.
    cleared["tracer"] = engine.tracer.clear_marks()
    await _drain_bounded(engine, RESET_DRAIN_TIMEOUT_S)
    late = await engine.attrib.reset()
    cleared["attrib_late"] = late
    return cleared


@asynccontextmanager
async def _lifespan(app: FastAPI):
    load_dotenv()
    provider = resolve_provider(llm_flag=None)
    bus_backend = resolve_bus_backend(bus_flag=None)
    log.info("CANOPY API starting (llm=%s bus=%s)", provider, bus_backend)
    if app.state.api_token is None:
        log.warning(
            "%s is not set: the gateway accepts unauthenticated REST and WebSocket "
            "clients. Set it before exposing the gateway beyond localhost.",
            TOKEN_ENV,
        )
    else:
        log.info(
            "bearer-token auth enabled: REST routes except GET /health and the "
            "WebSocket require the %s credential",
            TOKEN_ENV,
        )
    log.info("CORS allow-list: %s", ", ".join(app.state.cors_origins))

    app.state.blocked_domains: set[str] = set()
    # The operator's latest call per decision (accepted / denied /
    # reconsidered), posted by the console; cleared by ``POST /reset``.
    app.state.operator_decisions: dict[str, dict[str, Any]] = {}
    # CANOPY_KB_PATH selects the knowledge base; the MEGALITH demo points it at
    # the demo-only file so no entry naming a real actor can reach the model.
    kb_path = os.environ.get("CANOPY_KB_PATH") or DEFAULT_KB_PATH
    engine = build_engine(
        provider=provider,
        kb_path=kb_path,
        blocked_domains_provider=lambda: app.state.blocked_domains,
        enable_osint=not bool(os.environ.get("CANOPY_DISABLE_OSINT")),
        bus_backend=bus_backend,
        nats_url=os.environ.get("CANOPY_NATS_URL"),
    )
    app.state.engine = engine
    # MEGALITH_ARCHIVE_DIR: the demo run bundles served by /archive (archive.py).
    app.state.archive = archive.ArchiveReader(archive.resolve_archive_dir())
    app.state.clients = set()
    app.state.replay_task = None
    # The current run's timeline (the ``replay`` control envelope's data) and
    # the service publishing it; None until a replay has started or after a reset.
    app.state.replay_state = None
    app.state.replay_service = None
    app.state.control_lock = asyncio.Lock()
    app.state.engine_tasks = start_engine_tasks(engine)
    app.state.fanout_tasks = [
        asyncio.create_task(
            _fanout(engine.bus, pattern, app.state.clients),
            name=f"fanout-{pattern}",
        )
        for pattern in _FANOUT_PATTERNS
    ]

    try:
        yield
    finally:
        log.info("CANOPY API shutting down")
        replay = app.state.replay_task
        if replay is not None and not replay.done():
            replay.cancel()
        for task in (*app.state.fanout_tasks, *app.state.engine_tasks):
            task.cancel()
        await asyncio.gather(
            *(t for t in app.state.fanout_tasks),
            *(t for t in app.state.engine_tasks),
            return_exceptions=True,
        )
        await engine.bus.close()


async def _broadcast(clients: set[WebSocket], envelope: dict[str, Any]) -> None:
    """Send one envelope to every connected client; a failed send drops the client."""
    # Iterate over a snapshot — clients can disconnect mid-fanout.
    for ws in list(clients):
        try:
            await ws.send_json(envelope)
        except Exception:
            clients.discard(ws)


async def _fanout(bus, pattern: str, clients: set[WebSocket]) -> None:
    """Forward every bus event matching *pattern* to every connected client."""
    async for topic, event in bus.subscribe(pattern):
        try:
            envelope = codec.envelope(topic, event)
        except codec.CodecError:
            log.warning(
                "fanout: dropping unregistered event on %s: %r", topic, type(event)
            )
            continue
        await _broadcast(clients, envelope)


def control_envelope(kind: str, data: dict[str, Any]) -> dict[str, Any]:
    """A gateway control message in the fan-out envelope shape (spec §10, 1.4.2).

    Not a bus event: it describes this gateway's own state. ``control.*``
    topics are reserved for it. ``reset`` makes every console clear its event
    store so a run started by another client never mixes with the run before
    it; ``replay`` (1.4.3) announces a run's timeline for the flight clock.
    """
    return {"kind": kind, "topic": f"control.{kind}", "data": data}


def _iso_z(when: datetime) -> str:
    return when.astimezone(UTC).isoformat().replace("+00:00", "Z")


def replay_envelope(state: dict[str, Any], *, now_ts: datetime) -> dict[str, Any]:
    """The ``replay`` control envelope for a run's recorded timeline.

    ``now_ts`` is the scenario time at emission: the first signal's at
    ``started``, the newest published one while a run is live, the last one at
    ``finished``. A console evaluates ``now_ts + (wall − receipt) × speed``.
    """
    return control_envelope(
        "replay",
        {
            "state": state["state"],
            "scenario": state["scenario"],
            "speed": state["speed"],
            "max_delay_s": state["max_delay_s"],
            "first_ts": _iso_z(state["first_ts"]),
            "last_ts": _iso_z(state["last_ts"]),
            "now_ts": _iso_z(now_ts),
            "started_at": _iso_z(state["started_at"]),
            "ts": _iso_z(datetime.now(UTC)),
        },
    )


def _replay_now_ts(app: FastAPI) -> datetime:
    """Scenario time of the current run as far as the gateway knows it.

    Finished: the end. Started without a cap (a flight run): the timeline is
    linear, so it is ``first_ts + (now - started_at) * speed``, capped at
    ``last_ts``; a console joining between two sparse records must not start
    at the last record's time and lag the others (flight plan §2.2). With a
    cap the timeline jumps, so the last published record is where the
    stream is.
    """
    state = app.state.replay_state
    if state["state"] == "finished":
        return state["last_ts"]
    if state["state"] == "started" and state.get("max_delay_s") is None:
        elapsed_s = max(0.0, (datetime.now(UTC) - state["started_at"]).total_seconds())
        position = state["first_ts"] + timedelta(seconds=elapsed_s * float(state["speed"]))
        return min(position, state["last_ts"])
    service = app.state.replay_service
    published = getattr(service, "last_published_ts", None)
    return published or state["first_ts"]


async def _announce_replay(app: FastAPI, new_state: str) -> None:
    """Move the current run to ``new_state`` and tell every console."""
    state = app.state.replay_state
    if state is None or state["state"] != "started":
        return
    now_ts = _replay_now_ts(app)
    state["state"] = new_state
    await _broadcast(app.state.clients, replay_envelope(state, now_ts=now_ts))


def create_app(
    *,
    api_token: str | None | EllipsisType = ...,
    cors_origins: Sequence[str] | None = None,
) -> FastAPI:
    """Build the gateway.

    ``api_token`` and ``cors_origins`` default to the environment
    (``CANOPY_API_TOKEN``, ``CANOPY_CORS_ORIGINS``, read after ``.env`` is
    loaded); pass them explicitly to pin a mode regardless of the environment,
    which is what the tests do. ``api_token=None`` is the open gateway.
    """
    load_dotenv()
    app = FastAPI(title="CANOPY Engine Gateway", lifespan=_lifespan)
    app.state.api_token = resolve_api_token() if api_token is ... else api_token
    app.state.cors_origins = (
        resolve_cors_origins() if cors_origins is None else [str(o) for o in cors_origins]
    )

    @app.middleware("http")
    async def _require_bearer_token(request: Request, call_next):
        token = app.state.api_token
        if token is None or request.method == "OPTIONS" or request.url.path in OPEN_PATHS:
            return await call_next(request)
        if _token_matches(token, _bearer_token(request.headers.get("authorization"))):
            return await call_next(request)
        return JSONResponse(
            {"detail": "missing or invalid bearer token"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Added after the auth middleware so it wraps it: CORS preflights are
    # answered here and never reach the token check.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(app.state.cors_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        engine = getattr(app.state, "engine", None)
        osint = {
            "service_attached": False,
            "model_loaded": False,
            "model_name": None,
            "embedding_dim": 0,
            "window_size": 0,
            "clusters_seen": 0,
            "similarity_threshold": None,
        }
        if engine is not None and engine.osint_cluster is not None:
            cluster = engine.osint_cluster
            osint["service_attached"] = True
            osint["model_loaded"] = cluster._encoder is not None
            osint["model_name"] = cluster._model_name
            osint["embedding_dim"] = cluster._encoder_dim
            osint["window_size"] = len(cluster._window)
            osint["clusters_seen"] = cluster._next_cluster_id
            osint["similarity_threshold"] = cluster._similarity_threshold
        return {
            "status": "ok",
            "llm": engine.llm.__class__.__name__ if engine else None,
            "kb_entries": len(engine.kb) if engine else 0,
            # Which knowledge base is loaded (docs/C2-API.md §7): path as
            # configured, absolute path, SHA-256 of the file, entry counts.
            "kb": engine.kb.source.model_dump(mode="json") if engine else None,
            "clients": len(getattr(app.state, "clients", ())),
            "osint_cluster": osint,
        }

    @app.get("/scenarios")
    async def list_scenarios() -> list[str]:
        return sorted(case.file for case in SCENARIO_REGISTRY.demo_cases())

    @app.get("/scenario-registry")
    async def get_scenario_registry() -> dict[str, Any]:
        return {
            "schema_version": SCENARIO_REGISTRY.schema_version,
            "cases": [
                case.model_dump(mode="json")
                for case in SCENARIO_REGISTRY.demo_cases()
            ],
        }

    @app.get("/kb")
    async def get_kb() -> dict[str, Any]:
        """Return the loaded knowledge base entries.

        The Operator view uses this to resolve kb-* citation ids to full
        title/summary/decision-implications cards client-side without baking
        the JSON into the frontend bundle.
        """
        engine = app.state.engine
        return {
            "entries": [e.model_dump(mode="json") for e in engine.kb.all_entries()],
        }

    @app.get("/fixture/ui_events")
    async def get_fixture_ui_events() -> dict[str, Any]:
        """Serve the canned UIEvent fixture for the frontend's offline mode."""
        import json

        path = ROOT / "data" / "expected_ui_events.json"
        if not path.exists():
            raise HTTPException(status_code=404, detail="fixture missing")
        return json.loads(path.read_text(encoding="utf-8"))

    @app.post("/scenarios/{name}/replay")
    async def replay_scenario(
        name: str,
        speed: float = Query(DEFAULT_REPLAY_SPEED, gt=0.0),
        max_delay_s: float = Query(DEFAULT_REPLAY_MAX_DELAY_S, ge=0.0),
        no_cap: bool = Query(False),
    ) -> dict[str, Any]:
        """Start replaying a demo scenario; a running replay is cancelled first.

        ``speed`` scales the scenario's own timestamps; ``max_delay_s`` caps any
        single inter-signal pause, so ``speed=20&max_delay_s=6`` paces a run
        with long lulls to roughly a minute on screen. ``no_cap`` ignores the
        cap so signals land at their scenario times scaled by ``speed``, for a
        run paced by the console's flight clock (spec §2, 1.4.3). The run's
        timeline is announced as a ``replay`` control envelope before its first
        signal and again when it finishes or is cancelled.
        """
        try:
            case = SCENARIO_REGISTRY.by_file(name)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"scenario not found: {name}")
        if "demo" not in case.visibility:
            raise HTTPException(status_code=404, detail=f"scenario not found: {name}")
        path = case.scenario_path
        cap: float | None = None if no_cap else max_delay_s
        inputs = [signal for signal in load_scenario_signals(path) if case.includes_as_input(signal)]
        if not inputs:
            raise HTTPException(status_code=400, detail=f"scenario has no input signals: {name}")

        async with _control_lock(app):
            if await cancel_replay(app.state.replay_task):
                await _announce_replay(app, "cancelled")
            # Same input discipline as the bench: oracle records (the scenario's
            # own answer key) never reach the bus, and redacted observables are
            # stripped, so the console shows what an operator would see.
            replay = ScenarioReplayService(
                app.state.engine.bus,
                path,
                speed=speed,
                max_delay_s=cap,
                signal_filter=case.includes_as_input,
                signal_transform=case.sanitize_input,
            )
            app.state.replay_service = replay
            app.state.replay_state = {
                "state": "started",
                "scenario": name,
                "speed": speed,
                "max_delay_s": cap,
                "first_ts": inputs[0].ts,
                "last_ts": inputs[-1].ts,
                "started_at": datetime.now(UTC),
            }
            # Announced inside the lock and before the task exists, so on every
            # connection the timeline precedes the run's first signal.
            await _broadcast(
                app.state.clients,
                replay_envelope(app.state.replay_state, now_ts=inputs[0].ts),
            )
            task = asyncio.create_task(replay.run(), name=f"replay-{name}")
            task.add_done_callback(_log_replay_outcome)
            task.add_done_callback(_announce_replay_done(app))
            app.state.replay_task = task
        return {
            "status": "replaying",
            "scenario": name,
            "speed": speed,
            "max_delay_s": cap,
            "no_cap": no_cap,
            "first_ts": _iso_z(inputs[0].ts),
            "last_ts": _iso_z(inputs[-1].ts),
        }

    @app.post("/reset")
    async def reset() -> dict[str, Any]:
        """Cancel any replay and clear engine state so the next run starts clean.

        One gateway process replaying Run B and then Run A would otherwise
        carry B's RF anomaly on the same satellite into A's attrib context and
        decide cache (docs/C2-API.md).
        """
        async with _control_lock(app):
            cancelled = await cancel_replay(app.state.replay_task)
            if cancelled:
                await _announce_replay(app, "cancelled")
            app.state.replay_task = None
            app.state.replay_state = None
            app.state.replay_service = None
            cleared = await reset_engine(app.state.engine)
            cleared["operator"] = {"decisions": len(app.state.operator_decisions)}
            app.state.operator_decisions.clear()
            # Tell every console, inside the lock so the marker precedes any
            # event of the replay that follows on the same connection.
            await _broadcast(
                app.state.clients,
                control_envelope(
                    "reset",
                    {
                        "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                        "replay_cancelled": cancelled,
                        "cleared": cleared,
                    },
                ),
            )
        log.info("engine reset (replay_cancelled=%s): %s", cancelled, cleared)
        return {"status": "reset", "replay_cancelled": cancelled, "cleared": cleared}

    @app.post("/signals")
    async def post_signal(signal: Signal) -> dict[str, Any]:
        await app.state.engine.bus.publish(f"signals.{signal.domain}", signal)
        return {"status": "queued", "id": signal.id}

    def _schema_mode(mode: str) -> str:
        if mode not in SCHEMA_MODES:
            raise HTTPException(
                status_code=400,
                detail=f"unknown schema mode {mode!r}; expected one of {list(SCHEMA_MODES)}",
            )
        return mode

    @app.get("/schemas")
    async def list_schemas(mode: str = "serialization") -> dict[str, Any]:
        """JSON Schema of every event kind, keyed by the bus codec's kind.

        ``mode=serialization`` (default) describes what the WebSocket emits;
        ``mode=validation`` describes what a client may send.
        """
        return event_schemas(mode=_schema_mode(mode))  # type: ignore[arg-type]

    @app.get("/schemas/{kind}")
    async def get_schema(kind: str, mode: str = "serialization") -> dict[str, Any]:
        resolved = _schema_mode(mode)
        try:
            return event_schema(kind, mode=resolved)  # type: ignore[arg-type]
        except codec.CodecError:
            raise HTTPException(
                status_code=404,
                detail=f"unknown event kind {kind!r}; known: {sorted(codec.registered_kinds())}",
            )

    OPERATOR_STATUSES = ("accepted", "denied", "reconsidered")

    @app.get("/stress")
    async def get_stress() -> dict[str, Any]:
        return {"blocked_domains": sorted(app.state.blocked_domains)}

    @app.post("/stress")
    async def post_stress(payload: dict[str, Any]) -> dict[str, Any]:
        raw = payload.get("blocked_domains", [])
        if not isinstance(raw, list):
            raise HTTPException(
                status_code=400, detail="blocked_domains must be a list"
            )
        # ``isinstance`` first: an unhashable entry (an object, a list) would
        # otherwise raise inside the membership test and turn a client error
        # into a 500. docs/C2-API.md promises 400 for anything outside the
        # vocabulary.
        invalid = [d for d in raw if not isinstance(d, str) or d not in _ALLOWED_DOMAINS]
        if invalid:
            raise HTTPException(
                status_code=400, detail=f"unknown domains: {invalid}"
            )
        app.state.blocked_domains = set(raw)
        return {"blocked_domains": sorted(app.state.blocked_domains)}

    @app.get("/decisions/operator")
    async def get_operator_decisions() -> dict[str, Any]:
        """The operator's latest call on each decision this run."""
        return {"decisions": list(app.state.operator_decisions.values())}

    @app.post("/decisions/{decision_id}/operator")
    async def post_operator_decision(
        decision_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Record the operator's call on a decision and write it to the trace.

        The console's Accept, Deny and Reconsider post here. The gateway keeps
        the latest call per decision and emits a decide-stage trace line
        (``operator accepted: threat_warning → space-ops-c2``) so the call is
        part of the run's record and reaches every connected console.
        """
        status = payload.get("status")
        if status not in OPERATOR_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"status must be one of {list(OPERATOR_STATUSES)}",
            )
        attribution_id = payload.get("attribution_id")
        if attribution_id is not None and not isinstance(attribution_id, str):
            # It keys the tracer's arrival marks below; an unhashable value
            # would raise there and answer a malformed body with a 500.
            raise HTTPException(status_code=400, detail="attribution_id must be a string")
        from datetime import datetime, timezone

        scenario_ts = payload.get("scenario_ts")
        if scenario_ts is not None and not isinstance(scenario_ts, str):
            raise HTTPException(status_code=400, detail="scenario_ts must be an ISO string or null")
        action = str(payload.get("action") or "decision")
        target = payload.get("target")
        record: dict[str, Any] = {
            "decision_id": decision_id,
            "status": status,
            "action": action,
            "authority": payload.get("authority"),
            "target": target,
            "satellite_id": payload.get("satellite_id"),
            "attribution_id": attribution_id,
            "operator": "console",
            # Two clocks (spec 1.4.3, flight plan §2.7): the gateway's wall
            # time, and the scenario clock's time at the call when the console
            # had a run's clock (null otherwise).
            "ts": datetime.now(timezone.utc).isoformat(),
            "scenario_ts": scenario_ts,
        }
        app.state.operator_decisions[decision_id] = record
        arrow = f" → {target}" if target and status != "reconsidered" else ""
        message = f"operator {status}: {action}{arrow}"
        tracer = app.state.engine.tracer
        await tracer.emit(
            "decide",
            "decision" if status == "accepted" else "info",
            message,
            ref_id=decision_id,
            t0=tracer.t0_for(decision_id, attribution_id),
            **{key: value for key, value in record.items() if key != "ts"},
        )
        return {"status": "recorded", "trace": message, "record": record}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        token = app.state.api_token
        if token is not None:
            presented = websocket.query_params.get("token") or _bearer_token(
                websocket.headers.get("authorization")
            )
            if not _token_matches(token, presented):
                # Closing before accept() rejects the handshake (HTTP 403).
                await websocket.close(code=WS_POLICY_VIOLATION, reason="missing or invalid token")
                return
        await websocket.accept()
        app.state.clients.add(websocket)
        # A console joining mid-run, or reloading a page, learns the run's
        # timeline at once (spec §10, 1.4.3) instead of waiting for a signal.
        if app.state.replay_state is not None:
            try:
                await websocket.send_json(
                    replay_envelope(app.state.replay_state, now_ts=_replay_now_ts(app))
                )
            except Exception:
                app.state.clients.discard(websocket)
                return
        try:
            while True:
                # Block on receive_text so the connection stays open; the
                # client doesn't actually need to send anything.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("websocket error")
        finally:
            app.state.clients.discard(websocket)

    app.include_router(archive.router)  # GET /archive, /archive/{run_id}, .../files/{path}

    return app


app = create_app()
