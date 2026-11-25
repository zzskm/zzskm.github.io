"""garmin-weight 수집 테스트 (P3: S2 실패 구분, S3 필드 병합, sync 블록, dry-run; P4: 토큰 로그인; P5: 입력 추출).

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
        self.readiness: list | dict = []
        self.training_status: dict = {}
        self.activities: list[dict] = [{"duration": 1800.0, "calories": 250.0}]
        self.sleep: dict = {"dailySleepDTO": {"sleepTimeSeconds": 25200, "sleepScores": {"overall": {"value": 81}}}}
        self.weight_item: dict = {"samplePk": 1, "weight": 83900.0}

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
        return self._respond("get_sleep_data", self.sleep)

    def get_body_composition(self, day):
        return self._respond("get_body_composition", {
            "totalAverage": {"weight": 83900.0, "bodyFat": 28.8, "visceralFat": 19.0},
            "dateWeightList": [self.weight_item],
            "devices": {"3390012345": {"name": SECRET}},
        })

    def get_activities_fordate(self, day):
        return self._respond("get_activities_fordate", {"ActivitiesForDay": {"payload": list(self.activities)}})

    def get_activities_by_date(self, start, end):
        return self._respond("get_activities_by_date", list(self.history) if start != end else [])

    def get_training_readiness(self, day):
        return self._respond("get_training_readiness", self.readiness)

    def get_training_status(self, day):
        return self._respond("get_training_status", self.training_status)


EXISTING = {
    "date": DAY, "weight_kg": 84.1, "weight_measure_count": 1, "exercise_minutes": 45.0, "exercise_calories": 400.0,
    "activity_count": 1, "steps": 7000, "sleep_hours": 6.5, "resting_hr": 60.0, "visceral_fat": 20.0, "metabolic_age": None,
    "body_fat_percent": 29.3, "sleep_score": 75, "training_load_acute": None, "exercise_source": "activity",
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
        # 강도 운동 시간은 보통 20분 + 격렬 5분의 실제 분이다(격렬 2배 가중 아님, D3).
        self.assertEqual(0, row["activity_count"])
        self.assertEqual(25.0, row["exercise_minutes"])
        self.assertEqual(310.0, row["exercise_calories"])
        self.assertEqual("intensity", row["exercise_source"])
        self.assertIn("get_activities_by_date", client.calls)
        self.assertEqual("partial", log.status())

    def test_stats_fallback_needs_stats(self) -> None:
        client = FakeGarmin(empty=("get_activities_fordate",), fail=("get_stats",))
        result, _ = _sync_one(client)
        row = result.rows[DAY]
        self.assertEqual(0, row["activity_count"])
        self.assertEqual((45.0, 400.0, "activity"), (row["exercise_minutes"], row["exercise_calories"], row["exercise_source"]))
        self.assertEqual(7000, row["steps"])

    def test_every_key_field_empty_keeps_existing_row(self) -> None:
        empty_all = ("get_stats", "get_heart_rates", "get_sleep_data", "get_body_composition", "get_activities_fordate",
                     "get_activities_by_date", "get_training_readiness", "get_training_status")
        result, log = _sync_one(FakeGarmin(empty=empty_all))
        self.assertEqual(EXISTING, result.rows[DAY])
        self.assertEqual([DAY], result.kept_rows)
        self.assertEqual("ok", log.status())


def _status_payload(*devices: dict) -> dict:
    """get_training_status 응답 모양(라이브러리 문서와 같은 중첩). 기기 ID 키 아래 기기별 상태가 있다."""
    return {"userId": 1, "mostRecentTrainingStatus": {"latestTrainingStatusData": {
        str(3390000000 + index): device for index, device in enumerate(devices)}}}


def _device(day: str, acute: int | None, primary: bool = False) -> dict:
    return {"calendarDate": day, "primaryTrainingDevice": primary, "trainingStatus": 4,
            "acuteTrainingLoadDTO": {"acwrPercent": 50, "dailyTrainingLoadAcute": acute, "dailyTrainingLoadChronic": 300}}


class TrainingLoadTests(unittest.TestCase):
    """P5(D2): 준비도 리스트와 훈련 상태의 기기별 중첩에서 급성 부하를 꺼낸다. 다른 날 값은 쓰지 않는다."""

    def test_readiness_list_uses_latest_entry_of_the_day(self) -> None:
        readiness = [
            {"calendarDate": DAY, "timestamp": "2026-11-24T07:00:00.0", "acuteLoad": 300},
            {"calendarDate": DAY, "timestamp": "2026-11-24T19:00:00.0", "acuteLoad": 340},
            {"calendarDate": "2026-11-25", "timestamp": "2026-11-25T07:00:00.0", "acuteLoad": 999},
        ]
        self.assertEqual(340, sync_garmin.extract_readiness_load(readiness, DAY))
        self.assertIsNone(sync_garmin.extract_readiness_load([{"calendarDate": "2026-11-23", "acuteLoad": 1}], DAY))
        self.assertEqual(321, sync_garmin.extract_readiness_load([{"acuteLoad": 321}], DAY))  # 리포트 D2 재현
        self.assertEqual(321, sync_garmin.extract_readiness_load({"acuteLoad": 321}, DAY))
        self.assertIsNone(sync_garmin.extract_readiness_load([], DAY))

    def test_status_reads_nested_device_map_and_prefers_primary(self) -> None:
        payload = _status_payload(_device(DAY, 250), _device(DAY, 410, primary=True))
        self.assertEqual(410, sync_garmin.extract_status_load(payload, DAY))
        self.assertIsNone(sync_garmin.extract_status_load(_status_payload(_device("2026-11-01", 410)), DAY))
        self.assertIsNone(sync_garmin.extract_status_load({"userId": 1, "mostRecentTrainingStatus": None}, DAY))
        self.assertIsNone(sync_garmin.extract_status_load(_status_payload(_device(DAY, None)), DAY))

    def test_readiness_value_skips_status_call(self) -> None:
        client = FakeGarmin()
        client.readiness = [{"calendarDate": DAY, "acuteLoad": 280}]
        result, _ = _sync_one(client)
        self.assertEqual(280, result.rows[DAY]["training_load_acute"])
        self.assertNotIn("get_training_status", client.calls)

    def test_status_used_when_readiness_has_no_load(self) -> None:
        client = FakeGarmin()
        client.readiness = [{"calendarDate": DAY, "score": 60}]
        client.training_status = _status_payload(_device(DAY, 333))
        result, _ = _sync_one(client)
        self.assertEqual(333, result.rows[DAY]["training_load_acute"])
        self.assertIn("get_training_status", client.calls)

    def test_failed_training_calls_keep_existing_load(self) -> None:
        client = FakeGarmin(fail=("get_training_readiness", "get_training_status"))
        result, _ = _sync_one(client, {**EXISTING, "training_load_acute": 222})
        self.assertEqual(222, result.rows[DAY]["training_load_acute"])


class MetabolicAgeTests(unittest.TestCase):
    """P5(D2): 대사 나이는 epoch ms(그 나이의 생일)로 온다. 측정일 기준 만 나이로 바꾼다."""

    def test_epoch_ms_becomes_age_on_the_measurement_day(self) -> None:
        born = 378518400000.0  # 1981-12-30 00:00 UTC
        self.assertEqual(44, sync_garmin._safe_metabolic_age(born, DAY))
        self.assertEqual(43, sync_garmin._safe_metabolic_age(born, "2025-12-29"))
        self.assertEqual(44, sync_garmin._safe_metabolic_age(born, "2025-12-30"))
        self.assertIsNone(sync_garmin._safe_metabolic_age(born, None))

    def test_years_and_implausible_values(self) -> None:
        self.assertEqual(45, sync_garmin._safe_metabolic_age(45.4, DAY))
        self.assertIsNone(sync_garmin._safe_metabolic_age(5.0, DAY))
        self.assertIsNone(sync_garmin._safe_metabolic_age(1.0e9, DAY))  # epoch 초는 받지 않는다
        self.assertIsNone(sync_garmin._safe_metabolic_age(4102444800000.0, DAY))  # 미래 생일

    def test_row_gets_metabolic_age_from_total_average(self) -> None:
        client = FakeGarmin()
        original = client.get_body_composition

        def body(day):
            payload = original(day)
            payload["totalAverage"]["metabolicAge"] = 378518400000.0
            return payload

        client.get_body_composition = body
        self.assertEqual(44, _sync_one(client, None)[0].rows[DAY]["metabolic_age"])


class ExerciseSourceTests(unittest.TestCase):
    """P5(D3): 운동 값의 출처를 남기고, 활동이 있는 날은 일일 요약과 섞지 않는다."""

    def test_activity_day(self) -> None:
        result, _ = _sync_one(FakeGarmin(), None)
        row = result.rows[DAY]
        self.assertEqual((1, 30.0, 250.0, "activity"),
                         (row["activity_count"], row["exercise_minutes"], row["exercise_calories"], row["exercise_source"]))

    def test_activity_without_calories_is_not_mixed_with_daily_kcal(self) -> None:
        client = FakeGarmin()
        client.activities = [{"duration": 1200.0}]
        row = _sync_one(client, None)[0].rows[DAY]
        self.assertEqual((20.0, 0.0, "activity"), (row["exercise_minutes"], row["exercise_calories"], row["exercise_source"]))

    def test_no_activity_and_no_intensity_has_no_source(self) -> None:
        client = FakeGarmin(empty=("get_activities_fordate", "get_stats"))
        row = _sync_one(client, None)[0].rows[DAY]
        self.assertEqual((0, 0.0, 0.0, None),
                         (row["activity_count"], row["exercise_minutes"], row["exercise_calories"], row["exercise_source"]))

    def test_source_round_trips_through_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rows.csv"
            sync_garmin.write_rows(path, {DAY: {**EXISTING, "exercise_source": "intensity"},
                                          "2026-11-23": {**EXISTING, "date": "2026-11-23", "exercise_source": None}})
            text = path.read_text(encoding="utf-8")
            self.assertTrue(text.splitlines()[0].endswith(",exercise_source"))
            rows = sync_garmin.load_existing_rows(path)
            path.write_text(text.replace(",intensity", ",bogus"), encoding="utf-8")
            bogus = sync_garmin.load_existing_rows(path)
        self.assertEqual(("intensity", None), (rows[DAY]["exercise_source"], rows["2026-11-23"]["exercise_source"]))
        self.assertIsNone(bogus[DAY]["exercise_source"])

    def test_old_csv_without_the_column_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "old.csv"
            path.write_text("date,weight_kg,steps\n2026-11-24,84.1,7000\n", encoding="utf-8")
            rows = sync_garmin.load_existing_rows(path)
        self.assertEqual((84.1, 7000, None), (rows[DAY]["weight_kg"], rows[DAY]["steps"], rows[DAY]["exercise_source"]))


class ProtectExistingTests(unittest.TestCase):
    """긴 backfill용: 성공했는데 빈 값이 와도 기존 값을 지우지 않는다."""

    def test_protect_keeps_values_and_counts_them(self) -> None:
        client = FakeGarmin(empty=("get_sleep_data",))
        log = sync_garmin.CallLog()
        result = sync_garmin.sync_days(client, [DAY], {DAY: dict(EXISTING)}, log, protect=True)
        self.assertEqual((6.5, 75), (result.rows[DAY]["sleep_hours"], result.rows[DAY]["sleep_score"]))
        self.assertEqual({(DAY, "sleep_hours"), (DAY, "sleep_score")}, result.protected)
        _, merge = sync_garmin.merge_stats(result, {DAY: dict(EXISTING)})
        self.assertEqual(1, merge["sleep_hours"]["protected"])
        self.assertEqual(0, merge["sleep_hours"]["cleared"])

    def test_without_protect_empty_values_clear(self) -> None:
        result, _ = _sync_one(FakeGarmin(empty=("get_sleep_data",)))
        self.assertIsNone(result.rows[DAY]["sleep_hours"])
        _, merge = sync_garmin.merge_stats(result, {DAY: dict(EXISTING)})
        self.assertEqual(1, merge["sleep_hours"]["cleared"])


class ProbeKindsTests(unittest.TestCase):
    """P5 probe: 값 대신 값의 종류만 남긴다."""

    def test_metabolic_age_units(self) -> None:
        self.assertEqual(["null", "years", "epoch_ms", "epoch_s", "other"],
                         [sync_garmin._number_kind(v) for v in (None, 45.0, 1.0e12, 1.0e9, 5.0)])
        # 1981-12-30 00:00 UTC를 생일로 읽으면 2026-11-24에 44세다.
        body = {"dateWeightList": [{"calendarDate": DAY, "metabolicAge": 378518400000.0}],
                "totalAverage": {"metabolicAge": 378518400000.0}}
        kinds = sync_garmin.probe_value_kinds(body, None, [], None)
        self.assertEqual({"items": ["epoch_ms"], "totalAverage": "epoch_ms", "epochMsAsBirthDateInRange": True},
                         kinds["metabolicAge"])

    def test_sleep_kinds_without_values(self) -> None:
        # 2026-11-24 02:30을 현지 벽시계로 담은 값(UTC처럼 해석).
        start = 1795919400000
        sleep = {"dailySleepDTO": {"sleepTimeSeconds": 14700, "deepSleepSeconds": 3000, "lightSleepSeconds": 9000,
                                   "remSleepSeconds": 2700, "napTimeSeconds": None, "sleepStartTimestampLocal": start,
                                   "sleepWindowConfirmationType": "ENHANCED_CONFIRMED_FINAL"}}
        kinds = sync_garmin.probe_value_kinds({}, sleep, [{"acuteLoad": 1}], _status_payload(_device(DAY, 1)))
        self.assertEqual({"present": ["sleepTimeSeconds", "deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds",
                                      "sleepStartTimestampLocal"],
                          "startBucket": "night", "confirmation": "ENHANCED_CONFIRMED_FINAL", "stagesOverTotal": 1.0},
                         kinds["sleep"])
        self.assertEqual((1, 1), (kinds["readinessEntries"], kinds["trainingStatusDevices"]))
        self.assertNotIn("14700", json.dumps(kinds))


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

    def test_run_reports_merge_counts(self) -> None:
        code, out = self.run_main(FakeGarmin(empty=("get_sleep_data",)))
        self.assertEqual(0, code)
        self.assertIn("::notice::garmin merge new_days=0 ", out)
        self.assertIn("::notice::garmin cleared fields=", out)

    def test_protect_existing_flag_reaches_merge(self) -> None:
        code, out = self.run_main(FakeGarmin(empty=("get_sleep_data",)), "--protect-existing")
        self.assertEqual(0, code)
        self.assertIn("cleared=0 protected=", out)
        self.assertNotIn("garmin cleared fields=", out)

    def test_probe_dates_need_dry_run_and_select_days(self) -> None:
        code, out = self.run_main(FakeGarmin(), "--probe-dates", "2026-11-19,2026-09-27")
        self.assertEqual((2, "::error::--probe-dates needs --dry-run\n"), (code, out))
        report_path = self.tmp / "probe.json"
        code, _ = self.run_main(FakeGarmin(), "--dry-run", "--stats-output", str(report_path),
                                "--probe-dates", "2026-11-19, 2026-09-27")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual((0, 2, "2026-11-19"), (code, report["days"], report["endDate"]))
        self.assertEqual(["2026-09-27", "2026-11-19"], sorted(report["valueKinds"]))
        self.assertEqual(["sleepTimeSeconds"], report["valueKinds"]["2026-11-19"]["sleep"]["present"])

    def test_token_dir_reaches_build_client(self) -> None:
        argv = ["--config", str(self.config), "--output-csv", str(self.csv), "--output-summary", str(self.summary),
                "--previous-summary", str(self.summary), "--date", DAY, "--log-level", "ERROR"]
        with mock.patch.dict(sync_garmin.os.environ, {"GARMIN_TOKEN_DIR": str(self.tmp / "tokens")}), \
                mock.patch.object(sync_garmin, "build_client", return_value=(FakeGarmin(), "token")) as build, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(0, sync_garmin.main(argv))
        build.assert_called_once_with(str(self.tmp / "tokens"))
        self.assertIn("::notice::garmin auth=token", out.getvalue())
        self.assertEqual("token", json.loads(self.summary.read_text(encoding="utf-8"))["sync"]["auth"])


GOOD_TOKENS = {"di_token": "good", "di_refresh_token": "refresh", "di_client_id": "client"}


class FakeLoginGarmin:
    """garminconnect 0.3.20 Garmin.login(tokenstore)의 갈래를 흉내 낸다(라이브러리 소스로 확인).

    - 토큰 파일이 읽히면 그 토큰으로 프로필을 불러 본다. 거부되면 자격 증명이 있을 때만 새로 로그인한다.
    - 토큰이 없거나 못 읽으면 자격 증명으로 로그인하고, 토큰 디렉터리가 있으면 새 토큰을 쓴다.
    tokens에는 토큰 값별 동작을 둔다: "good"은 통과, "bad"는 401, "flaky"는 첫 시도만 503.
    """

    instances: list["FakeLoginGarmin"] = []
    flaky_seen = False
    fresh_tokens: dict = {"di_token": "fresh", "di_refresh_token": "fresh-refresh", "di_client_id": "client"}

    def __init__(self, email=None, password=None, is_cn=False, **_):
        self.email, self.password, self.is_cn = email, password, is_cn
        self.logins: list = []
        self.password_login = False
        FakeLoginGarmin.instances.append(self)

    def _token_ok(self, token: str) -> None:
        if token == "good":
            return
        if token == "flaky" and not FakeLoginGarmin.flaky_seen:
            FakeLoginGarmin.flaky_seen = True
            raise FakeApiError(503)
        if token == "flaky":
            return
        raise FakeApiError(401)

    def login(self, tokenstore=None):
        self.logins.append(tokenstore)
        path = Path(tokenstore) / "garmin_tokens.json" if tokenstore else None
        data = None
        if path is not None and path.exists():
            with contextlib.suppress(ValueError):
                data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("di_token"):
            try:
                self._token_ok(data["di_token"])
                return None, None
            except FakeApiError:
                if not self.email:
                    raise
        elif not self.email:
            raise RuntimeError("Username and password are required")
        if self.password != "pw":
            raise FakeApiError(401)
        self.password_login = True
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(FakeLoginGarmin.fresh_tokens), encoding="utf-8")
        return None, None


class BuildClientTests(unittest.TestCase):
    """P4: 토큰 디렉터리 먼저, 안 되면 비밀번호. 인증 방식과 캐시 상태를 값 없이 남긴다."""

    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.token_dir = self.tmp / "tokens"
        self.token_file = self.token_dir / "garmin_tokens.json"
        FakeLoginGarmin.instances = []
        FakeLoginGarmin.flaky_seen = False
        FakeLoginGarmin.fresh_tokens = {"di_token": "fresh", "di_refresh_token": "fresh-refresh", "di_client_id": "client"}
        env = {"GARMIN_EMAIL": "me@example.com", "GARMIN_PASSWORD": "pw"}
        self.enterContext(mock.patch.dict(sync_garmin.os.environ, env))
        for name in ("GARMIN_TOKENS", "GARMIN_TOKENS_JSON", "GARMINTOKENS", "GARMIN_IS_CN"):
            sync_garmin.os.environ.pop(name, None)

    def write_tokens(self, payload) -> None:
        self.token_dir.mkdir(parents=True, exist_ok=True)
        text = payload if isinstance(payload, str) else json.dumps(payload)
        self.token_file.write_text(text, encoding="utf-8")

    def build(self, token_dir: Path | None) -> tuple[object, str, str]:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            client, auth = sync_garmin.build_client(str(token_dir) if token_dir else None, garmin_cls=FakeLoginGarmin)
        return client, auth, out.getvalue()

    def stored(self) -> dict:
        return json.loads(self.token_file.read_text(encoding="utf-8"))

    def test_valid_tokens_log_in_without_credentials(self) -> None:
        self.write_tokens(GOOD_TOKENS)
        client, auth, out = self.build(self.token_dir)
        self.assertEqual("token", auth)
        self.assertEqual(1, len(FakeLoginGarmin.instances))
        self.assertIsNone(client.email)  # 자격 증명 없이 만들어야 몰래 비밀번호로 넘어가지 않는다.
        self.assertEqual([str(self.token_dir)], client.logins)
        self.assertEqual("::notice::garmin token_cache=loaded\n", out)

    def test_first_run_logs_in_with_password_and_saves_tokens(self) -> None:
        client, auth, out = self.build(self.token_dir)
        self.assertEqual("password", auth)
        self.assertTrue(client.password_login)
        self.assertEqual("fresh", self.stored()["di_token"])
        self.assertEqual("::notice::garmin token_cache=saved\n", out)

    def test_rejected_tokens_fall_back_and_report_class_only(self) -> None:
        self.write_tokens({**GOOD_TOKENS, "di_token": "bad"})
        client, auth, out = self.build(self.token_dir)
        self.assertEqual("password", auth)
        self.assertEqual(
            "::warning::garmin token login failed error=FakeApiError status=401; using password\n"
            "::notice::garmin token_cache=saved\n", out)
        self.assertNotIn(SECRET, out)
        self.assertEqual("fresh", self.stored()["di_token"])

    def test_transient_token_failure_still_counts_as_password_login(self) -> None:
        # 첫 시도가 일시 오류로 실패하면 토큰 파일을 지우고 비밀번호로 로그인한다.
        # 지우지 않으면 두 번째 login이 같은 토큰으로 성공해 인증 방식을 잘못 기록한다.
        self.write_tokens({**GOOD_TOKENS, "di_token": "flaky"})
        client, auth, out = self.build(self.token_dir)
        self.assertEqual("password", auth)
        self.assertTrue(client.password_login)
        self.assertIn("error=FakeApiError status=503", out)
        self.assertEqual("fresh", self.stored()["di_token"])

    def test_unusable_file_is_replaced(self) -> None:
        for payload in ("not json", {"di_token": None, "di_refresh_token": None}, {"oauth1": "x"}):
            with self.subTest(payload=payload):
                self.write_tokens(payload)
                _, auth, out = self.build(self.token_dir)
                self.assertEqual("password", auth)
                self.assertTrue(out.startswith("::warning::garmin token file unusable; using password\n"))
                self.assertEqual("fresh", self.stored()["di_token"])

    def test_password_login_without_usable_tokens_is_reported(self) -> None:
        # 웹 전략으로 로그인하면 라이브러리는 DI 토큰 없이 파일을 쓴다. 다음 실행도 비밀번호 로그인이 된다.
        FakeLoginGarmin.fresh_tokens = {"di_token": None, "di_refresh_token": None, "di_client_id": None}
        _, auth, out = self.build(self.token_dir)
        self.assertEqual(("password", "::notice::garmin token_cache=unsaved\n"), (auth, out))

    def test_without_token_dir_logs_in_with_password_only(self) -> None:
        client, auth, out = self.build(None)
        self.assertEqual("password", auth)
        self.assertEqual([None], client.logins)
        self.assertEqual("", out)

    def test_missing_credentials_after_token_failure(self) -> None:
        self.write_tokens({**GOOD_TOKENS, "di_token": "bad"})
        sync_garmin.os.environ.pop("GARMIN_PASSWORD")
        with self.assertRaises(sync_garmin.MissingCredentials), contextlib.redirect_stdout(io.StringIO()):
            sync_garmin.build_client(str(self.token_dir), garmin_cls=FakeLoginGarmin)

    def test_wrong_password_propagates(self) -> None:
        sync_garmin.os.environ["GARMIN_PASSWORD"] = "wrong"
        with self.assertRaises(FakeApiError), contextlib.redirect_stdout(io.StringIO()):
            sync_garmin.build_client(str(self.token_dir), garmin_cls=FakeLoginGarmin)

    def test_legacy_token_secrets_are_ignored(self) -> None:
        # GARMIN_TOKENS는 이제 캐시 암호화 키 시크릿 이름이다. 코드가 그 값을 토큰으로 쓰면 안 된다.
        sync_garmin.os.environ["GARMIN_TOKENS"] = json.dumps(GOOD_TOKENS)
        _, auth, _ = self.build(None)
        self.assertEqual("password", auth)
        self.assertNotIn("GARMIN_TOKENS", MODULE_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
