"""garmin-weight 페이지 표시 회귀 테스트 (로컬 서버 + 결정적 요약 픽스처).

요약은 sync_garmin.build_summary로 합성 행에서 만든다. 실제 data/ 파일은 읽지 않는다.
Playwright가 없으면 건너뛴다. GARMIN_REQUIRE_BROWSER_TESTS=1이면 건너뛰지 않고 실패한다(CI).
"""
from __future__ import annotations

import functools
import http.server
import importlib.util
import os
import shutil
import sys
import threading
import unittest
from datetime import date, datetime, timedelta, timezone
from math import sin
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = "/garmin-weight/index.html"
TARGET_KG = 78.0

_spec = importlib.util.spec_from_file_location("sync_garmin_for_browser", ROOT / "garmin-weight" / "scripts" / "sync_garmin.py")
sync_garmin = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules[_spec.name] = sync_garmin
_spec.loader.exec_module(sync_garmin)


def _row(day: date, weight: float | None) -> dict:
    return {
        "date": day.isoformat(), "weight_kg": weight, "weight_measure_count": 1 if weight is not None else 0,
        "exercise_minutes": 30, "exercise_calories": 250 + (day.day % 5) * 40, "activity_count": 1,
        "steps": 7000, "sleep_hours": None, "resting_hr": 60, "visceral_fat": 20, "metabolic_age": None,
        "body_fat_percent": 29.0,
    }


def steady_summary(unmeasured_tail_days: int = 1) -> dict:
    """60일, 84kg 근처 잔물결. 마지막 측정은 추세보다 0.4kg 높아 인사이트 문장이 두 개 나온다."""
    start = date(2030, 1, 1)
    rows = []
    for i in range(60):
        weight = round(84.0 + 0.25 * sin(i * 1.3), 2)
        rows.append(_row(start + timedelta(days=i), weight))
    last_measured = len(rows) - 1 - unmeasured_tail_days
    rows[last_measured]["weight_kg"] = 84.45
    for i in range(last_measured + 1, len(rows)):
        rows[i]["weight_kg"] = None
        rows[i]["weight_measure_count"] = 0
    return sync_garmin.build_summary(rows, {"targetWeightKg": TARGET_KG})


def warming_up_summary() -> dict:
    start = date(2030, 1, 1)
    return sync_garmin.build_summary([_row(start + timedelta(days=i), 84.0 - i * 0.05) for i in range(9)], {"targetWeightKg": TARGET_KG})


def with_sync(summary: dict, hours_ago: float, failed: tuple[str, ...] = ()) -> dict:
    """마지막 수집 성공 시각을 hours_ago시간 전으로 둔다. generatedAt은 그대로(방금)다."""
    stamp = (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).replace(microsecond=0, tzinfo=None).isoformat() + "Z"
    sync = {"status": "partial" if failed else "ok", "lastAttemptAt": stamp, "lastSuccessAt": stamp, "failedEndpoints": list(failed)}
    return {**summary, "sync": sync}


NORMALIZE_COLOR_JS = """(c) => { const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d);
  const v = getComputedStyle(d).color; d.remove(); return v; }"""


class GarminWeightBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not importlib.util.find_spec("playwright"):
            if os.getenv("GARMIN_REQUIRE_BROWSER_TESTS") == "1":
                raise RuntimeError("Playwright is required (GARMIN_REQUIRE_BROWSER_TESTS=1)")
            raise unittest.SkipTest("Playwright unavailable")
        from playwright.sync_api import sync_playwright

        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

        cls.pw = sync_playwright().start()
        executable = os.getenv("BROWSER_EXECUTABLE") or shutil.which("chromium") or cls.pw.chromium.executable_path
        if not Path(executable).exists():
            cls.pw.stop()
            message = f"No browser executable at {executable} (set BROWSER_EXECUTABLE)"
            if os.getenv("GARMIN_REQUIRE_BROWSER_TESTS") == "1":
                raise RuntimeError(message)
            raise unittest.SkipTest(message)
        cls.browser = cls.pw.chromium.launch(executable_path=executable, headless=True)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        steady = steady_summary()
        cls.summaries = {
            "steady": with_sync(steady, 2),
            "late": with_sync(steady, 30),
            "partial": with_sync(steady, 2, ("get_body_composition",)),
            "stale": steady_summary(unmeasured_tail_days=5),  # sync 블록이 없는 예전 요약: generatedAt을 쓴다
            "warming": warming_up_summary(),
        }

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def open_page(self, fixture: str = "steady", width: int = 1440):
        context = self.browser.new_context(viewport={"width": width, "height": 1000}, service_workers="block",
                                           timezone_id="Asia/Seoul", color_scheme="light")
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        summary = self.summaries[fixture]
        page.route("**/garmin-weight/data/summary.json*", lambda r: r.fulfill(json=summary))
        page.route("**/garmin-weight/config.json*", lambda r: r.fulfill(json={"targetWeightKg": TARGET_KG}))
        page.goto(f"http://127.0.0.1:{self.server.server_port}{PAGE}")
        page.wait_for_function("document.querySelector('.app')?.dataset.state === 'ready'", timeout=20000)
        page.wait_for_function("window.Chart && Chart.getChart(document.getElementById('weightChart'))", timeout=20000)
        self.addCleanup(lambda: self.assertEqual([], errors, "page errors"))
        return page

    def test_prediction_guard_follows_confidence(self) -> None:
        self.assertNotEqual("low", self.summaries["steady"]["modelDiagnostics"]["confidence"]["level"])
        page = self.open_page("steady")
        self.assertFalse(page.locator("#predictionGuard").is_visible())

        page = self.open_page("warming")
        self.assertTrue(page.locator("#predictionGuard").is_visible())
        self.assertIn("추세 판단 중", page.locator("#predictionGuardText").text_content())
        self.assertEqual("추세 판단 중", page.locator("#statusBadge").text_content().strip())

    def test_chart_uses_page_legend_and_target_line(self) -> None:
        page = self.open_page("steady")
        facts = page.evaluate(f"""() => {{
          const norm = {NORMALIZE_COLOR_JS};
          const chart = Chart.getChart(document.getElementById('weightChart'));
          const ds = Object.fromEntries(chart.data.datasets.map(d => [d.label, norm(d.borderColor)]));
          const swatch = (cls) => norm(getComputedStyle(document.querySelector(cls)).borderTopColor);
          return {{
            legend: chart.options.plugins.legend.display,
            target: chart.options.plugins.targetLine.value,
            plugin: chart.config.plugins.some(p => p.id === 'targetLine'),
            ds,
            trendSwatch: swatch('.panel-head-legend-swatch--trend'),
            forecastSwatch: swatch('.panel-head-legend-swatch--forecast'),
            mobileTrendSwatch: swatch('.chart-legend-swatch--trend'),
            // 선 데이터셋의 견본은 선 모양(투명 배경 + 2px 위 테두리)이어야 한다. 기본 견본(짙은 10×10 네모)에 덮이면 안 된다.
            lineSwatches: [...document.querySelectorAll(
              '.panel-head-legend-swatch--trend, .panel-head-legend-swatch--forecast, .panel-head-legend-swatch--target,' +
              '.chart-legend-swatch--trend, .chart-legend-swatch--forecast, .chart-legend-swatch--target')]
              .map(n => {{ const cs = getComputedStyle(n); return cs.backgroundColor + ' ' + cs.borderTopWidth; }}),
            firstTick: chart.scales.x.ticks[0]?.label,
          }};
        }}""")
        self.assertIs(False, facts["legend"])
        self.assertEqual(TARGET_KG, facts["target"])
        self.assertTrue(facts["plugin"])
        self.assertEqual(facts["ds"]["추세"], facts["trendSwatch"])
        self.assertEqual(facts["ds"]["추세"], facts["mobileTrendSwatch"])
        self.assertEqual(facts["ds"]["예측"], facts["forecastSwatch"])
        self.assertEqual(["rgba(0, 0, 0, 0) 2px"] * 6, facts["lineSwatches"])
        self.assertRegex(facts["firstTick"], r"^\d{1,2}/\d{1,2}$")
        self.assertNotIn("14일 평균", facts["ds"], "14-day average is off by default, matching the HTML chip")

    def test_no_horizontal_overflow(self) -> None:
        for width in (320, 344, 360, 390, 1440):
            with self.subTest(width=width):
                page = self.open_page("steady", width=width)
                overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                self.assertLessEqual(overflow, 0)

    def test_insight_is_not_repeated(self) -> None:
        lines = self.summaries["steady"]["insight"]["lines"]
        self.assertGreaterEqual(len(lines), 2, "fixture should produce two insight sentences")
        page = self.open_page("steady")
        self.assertEqual(lines[0], page.locator("#insightHeadline").text_content())
        self.assertNotIn(lines[0], page.locator("#insightLines").text_content())

    def test_stale_measurement_is_marked(self) -> None:
        page = self.open_page("stale")
        dot = page.evaluate(f"""() => ({NORMALIZE_COLOR_JS})(getComputedStyle(document.querySelector('#lastSync .sync-dot')).backgroundColor)""")
        expected = page.evaluate(f"({NORMALIZE_COLOR_JS})('#A0522D')")
        self.assertEqual(expected, dot)
        self.assertIn("마지막 측정 5일 전", page.locator("#lastSync .sync-text").text_content())
        self.assertEqual("5일 전", page.locator("#lastEntry").text_content())

    def sync_pill(self, page) -> dict:
        return page.evaluate(f"""() => ({{
          text: document.querySelector('#lastSync .sync-text').textContent,
          dot: ({NORMALIZE_COLOR_JS})(getComputedStyle(document.querySelector('#lastSync .sync-dot')).backgroundColor),
          title: document.getElementById('lastSync').getAttribute('title'),
          stale: ({NORMALIZE_COLOR_JS})('#A0522D'),
          warn: ({NORMALIZE_COLOR_JS})('#8B6F5E'),
        }})""")

    def test_sync_time_follows_last_successful_collection(self) -> None:
        fresh = self.sync_pill(self.open_page("steady"))
        self.assertNotIn("수집 없음", fresh["text"])
        self.assertNotIn(fresh["dot"], (fresh["stale"], fresh["warn"]))
        self.assertIsNone(fresh["title"])

        # 요약은 방금 만들었어도(generatedAt) 마지막 수집 성공이 30시간 전이면 경고한다.
        late = self.sync_pill(self.open_page("late"))
        self.assertIn("30시간째 수집 없음", late["text"])
        self.assertEqual(late["stale"], late["dot"])
        self.assertIn("마지막 수집 성공 후 30시간", late["title"])

    def test_partial_collection_is_marked(self) -> None:
        pill = self.sync_pill(self.open_page("partial"))
        self.assertEqual(pill["warn"], pill["dot"])
        self.assertIn("get_body_composition", pill["title"])
        self.assertNotIn("수집 없음", pill["text"])

    def test_shortcuts_ignore_modifier_keys(self) -> None:
        page = self.open_page("steady")
        active = "document.querySelector('.seg-btn.is-active').dataset.range"
        page.keyboard.press("Control+1")
        self.assertEqual("60", page.evaluate(active))
        page.keyboard.press("1")
        self.assertEqual("30", page.evaluate(active))

    def test_sparkline_colors_follow_selection(self) -> None:
        page = self.open_page("steady")
        stroke = "(k) => document.querySelector(`.scenario-sparkline[data-spark='${k}'] polyline`).getAttribute('stroke')"
        self.assertEqual("#ffffff", page.evaluate(stroke, "base"))
        page.click(".scenario[data-scenario='optimistic']")
        self.assertEqual("#ffffff", page.evaluate(stroke, "optimistic"))
        self.assertNotEqual("#ffffff", page.evaluate(stroke, "base"))


if __name__ == "__main__":
    unittest.main()
