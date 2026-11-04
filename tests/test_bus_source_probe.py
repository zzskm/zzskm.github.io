import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bus-arrival" / "scripts"))
import source_probe  # noqa: E402

KEY = "secret%2Bkey=="


def info(veh_id=204001378, predict=445):
    return {"veh_id": veh_id, "predict_sec": predict}


def fake(result=None, detail=None, extra=None, exc=None):
    def probe(key, plates):
        if exc:
            raise exc
        return result, dict(detail or {}), dict(extra or {})
    return probe


class ProbeTests(unittest.TestCase):
    def probes(self, **overrides):
        base = {name: fake(info()) for name in source_probe.SOURCES}
        base["gbis_web_route"] = fake({"veh_id": None}, extra={"vehicles": 4})
        base.update(overrides)
        return mock.patch.dict(source_probe.PROBES, base)

    def test_verdicts_separate_blocked_runner_from_content_states(self):
        with self.probes(
            kakao=fake(None, {"kind": "unknown_vehicle"}),
            naver=fake(None, {"kind": "http_error", "http_status": 403}),
            gbis_web=fake(None, {"kind": "timeout", "phase": "connect"}),
        ):
            report = source_probe.run(key=KEY, sleep=lambda s: None)
        results = {r["source"]: r for r in report["rounds"][0]["results"]}
        self.assertEqual(results["official"]["verdict"], "ok")
        self.assertTrue(results["official"]["has_vehicle"])
        self.assertEqual(results["gbis_web_route"]["vehicles"], 4)
        self.assertNotIn("has_vehicle", results["gbis_web_route"])
        self.assertEqual(results["kakao"]["verdict"], "reachable")
        self.assertEqual(results["naver"], {**results["naver"], "verdict": "failed",
                                            "error": {"kind": "http_error", "http_status": 403}})
        self.assertEqual(results["gbis_web"]["error"], {"kind": "timeout", "phase": "connect"})
        self.assertEqual(sorted(source_probe.failed_sources(report)), ["gbis_web", "naver"])

    def test_no_bus_is_ok_not_failure(self):
        with self.probes(kakao=fake(info(None, None))):
            report = source_probe.run(key=KEY)
        kakao = report["rounds"][0]["results"][3]
        self.assertEqual((kakao["verdict"], kakao["has_vehicle"]), ("ok", False))
        self.assertNotIn("predict_sec", kakao)

    def test_official_skipped_without_key_and_not_counted_as_failure(self):
        called = []
        with self.probes(official=lambda key, plates: called.append(key)):
            report = source_probe.run(key=None)
        self.assertEqual(called, [])
        self.assertEqual(report["summary"]["official"]["skipped"], 1)
        self.assertEqual(source_probe.failed_sources(report), [])
        self.assertIn("건너뜀", source_probe.describe("official", report["summary"]["official"]))

    def test_unexpected_exception_is_recorded_without_message(self):
        with self.probes(naver=fake(exc=RuntimeError("https://map.naver.com/?token=abc"))):
            report = source_probe.run(key=KEY)
        naver = report["rounds"][0]["results"][4]
        self.assertEqual(naver["error"], {"kind": "unexpected_error"})
        self.assertNotIn("token", json.dumps(report))

    def test_only_safe_detail_keys_are_kept(self):
        detail = {"kind": "gateway_error", "gateway_code": "22", "url": "https://x/?serviceKey=" + KEY,
                  "message": "boom"}
        with self.probes(official=fake(None, detail)):
            report = source_probe.run(key=KEY)
        self.assertEqual(report["rounds"][0]["results"][0]["error"], {"kind": "gateway_error", "gateway_code": "22"})
        self.assertNotIn(KEY, json.dumps(report))

    def test_rounds_summarize_intermittent_failures(self):
        outcomes = iter([info(), None, info()])
        sleeps = []

        def flaky(key, plates):
            value = next(outcomes)
            return value, ({} if value else {"kind": "timeout", "phase": "read"}), {}

        with self.probes(kakao=flaky):
            report = source_probe.run(rounds=3, gap=20, key=KEY, sleep=sleeps.append)
        self.assertEqual(sleeps, [20, 20])
        self.assertEqual(len(report["rounds"]), 3)
        entry = report["summary"]["kakao"]
        self.assertEqual((entry["ok"], entry["failed"]), (2, 1))
        self.assertEqual(entry["last_error"], {"kind": "timeout", "phase": "read"})
        self.assertIn("실패 1 (timeout,read)", source_probe.describe("kakao", entry))

    def test_annotations_and_step_summary(self):
        with self.probes(naver=fake(None, {"kind": "http_error", "http_status": 403})):
            report = source_probe.run(key=KEY)
        out = io.StringIO()
        source_probe.annotate(report, out)
        lines = out.getvalue().splitlines()
        self.assertTrue(lines[0].startswith("::notice title=Bus source probe::official 성공 1/1"))
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[1].startswith("::warning title=Bus source probe naver::"))
        self.assertIn("http_error,403", lines[1])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.md"
            source_probe.step_summary(report, path)
            text = path.read_text(encoding="utf-8")
        self.assertIn("| naver | 0 | 0 | 1 | kind=http_error http_status=403 |", text)

    def test_main_strict_exit_code_and_output_file(self):
        with tempfile.TemporaryDirectory() as tmp, self.probes(
                naver=fake(None, {"kind": "connection_error"})), \
                mock.patch.dict(os.environ, {"SERVICE_KEY": KEY, "GITHUB_ACTIONS": "false"}), \
                mock.patch("sys.stdout", new=io.StringIO()):
            output = Path(tmp) / "probe.json"
            args = ["--output", str(output), "--predict-log", str(Path(tmp) / "none.csv")]
            self.assertEqual(source_probe.main(args), 0)
            self.assertEqual(source_probe.main(args + ["--strict"]), 1)
            saved = output.read_text(encoding="utf-8")
        self.assertEqual(json.loads(saved)["summary"]["naver"]["failed"], 1)
        self.assertNotIn(KEY, saved)

    def test_real_probe_functions_use_scrape_targets(self):
        """출처별 조회가 scrape.py 와 같은 정류장·노선·순번을 쓰는지 (네트워크 없이)."""
        calls = []
        with mock.patch.object(source_probe.station_signals, "fetch_station_list",
                               side_effect=lambda *a, **k: calls.append(("official", a[1:])) or
                               {"info": info(), "routes": [1, 2]}), \
                mock.patch.object(source_probe.gbis_web, "fetch_station_info",
                                  side_effect=lambda *a, **k: calls.append(("gbis_web", a)) or info()), \
                mock.patch.object(source_probe.gbis_web, "fetch_route_positions",
                                  side_effect=lambda *a, **k: calls.append(("route", a)) or {"vehicles": []}), \
                mock.patch.object(source_probe.kakao_stop, "fetch_info",
                                  side_effect=lambda plates, **k: calls.append(("kakao", plates)) or None), \
                mock.patch.object(source_probe.naver_stop, "fetch_info",
                                  side_effect=lambda plates, **k: calls.append(("naver", plates)) or {"info": info()}):
            report = source_probe.run(key=KEY, plates={"경기70아7046": 204001378})
        import scrape
        self.assertEqual((source_probe.STATION_ID, source_probe.ROUTE_ID, source_probe.STA_ORDER),
                         (scrape.STATION_ID, scrape.TARGET_ROUTE_ID, scrape.STA_ORDER))
        self.assertEqual(calls[0], ("official", (206000565, 204000170, 6)))
        self.assertEqual(calls[1], ("gbis_web", (206000565, 204000170, 6)))
        self.assertEqual(calls[2], ("route", (204000170,)))
        self.assertEqual(calls[3][1], {"경기70아7046": 204001378})
        results = {r["source"]: r for r in report["rounds"][0]["results"]}
        self.assertEqual(results["official"]["routes"], 2)
        self.assertEqual(results["kakao"]["error"], {"kind": "unknown"})
        self.assertEqual(results["naver"]["verdict"], "ok")


if __name__ == "__main__":
    unittest.main()
