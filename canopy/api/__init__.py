"""FastAPI gateway exposing the in-process CANOPY engine to browser clients.

Endpoints:

* ``GET  /health``                     — liveness (never needs a token)
* ``GET  /scenarios``                  — list checked-in scenario JSONL filenames
* ``POST /scenarios/{name}/replay``    — start a ScenarioReplayService for that beat
                                         (``speed``, ``max_delay_s`` query parameters)
* ``POST /reset``                      — cancel a running replay and clear every
                                         service's in-process state between runs
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
from pathlib import Path
from types import EllipsisType
from typing import Any, get_args

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from canopy._engine import (
    Engine,
    build_engine,
    resolve_bus_backend,
    resolve_provider,
    start_engine_tasks,
)
from canopy.api.schemas import SCHEMA_MODES, event_schema, event_schemas
from canopy.services.bus import codec
from canopy.services.scenario_replay import ScenarioReplayService
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
    cleared: dict[str, dict[str, int]] = {"attrib": await engine.attrib.reset()}
    await _drain_bounded(engine, RESET_DRAIN_TIMEOUT_S)
    cleared["fusion"] = engine.fusion.reset()
    cleared["decide"] = engine.decide.reset()
    cleared["ui_events"] = engine.ui_events.reset()
    await _drain_bounded(engine, RESET_DRAIN_TIMEOUT_S)
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
    engine = build_engine(
        provider=provider,
        blocked_domains_provider=lambda: app.state.blocked_domains,
        enable_osint=not bool(os.environ.get("CANOPY_DISABLE_OSINT")),
        bus_backend=bus_backend,
        nats_url=os.environ.get("CANOPY_NATS_URL"),
    )
    app.state.engine = engine
    app.state.clients = set()
    app.state.replay_task = None
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
        # Iterate over a snapshot — clients can disconnect mid-fanout.
        for ws in list(clients):
            try:
                await ws.send_json(envelope)
            except Exception:
                clients.discard(ws)


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
    ) -> dict[str, Any]:
        """Start replaying a demo scenario; a running replay is cancelled first.

        ``speed`` scales the scenario's own timestamps; ``max_delay_s`` caps any
        single inter-signal pause, so ``speed=20&max_delay_s=6`` paces a run
        with long lulls to roughly a minute on screen.
        """
        try:
            case = SCENARIO_REGISTRY.by_file(name)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"scenario not found: {name}")
        if "demo" not in case.visibility:
            raise HTTPException(status_code=404, detail=f"scenario not found: {name}")
        path = case.scenario_path

        async with _control_lock(app):
            await cancel_replay(app.state.replay_task)
            # Same input discipline as the bench: oracle records (the scenario's
            # own answer key) never reach the bus, and redacted observables are
            # stripped, so the console shows what an operator would see.
            replay = ScenarioReplayService(
                app.state.engine.bus,
                path,
                speed=speed,
                max_delay_s=max_delay_s,
                signal_filter=case.includes_as_input,
                signal_transform=case.sanitize_input,
            )
            app.state.replay_task = asyncio.create_task(
                replay.run(), name=f"replay-{name}"
            )
        return {
            "status": "replaying",
            "scenario": name,
            "speed": speed,
            "max_delay_s": max_delay_s,
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
            app.state.replay_task = None
            cleared = await reset_engine(app.state.engine)
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
        invalid = [d for d in raw if d not in _ALLOWED_DOMAINS]
        if invalid:
            raise HTTPException(
                status_code=400, detail=f"unknown domains: {invalid}"
            )
        app.state.blocked_domains = set(raw)
        return {"blocked_domains": sorted(app.state.blocked_domains)}

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

    return app


app = create_app()
