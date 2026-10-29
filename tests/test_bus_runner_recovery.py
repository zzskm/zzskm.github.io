import datetime as dt
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_bus_arrival_logic import ROOT, SCRAPER, KST, NO_BUS, load_module, simulate


CONNECT = {"kind": "timeout", "phase": "connect"}
DIAGNOSTICS = load_module("bus-arrival/scripts/runner_diagnostics.py", "bus_runner_diagnostics")


class RunnerRecoveryTests(unittest.TestCase):
    START = dt.datetime(2026, 10, 29, 18, tzinfo=KST)
    ARGS = ("--session-id", "runner-a", "--max-connect-timeouts", "8")

    def test_eighth_failed_poll_preserves_tracking_call_budget_and_status_before_exit(self):
        earlier = (self.START - dt.timedelta(minutes=1)).isoformat()
        initial = {"date": "2026-10-29", "daily_calls": 12, "cur_vid": 111,
                   "first_seen": earlier, "last_seen": earlier, "last_poll": earlier,
                   "last_success": earlier, "samples": 1, "last_predict": 600}
        with tempfile.TemporaryDirectory() as folder:
            codes, polls = [], []
            arrivals, state = simulate(folder, [None] * 9, self.START, state=initial,
                                       extra_args=self.ARGS, failure_detail=CONNECT,
                                       exit_codes=codes, poll_times=polls)
            status = json.loads((Path(folder) / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(codes, [75])
        self.assertEqual(len(polls), 8)
        self.assertEqual(arrivals, [])
        self.assertEqual((state["cur_vid"], state["samples"], state["last_predict"]), (111, 1, 600))
        self.assertEqual(state["daily_calls"], 20)
        self.assertEqual(state["last_success"], earlier)
        self.assertEqual(state["next_poll_ts"], (self.START + dt.timedelta(minutes=8)).isoformat())
        self.assertEqual(status["recovery_action"], "rotate_runner")
        self.assertEqual(status["consecutive_connect_timeouts"], 8)
        self.assertEqual(status["api_error_detail"], CONNECT)

    def test_streak_spans_segments_but_new_runner_keeps_budget_and_starts_at_one(self):
        with tempfile.TemporaryDirectory() as folder:
            codes = []
            for minute in (0, 3, 6):
                _, state = simulate(folder, [None] * 3, self.START + dt.timedelta(minutes=minute),
                                    extra_args=self.ARGS, failure_detail=CONNECT, exit_codes=codes)
            self.assertEqual(codes, [None, None, 75])
            self.assertEqual(state["daily_calls"], 8)
            _, state = simulate(folder, [None], self.START + dt.timedelta(minutes=8),
                                extra_args=("--session-id", "runner-b"),
                                failure_detail=CONNECT, exit_codes=codes)
            self.assertEqual(codes[-1], None)
            self.assertEqual(state["connection_health"]["consecutive_timeouts"], 1)
            self.assertEqual(state["daily_calls"], 9)
            self.assertEqual(state["consec_fail"], 9)  # preserve data-gap classification
            simulate(folder, [NO_BUS], self.START + dt.timedelta(minutes=9),
                     extra_args=("--session-id", "runner-b"))
            status = json.loads((Path(folder) / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["consecutive_connect_timeouts"], 0)
        self.assertNotIn("recovery_action", status)

    def test_success_response_and_non_connection_errors_break_streak(self):
        cases = [None, {"kind": "timeout", "phase": "read"},
                 {"kind": "gateway_error", "gateway_code": "22"},
                 {"kind": "http_error", "http_status": 429}, {"kind": "connection_error"}]
        for other in cases:
            with self.subTest(other=other), tempfile.TemporaryDirectory() as folder:
                codes = []
                responses = [None, None if other else NO_BUS, None]
                _, state = simulate(folder, responses, self.START,
                                    extra_args=("--max-connect-timeouts", "2"),
                                    failure_details=[CONNECT, other, CONNECT], exit_codes=codes)
                self.assertEqual(codes, [None])
                self.assertEqual(state["connection_health"]["consecutive_timeouts"], 1)

    def test_station_list_and_fallback_must_both_fail_to_connect(self):
        for list_error in (CONNECT, {"kind": "http_error", "http_status": 403, "gateway_code": "22"}):
            def fail_list(*args, diagnostics):
                diagnostics.update(list_error)
                return None

            with self.subTest(list_error=list_error), tempfile.TemporaryDirectory() as folder, \
                    mock.patch.object(SCRAPER, "fetch_station_list", side_effect=fail_list):
                codes = []
                _, state = simulate(folder, [None] * 3, self.START,
                                    extra_args=("--primary-mode", "station-list", "--max-connect-timeouts", "2"),
                                    failure_detail=CONNECT, exit_codes=codes)
                self.assertEqual(codes, [75 if list_error == CONNECT else None])
                self.assertEqual(state["daily_calls"], 4 if list_error == CONNECT else 6)

    def test_successful_list_with_failed_disappearance_confirmation_does_not_rotate(self):
        earlier = (self.START - dt.timedelta(minutes=1)).isoformat()
        initial = {"date": "2026-10-29", "cur_vid": 111, "last_poll": earlier, "last_seen": earlier}
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(
                SCRAPER, "fetch_station_list", return_value={"info": NO_BUS, "routes": []}):
            codes = []
            _, state = simulate(folder, [None] * 3, self.START, state=initial,
                                extra_args=("--primary-mode", "station-list", "--max-connect-timeouts", "2"),
                                failure_detail=CONNECT, exit_codes=codes)
        self.assertEqual(codes, [None])
        self.assertEqual(state["connection_health"]["consecutive_timeouts"], 0)

    def test_disabled_rotation_and_invalid_threshold(self):
        with tempfile.TemporaryDirectory() as folder:
            codes = []
            _, state = simulate(folder, [None] * 10, self.START,
                                extra_args=("--max-connect-timeouts", "0"),
                                failure_detail=CONNECT, exit_codes=codes)
        self.assertEqual(codes, [None])
        self.assertEqual(state["connection_health"]["consecutive_timeouts"], 10)
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            SCRAPER.parse_args(["--max-connect-timeouts", "-1"])

    def test_cli_propagates_rotation_exit_and_reads_session_configuration(self):
        with mock.patch.dict(os.environ, {"BUS_MAX_CONNECT_TIMEOUTS": "6", "BUS_SESSION_ID": "shared-session"}):
            args = SCRAPER.parse_args([])
        self.assertEqual((args.max_connect_timeouts, args.session_id), (6, "shared-session"))
        with mock.patch.object(SCRAPER, "parse_args", return_value=args), \
                mock.patch.object(SCRAPER, "run_loop", return_value=75):
            self.assertEqual(SCRAPER.main(), 75)


@unittest.skipUnless(shutil.which("bash"), "bash is required for session integration tests")
class RunnerRecoverySessionTests(unittest.TestCase):
    def session(self, publish_failures=0, scrape_code=75):
        script = (ROOT / "bus-arrival/scripts/session.sh").read_text(encoding="utf-8").rsplit('main "$@"', 1)[0]
        fake_commands = r'''
git() { return 0; }
sleep() { :; }
publish_calls=0
python() {
  if [[ $1 == -c ]]; then echo test-session; return 0; fi
  if [[ $* == *--gate-only* ]]; then
    # gate runs in a subshell; the published marker ends the normal session.
    if [[ $publish_calls -gt 0 ]]; then echo reason=after_window; else echo reason=ok; fi
    echo wait_seconds=0
    return 0
  fi
  if [[ $* == *scrape.py* ]]; then
    echo "scrape session=$BUS_SESSION_ID"
    return SCRAPE_CODE
  fi
  return 0
}
publish() {
  publish_calls=$((publish_calls + 1))
  echo "publish $publish_calls"
  (( publish_calls > PUBLISH_FAILURES ))
}
main
'''.replace("SCRAPE_CODE", str(scrape_code)).replace("PUBLISH_FAILURES", str(publish_failures))
        result = subprocess.run(["bash"], input=(script + fake_commands).encode("utf-8"), capture_output=True, timeout=15)
        return result.returncode, result.stdout.decode("utf-8"), result.stderr.decode("utf-8")

    def test_rotation_waits_for_successful_publication(self):
        code, output, _ = self.session(publish_failures=1)
        self.assertEqual(code, 75)
        self.assertEqual(output.count("scrape session=test-session"), 1)
        self.assertLess(output.index("publish 2"), output.index("기록 게시 완료"))

    def test_publication_failure_keeps_recovery_exit_from_claiming_success(self):
        code, output, _ = self.session(publish_failures=3)
        self.assertEqual(code, 1)
        self.assertEqual(output.count("publish "), 3)
        self.assertIn("보존용 artifact", output)
        self.assertNotIn("기록 게시 완료", output)

    def test_normal_segment_continues_without_rotation(self):
        code, output, _ = self.session(scrape_code=0)
        self.assertEqual(code, 0)
        self.assertEqual(output.count("publish "), 1)
        self.assertNotIn("기록 게시 완료", output)


class RunnerDiagnosticsTests(unittest.TestCase):
    def test_only_validated_network_metadata_is_recorded(self):
        responses = [SCRAPER.httpx.Response(200, text="northcentralus"),
                     SCRAPER.httpx.Response(200, text="203.0.113.42")]
        for response in responses:
            response.request = SCRAPER.httpx.Request("GET", "https://example.test")
        with mock.patch.object(DIAGNOSTICS.httpx, "get", side_effect=responses) as fetch, \
                mock.patch.object(DIAGNOSTICS.socket, "getaddrinfo", return_value=[(2, 1, 0, "", ("27.101.236.63", 443))]), \
                mock.patch.dict(os.environ, {"SERVICE_KEY": "secret-key", "GITHUB_TOKEN": "secret-token"}):
            data = DIAGNOSTICS.collect()
        self.assertEqual(data["region"], "northcentralus")
        self.assertEqual(data["public_ip"], "203.0.113.42")
        self.assertEqual(data["api_addresses"], ["27.101.236.63"])
        self.assertFalse(fetch.call_args_list[0].kwargs["trust_env"])
        self.assertNotIn("secret", json.dumps(data))

    def test_diagnostic_network_failures_are_optional_and_do_not_echo_exceptions(self):
        with mock.patch.object(DIAGNOSTICS.httpx, "get", side_effect=SCRAPER.httpx.ConnectTimeout("serviceKey=secret")), \
                mock.patch.object(DIAGNOSTICS.socket, "getaddrinfo", side_effect=OSError("secret")):
            data = DIAGNOSTICS.collect()
        self.assertIsNone(data["region"])
        self.assertIsNone(data["public_ip"])
        self.assertEqual(data["api_addresses"], [])
        self.assertNotIn("secret", json.dumps(data))

    def test_unexpected_response_text_is_not_written_to_diagnostics(self):
        response = SCRAPER.httpx.Response(200, text="serviceKey=secret",
                                         request=SCRAPER.httpx.Request("GET", "https://example.test"))
        with mock.patch.object(DIAGNOSTICS.httpx, "get", return_value=response), \
                mock.patch.object(DIAGNOSTICS.socket, "getaddrinfo", return_value=[]):
            data = DIAGNOSTICS.collect()
        self.assertIsNone(data["region"])
        self.assertIsNone(data["public_ip"])
        self.assertNotIn("secret", json.dumps(data))


if __name__ == "__main__":
    unittest.main()
