"""실제 garminconnect(requirements.txt가 고정한 버전)로 수집 코드의 가정을 확인한다.

네트워크는 쓰지 않는다. requests의 어댑터와 토큰 엔드포인트 POST를 가짜로 바꾼다.
CI의 library 잡이 requirements.txt를 설치하고 GARMIN_REQUIRE_LIBRARY_TESTS=1로 돌린다.
라이브러리가 없는 곳(unit 잡, 로컬)에서는 건너뛴다.

여기서 확인하는 것:
- 수집이 부르는 메서드와 토큰 갱신 함수가 있다.
- 호출이 실패해도 표시 이름이 든 경로가 로그에 나가지 않는다(재검토 SY5).
- 토큰 로그인 실패에서 HTTP 상태를 읽을 수 있고, 갱신 실패의 이유를 구분할 수 있다(재검토 SY6).
  tests/test_garmin_sync.py의 FakeLoginGarmin이 흉내 내는 갈래가 실제와 같은지도 이 테스트가 본다.
"""
from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import json
import logging
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit

try:
    import requests
    from garminconnect import Garmin
    from requests.adapters import HTTPAdapter

    HAS_LIBRARY = True
except ImportError:  # 표준 라이브러리만 있는 환경
    HAS_LIBRARY = False

REQUIRED = os.environ.get("GARMIN_REQUIRE_LIBRARY_TESTS") == "1"

MODULE_PATH = Path(__file__).resolve().parents[1] / "garmin-weight" / "scripts" / "sync_garmin.py"
SPEC = importlib.util.spec_from_file_location("sync_garmin_for_library_tests", MODULE_PATH)
sync_garmin = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = sync_garmin
SPEC.loader.exec_module(sync_garmin)

SECRET = "SecretDisplayName"
DAY = "2026-11-24"
API_HOST = "connectapi.garmin.com"
TOKEN_HOST = "diauth.garmin.com"


def fake_jwt(expires_at: float) -> str:
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'RS256'})}.{part({'exp': expires_at, 'client_id': 'CLIENT'})}.signature"


def api_response(request, status: int, payload: dict | None = None):
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps(payload or {}).encode()
    response.headers["Content-Type"] = "application/json"
    response.url = request.url
    response.request = request
    return response


PROFILE = {"displayName": SECRET, "fullName": "x", "profileId": 1}
SETTINGS = {"userData": {"measurementSystem": "metric"}}


class Transport:
    """가짜 전송 계층. api와 refresh는 HTTP 상태, 예외, 또는 상태의 목록(호출 순서대로, 마지막 값이 반복)이다."""

    def __init__(self, api=200, refresh=200) -> None:
        self.api = api if isinstance(api, list) else [api]
        self.refresh = refresh if isinstance(refresh, list) else [refresh]
        self.urls: list[str] = []
        self.api_calls = 0
        self.refresh_calls = 0

    @staticmethod
    def _next(plan: list, index: int):
        return plan[min(index, len(plan) - 1)]

    def send(self, adapter, request, **kwargs):
        self.urls.append(request.url)
        outcome = self._next(self.api, self.api_calls)
        self.api_calls += 1
        if isinstance(outcome, Exception):
            raise outcome
        payload = PROFILE if "socialProfile" in request.url else SETTINGS
        return api_response(request, outcome, payload if outcome == 200 else {})

    def post(self, url, **kwargs):
        self.urls.append(url)
        outcome = self._next(self.refresh, self.refresh_calls)
        self.refresh_calls += 1
        if isinstance(outcome, Exception):
            raise outcome
        answer = mock.Mock()
        answer.status_code = outcome
        answer.ok = outcome == 200
        answer.text = "{}"
        answer.json = lambda: {"access_token": fake_jwt(time.time() + 3600), "refresh_token": "REFRESH2"}
        return answer

    def hosts(self) -> set[str]:
        return {urlsplit(url).netloc for url in self.urls}

    @contextlib.contextmanager
    def installed(self):
        transport = self

        def send(adapter, request, **kwargs):
            return transport.send(adapter, request, **kwargs)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(HTTPAdapter, "send", send))
            stack.enter_context(mock.patch("requests.post", self.post))
            with contextlib.suppress(ImportError):
                import curl_cffi.requests  # noqa: F401

                stack.enter_context(mock.patch("curl_cffi.requests.post", self.post))
            stack.enter_context(mock.patch("time.sleep", lambda seconds: None))
            yield self


class LibraryTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not HAS_LIBRARY:
            if REQUIRED:
                raise AssertionError("garminconnect must be installed when GARMIN_REQUIRE_LIBRARY_TESTS=1")
            raise unittest.SkipTest("garminconnect is not installed")

    def setUp(self) -> None:
        # 로거 상태는 프로세스 전체가 공유한다. 테스트가 바꾼 것을 되돌린다.
        root = logging.getLogger()
        library = logging.getLogger("garminconnect")
        saved = (root.level, list(root.handlers), library.level, library.propagate, list(library.handlers))

        def restore() -> None:
            root.setLevel(saved[0])
            root.handlers[:] = saved[1]
            library.setLevel(saved[2])
            library.propagate = saved[3]
            library.handlers[:] = saved[4]

        self.addCleanup(restore)
        self.stream = io.StringIO()
        root.handlers[:] = [logging.StreamHandler(self.stream)]
        root.setLevel(logging.INFO)
        sync_garmin.configure_logging("INFO")

    def client(self):
        client = Garmin()
        client.retry_min_wait = client.retry_max_wait = 0.0
        return client


class ContractTests(LibraryTestCase):
    def test_client_has_every_method_the_sync_calls(self) -> None:
        missing = [name for name in sync_garmin.GARMIN_METHODS if not callable(getattr(Garmin, name, None))]
        self.assertEqual([], missing)

    def test_inner_client_has_the_refresh_and_dump_functions(self) -> None:
        # build_client는 401·403 뒤에 리프레시 토큰을 직접 써 본다. 이름이 바뀌면 그 판정이 조용히 빠진다.
        inner = self.client().client
        self.assertTrue(callable(getattr(inner, "_refresh_di_token", None)))
        self.assertTrue(callable(getattr(inner, "dump", None)))
        self.assertEqual("garmin_tokens.json", sync_garmin.TOKEN_FILE_NAME)


class PublicLogTests(LibraryTestCase):
    """재검토 SY5: 재시도가 끝난 5xx와 네트워크 오류에서 라이브러리는 요청 경로를 logger.exception으로 남긴다."""

    FAILURES = {
        "503": 503,
        "connection error": requests.ConnectionError("boom") if HAS_LIBRARY else None,
        "timeout": requests.Timeout("slow") if HAS_LIBRARY else None,
    }
    # 경로에 표시 이름이 들어가는 호출.
    METHODS = ("get_stats", "get_heart_rates", "get_sleep_data")

    def failing_client(self):
        client = self.client()
        client.display_name = SECRET
        client.client.di_token = "aaa.bbb.ccc"
        return client

    def test_failed_calls_leave_only_our_own_line(self) -> None:
        for label, failure in self.FAILURES.items():
            for method in self.METHODS:
                with self.subTest(failure=label, method=method):
                    self.stream.seek(0)
                    self.stream.truncate()
                    log = sync_garmin.CallLog()
                    with Transport(api=failure).installed() as transport:
                        value, status = sync_garmin.safe_call(self.failing_client(), method, DAY, log=log)
                    self.assertEqual((None, "failed"), (value, status))
                    # 요청 경로에는 실제로 표시 이름이 들어 있었다.
                    self.assertTrue(any(SECRET in url for url in transport.urls), transport.urls)
                    text = self.stream.getvalue()
                    self.assertNotIn(SECRET, text)
                    self.assertNotIn("Traceback", text)
                    self.assertEqual(1, len(text.splitlines()), text)
                    self.assertIn(f"garmin endpoint={method} day={DAY} failed error=GarminConnectConnectionError", text)

    def test_the_library_does_log_the_path_when_its_logger_is_left_on(self) -> None:
        # 대조군. 이 테스트가 실패하면 라이브러리가 경로를 더는 남기지 않는 것이므로 configure_logging의 차단을 다시 볼 수 있다.
        library = logging.getLogger("garminconnect")
        library.setLevel(logging.ERROR)  # 재검토 전의 설정
        library.propagate = True
        with Transport(api=503).installed():
            sync_garmin.safe_call(self.failing_client(), "get_stats", DAY, log=sync_garmin.CallLog())
        self.assertIn(SECRET, self.stream.getvalue())


class TokenLoginTests(LibraryTestCase):
    """재검토 SY6: 자격 증명 없는 클라이언트의 토큰 로그인이 어떻게 실패하는지."""

    def setUp(self) -> None:
        super().setUp()
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.token_file = self.tmp / sync_garmin.TOKEN_FILE_NAME

    def write_tokens(self, expires_in: float) -> str:
        text = json.dumps({"di_token": fake_jwt(time.time() + expires_in), "di_refresh_token": "REFRESH", "di_client_id": "CLIENT"})
        self.token_file.write_text(text, encoding="utf-8")
        return text

    def stored_refresh_token(self) -> str:
        return json.loads(self.token_file.read_text(encoding="utf-8"))["di_refresh_token"]

    def test_valid_token_logs_in_without_touching_the_sso(self) -> None:
        self.write_tokens(3600)
        with Transport().installed() as transport:
            self.assertIsNone(sync_garmin._try_login(self.client(), str(self.tmp)))
        self.assertEqual({API_HOST}, transport.hosts())
        self.assertEqual(0, transport.refresh_calls)

    def test_expired_token_is_refreshed_by_the_library_and_persisted(self) -> None:
        self.write_tokens(-60)
        with Transport().installed() as transport:
            self.assertIsNone(sync_garmin._try_login(self.client(), str(self.tmp)))
        self.assertEqual({API_HOST, TOKEN_HOST}, transport.hosts())
        self.assertEqual("REFRESH2", self.stored_refresh_token())

    def test_api_failures_carry_the_status_and_never_fall_back_to_a_password(self) -> None:
        cases = {
            401: (401, False),
            403: (403, False),
            429: (429, True),
            503: (503, True),
            "connection error": (None, True),
        }
        for label, (status, transient) in cases.items():
            with self.subTest(api=label):
                before = self.write_tokens(3600)
                failure = requests.ConnectionError("boom") if label == "connection error" else label
                with Transport(api=failure, refresh=400).installed() as transport:
                    error = sync_garmin._try_login(self.client(), str(self.tmp))
                self.assertIsNotNone(error)
                self.assertEqual(status, sync_garmin._http_status(error))
                self.assertEqual(transient, sync_garmin._token_failure_is_transient(error))
                # 자격 증명이 없으므로 SSO로 가지 않는다. 토큰 파일도 그대로다.
                self.assertLessEqual(transport.hosts(), {API_HOST, TOKEN_HOST})
                self.assertEqual(before, self.token_file.read_text(encoding="utf-8"))
                self.assertNotIn(SECRET, sync_garmin.describe_error(error))

    def test_a_failed_refresh_looks_like_401_and_only_the_refresh_function_tells_why(self) -> None:
        cases = {400: "rejected", 401: "rejected", 429: "transient", 503: "transient",
                 "connection error": "transient"}
        for label, verdict in cases.items():
            with self.subTest(refresh=label):
                self.write_tokens(-60)
                failure = requests.ConnectionError("boom") if label == "connection error" else label
                client = self.client()
                with Transport(api=401, refresh=failure).installed():
                    error = sync_garmin._try_login(client, str(self.tmp))
                    self.assertEqual(401, sync_garmin._http_status(error))
                    self.assertEqual(verdict, sync_garmin._refresh_verdict(client))
                self.assertEqual("REFRESH", self.stored_refresh_token())

    def test_refresh_function_succeeds_once_the_endpoint_is_back(self) -> None:
        self.write_tokens(-60)
        client = self.client()
        with Transport(api=401, refresh=503).installed() as transport:
            error = sync_garmin._try_login(client, str(self.tmp))
            self.assertEqual(401, sync_garmin._http_status(error))
            transport.refresh = [200]  # 토큰 엔드포인트가 돌아왔다
            self.assertEqual("refreshed", sync_garmin._refresh_verdict(client))
            client.client.dump(str(self.tmp))
        self.assertEqual("REFRESH2", self.stored_refresh_token())


class BuildClientTests(LibraryTestCase):
    """build_client 전체를 실제 라이브러리로 돈다. 비밀번호 로그인(SSO)만 가짜로 바꾼다."""

    def setUp(self) -> None:
        super().setUp()
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.token_file = self.tmp / sync_garmin.TOKEN_FILE_NAME
        self.enterContext(mock.patch.dict(os.environ, {"GARMIN_EMAIL": "me@example.com", "GARMIN_PASSWORD": "pw"}))
        os.environ.pop("GARMIN_IS_CN", None)
        token_file = self.token_file
        test = self
        self.password_logins = 0

        class Recording(Garmin):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.retry_min_wait = self.retry_max_wait = 0.0

            def login(self, tokenstore=None):
                if self.username:
                    test.password_logins += 1
                    fresh = {"di_token": fake_jwt(time.time() + 3600), "di_refresh_token": "FRESH", "di_client_id": "CLIENT"}
                    token_file.write_text(json.dumps(fresh), encoding="utf-8")
                    return None, None
                return super().login(tokenstore)

        self.garmin_cls = Recording

    def write_tokens(self, expires_in: float) -> str:
        text = json.dumps({"di_token": fake_jwt(time.time() + expires_in), "di_refresh_token": "REFRESH", "di_client_id": "CLIENT"})
        self.token_file.write_text(text, encoding="utf-8")
        return text

    def build(self, transport: Transport):
        out = io.StringIO()
        with transport.installed(), contextlib.redirect_stdout(out):
            try:
                _, auth = sync_garmin.build_client(str(self.tmp), garmin_cls=self.garmin_cls)
            except sync_garmin.TokenLoginUnavailable as exc:
                auth = f"unavailable: {exc}"
        return auth, out.getvalue()

    def refresh_token(self) -> str:
        return json.loads(self.token_file.read_text(encoding="utf-8"))["di_refresh_token"]

    def test_valid_token(self) -> None:
        self.write_tokens(3600)
        auth, out = self.build(Transport())
        self.assertEqual(("token", "::notice::garmin token_cache=loaded\n", 0), (auth, out, self.password_logins))

    def test_api_outage_keeps_the_token(self) -> None:
        for failure in (429, 503):
            with self.subTest(api=failure):
                before = self.write_tokens(3600)
                auth, out = self.build(Transport(api=failure))
                self.assertEqual(f"unavailable: GarminConnectAuthenticationError status={failure}", auth)
                self.assertIn("token kept, password not used", out)
                self.assertEqual((before, 0), (self.token_file.read_text(encoding="utf-8"), self.password_logins))

    def test_refresh_outage_with_an_expired_token_keeps_the_token(self) -> None:
        before = self.write_tokens(-60)
        auth, out = self.build(Transport(api=401, refresh=429))
        self.assertEqual("unavailable: GarminConnectAuthenticationError status=401 refresh=unavailable", auth)
        self.assertEqual((before, 0), (self.token_file.read_text(encoding="utf-8"), self.password_logins))
        self.assertNotIn(SECRET, out)

    def test_rejected_refresh_token_falls_back_to_the_password(self) -> None:
        self.write_tokens(-60)
        auth, out = self.build(Transport(api=401, refresh=400))
        self.assertEqual(("password", 1, "FRESH"), (auth, self.password_logins, self.refresh_token()))
        self.assertEqual("::warning::garmin token login failed error=GarminConnectAuthenticationError status=401; using password\n"
                         "::notice::garmin token_cache=saved\n", out)

    def test_refresh_that_recovers_is_used_without_a_password(self) -> None:
        # 로그인 중의 갱신은 503이었다. build_client가 갱신을 직접 불러 볼 때는 토큰 엔드포인트가 돌아와 있고,
        # 새 토큰은 API가 받는다. 라이브러리 안의 재시도 횟수에 기대지 않게, 직접 부르는 시점에 전송 계층을 바꾼다.
        self.write_tokens(-60)
        transport = Transport(api=401, refresh=503)
        original = sync_garmin._refresh_verdict

        def recovered(client):
            transport.refresh = [200]
            transport.api = [200]
            return original(client)

        with mock.patch.object(sync_garmin, "_refresh_verdict", recovered):
            auth, out = self.build(transport)
        self.assertEqual(("token", 0, "REFRESH2"), (auth, self.password_logins, self.refresh_token()))
        self.assertEqual("::notice::garmin token refreshed after a rejected attempt\n::notice::garmin token_cache=loaded\n", out)


if __name__ == "__main__":
    unittest.main()
