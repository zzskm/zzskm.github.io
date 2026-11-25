"""garmin-weight 서비스 워커를 실제 브라우저로 확인한다 (재검토 FE5, TD1).

앱 폴더의 사본을 임시 폴더에 두고 GitHub Pages와 같은 캐시 헤더(max-age=600)로 내보낸다. 요약은 합성 행으로 만들고
저장소의 data/ 파일은 쓰지 않는다. 브라우저는 프로필을 유지한 채 여러 번 다시 띄운다(방문 사이에 캐시가 남아야 한다).
오프라인은 서버를 멈추고 이름 풀이를 막아 만든다. 서비스 워커가 보내는 요청도 함께 끊긴다.

Playwright가 없으면 건너뛴다. GARMIN_REQUIRE_BROWSER_TESTS=1이면 건너뛰지 않고 실패한다(CI).
"""
from __future__ import annotations

import functools
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import unittest
from datetime import date, timedelta
from math import sin
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "garmin-weight"
APP_FILES = ("index.html", "app.js", "app.helpers.js", "enhancements.js", "style.css", "sw.js", "manifest.webmanifest", "config.json")

_spec = importlib.util.spec_from_file_location("sync_garmin_for_sw_browser", APP / "scripts" / "sync_garmin.py")
sync_garmin = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules[_spec.name] = sync_garmin
_spec.loader.exec_module(sync_garmin)


def synthetic_summary(level: float) -> dict:
    start = date(2030, 1, 1)
    rows = [{
        "date": (start + timedelta(days=i)).isoformat(), "weight_kg": round(level + 0.25 * sin(i * 1.3), 2),
        "weight_measure_count": 1, "exercise_minutes": 30, "exercise_calories": 250, "activity_count": 0, "steps": 7000,
        "sleep_hours": None, "resting_hr": 60, "visceral_fat": 20, "metabolic_age": None, "body_fat_percent": 29.0,
    } for i in range(60)]
    return sync_garmin.build_summary(rows, {"targetWeightKg": 78.0})


class PagesLikeHandler(http.server.SimpleHTTPRequestHandler):
    """GitHub Pages처럼 모든 응답에 max-age=600을 붙인다."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "max-age=600")
        super().end_headers()

    def log_message(self, *args) -> None:
        pass


class ServiceWorkerBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not importlib.util.find_spec("playwright"):
            if os.getenv("GARMIN_REQUIRE_BROWSER_TESTS") == "1":
                raise RuntimeError("Playwright is required (GARMIN_REQUIRE_BROWSER_TESTS=1)")
            raise unittest.SkipTest("Playwright unavailable")
        from playwright.sync_api import sync_playwright

        cls.pw = sync_playwright().start()
        cls.executable = os.getenv("BROWSER_EXECUTABLE") or shutil.which("chromium") or cls.pw.chromium.executable_path
        if not Path(cls.executable).exists():
            cls.pw.stop()
            message = f"No browser executable at {cls.executable} (set BROWSER_EXECUTABLE)"
            if os.getenv("GARMIN_REQUIRE_BROWSER_TESTS") == "1":
                raise RuntimeError(message)
            raise unittest.SkipTest(message)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.pw.stop()

    def setUp(self) -> None:
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory(ignore_cleanup_errors=True)))
        self.site = self.tmp / "site"
        self.app = self.site / "garmin-weight"
        (self.app / "data").mkdir(parents=True)
        for name in APP_FILES:
            shutil.copy(APP / name, self.app / name)
        shutil.copytree(APP / "icons", self.app / "icons")
        self.write_summary(84.0)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}/garmin-weight/"
        self.server = None
        self.context = None
        self.addCleanup(self.stop_browser)
        self.addCleanup(self.stop_server)

    # --- 사이트 -----------------------------------------------------------------

    def write_summary(self, level: float) -> None:
        (self.app / "data" / "summary.json").write_text(json.dumps(synthetic_summary(level)), encoding="utf-8")

    def deploy_new_version(self, version: str) -> None:
        """자산 버전을 올린 배포를 흉내 낸다. index.html에는 새 배포임을 알아볼 표식을 넣는다."""
        sw = (self.app / "sw.js").read_text(encoding="utf-8")
        old = re.search(r"const ASSET_VERSION = '([0-9a-z]+)';", sw).group(1)
        (self.app / "sw.js").write_text(sw.replace(f"'{old}'", f"'{version}'"), encoding="utf-8")
        for name in ("index.html", "manifest.webmanifest"):
            text = (self.app / name).read_text(encoding="utf-8").replace(f"?v={old}", f"?v={version}")
            if name == "index.html":
                text = text.replace("<body>", f'<body data-deploy="{version}">')
            (self.app / name).write_text(text, encoding="utf-8")

    def start_server(self) -> None:
        handler = functools.partial(PagesLikeHandler, directory=str(self.site))
        http.server.ThreadingHTTPServer.allow_reuse_address = True
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop_server(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()
            self.server = None

    # --- 브라우저 ---------------------------------------------------------------

    def start_browser(self, offline: bool = False) -> None:
        self.stop_browser()
        if offline:
            self.stop_server()
        elif self.server is None:
            self.start_server()
        # 오프라인: 서버가 없고(로컬 연결 거부) CDN 이름도 풀리지 않는다.
        args = ["--host-resolver-rules=MAP * ~NOTFOUND"] if offline else []
        self.context = self.pw.chromium.launch_persistent_context(
            str(self.tmp / "profile"), executable_path=self.executable, headless=True, args=args,
            viewport={"width": 1280, "height": 900}, timezone_id="Asia/Seoul")

    def stop_browser(self) -> None:
        if self.context is not None:
            self.context.close()
            self.context = None

    def visit(self, path: str = "", expect_chart: bool = True):
        page = self.context.new_page()
        page.goto(self.url + path, wait_until="load")
        page.wait_for_function("document.querySelector('.app')?.dataset.state === 'ready'", timeout=20000)
        if expect_chart:
            page.wait_for_function("window.Chart && Chart.getChart(document.getElementById('weightChart'))", timeout=20000)
        return page

    def wait_for_worker(self, page, version: str | None = None) -> dict:
        """워커가 이 페이지를 맡고 설치 때의 미리 받기가 끝날 때까지 기다린 뒤 캐시 내용을 돌려준다."""
        page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        expected_shell = f"gw-shell-{version}" if version else None
        page.wait_for_function(
            """async (expected) => {
              const names = await caches.keys();
              const shell = names.find((n) => n.startsWith('gw-shell-') && (!expected || n === expected));
              if (!shell || !names.includes('gw-data-v1') || !names.includes('gw-runtime-v1')) return false;
              if (expected && names.some((n) => n.startsWith('gw-shell-') && n !== expected)) return false;
              const urls = async (name) => (await (await caches.open(name)).keys()).map((request) => request.url);
              // 미리 받는 CDN 자산 둘(Chart.js, Pretendard CSS)이 모두 들어올 때까지 기다린다. 둘은 따로 받아지므로
              // "하나 이상"만 보면 CSS만 들어온 순간에 통과해 버린다(Q5 브랜치의 CI에서 그렇게 실패했다).
              const runtime = await urls('gw-runtime-v1');
              const precached = ['chart.umd.js', 'pretendardvariable'].every((part) => runtime.some((url) => url.includes(part)));
              return (await urls(shell)).length >= 13 && (await urls('gw-data-v1')).length >= 2 && precached;
            }""", arg=expected_shell, timeout=30000)
        return page.evaluate(
            """async () => Object.fromEntries(await Promise.all((await caches.keys()).map(async (name) =>
              [name, (await (await caches.open(name)).keys()).map((r) => r.url)])))""")

    def facts(self, page) -> dict:
        return page.evaluate("""() => ({
          weight: document.getElementById('currentWeight').textContent.trim(),
          sync: document.querySelector('#lastSync .sync-text').textContent,
          deploy: document.body.dataset.deploy || null,
          chart: !!(window.Chart && Chart.getChart(document.getElementById('weightChart'))),
          controlled: !!navigator.serviceWorker.controller,
        })""")

    # --- 시나리오 ---------------------------------------------------------------

    def test_one_visit_is_enough_to_work_offline(self) -> None:
        self.start_browser()
        page = self.visit()
        caches = self.wait_for_worker(page)
        self.assertEqual({"gw-data-v1", "gw-runtime-v1"}, {name for name in caches if not name.startswith("gw-shell-")})
        self.assertEqual({f"{self.url}data/summary.json", f"{self.url}config.json"}, set(caches["gw-data-v1"]))
        self.assertTrue(any("chart.umd.js" in url for url in caches["gw-runtime-v1"]))
        online = self.facts(page)
        self.assertNotIn("오프라인 사본", online["sync"])

        self.start_browser(offline=True)
        for path in ("", "?utm_source=homescreen", "index.html?x=1"):
            with self.subTest(path=path):
                facts = self.facts(self.visit(path))
                self.assertEqual((online["weight"], True, True), (facts["weight"], facts["chart"], facts["controlled"]))
                self.assertIn("오프라인 사본", facts["sync"])

    def test_new_deploy_shows_on_the_next_visit_and_keeps_offline_data(self) -> None:
        self.start_browser()
        page = self.visit()
        self.wait_for_worker(page)
        self.assertIsNone(self.facts(page)["deploy"])

        # 배포: 자산 버전이 오르고 요약도 새로 나왔다. 브라우저의 HTTP 캐시에는 예전 index.html이 10분 동안 남아 있다.
        self.deploy_new_version("testbump1")
        self.write_summary(83.0)
        self.start_browser()
        page = self.visit()  # 이 방문은 예전 워커가 예전 화면을 준다. 뒤에서 새 워커가 설치된다.
        caches = self.wait_for_worker(page, version="testbump1")
        self.assertIn(f"{self.url}data/summary.json", caches["gw-data-v1"])
        second = self.facts(self.visit())
        self.assertEqual("testbump1", second["deploy"], "the visit after a deploy must show the new page")

        self.start_browser(offline=True)
        offline = self.facts(self.visit())
        self.assertEqual(("testbump1", second["weight"], True), (offline["deploy"], offline["weight"], offline["chart"]))
        self.assertIn("오프라인 사본", offline["sync"])

    def test_missing_summary_on_the_server_falls_back_to_the_stored_copy(self) -> None:
        self.start_browser()
        page = self.visit()
        self.wait_for_worker(page)
        weight = self.facts(page)["weight"]

        (self.app / "data" / "summary.json").unlink()  # 서버가 404를 준다
        facts = self.facts(self.visit())
        self.assertEqual((weight, True), (facts["weight"], facts["chart"]))
        self.assertIn("오프라인 사본", facts["sync"])


if __name__ == "__main__":
    unittest.main()
