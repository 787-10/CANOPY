"""FastAPI gateway exposing the in-process CANOPY engine to browser clients.

Endpoints:

* ``GET  /health``                     — liveness
* ``GET  /scenarios``                  — list checked-in scenario JSONL filenames
* ``POST /scenarios/{name}/replay``    — start a ScenarioReplayService for that beat
* ``POST /signals``                    — accept a Signal and publish to the bus
* ``WS   /ws``                         — fan out every bus event as a JSON envelope:
                                         ``{topic, kind, data}``

The app boots an in-process engine in its lifespan; every connected WebSocket
gets the same firehose. Brigade vs Operator filtering is the client's job.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from canopy._engine import build_engine, resolve_provider, start_engine_tasks
from canopy.services.scenario_replay import ScenarioReplayService
from canopy.services.schemas.events import Signal
from bench.specs import load_scenario_registry

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
SCENARIOS_DIR = ROOT / "scenarios"
SCENARIO_REGISTRY = load_scenario_registry()

# Topic patterns we forward to clients, paired with the kind tag they get
# tagged with in the WebSocket envelope.
_FANOUT_PATTERNS: tuple[tuple[str, str], ...] = (
    ("signals.*", "signal"),
    ("anomalies.*", "anomaly"),
    ("attributions.*", "attribution"),
    ("decisions.*", "decision"),
    ("ui_events.*", "ui_event"),
    ("traces.*", "trace"),
    ("embeddings.*", "embedding"),
)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    load_dotenv()
    provider = resolve_provider(llm_flag=None)
    log.info("CANOPY API starting (llm=%s)", provider)

    app.state.blocked_domains: set[str] = set()
    engine = build_engine(
        provider=provider,
        blocked_domains_provider=lambda: app.state.blocked_domains,
        enable_osint=not bool(os.environ.get("CANOPY_DISABLE_OSINT")),
    )
    app.state.engine = engine
    app.state.clients = set()
    app.state.replay_task = None
    app.state.engine_tasks = start_engine_tasks(engine)
    app.state.fanout_tasks = [
        asyncio.create_task(
            _fanout(engine.bus, pattern, kind, app.state.clients),
            name=f"fanout-{kind}",
        )
        for pattern, kind in _FANOUT_PATTERNS
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
        engine.bus.close()


async def _fanout(bus, pattern: str, kind: str, clients: set[WebSocket]) -> None:
    """Forward every bus event matching *pattern* to every connected client."""
    async for topic, event in bus.subscribe(pattern):
        if hasattr(event, "model_dump"):
            data: Any = event.model_dump(mode="json")
        else:
            data = event
        envelope = {"topic": topic, "kind": kind, "data": data}
        # Iterate over a snapshot — clients can disconnect mid-fanout.
        for ws in list(clients):
            try:
                await ws.send_json(envelope)
            except Exception:
                clients.discard(ws)


def create_app() -> FastAPI:
    app = FastAPI(title="CANOPY Engine Gateway", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
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
    async def replay_scenario(name: str, speed: float = 5.0) -> dict[str, Any]:
        try:
            case = SCENARIO_REGISTRY.by_file(name)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"scenario not found: {name}")
        if "demo" not in case.visibility:
            raise HTTPException(status_code=404, detail=f"scenario not found: {name}")
        path = case.scenario_path

        prev = app.state.replay_task
        if prev is not None and not prev.done():
            prev.cancel()

        replay = ScenarioReplayService(
            app.state.engine.bus,
            path,
            speed=speed,
            max_delay_s=0.5,
        )
        app.state.replay_task = asyncio.create_task(
            replay.run(), name=f"replay-{name}"
        )
        return {"status": "replaying", "scenario": name, "speed": speed}

    @app.post("/signals")
    async def post_signal(signal: Signal) -> dict[str, Any]:
        await app.state.engine.bus.publish(f"signals.{signal.domain}", signal)
        return {"status": "queued", "id": signal.id}

    _ALLOWED_DOMAINS = {
        "sda", "orbit", "osint", "humint", "rf_ew", "cyber",
        "pnt", "satcom", "drone", "terrain",
    }

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
