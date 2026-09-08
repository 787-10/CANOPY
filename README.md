# CANOPY: Cross-domain Attribution and Orbital Protection sYstem

**Sense · Attribute · Decide.**

> *"We must defend U.S. space capabilities, and we must protect our forces from space-enabled attack."*
> — CSO Gen. B. Chance Saltzman, *Space Warfighting*, March 2025

Space supports **every** fight. CANOPY lets the fight support space.

Virtually every ground operation runs on data piped down from orbit; think ISR, comms, GEOINT, imagery, GPS timing, etc. Adversaries know it: Iran has demonstrated it can sever ~80% of Starlink access to civilians inside its borders, and China fields inspector satellites that shadow allied assets and has physically tugged targets into graveyard orbits. Lose the uplink, lose the fight — and operators today has no single picture of who is doing what to which asset, or what they are authorized to do about it in the next minute.

CANOPY is a tactical multi-domain awareness and decision-support system for the brigade-level analyst, operator, and commander. It fuses orbital, RF/EW, cyber, PNT, SATCOM, drone, HUMINT, and OSINT signals into a single live picture, attributes the threat, recommends an authorized response, and visualizes the outcome — all on hardware that fits in a forward operating base.

- Runs at the **edge** on a single NVIDIA RTX 3090.
- **Sense to decide in under 20 seconds.**
- 100% local LLM inference via Ollama — no cloud, no PII egress. Designed to be hosted entirely on-prem.

YouTube demo [here](https://www.youtube.com/watch?v=NzDcP5XryC4).

---

## Architecture

CANOPY is a three-stage agentic pipeline. Each stage publishes typed events to an in-process bus; the FastAPI gateway fans them out to the frontend over a single WebSocket.

| Stage | What it does | Output |
|---|---|---|
| **Sense** | Normalizes heterogeneous feeds (RF, orbital, cyber, PNT, SATCOM, drone, OSINT) into a canonical `Signal`. Fuses signals into `Anomaly` clusters via temporal + spatial + semantic correlation. | `Signal`, `Anomaly` |
| **Attribute** | Multi-agent reasoning: a primary LLM call attributes the anomaly, a red-team call challenges it, and a reconciler produces a calibrated final `Attribution` with confidence. | `Attribution`, `AttributionChallenge` |
| **Decide** | Tool-using LLM agent calls real tools (`kb.lookup`, `orbit.compute_close_approach` (Skyfield SGP4 solver), `orbit.simulate_maneuver` (Clohessy-Wiltshire equations), `request.draft`, `routing.validate`) to produce an actionable `Decision` with authority routing. | `Decision`, `RequestPacket` |

Interpretability: Every reasoning step emits a `ReasoningTrace` event so the operator sees *why* — not just *what* — on a live terminal-style panel.

The frontend is a React + Cesium + MapLibre console with two views:
- **Brigade COP** — multi-domain fusion picture, OSINT clustering, scenario timeline, reasoning trace, and approval banner.
- **Operator Console** — review surface where the operator accepts or denies the decide-stage recommendation. Accept triggers an interactive Cesium animation showing the maneuver against the live N2YO satellite catalog (plane-change burn, kinetic-strike Bezier, or link-interdiction beam, depending on the action).

---

## Where the data comes from

| Source | Domain | Notes |
|---|---|---|
| **CelesTrak GP catalog** ([`data/source_registry.json`](data/source_registry.json), [`scripts/fetch_orbital_cache.py`](scripts/fetch_orbital_cache.py)) | orbit / SDA | Authoritative TLE/OMM feeds for GEO, GPS-OPS, Starlink, Planet, and the GPZ+ "objects of interest" group. Pulled directly from `celestrak.org/NORAD/elements/gp.php`. Skyfield-backed SGP4 propagation produces real close-approach geometry. |
| **N2YO position feed** ([`public/orbital/`](public/orbital/), [`data/tle_cache.json`](data/tle_cache.json)) | orbit / SDA | Per-satellite live position polls for AEHF, MUOS, WGS, SBIRS, GSSAP, GPS-3 (US) and Yaogan / Cosmos (CHN/RUS). Drives the Cesium globe's animated orbital tracks. |
| **OSINT corpus** | open-source | Sentence-transformer (`all-MiniLM-L6-v2`, 384-dim) embeddings, cosine-clustered at 0.40, PCA-projected to 2D for the embedding panel. |
| **Hand-authored scenarios** ([`scenarios/*.jsonl`](scenarios/)) | RF/EW, cyber, PNT, SATCOM, drone, HUMINT | 11 deterministic JSONL beats covering CENTCOM, Army, and regional vignettes. |
| **Procedural variants** ([`bench/scenarios/`](bench/)) | synthetic | 44 checked-in perturbations of the 11 seeds for the benchmark harness. |
| **KB** ([`kb/`](kb/), [`data/kb_seed_entries.json`](data/kb_seed_entries.json)) | tradecraft | Actor capabilities, doctrine references, and routing rules used by `kb.lookup`. |

CANOPY can ingest **live** from both the [CelesTrak](https://celestrak.org) and [N2YO](https://www.n2yo.com) public APIs — `scripts/fetch_orbital_cache.py --mode live` refreshes the TLE catalog directly from CelesTrak, and the N2YO position cache is repopulated on demand from the per-NORAD position-feed endpoint. The on-disk caches in `public/orbital/` and `data/` are the offline fixtures used when the box has no backhaul; switching to live is a single flag.

Every record — real, live, fixture, or synthetic — flows through the same canonical `Signal` schema.

---

## Running locally

### Prerequisites

- Python ≥ 3.11 with [`uv`](https://github.com/astral-sh/uv). 
- Node ≥ 20.
- [Ollama](https://ollama.com) running locally with **Gemma 4 E2B** pulled.
- One NVIDIA RTX 3090 (or any GPU with ~12 GB VRAM) for inference.

### Environment setup
```
uv venv
source .venv/bin/activate
uv sync
```

### Start the local LLM

```bash
ollama pull gemma4:e2b
ollama serve
```

CANOPY reads `CANOPY_OLLAMA_URL` (default `http://localhost:11434`) and `CANOPY_OLLAMA_MODEL` (set this to `gemma4:e2b`).

### Backend gateway
In one terminal, run the following to start the backend:
```bash
uv run uvicorn canopy.api:app --host 0.0.0.0 --port 8000
```

The gateway boots the in-process bus, the three services, and exposes:
- `GET /kb`, `GET /scenarios`, `POST /scenarios/{id}/start`, `POST /stress`
- `WS /ws` — Signal / Anomaly / Attribution / Decision / UIEvent / ReasoningTrace fanout

### Frontend
In a second terminal, run the following to start the frontend:
```bash
npm install
npm run dev   # http://localhost:5173
```

Set `VITE_CANOPY_API_URL=http://localhost:8000` in `.env.local` if the gateway runs on a different host.
You can view and interact with the frontend by going to `http://localhost:5173` in a browser.

### One-shot verification

```bash
uv run python scripts/verify.py scenarios/army_multidomain_attack_chain.jsonl
```

Replays a scenario through the engine in-process, asserts the expected sense → attribute → decide chain, and prints the reasoning trace.

### Benchmark

```bash
uv run python -m bench.run
```

Runs the 55-scenario harness (11 seeds + 44 procedural variants) and writes a scorecard with attribution accuracy, calibration, and p50/p95 latency.

### Stress mode

The operator panel can simulate domain loss:

```bash
curl -X POST http://localhost:8000/stress \
  -H "Content-Type: application/json" \
  -d '{"blocked_domains": ["pnt", "satcom"]}'
```

The reasoning panel will surface `[stress] PNT data unavailable, lowering confidence` in real time and the engine will route to `threat_warning` when correlations are starved.

---

## Why local-first

| Constraint | CANOPY's answer |
|---|---|
| No reliable backhaul at the edge | Full pipeline runs on a single GPU; no API calls leave the box. |
| Adversarial denial of comms | Stress-mode degrades gracefully; reasoning panel narrates the loss. |
| Sensitive sensor data | Nothing is sent to a hyperscaler because Ollama hosts the model in-process. |
| Time-critical decisions | <20 s sense-to-decide on Gemma 4 E2B. |

---

## Repo layout

```
canopy/                  # Python engine (services, schemas, API gateway)
  api/                 # FastAPI gateway + WebSocket fanout
  services/            # fusion, attrib (multi-agent), decide (tool-using), llm, orbit, kb, traces
src/                   # React + Cesium + MapLibre console
  components/          # Brigade COP + Operator Console + reasoning panel + maneuver demo
  lib/n2yoSatelliteLayer.ts  # SGP4-driven orbital animation
scenarios/             # 11 hand-authored JSONL beats
bench/                 # benchmark harness + scorecard
data/                  # KB seeds, source registry, orbital cache metadata
public/orbital/        # N2YO position caches per NORAD ID
kb/                    # capability + routing knowledge base
```

---

## Benchmark

CANOPY ships with its own evaluation harness ([`bench/`](bench/)), which contains 11 hand-labelled seed scenarios plus 44 procedural variants. The versioned [`scenarios/manifest.json`](scenarios/manifest.json) is the shared source for demo metadata, benchmark expectations, visibility, and input roles. `bench/run.py` boots a fresh engine per case, publishes only stimulus/context records, and produces a scorecard covering attribution accuracy, action match, authority routing, confidence behavior, and p50/p95 latency.

We're aware that small open-weight models leave headroom on multi-domain attribution compared to large cloud-hosted LLMs. We're interested in pursuing further research in this direction and are happy to move forward with the right collaborators on this.

## Partnering with frontier labs

CANOPY is built around the assumption that the model lives at the edge but the *quality* of attribution and decision routing tracks directly with the underlying model. **We're actively seeking partnerships with frontier labs** to push two things:

1. **Edge-first model distillation** — a Gemma-class (or smaller) model fine-tuned on the multi-domain reasoning, tool-use, and red-team-vs-reconciler patterns CANOPY exercises. Today we use the off-the-shelf weights; we'd like to close the gap to frontier-class reasoning at sub-20 GB VRAM.
2. **Defensible evaluation** — extending the benchmark with adversarial scenarios, calibration probes, and authority-routing edge cases that frontier labs care about for safety and reliability research, with results we can publish jointly.

If you're at a frontier lab and you find this interesting, we'd love to hear from you! In this project, we'll publish an initial (truncated) version of the benchmark; future updates to the benchmark will move to a dedicated repo (to be linked here in the future).

## Contact
For any questions regarding this project, please contact Brian via [bwu.ai](https://bwu.ai).
