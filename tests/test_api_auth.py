"""Gateway access control (docs/C2-API.md): bearer token and CORS, both opt-in.

``CANOPY_API_TOKEN`` unset keeps the gateway open, as local demos expect;
set, every REST route but ``GET /health`` needs ``Authorization: Bearer``
and the WebSocket needs ``?token=`` or the same header. ``CANOPY_CORS_ORIGINS``
replaces the hard-coded Vite origins. Each mode gets its own app so the tests
do not depend on the developer's environment or ``.env``.
"""
from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from canopy.api import (
    CORS_ENV,
    DEFAULT_CORS_ORIGINS,
    TOKEN_ENV,
    WS_POLICY_VIOLATION,
    create_app,
    resolve_api_token,
    resolve_cors_origins,
)

TOKEN = "s3cret-demo-token"
CONSOLE = "https://console.example"


@pytest.fixture(scope="module", autouse=True)
def _no_osint():
    # The OSINT clustering model is irrelevant here and slow to attach.
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("CANOPY_DISABLE_OSINT", "1")
    yield
    monkeypatch.undo()


@pytest.fixture(scope="module")
def locked():
    with TestClient(create_app(api_token=TOKEN, cors_origins=[CONSOLE])) as client:
        yield client


@pytest.fixture(scope="module")
def open_client():
    with TestClient(create_app(api_token=None)) as client:
        yield client


def _auth(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ---- Environment resolution ------------------------------------------------------------


def test_token_resolution_treats_blank_as_unset() -> None:
    assert resolve_api_token({}) is None
    assert resolve_api_token({TOKEN_ENV: ""}) is None
    assert resolve_api_token({TOKEN_ENV: "   "}) is None
    assert resolve_api_token({TOKEN_ENV: " abc "}) == "abc"


def test_cors_resolution_defaults_to_the_vite_origins() -> None:
    assert resolve_cors_origins({}) == list(DEFAULT_CORS_ORIGINS)
    assert resolve_cors_origins({CORS_ENV: ""}) == list(DEFAULT_CORS_ORIGINS)
    assert resolve_cors_origins({CORS_ENV: " , "}) == list(DEFAULT_CORS_ORIGINS)
    assert resolve_cors_origins({CORS_ENV: "https://a.example, https://b.example ,"}) == [
        "https://a.example",
        "https://b.example",
    ]
    assert DEFAULT_CORS_ORIGINS == ("http://localhost:5173", "http://127.0.0.1:5173")


def test_create_app_reads_the_environment_when_not_pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(TOKEN_ENV, "from-env")
    monkeypatch.setenv(CORS_ENV, "https://x.example")
    app = create_app()
    assert app.state.api_token == "from-env"
    assert app.state.cors_origins == ["https://x.example"]
    monkeypatch.delenv(TOKEN_ENV)
    monkeypatch.delenv(CORS_ENV)
    app = create_app()
    assert app.state.api_token is None
    assert app.state.cors_origins == list(DEFAULT_CORS_ORIGINS)


# ---- Open mode ---------------------------------------------------------------------------------


def test_open_gateway_serves_rest_and_websocket_without_credentials(open_client: TestClient) -> None:
    assert open_client.get("/health").status_code == 200
    assert open_client.get("/scenarios").status_code == 200
    assert open_client.get("/schemas/decision").status_code == 200
    with open_client.websocket_connect("/ws"):
        pass


def test_open_gateway_warns_once_at_startup(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="canopy.api"):
        with TestClient(create_app(api_token=None)):
            pass
    warnings = [r for r in caplog.records if TOKEN_ENV in r.getMessage() and r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "unauthenticated" in warnings[0].getMessage()


def test_locked_gateway_does_not_warn_at_startup(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="canopy.api"):
        with TestClient(create_app(api_token=TOKEN)):
            pass
    assert not [r for r in caplog.records if TOKEN_ENV in r.getMessage() and r.levelno == logging.WARNING]


# ---- Token mode: REST -------------------------------------------------------------------------


def test_health_stays_open(locked: TestClient) -> None:
    response = locked.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/scenarios", None),
        ("GET", "/scenario-registry", None),
        ("GET", "/kb", None),
        ("GET", "/schemas", None),
        ("GET", "/schemas/signal", None),
        ("GET", "/stress", None),
        ("POST", "/stress", {"blocked_domains": []}),
        ("POST", "/scenarios/beat47.jsonl/replay", None),
        ("POST", "/reset", None),
        ("POST", "/signals", {"domain": "rf_ew"}),
    ],
)
def test_every_other_route_requires_the_token(
    locked: TestClient, method: str, path: str, body: dict | None
) -> None:
    response = locked.request(method, path, json=body)
    assert response.status_code == 401, (method, path, response.text)
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json() == {"detail": "missing or invalid bearer token"}


def test_wrong_scheme_or_wrong_token_is_rejected(locked: TestClient) -> None:
    assert locked.get("/scenarios", headers=_auth("nope")).status_code == 401
    assert locked.get("/scenarios", headers={"Authorization": TOKEN}).status_code == 401
    assert locked.get("/scenarios", headers={"Authorization": f"Basic {TOKEN}"}).status_code == 401
    assert locked.get("/scenarios", headers={"Authorization": "Bearer "}).status_code == 401
    assert locked.get("/scenarios", headers=_auth(TOKEN + "x")).status_code == 401


def test_right_token_is_accepted_and_scheme_is_case_insensitive(locked: TestClient) -> None:
    assert locked.get("/scenarios", headers=_auth()).status_code == 200
    assert locked.get("/schemas", headers={"Authorization": f"bearer {TOKEN}"}).status_code == 200
    response = locked.post("/stress", json={"blocked_domains": ["rf_ew"]}, headers=_auth())
    assert response.status_code == 200
    assert response.json() == {"blocked_domains": ["rf_ew"]}
    locked.post("/stress", json={"blocked_domains": []}, headers=_auth())


def test_validation_errors_still_need_the_token_first(locked: TestClient) -> None:
    # A bad payload without a token is a 401, not a 422: nothing is parsed
    # for an unauthenticated caller.
    assert locked.post("/signals", json={"domain": "rf_ew"}).status_code == 401
    assert locked.post("/signals", json={"domain": "rf_ew"}, headers=_auth()).status_code == 422


# ---- Token mode: WebSocket --------------------------------------------------------------------


def test_unauthenticated_websocket_is_rejected(locked: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with locked.websocket_connect("/ws"):
            pass
    assert excinfo.value.code == WS_POLICY_VIOLATION
    with pytest.raises(WebSocketDisconnect):
        with locked.websocket_connect("/ws?token=wrong"):
            pass
    with pytest.raises(WebSocketDisconnect):
        with locked.websocket_connect("/ws", headers={"Authorization": f"Basic {TOKEN}"}):
            pass


def test_websocket_accepts_the_token_as_query_or_header(locked: TestClient) -> None:
    with locked.websocket_connect(f"/ws?token={TOKEN}"):
        pass
    with locked.websocket_connect("/ws", headers=_auth()):
        pass


def test_authenticated_websocket_still_receives_the_firehose(locked: TestClient) -> None:
    with locked.websocket_connect(f"/ws?token={TOKEN}") as ws:
        response = locked.post("/scenarios/beat47.jsonl/replay?speed=1000", headers=_auth())
        assert response.status_code == 200
        envelope = ws.receive_json()
        assert set(envelope) == {"kind", "topic", "data"}


# ---- CORS ---------------------------------------------------------------------------------------


def test_cors_allow_list_comes_from_the_configured_origins(locked: TestClient) -> None:
    allowed = locked.get("/health", headers={"Origin": CONSOLE})
    assert allowed.headers.get("access-control-allow-origin") == CONSOLE
    default_origin = locked.get("/health", headers={"Origin": "http://localhost:5173"})
    assert "access-control-allow-origin" not in default_origin.headers


def test_default_cors_origins_are_the_vite_dev_server(open_client: TestClient) -> None:
    for origin in DEFAULT_CORS_ORIGINS:
        response = open_client.get("/health", headers={"Origin": origin})
        assert response.headers.get("access-control-allow-origin") == origin
    other = open_client.get("/health", headers={"Origin": CONSOLE})
    assert "access-control-allow-origin" not in other.headers


def test_preflight_needs_no_token(locked: TestClient) -> None:
    response = locked.options(
        "/scenarios",
        headers={
            "Origin": CONSOLE,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == CONSOLE
    assert "authorization" in response.headers.get("access-control-allow-headers", "").lower()
