"""garmin-weight 수집 실패 경로 테스트 (P3: S2 실패 구분, S3 필드 병합, sync 블록, dry-run).

가짜 Garmin 클라이언트를 쓴다. garminconnect가 설치돼 있지 않아도 돈다.
"""
from __future__ import annotations

import contextlib
import csv
import importlib.util
import io
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "garmin-weight" / "scripts" / "sync_garmin.py"
SPEC = importlib.util.spec_from_file_location("sync_garmin_for_sync_tests", MODULE_PATH)
sync_garmin = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = sync_garmin
SPEC.loader.exec_module(sync_garmin)
# 실패 경로 경고가 테스트 출력에 섞이지 않게 한다. assertLogs는 자체 처리기를 붙이므로 영향이 없다.
sync_garmin.LOGGER.addHandler(logging.NullHandler())

# 예외 메시지와 응답 값에 섞여 들어간 식별자. 로그·주석·보고서 어디에도 나오면 안 된다.
SECRET = "SecretDisplayName"
DAY = "2026-11-24"


class FakeApiError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"API Error {status} for https://connect.garmin.com/modern/profile/{SECRET}")
        self.response = mock.Mock(status_code=status)


class FakeGarmin:
    """정상 응답을 돌려준다. fail에 든 메서드는 예외를, empty에 든 메서드는 {}를 돌려준다."""

    def __init__(self, fail: tuple[str, ...] | str = (), empty: tuple[str, ...] = (), status: int = 500) -> None:
        self.fail = fail
        self.empty = set(empty)
        self.status = status
        self.calls: list[str] = []
        self.history: list[dict] = []  # 기간 조회(시작일 != 종료일)에 돌려줄 활동

    def _respond(self, name: str, payload):
        self.calls.append(name)
        if self.fail == "*" or name in self.fail:
            raise FakeApiError(self.status)
        if name in self.empty:
            return {}
        return payload

    def get_stats(self, day):
        return self._respond("get_stats", {
            "totalSteps": 8123, "restingHeartRate": 58, "moderateIntensityMinutes": 20, "vigorousIntensityMinutes": 5,
            "activeKilocalories": 310, "displayName": SECRET,
        })

    def get_heart_rates(self, day):
        return self._respond("get_heart_rates", {"restingHeartRate": 57, "heartRateValues": [[1, 60], [2, None]]})

    def get_sleep_data(self, day):
        return self._respond("get_sleep_data", {"dailySleepDTO": {"sleepTimeSeconds": 25200, "sleepScores": {"overall": {"value": 81}}}})

    def get_body_composition(self, day):
        return self._respond("get_body_composition", {
            "totalAverage": {"weight": 83900.0, "bodyFat": 28.8, "visceralFat": 19.0},
            "dateWeightList": [{"samplePk": 1, "weight": 83900.0}],
            "devices": {"3390012345": {"name": SECRET}},
        })

    def get_activities_fordate(self, day):
        return self._respond("get_activities_fordate", {"ActivitiesForDay": {"payload": [{"duration": 1800.0, "calories": 250.0}]}})

    def get_activities_by_date(self, start, end):
        return self._respond("get_activities_by_date", list(self.history) if start != end else [])

    def get_training_readiness(self, day):
        return self._respond("get_training_readiness", [])

    def get_training_status(self, day):
        return self._respond("get_training_status", {})


EXISTING = {
    "date": DAY, "weight_kg": 84.1, "weight_measure_count": 1, "exercise_minutes": 45.0, "exercise_calories": 400.0,
    "activity_count": 1, "steps": 7000, "sleep_hours": 6.5, "resting_hr": 60.0, "visceral_fat": 20.0, "metabolic_age": None,
    "body_fat_percent": 29.3, "sleep_score": 75, "training_load_acute": None,
}


def _sync_one(client: FakeGarmin, existing: dict | None = EXISTING):
    log = sync_garmin.CallLog()
    existing_rows = {DAY: dict(existing)} if existing else {}
    result = sync_garmin.sync_days(client, [DAY], existing_rows, log)
    return result, log


class SafeCallTests(unittest.TestCase):
    def test_statuses(self) -> None:
        log = sync_garmin.CallLog()
        self.assertEqual(({"a": 1}, "ok"), sync_garmin.safe_call(mock.Mock(get_x=lambda d: {"a": 1}), "get_x", DAY, log=log))
        self.assertEqual(({}, "empty"), sync_garmin.safe_call(mock.Mock(get_y=lambda d: {}), "get_y", DAY, log=log))
        self.assertEqual((None, "empty"), sync_garmin.safe_call(mock.Mock(get_z=lambda d: None), "get_z", DAY, log=log))
        self.assertEqual((None, "failed"), sync_garmin.safe_call(object(), "get_missing", DAY, log=log))
        self.assertEqual({"ok": 1, "empty": 2, "failed": 1}, log.totals())
        self.assertEqual({"get_missing": {"MethodUnavailable": 1}}, log.errors)

    def test_failure_logs_class_and_status_only(self) -> None:
        log = sync_garmin.CallLog()
        with self.assertLogs(sync_garmin.LOGGER, "WARNING") as logs:
            value, status = sync_garmin.safe_call(FakeGarmin(fail="*", status=429), "get_stats", DAY, log=log)
        self.assertEqual((None, "failed"), (value, status))
        output = "\n".join(logs.output)
        self.assertIn("endpoint=get_stats", output)
        self.assertIn("FakeApiError status=429", output)
        self.assertNotIn(SECRET, output)
        self.assertNotIn("http", output)
        self.assertEqual({"get_stats": {"FakeApiError status=429": 1}}, log.errors)

    def test_status_found_on_cause_chain(self) -> None:
        try:
            try:
                raise FakeApiError(403)
            except FakeApiError as inner:
                raise RuntimeError("wrapped") from inner
        except RuntimeError as outer:
            self.assertEqual("RuntimeError status=403", sync_garmin.describe_error(outer))


class FieldMergeTests(unittest.TestCase):
    """리포트 S3의 두 재현과 '성공했지만 비어 있음' 경로."""

    def test_all_calls_failing_keeps_existing_row(self) -> None:
        result, log = _sync_one(FakeGarmin(fail="*"))
        self.assertEqual(EXISTING, result.rows[DAY])
        self.assertEqual(sync_garmin.ROW_FIELDS, result.fetched[DAY].failed_fields)
        self.assertEqual("failed", log.status())

    def test_all_calls_failing_creates_no_new_row(self) -> None:
        result, _ = _sync_one(FakeGarmin(fail="*"), existing=None)
        self.assertNotIn(DAY, result.rows)

    def test_body_composition_failure_keeps_weight_and_updates_the_rest(self) -> None:
        result, log = _sync_one(FakeGarmin(fail=("get_body_composition",)))
        row = result.rows[DAY]
        self.assertEqual(84.1, row["weight_kg"])
        self.assertEqual(29.3, row["body_fat_percent"])
        self.assertEqual(20.0, row["visceral_fat"])
        self.assertEqual(1, row["weight_measure_count"])
        self.assertEqual(8123, row["steps"])
        self.assertEqual(7.0, row["sleep_hours"])
        self.assertEqual("partial", log.status())
        self.assertEqual(["get_body_composition"], log.failed_endpoints())

    def test_ok_but_empty_clears_field(self) -> None:
        result, _ = _sync_one(FakeGarmin(empty=("get_sleep_data",)))
        row = result.rows[DAY]
        self.assertIsNone(row["sleep_hours"])
        self.assertIsNone(row["sleep_score"])
        self.assertEqual(83.9, row["weight_kg"])

    def test_resting_hr_uses_any_successful_source(self) -> None:
        result, _ = _sync_one(FakeGarmin(fail=("get_heart_rates",)))
        self.assertEqual(58.0, result.rows[DAY]["resting_hr"])
        self.assertNotIn("resting_hr", result.fetched[DAY].failed_fields)

    def test_activity_failure_keeps_exercise_fields(self) -> None:
        result, _ = _sync_one(FakeGarmin(fail=("get_activities_fordate", "get_activities_by_date")))
        row = result.rows[DAY]
        self.assertEqual((1, 45.0, 400.0), (row["activity_count"], row["exercise_minutes"], row["exercise_calories"]))

    def test_activity_fordate_failure_falls_back_to_by_date(self) -> None:
        client = FakeGarmin(fail=("get_activities_fordate",))
        result, log = _sync_one(client)
        row = result.rows[DAY]
        # 대체 경로가 빈 목록을 돌려주면 활동 0건이고, 운동 값은 일일 요약으로 보강한다.
        self.assertEqual(0, row["activity_count"])
        self.assertEqual(30.0, row["exercise_minutes"])
        self.assertEqual(310.0, row["exercise_calories"])
        self.assertIn("get_activities_by_date", client.calls)
        self.assertEqual("partial", log.status())

    def test_stats_fallback_needs_stats(self) -> None:
        client = FakeGarmin(empty=("get_activities_fordate",), fail=("get_stats",))
        result, _ = _sync_one(client)
        row = result.rows[DAY]
        self.assertEqual(0, row["activity_count"])
        self.assertEqual((45.0, 400.0), (row["exercise_minutes"], row["exercise_calories"]))
        self.assertEqual(7000, row["steps"])

    def test_every_key_field_empty_keeps_existing_row(self) -> None:
        empty_all = ("get_stats", "get_heart_rates", "get_sleep_data", "get_body_composition", "get_activities_fordate",
                     "get_activities_by_date", "get_training_readiness", "get_training_status")
        result, log = _sync_one(FakeGarmin(empty=empty_all))
        self.assertEqual(EXISTING, result.rows[DAY])
        self.assertEqual([DAY], result.kept_rows)
        self.assertEqual("ok", log.status())


class DeclaredMethodsTests(unittest.TestCase):
    def test_every_called_method_is_declared_for_the_library_check(self) -> None:
        client = FakeGarmin(fail=("get_activities_fordate", "get_training_readiness"))
        _sync_one(client)
        self.assertIn("get_training_status", client.calls)
        self.assertIn("get_activities_by_date", client.calls)
        self.assertLessEqual(set(client.calls), set(sync_garmin.GARMIN_METHODS))


class StructureTests(unittest.TestCase):
    def test_structure_drops_values_and_masks_ids(self) -> None:
        shape = sync_garmin.describe_structure({
            "displayName": SECRET, "3390012345": {"x": 1}, "2026-11-24": 2.5, "values": [[1, 2.0], [3, None]], "nested": None,
        })
        text = json.dumps(shape)
        self.assertNotIn(SECRET, text)
        self.assertNotIn("3390012345", text)
        self.assertNotIn("2026-11-24", text)
        self.assertEqual("str", shape["displayName"])
        self.assertEqual({"<oneof>": [{"x": "int"}, "float"]}, shape["<id>"])
        self.assertEqual({"<list>": 2, "<item>": {"<list>": 2, "<item>": "float|int|null"}}, shape["values"])

    def test_nullable_object_is_marked(self) -> None:
        merged = sync_garmin._merge_shapes(sync_garmin.describe_structure({"a": 1}), "null")
        self.assertEqual({"a": "int", "<null>": True}, merged)


class MainTests(unittest.TestCase):
    """main()의 종료 코드, 주석, sync 블록, 파일 쓰기."""

    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.config = self.tmp / "config.json"
        self.config.write_text(json.dumps({"targetWeightKg": 78}), encoding="utf-8")
        self.csv = self.tmp / "daily.csv"
        self.summary = self.tmp / "summary.json"
        rows = {}
        for offset in range(20):
            day = (sync_garmin.date(2026, 11, 24) - sync_garmin.timedelta(days=19 - offset)).isoformat()
            rows[day] = {**EXISTING, "date": day, "weight_kg": round(84.5 - offset * 0.02, 2)}
        sync_garmin.write_rows(self.csv, rows)
        self.previous_sync = {"status": "ok", "lastAttemptAt": "2026-11-23T00:00:00Z", "lastSuccessAt": "2026-11-23T00:00:00Z"}
        self.summary.write_text(json.dumps({"generatedAt": "x", "sync": self.previous_sync}), encoding="utf-8")

    def run_main(self, client: FakeGarmin | None, *extra: str) -> tuple[int, str]:
        argv = ["--config", str(self.config), "--output-csv", str(self.csv), "--output-summary", str(self.summary),
                "--previous-summary", str(self.summary), "--date", DAY, "--backfill-days", "3", "--log-level", "ERROR", *extra]
        stdout = io.StringIO()
        with mock.patch.object(sync_garmin, "build_client", return_value=(client, "password")), contextlib.redirect_stdout(stdout):
            code = sync_garmin.main(argv)
        return code, stdout.getvalue()

    def test_all_failures_exit_nonzero_and_keep_last_success(self) -> None:
        csv_before = self.csv.read_text(encoding="utf-8")
        code, out = self.run_main(FakeGarmin(fail="*"))
        self.assertEqual(1, code)
        self.assertIn("::error::garmin every call failed", out)
        self.assertNotIn(SECRET, out)
        self.assertEqual(csv_before, self.csv.read_text(encoding="utf-8"))
        sync = json.loads(self.summary.read_text(encoding="utf-8"))["sync"]
        self.assertEqual("failed", sync["status"])
        self.assertEqual("2026-11-23T00:00:00Z", sync["lastSuccessAt"])
        self.assertEqual(0, sync["calls"]["ok"])

    def test_partial_failure_warns_and_records_sync_block(self) -> None:
        code, out = self.run_main(FakeGarmin(fail=("get_body_composition",)))
        self.assertEqual(0, code)
        self.assertIn("::warning::garmin endpoint=get_body_composition failed=3", out)
        self.assertIn("::notice::garmin auth=password status=partial", out)
        summary = json.loads(self.summary.read_text(encoding="utf-8"))
        sync = summary["sync"]
        self.assertEqual("partial", sync["status"])
        self.assertEqual(summary["generatedAt"], sync["lastSuccessAt"])
        self.assertEqual(summary["generatedAt"], sync["lastAttemptAt"])
        self.assertEqual(["get_body_composition"], sync["failedEndpoints"])
        self.assertEqual({"ok": 0, "empty": 0, "failed": 3}, sync["endpoints"]["get_body_composition"])
        self.assertEqual((3, DAY), (sync["days"], sync["endDate"]))
        with self.csv.open(encoding="utf-8", newline="") as handle:
            last = list(csv.DictReader(handle))[-1]
        self.assertEqual(("84.12", "8123"), (last["weight_kg"], last["steps"]))

    def test_login_failure_exits_without_writing(self) -> None:
        summary_before = self.summary.read_text(encoding="utf-8")
        stdout = io.StringIO()
        argv = ["--config", str(self.config), "--output-csv", str(self.csv), "--output-summary", str(self.summary),
                "--previous-summary", str(self.summary), "--log-level", "ERROR"]
        with mock.patch.object(sync_garmin, "build_client", side_effect=FakeApiError(429)), contextlib.redirect_stdout(stdout):
            code = sync_garmin.main(argv)
        self.assertEqual(1, code)
        self.assertEqual("::error::garmin login failed error=FakeApiError status=429\n", stdout.getvalue())
        self.assertEqual(summary_before, self.summary.read_text(encoding="utf-8"))

    def test_skip_garmin_carries_previous_sync(self) -> None:
        code, _ = self.run_main(None, "--skip-garmin")
        self.assertEqual(0, code)
        self.assertEqual(self.previous_sync, json.loads(self.summary.read_text(encoding="utf-8"))["sync"])

    def test_dry_run_writes_nothing_and_reports_counts_and_shapes(self) -> None:
        csv_before = self.csv.read_text(encoding="utf-8")
        summary_before = self.summary.read_text(encoding="utf-8")
        report_path = self.tmp / "probe.json"
        code, out = self.run_main(FakeGarmin(fail=("get_activities_fordate",)), "--dry-run", "--stats-output", str(report_path))
        self.assertEqual(0, code)
        self.assertEqual(csv_before, self.csv.read_text(encoding="utf-8"))
        self.assertEqual(summary_before, self.summary.read_text(encoding="utf-8"))
        text = report_path.read_text(encoding="utf-8")
        self.assertNotIn(SECRET, text + out)
        self.assertNotIn("83900", text)
        report = json.loads(text)
        self.assertEqual("partial", report["status"])
        self.assertEqual({"ok": 0, "empty": 0, "failed": 3}, report["endpoints"]["get_activities_fordate"])
        self.assertEqual({"ok": 0, "empty": 3, "failed": 0}, report["endpoints"]["get_activities_by_date"])
        self.assertEqual({"FakeApiError status=500": 3}, report["errors"]["get_activities_fordate"])
        self.assertEqual({"value": 3, "none": 0, "failed": 0}, report["fields"]["weight_kg"])
        self.assertEqual({"value": 0, "none": 3, "failed": 0}, report["fields"]["training_load_acute"])
        self.assertEqual(3, report["mergeVsCsv"]["fields"]["steps"]["changed"])
        self.assertIn("<id>", report["structures"]["get_body_composition"]["devices"])
        self.assertEqual("int", report["structures"]["get_stats"]["totalSteps"])
        self.assertNotIn("get_activities_fordate", report["structures"])
        self.assertNotIn("activityHistory", report)

    def test_dry_run_counts_activity_history_by_month_without_values(self) -> None:
        client = FakeGarmin()
        client.history = [
            {"activityId": 123456789, "activityName": SECRET, "startTimeLocal": "2026-05-03 07:10:00", "duration": 1800.0},
            {"activityId": 123456790, "activityName": SECRET, "startTimeLocal": "2026-05-14 07:10:00", "duration": 2400.0},
            {"activityId": 123456791, "activityName": SECRET, "startTimeLocal": "2026-11-20 18:00:00", "duration": 900.0},
            {"activityId": 123456792},
        ]
        report_path = self.tmp / "probe.json"
        code, out = self.run_main(client, "--dry-run", "--stats-output", str(report_path), "--probe-activities-since", "2026-03-01")
        self.assertEqual(0, code)
        text = report_path.read_text(encoding="utf-8")
        self.assertNotIn(SECRET, text + out)
        self.assertNotIn("123456789", text)
        history = json.loads(text)["activityHistory"]
        self.assertEqual(("2026-03-01", DAY, "ok", 4), (history["since"], history["until"], history["status"], history["total"]))
        self.assertEqual({"2026-05": 2, "2026-11": 1, "unknown": 1}, history["byMonth"])
        # 구조에는 키와 타입만 남는다(키가 없는 활동이 섞여도 있는 쪽의 타입).
        self.assertEqual({"activityId": "int", "activityName": "str", "startTimeLocal": "str", "duration": "float"},
                         history["structure"]["<item>"])


if __name__ == "__main__":
    unittest.main()
