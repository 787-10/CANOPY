from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import jsonschema

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import replay, validate_scenarios  # noqa: E402
from services.ingest import (  # noqa: E402
    bus_health,
    cyber,
    drone,
    humint,
    orbit,
    osint,
    pnt,
    rf_ew,
    satcom,
    sda,
    space_weather,
    terrain,
)
from services.ingest.common import iter_domain_signals  # noqa: E402


SCENARIO_DIR = ROOT / "scenarios"
SIGNAL_SCHEMA = ROOT / "services" / "bus" / "schemas" / "signal.schema.json"
EXAMPLES_DIR = ROOT / "services" / "bus" / "schemas" / "examples"
PAYLOADS_DIR = ROOT / "services" / "bus" / "schemas" / "payloads"


class DataLaneBehaviorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scenarios = sorted(SCENARIO_DIR.glob("*.jsonl"))
        self.assertGreater(len(self.scenarios), 0, "expected checked-in scenario JSONL files")

    def test_checked_in_scenarios_validate_successfully(self) -> None:
        validator, warning = validate_scenarios.load_json_schema_validator(SIGNAL_SCHEMA)

        self.assertIsNone(warning)
        self.assertIsNotNone(validator)

        total_records = 0
        all_errors: list[str] = []
        for scenario in self.scenarios:
            records, errors = validate_scenarios.validate_file(scenario, validator)
            total_records += records
            all_errors.extend(errors)

        self.assertGreater(total_records, 0)
        self.assertEqual([], all_errors)

    def test_replay_dry_run_emits_compact_jsonl_records_without_sleeping(self) -> None:
        scenario = SCENARIO_DIR / "beat1.jsonl"
        expected_records = replay.load_records(scenario)
        stdout = io.StringIO()
        argv = ["replay.py", str(scenario), "--dry-run", "--cadence-ms", "5000"]

        with mock.patch.object(sys, "argv", argv):
            with mock.patch.object(replay.time, "sleep", side_effect=AssertionError("dry-run slept")):
                with contextlib.redirect_stdout(stdout):
                    exit_code = replay.main()

        lines = stdout.getvalue().splitlines()
        parsed_records = [json.loads(line) for line in lines]

        self.assertEqual(0, exit_code)
        self.assertEqual(expected_records, parsed_records)
        self.assertEqual(len(expected_records), len(lines))
        # The dry-run must emit compact JSON (no whitespace between tokens).
        # Compare each line against the canonical compact serialization rather
        # than scanning for ", " / ": " — the latter false-positives on any
        # prose summary that contains natural English punctuation.
        for line, record in zip(lines, parsed_records, strict=True):
            self.assertEqual(json.dumps(record, separators=(",", ":")), line)

    def test_ingest_adapters_filter_to_their_own_domain(self) -> None:
        adapters = {
            "bus_health": bus_health,
            "cyber": cyber,
            "drone": drone,
            "humint": humint,
            "orbit": orbit,
            "osint": osint,
            "pnt": pnt,
            "rf_ew": rf_ew,
            "satcom": satcom,
            "sda": sda,
            "space_weather": space_weather,
            "terrain": terrain,
        }
        example_signals = [
            json.loads(example_path.read_text(encoding="utf-8"))
            for example_path in sorted(EXAMPLES_DIR.glob("*.json"))
        ]

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".jsonl") as feed:
            for signal in example_signals:
                feed.write(json.dumps(signal) + "\n")
            feed.flush()

            for domain, adapter in adapters.items():
                with self.subTest(domain=domain):
                    expected_signals = list(iter_domain_signals(feed.name, domain))
                    adapter_signals = list(adapter.iter_signals(feed.name))

                    self.assertEqual(expected_signals, adapter_signals)
                    self.assertEqual(1, len(adapter_signals))
                    self.assertEqual({domain}, {signal["domain"] for signal in adapter_signals})

    def test_schema_examples_validate_against_signal_and_payload_schemas(self) -> None:
        example_paths = sorted(EXAMPLES_DIR.glob("*.json"))

        self.assertGreater(len(example_paths), 0, "expected checked-in schema examples")

        for example_path in example_paths:
            with self.subTest(example=example_path.name):
                example = json.loads(example_path.read_text(encoding="utf-8"))
                # One example per domain, named after it, validated against
                # the Signal envelope and that domain's payload schema.
                self.assertEqual(example_path.stem, example["domain"])
                self._assert_signal_and_payload_valid(example["domain"], example)

    # ---- MEGALITH domains (docs/INTERFACE-SPEC.md §3, §4) -----------------

    @staticmethod
    def _validators(domain: str) -> tuple[jsonschema.Draft202012Validator, jsonschema.Draft202012Validator]:
        signal_schema = json.loads(SIGNAL_SCHEMA.read_text(encoding="utf-8"))
        payload_schema = json.loads((PAYLOADS_DIR / f"{domain}.schema.json").read_text(encoding="utf-8"))
        return (
            jsonschema.Draft202012Validator(signal_schema),
            jsonschema.Draft202012Validator(payload_schema),
        )

    def _assert_signal_and_payload_valid(self, domain: str, signal: dict) -> None:
        signal_validator, payload_validator = self._validators(domain)
        signal_validator.validate(signal)
        payload_validator.validate(signal["payload"])

    def test_new_domains_have_examples_and_payload_schemas(self) -> None:
        for domain in ("bus_health", "space_weather"):
            with self.subTest(domain=domain):
                self.assertTrue((EXAMPLES_DIR / f"{domain}.json").exists())
                self.assertTrue((PAYLOADS_DIR / f"{domain}.schema.json").exists())

    def test_bus_health_builder_emits_schema_valid_signal(self) -> None:
        signal = bus_health.build_bus_health_signal(
            signal_id="sig_bus_health_test_1",
            ts="2026-09-17T14:32:12Z",
            event_type="link_margin_drop",
            summary="LEO-SCIENCE-1 downlink margin falling 0.42 dB/s since 14:32:10Z.",
            asset="LEO-SCIENCE-1",
            satellite_id="ctb://centralblue.dev/leo-science-1",
            subsystem="comms",
            symptom="link_margin_db_drop",
            onset_ts="2026-09-17T14:32:10Z",
            onset_clock_domain="simulation",
            sim_time_s=812.0,
            physics_consistency=0.83,
            physics_basis="belief:pa_degradation=0.79;shape=ramp",
            confidence=0.81,
            rate_of_change=-0.42,
            rate_unit="dB/s",
            shape="ramp",
            recommended_recovery={
                "action_id": "switch_redundant_amplifier",
                "target_subsystem": "comms",
                "requires_approval": True,
                "rationale": "Primary amplifier output trending down; redundant unit nominal.",
            },
            norad_cat_id="99901",
            sim_identity="ctb://sim.centralblue.dev/leo-science-1",
            generated_at="2026-09-17T14:32:12Z",
            epoch_utc="2026-09-17T14:18:38Z",
        )
        self._assert_signal_and_payload_valid("bus_health", signal)
        self.assertEqual("bus_health", signal["domain"])
        self.assertEqual("internal-diagnosis", signal["source"])
        self.assertEqual("internal-diagnosis", signal["provenance"]["source_id"])
        self.assertEqual({"label": "LEO-SCIENCE-1"}, signal["location"])
        self.assertEqual("epoch=2026-09-17T14:18:38Z", signal["provenance"]["notes"])
        self.assertEqual("ctb://centralblue.dev/leo-science-1", signal["payload"]["satellite_id"])
        self.assertEqual(812.0, signal["payload"]["observables"]["sim_time_s"])

        # The adapter's own domain filter accepts what it builds.
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".jsonl") as feed:
            feed.write(json.dumps(signal) + "\n")
            feed.flush()
            self.assertEqual([signal], list(bus_health.iter_signals(feed.name)))

    def test_bus_health_builder_keeps_nullable_window_fields_present(self) -> None:
        signal = bus_health.build_bus_health_signal(
            signal_id="sig_bus_health_test_2",
            ts="2026-09-17T15:00:00Z",
            event_type="safe_mode_entry",
            summary="LEO-SCIENCE-1 entered safe mode on a fault-protection trip.",
            asset="LEO-SCIENCE-1",
            satellite_id="ctb://centralblue.dev/leo-science-1",
            subsystem="cdh",
            symptom="safe_mode",
            onset_ts="2026-09-17T14:59:58Z",
            onset_clock_domain="utc",
            physics_consistency=0.5,
            confidence=0.7,
        )
        self._assert_signal_and_payload_valid("bus_health", signal)
        observables = signal["payload"]["observables"]
        for key in ("rate_of_change", "rate_unit", "shape", "recommended_recovery"):
            self.assertIn(key, observables)
            self.assertIsNone(observables[key])
        self.assertNotIn("sim_time_s", observables)
        self.assertNotIn("notes", signal["provenance"])

    def test_bus_health_builder_rejects_off_vocabulary_values(self) -> None:
        base = dict(
            signal_id="sig_bus_health_test_3",
            ts="2026-09-17T15:00:00Z",
            event_type="link_margin_drop",
            summary="x",
            asset="LEO-SCIENCE-1",
            satellite_id="ctb://centralblue.dev/leo-science-1",
            subsystem="comms",
            symptom="link_margin_db_drop",
            onset_ts="2026-09-17T14:59:58Z",
            onset_clock_domain="utc",
            physics_consistency=0.5,
            confidence=0.7,
        )
        bad_cases = {
            "event_type": "amplifier_failure",
            "subsystem": "radio",
            "onset_clock_domain": "local",
            "shape": "spike",
            "physics_consistency": 1.2,
            "satellite_id": "leo-science-1",
            "recommended_recovery": {"action_id": "reset"},
        }
        for key, value in bad_cases.items():
            with self.subTest(field=key):
                with self.assertRaises(ValueError):
                    bus_health.build_bus_health_signal(**{**base, key: value})
        with self.subTest(field="sim_time_s"):
            with self.assertRaises(ValueError):
                bus_health.build_bus_health_signal(**{**base, "onset_clock_domain": "simulation"})

    def test_space_weather_builder_emits_schema_valid_signal(self) -> None:
        common_kwargs = dict(
            ts="2026-09-17T14:20:00Z",
            event_type="geomagnetic_storm",
            summary="Geomagnetic storm in progress (G2): Kp 6.33.",
            kp=6.33,
            dst_nt=-112,
            f107=158.4,
            severity=space_weather.severity_from_scale(2),
            valid_from="2026-09-17T14:00:00Z",
            valid_to="2026-09-17T20:00:00Z",
            citation="https://www.swpc.noaa.gov/products/planetary-k-index",
        )
        fixture = space_weather.build_space_weather_signal(
            signal_id="sig_space_weather_test_1", **common_kwargs
        )
        live = space_weather.build_space_weather_signal(
            signal_id="sig_space_weather_test_2", live=True, **common_kwargs
        )
        for signal in (fixture, live):
            self._assert_signal_and_payload_valid("space_weather", signal)
            self.assertEqual("space_weather", signal["domain"])
            self.assertEqual({"label": "geospace"}, signal["location"])
            self.assertNotIn("satellite_id", signal["payload"])
            self.assertEqual(0.4, signal["payload"]["observables"]["severity"])

        self.assertEqual("noaa-swpc", fixture["source"])
        self.assertEqual("mock_operational", fixture["realism"])
        self.assertEqual("fixture", fixture["provenance"]["method"])
        self.assertEqual("noaa-swpc-live", live["source"])
        self.assertEqual("real_source", live["realism"])
        self.assertEqual("live_fetch", live["provenance"]["method"])

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".jsonl") as feed:
            feed.write(json.dumps(fixture) + "\n")
            feed.flush()
            self.assertEqual([fixture], list(space_weather.iter_signals(feed.name)))

    def test_space_weather_helpers_follow_the_spec_triggers(self) -> None:
        self.assertEqual("geomagnetic_storm", space_weather.event_type_for_kp(5.0))
        self.assertEqual("quiet", space_weather.event_type_for_kp(4.67))
        self.assertEqual(1.0, space_weather.severity_from_scale(5))
        self.assertEqual(0.0, space_weather.severity_from_scale(0))
        with self.assertRaises(ValueError):
            space_weather.severity_from_scale(6)
        with self.assertRaises(ValueError):
            space_weather.build_space_weather_signal(
                signal_id="x",
                ts="2026-09-17T14:20:00Z",
                event_type="aurora",
                summary="x",
                kp=3.0,
                dst_nt=None,
                f107=None,
                severity=0.0,
                valid_from="2026-09-17T14:00:00Z",
                valid_to="2026-09-17T20:00:00Z",
            )

    # ---- Nullable optional properties (wave 4B) -------------------------------
    #
    # The pydantic Signal model serializes every field, unset ones as null, and
    # the WebSocket envelope is that full dump. The JSON Schemas accept null
    # wherever the model allows None, so adapters and tests no longer need
    # ``exclude_none`` to validate what the bus actually carries.

    @staticmethod
    def _pydantic_bus_health_signal():
        from canopy.services.schemas.events import Signal

        return Signal.model_validate(
            {
                "id": "sig-bus-raw-1",
                "ts": "2026-09-17T14:32:12Z",
                "domain": "bus_health",
                "source": "internal-diagnosis",
                "realism": "mock_operational",
                "confidence": 0.81,
                "location": {"label": "LEO-SCIENCE-1"},
                "payload": {
                    "event_type": "link_margin_drop",
                    "summary": "LEO-SCIENCE-1 downlink margin falling 0.42 dB/s since 14:32:10Z.",
                    "asset": "LEO-SCIENCE-1",
                    "satellite_id": "ctb://centralblue.dev/leo-science-1",
                    "observables": {
                        "subsystem": "comms",
                        "symptom": "link_margin_db_drop",
                        "onset_ts": "2026-09-17T14:32:10Z",
                        "onset_clock_domain": "simulation",
                        "sim_time_s": 812.0,
                        "rate_of_change": None,
                        "rate_unit": None,
                        "physics_consistency": 0.83,
                        "physics_basis": "shape:ramp;shape_support=0.80",
                        "shape": None,
                        "recommended_recovery": None,
                        "sim_identity": "ctb://sim.centralblue.dev/leo-science-1",
                    },
                },
                "provenance": {
                    "source_id": "internal-diagnosis",
                    "collector": "megalith-bus-health-adapter",
                    "method": "rule_fdir",
                    "generated_at": "2026-09-17T14:32:12Z",
                    "notes": "epoch=2026-09-17T14:18:38Z",
                },
            }
        )

    @staticmethod
    def _pydantic_space_weather_signal():
        from canopy.services.schemas.events import Signal

        return Signal.model_validate(
            {
                "id": "sig-sw-raw-1",
                "ts": "2026-09-17T14:20:00Z",
                "domain": "space_weather",
                "source": "noaa-swpc",
                "realism": "mock_operational",
                "confidence": 0.9,
                "location": {"label": "geospace"},
                "payload": {
                    "event_type": "geomagnetic_storm",
                    "summary": "Geomagnetic storm in progress (G2): Kp 6.33.",
                    "observables": {
                        "kp": 6.33,
                        "dst_nt": None,
                        "f107": None,
                        "severity": 0.4,
                        "valid_from": "2026-09-17T14:00:00Z",
                        "valid_to": "2026-09-17T20:00:00Z",
                    },
                },
                "provenance": {"source_id": "noaa-swpc", "method": "fixture", "citation": None},
            }
        )

    def test_raw_pydantic_dump_of_adapter_shaped_signals_validates_without_exclude_none(self) -> None:
        format_checker = jsonschema.FormatChecker()
        for domain, signal in (
            ("bus_health", self._pydantic_bus_health_signal()),
            ("space_weather", self._pydantic_space_weather_signal()),
        ):
            with self.subTest(domain=domain):
                raw = signal.model_dump(mode="json")  # no exclude_none: nulls are present
                self.assertIsNone(raw["location"]["lat"])
                self.assertIsNone(raw["payload"]["beat"])
                if domain == "space_weather":
                    self.assertIsNone(raw["payload"]["satellite_id"])
                    self.assertIsNone(raw["payload"]["asset"])
                signal_validator, payload_validator = self._validators(domain)
                jsonschema.Draft202012Validator(
                    signal_validator.schema, format_checker=format_checker
                ).validate(raw)
                jsonschema.Draft202012Validator(
                    payload_validator.schema, format_checker=format_checker
                ).validate(raw["payload"])
                # The envelope the WebSocket and NATS carry is the same dump.
                from canopy.services.bus import codec

                envelope = codec.envelope(f"signals.{domain}", signal)
                self.assertEqual(raw, envelope["data"])

    def test_signal_schema_optional_properties_accept_null(self) -> None:
        schema = json.loads(SIGNAL_SCHEMA.read_text(encoding="utf-8"))
        location = schema["properties"]["location"]["properties"]
        payload = schema["properties"]["payload"]["properties"]
        provenance = schema["properties"]["provenance"]["properties"]
        for name, prop in {**location, **payload, **provenance}.items():
            required = (
                name in schema["properties"]["payload"]["required"]
                or name in schema["properties"]["provenance"]["required"]
                or name == "references"  # a list default, never None
            )
            with self.subTest(property=name):
                if required:
                    self.assertNotIn("null", prop["type"])
                else:
                    self.assertIn("null", prop["type"])

    def test_location_still_needs_one_non_null_localizer(self) -> None:
        signal_validator, _ = self._validators("bus_health")
        base = self._pydantic_bus_health_signal().model_dump(mode="json")
        all_null = {key: None for key in base["location"]}
        self.assertTrue(list(signal_validator.iter_errors({**base, "location": all_null})))
        self.assertFalse(list(signal_validator.iter_errors({**base, "location": {**all_null, "label": "x"}})))
        self.assertFalse(
            list(signal_validator.iter_errors({**base, "location": {**all_null, "lat": 1.0, "lng": 2.0}}))
        )
        self.assertTrue(list(signal_validator.iter_errors({**base, "location": {**all_null, "lat": 1.0}})))


if __name__ == "__main__":
    unittest.main()
