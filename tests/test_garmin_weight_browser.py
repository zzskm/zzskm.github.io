"""garmin-weight 페이지 표시 회귀 테스트 (로컬 서버 + 결정적 요약 픽스처).

요약은 sync_garmin.build_summary로 합성 행에서 만든다. 실제 data/ 파일은 읽지 않는다.
Playwright가 없으면 건너뛴다. GARMIN_REQUIRE_BROWSER_TESTS=1이면 건너뛰지 않고 실패한다(CI).
"""
from __future__ import annotations

import functools
import http.server
import importlib.util
import json
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


def long_summary() -> dict:
    """150일. 모든 백테스트 기간(84일 포함)에 표본이 20개 넘게 나온다."""
    start = date(2030, 1, 1)
    rows = [_row(start + timedelta(days=i), round(86.0 - 0.015 * i + 0.3 * sin(i * 1.7), 2) if i % 4 else None)
            for i in range(150)]
    return sync_garmin.build_summary(rows, {"targetWeightKg": TARGET_KG})


def warming_up_summary() -> dict:
    start = date(2030, 1, 1)
    return sync_garmin.build_summary([_row(start + timedelta(days=i), 84.0 - i * 0.05) for i in range(9)], {"targetWeightKg": TARGET_KG})


def with_sync(summary: dict, hours_ago: float, failed: tuple[str, ...] = ()) -> dict:
    """마지막 수집 성공 시각을 hours_ago시간 전으로 둔다. generatedAt은 그대로(방금)다."""
    stamp = (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).replace(microsecond=0, tzinfo=None).isoformat() + "Z"
    sync = {"status": "partial" if failed else "ok", "lastAttemptAt": stamp, "lastSuccessAt": stamp, "failedEndpoints": list(failed)}
    return {**summary, "sync": sync}


def reached_summary() -> dict:
    """목표(78kg) 아래에서 시작해 계속 그 아래에 있다. "목표까지"가 음수가 되는 경우다."""
    start = date(2030, 1, 1)
    rows = [_row(start + timedelta(days=i), round(77.6 - 0.005 * i + 0.1 * sin(i * 1.3), 2)) for i in range(70)]
    return sync_garmin.build_summary(rows, {"targetWeightKg": TARGET_KG})


STRAY_DAY = 40


def stray_summary() -> dict:
    """steady와 같은 60일인데 41번째 날에 다른 사람이 잰 70kg이 섞여 있다."""
    start = date(2030, 1, 1)
    rows = [_row(start + timedelta(days=i), round(84.0 + 0.25 * sin(i * 1.3), 2)) for i in range(60)]
    rows[STRAY_DAY]["weight_kg"] = 70.0
    return sync_garmin.build_summary(rows, {"targetWeightKg": TARGET_KG})


def patched(summary: dict, *, scenario_values: float | None = None, long_range: str | None = None,
            eta: tuple[int, str] | None = None, blended: float | None = None) -> dict:
    """요약의 사본에서 화면이 읽는 값 몇 개만 바꾼다(백엔드로는 만들기 번거로운 상태를 그리기 위한 것)."""
    copy = json.loads(json.dumps(summary))
    if scenario_values is not None:
        for scenario in copy["predictions"]["scenarios"].values():
            scenario["threeMonthWeightKg"] = scenario_values
    if long_range is not None:
        copy["modelDiagnostics"]["longRange"] = {"horizon": "84d", "status": long_range, "maeKg": 1.49, "flatMaeKg": 1.19,
                                                 "sampleCount": 149}
    if eta is not None:
        copy["goal"].update({"etaStatus": "date", "etaDays": eta[0], "etaDate": eta[1], "etaRangeDays": None})
    if blended is not None:
        copy["rolling"]["lossRateDetail"]["blended"] = blended
    return copy


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
            "long": with_sync(long_summary(), 2),
        }
        long = cls.summaries["long"]
        cls.summaries.update({
            "empty": sync_garmin.build_summary([], {"targetWeightKg": TARGET_KG}),
            "reached": with_sync(reached_summary(), 2),
            "stray": with_sync(stray_summary(), 2),
            "equal": patched(long, scenario_values=78.0, long_range="ok"),
            "longworse": patched(long, long_range="worse_than_flat", eta=(400, "2031-07-05")),
            "zero": patched(cls.summaries["steady"], blended=0.001),
            # 문구가 가장 길어지는 경우: 수집이 늦고, 일부 항목이 실패했고, 측정이 며칠 없고, 3개월 값이 장기 추정이다.
            "busy": with_sync(patched(steady_summary(unmeasured_tail_days=5), long_range="worse_than_flat"), 30,
                              ("get_body_composition", "get_sleep_data", "get_stats", "get_activities_fordate")),
        })

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def open_page(self, fixture: str = "steady", width: int = 1440, block_cdn: bool = False, console: list | None = None,
                  fixed_time: str | None = None, summary_status: int = 200, expect_state: str = "ready"):
        """fixture 요약으로 페이지를 연다. summary_status가 200이 아니면 요약 요청이 그 상태로 실패한다.

        돌려주는 page에는 server가 붙는다: server["status"]와 server["payload"]를 바꾸면 다음 요청부터 응답이 바뀌고,
        server["requests"]는 요약 요청 수다.
        """
        context = self.browser.new_context(viewport={"width": width, "height": 1000}, service_workers="block",
                                           timezone_id="Asia/Seoul", color_scheme="light")
        self.addCleanup(context.close)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        server = {"status": summary_status, "payload": self.summaries[fixture], "requests": 0}
        page.server = server

        def serve_summary(route) -> None:
            server["requests"] += 1
            if server["status"] == 200:
                route.fulfill(json=server["payload"])
            else:
                route.fulfill(status=server["status"], body="unavailable")

        page.route("**/garmin-weight/data/summary.json*", serve_summary)
        page.route("**/garmin-weight/config.json*", lambda r: r.fulfill(json={"targetWeightKg": TARGET_KG}))
        if block_cdn:
            page.route("https://cdn.jsdelivr.net/**", lambda r: r.abort())
        if console is not None:
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
        if fixed_time is not None:
            page.clock.set_fixed_time(fixed_time)
        page.goto(f"http://127.0.0.1:{self.server.server_port}{PAGE}")
        page.wait_for_function("(state) => document.querySelector('.app')?.dataset.state === state", arg=expect_state, timeout=20000)
        has_weights = any(point.get("valueKg") is not None for point in server["payload"]["series"]["daily"])
        if not block_cdn and expect_state == "ready" and has_weights:
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
        # busy는 동기화 표시와 시나리오 안내 문구가 가장 길어지는 요약이다.
        for fixture in ("steady", "busy"):
            for width in (320, 344, 360, 390, 1440):
                with self.subTest(fixture=fixture, width=width):
                    page = self.open_page(fixture, width=width)
                    page.evaluate("document.querySelector('.details-panel').open = true")
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
        # 재검토 FE4: 점 색만으로는 거의 보이지 않고 터치 기기에는 툴팁이 없다. 글자로도 적는다.
        self.assertIn("일부 수집 실패(체성분)", pill["text"])
        self.assertNotIn("get_body_composition", pill["text"])
        self.assertNotIn("수집 실패", self.sync_pill(self.open_page("steady"))["text"])

    def test_model_audit_is_one_table_with_shared_samples(self) -> None:
        """P6(M1): 운영·섀도·Kalman·변화 없음이 같은 n으로 한 표에 나오고, '우세' 같은 서로 다른 판정 줄이 없다."""
        summary = self.summaries["long"]
        diag = summary["modelDiagnostics"]
        for width in (1440, 360):
            with self.subTest(width=width):
                page = self.open_page("long", width=width)
                table = page.evaluate("""() => {
                  const t = document.querySelector('#modelAudit table');
                  return { head: [...t.tHead.rows[0].cells].map(c => c.textContent),
                           rows: [...t.tBodies[0].rows].map(r => [...r.cells].map(c => c.textContent)),
                           text: document.getElementById('modelAudit').textContent,
                           overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
                }""")
                self.assertEqual(["모델", *(f"{h}일n={diag['backtestSampleCounts'][f'{h}d']}" for h in (7, 14, 28, 84))], table["head"])
                labels = [row[0] for row in table["rows"]]
                self.assertEqual("운영 · EWMA 혼합", labels[0])
                self.assertTrue(labels[1].startswith("섀도 · "), labels)
                self.assertEqual(["Kalman", "변화 없음"], labels[2:])
                current = [f"{diag['backtest'][h]['maeKg']:.2f}" for h in ("7d", "14d", "28d", "84d")]
                self.assertEqual(current, table["rows"][0][1:])
                flat = [f"{diag['modelAudit']['ewma_flat'][h]['maeKg']:.2f}" for h in ("7d", "14d", "28d", "84d")]
                self.assertEqual(flat, table["rows"][3][1:])
                self.assertNotIn("우세", table["text"])
                self.assertIn("예측은 운영 모델로 계산합니다", table["text"])
                self.assertLessEqual(table["overflow"], 0)

    def test_short_history_shows_dashes_not_numbers(self) -> None:
        page = self.open_page("steady")
        cells = page.evaluate("() => [...document.querySelectorAll('#modelAudit tbody tr:first-child td')].map(c => c.textContent)")
        self.assertEqual("–", cells[-1])  # 60일 이력에는 84일 표본이 없다

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

    def test_time_axis_is_proportional(self) -> None:
        """P7(F3): 60일 보기에서 과거와 미래의 하루당 픽셀 수가 같다(예측 13점이 실측 60점과 같은 간격이 아니다)."""
        page = self.open_page("long")
        facts = page.evaluate("""() => {
          const chart = Chart.getChart(document.getElementById('weightChart'));
          const x = chart.scales.x;
          const pred = chart.data.datasets.find(d => d.label === '예측').data;
          const daily = chart.data.datasets.find(d => d.label === '실제').data;
          const perDay = (a, b) => (x.getPixelForValue(b.x) - x.getPixelForValue(a.x)) / (b.x - a.x);
          return { type: x.type, past: perDay(daily[0], daily[daily.length - 1]), future: perDay(pred[0], pred[pred.length - 1]),
                   predStep: pred[1].x - pred[0].x, span: x.max - x.min };
        }""")
        self.assertEqual("linear", facts["type"])
        self.assertAlmostEqual(facts["past"], facts["future"], places=6)
        self.assertEqual(7, facts["predStep"])
        self.assertGreaterEqual(facts["span"], 60 + 84 - 1)

    def test_scenarios_draw_their_own_curves(self) -> None:
        """P7(M6, F6): 카드 값 = 차트 선의 끝 값, 시나리오를 바꾸면 선과 띠가 그 시나리오 시계열로 바뀐다."""
        summary = self.summaries["long"]
        scenarios = summary["predictions"]["scenarios"]
        page = self.open_page("long")
        line_end = "() => { const d = Chart.getChart(document.getElementById('weightChart')).data.datasets.find(d => d.label === '예측').data; return d[d.length - 1].y; }"
        upper_end = "() => { const d = Chart.getChart(document.getElementById('weightChart')).data.datasets.find(d => d.label === 'ciUpper').data; return d[d.length - 1].y; }"
        for key, card_id in (("base", "scenarioBase"), ("optimistic", "scenarioOpt"), ("conservative", "scenarioCon")):
            with self.subTest(scenario=key):
                page.click(f".scenario[data-scenario='{key}']")
                card = scenarios[key]["threeMonthWeightKg"]
                self.assertAlmostEqual(card, page.evaluate(line_end), delta=0.01)
                self.assertEqual(f"{card:.1f}", page.text_content(f"#{card_id}").strip())
                self.assertAlmostEqual(scenarios[key]["series"][-1]["upper80"], page.evaluate(upper_end), delta=0.01)
        sparks = page.evaluate("() => ['optimistic','base','conservative'].map(k => document.querySelector(`.scenario-sparkline[data-spark='${k}'] polyline`).getAttribute('points'))")
        self.assertEqual(3, len(set(sparks)), "each card draws its own curve")
        self.assertEqual(13, len(sparks[0].split()))

    def test_eta_beyond_two_years_is_labelled(self) -> None:
        page = self.open_page("steady")
        page.evaluate("""() => {
          const goal = { etaStatus: 'beyond', etaDays: null, etaRangeDays: null };
          document.getElementById('etaValue').textContent = window.GWAppHelpers.fmtEta(goal);
        }""")
        self.assertEqual("2년 이후", page.text_content("#etaValue"))
        self.assertEqual("약 5주~2년 이후 범위", page.evaluate("() => window.GWAppHelpers.fmtEtaRange({ etaRangeDays: { min: 35, max: null, maxBeyond: true } })"))
        self.assertEqual("감량 추세 아님", page.evaluate("() => window.GWAppHelpers.fmtEta({ etaStatus: 'no_loss' })"))

    def test_page_works_without_the_chart_cdn(self) -> None:
        """P8(W1): CDN이 막혀도 5초 안에 숫자를 보여 주고, 차트 자리에 안내를 띄우며, 새로고침 버튼이 살아 있다."""
        import time
        started = time.monotonic()
        page = self.open_page("steady", block_cdn=True)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 12)
        # 투명도 전환(0.5초)이 끝날 때까지 기다린다.
        page.wait_for_function("getComputedStyle(document.querySelector('.app')).opacity === '1'", timeout=3000)
        facts = page.evaluate("""() => ({
          opacity: getComputedStyle(document.querySelector('.app')).opacity,
          notice: document.getElementById('chartNotice').hidden ? null : document.getElementById('chartNotice').textContent,
          weight: document.getElementById('currentWeight').textContent,
          reloadDisabled: document.getElementById('reloadBtn').disabled,
        })""")
        self.assertEqual("1", facts["opacity"])
        self.assertIn("차트 라이브러리를 불러오지 못했습니다", facts["notice"])
        self.assertNotEqual("–", facts["weight"])
        self.assertIs(False, facts["reloadDisabled"])

    def test_reload_keeps_the_page_visible(self) -> None:
        """P8(W1): 새로고침 때는 화면을 투명하게 가리지 않는다."""
        page = self.open_page("steady")
        page.evaluate("""() => { window.__states = []; new MutationObserver(() => window.__states.push(
            getComputedStyle(document.querySelector('.app')).opacity + '/' + document.querySelector('.app').dataset.state))
          .observe(document.querySelector('.app'), { attributes: true }); }""")
        page.click("#reloadBtn")
        page.wait_for_function("!document.querySelector('.app').dataset.busy && window.__states.length > 0")
        states = page.evaluate("window.__states")
        self.assertTrue(all(not s.endswith("/loading") for s in states), states)

    # --- 재검토 Q3: 화면 일관성 -----------------------------------------------------------

    def scenario_hint(self, page) -> dict:
        return page.evaluate("""() => {
          const hint = document.getElementById('scenariosHint');
          return { text: hint.textContent, caution: hint.classList.contains('is-caution'),
                   muted: document.querySelector('.scenarios').classList.contains('is-muted') };
        }""")

    def test_scenario_hint_follows_the_summary(self) -> None:
        """재검토 FE3: 안내 문구는 패널 머리에 있다. 예전에는 .scenarios 안에서 찾아 문구가 한 번도 바뀌지 않았다."""
        self.assertEqual("ok", self.summaries["long"]["modelDiagnostics"]["longRange"]["status"])
        cases = {
            "long": ("선택한 강도가 차트 예측선과 신뢰 띠에 반영됩니다", False, False),
            "warming": ("예측 신뢰도가 낮아 시나리오는 참고용입니다", True, True),
            "equal": ("시나리오 간 3개월 차이가 0.2kg 미만입니다", True, True),
            "longworse": ("3개월 값은 장기 추정입니다 · 84일 검증 오차 1.49kg, 변화 없음 가정 1.19kg", True, False),
            "steady": ("3개월 값은 장기 추정입니다 · 84일 검증 표본이 아직 모자랍니다", True, False),
            "empty": ("체중 기록이 쌓이면 시나리오를 보여 줍니다", True, True),
        }
        for fixture, (text, caution, muted) in cases.items():
            with self.subTest(fixture=fixture):
                hint = self.scenario_hint(self.open_page(fixture))
                self.assertEqual((text, caution, muted), (hint["text"], hint["caution"], hint["muted"]))

    def test_long_range_marker_sits_next_to_the_eta(self) -> None:
        """재검토 MD5: 신뢰도 등급이 높아도 3개월 값이 "변화 없음"보다 나쁘면 목표 도달일 옆에 표시한다."""
        marked = self.open_page("longworse")
        self.assertEqual("7/5 · 장기 추정", marked.text_content("#etaSub"))
        self.assertIn("84일 예측 오차", marked.text_content("#detailMae"))
        plain = self.open_page("long")
        self.assertNotIn("장기 추정", plain.text_content("#etaSub"))

    def test_small_labels_and_filled_bars(self) -> None:
        """재검토 FE7: 이름표가 값보다 크게 나오던 것, 비어 있던 품질 막대, 열어도 +이던 표식."""
        page = self.open_page("long")
        facts = page.evaluate("""() => {
          const px = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
          const toggle = () => getComputedStyle(document.querySelector('.details-summary-toggle'), '::before').content;
          const closed = toggle();
          document.querySelector('.details-panel').open = true;
          const fill = document.querySelector('.quality-bar-fill--accent');
          const track = fill.parentElement;
          return {
            eyebrow: px('.eyebrow'), title: px('.panel-title'), stripLabel: px('.model-strip-cell .label'),
            stripValue: px('#modelConfidence'), closed, open: toggle(),
            fillWidth: fill.getBoundingClientRect().width, trackWidth: track.clientWidth,
            titles: [...document.querySelectorAll('.panel-head')].map((head) => [
              head.querySelector('.eyebrow')?.textContent.trim(), head.querySelector('h2, h3, h4')?.textContent.trim()]),
            stepsUnit: document.querySelector('#stepsAvg').parentElement.querySelector('.tile-unit').textContent,
            fatDelta: document.getElementById('bodyFatDelta').textContent,
          };
        }""")
        self.assertLessEqual(facts["eyebrow"], 11)
        self.assertLess(facts["eyebrow"], facts["title"])
        self.assertLess(facts["stripLabel"], facts["stripValue"])
        self.assertEqual(('"+"', '"−"'), (facts["closed"], facts["open"]))
        pct = self.summaries["long"]["modelDiagnostics"]["dataQuality"]["recentCoveragePct"]
        self.assertAlmostEqual(pct / 100, facts["fillWidth"] / facts["trackWidth"], delta=0.02)
        for eyebrow, title in facts["titles"]:
            self.assertNotEqual(eyebrow, title)
        self.assertEqual("천 보 · 7일", facts["stepsUnit"])
        self.assertNotIn("30d", facts["fatDelta"])

    def test_coverage_dots_match_the_count(self) -> None:
        """재검토 MD6: 측정률 숫자와 점, 모델 줄의 측정률이 같은 창(완료된 날 30일)을 센다."""
        summary = self.summaries["stale"]  # 마지막 닷새는 측정이 없다
        coverage = summary["coverage"]
        self.assertEqual(30, coverage["last30Total"])
        page = self.open_page("stale")
        facts = page.evaluate("""() => ({
          dots: document.querySelectorAll('#summaryDots .dot-cell').length,
          filled: document.querySelectorAll('#summaryDots .dot-cell.has, #summaryDots .dot-cell.has-today').length,
          text: document.getElementById('summaryCoverageText').textContent,
          strip: document.getElementById('modelValidate').textContent,
          first: document.querySelector('#summaryDots .dot-cell').title,
        })""")
        self.assertEqual((30, coverage["last30Measured"]), (facts["dots"], facts["filled"]))
        self.assertEqual(f"{coverage['last30Measured']}/30", facts["text"])
        self.assertIn(f"측정 {coverage['last30Pct']:.0f}%", facts["strip"])
        self.assertTrue(facts["first"].startswith(coverage["windowStart"]))

    def test_weekly_change_near_zero_has_no_sign(self) -> None:
        page = self.open_page("zero")
        self.assertEqual("±0.00 kg/주", page.text_content("#heroWeeklyChange"))
        self.assertEqual(["−0.11", "+0.03", "±0.00", "±0.00", "–"],
                         page.evaluate("() => [0.11, -0.03, 0.004, -0.004, null].map((v) => window.GWAppHelpers.fmtWeekly(v))"))

    def test_empty_summary_says_there_are_no_records(self) -> None:
        """재검토 FE8: 자료가 0건이면 배지 "유지"와 0~1.0 눈금의 빈 차트가 나왔다."""
        page = self.open_page("empty")
        facts = page.evaluate("""() => ({
          badge: document.getElementById('statusBadge').textContent,
          reason: document.getElementById('statusReason').textContent,
          guard: document.querySelector('.prediction-guard-title').textContent,
          guardVisible: !document.getElementById('predictionGuard').hidden,
          notice: document.getElementById('chartNotice').hidden ? null : document.getElementById('chartNotice').textContent,
          chart: !!(window.Chart && Chart.getChart(document.getElementById('weightChart'))),
        })""")
        self.assertEqual(("기록 없음", "체중 기록이 아직 없습니다", "기록 없음", True),
                         (facts["badge"], facts["reason"], facts["guard"], facts["guardVisible"]))
        self.assertEqual("표시할 체중 기록이 아직 없습니다.", facts["notice"])
        self.assertFalse(facts["chart"])

    def test_goal_already_reached(self) -> None:
        summary = self.summaries["reached"]
        self.assertLess(summary["goal"]["remainingKg"], 0)
        page = self.open_page("reached")
        self.assertEqual(("도달", "100%", "도달"),
                         (page.text_content("#toTarget"), page.text_content("#goalProgressBig"), page.text_content("#etaValue")))

    def test_first_load_failure_names_the_cause(self) -> None:
        """재검토 FE8: 첫 로드가 실패하면 "예측 보류"와 "최근 30일"(HTML 기본값)이 남고 푸터에 오류 원문이 나왔다."""
        page = self.open_page("steady", summary_status=503, expect_state="error")
        facts = page.evaluate("""() => ({
          badge: document.getElementById('statusBadge').textContent,
          reason: document.getElementById('statusReason').textContent,
          foot: document.getElementById('statusLine').textContent,
          pill: document.querySelector('#lastSync .sync-text').textContent,
        })""")
        self.assertEqual("불러오지 못함", facts["badge"])
        self.assertEqual("서버 응답 503 · 다시 불러오기를 눌러 주세요", facts["reason"])
        self.assertEqual("데이터를 불러오지 못했습니다(서버 응답 503).", facts["foot"])
        self.assertEqual("로드 실패", facts["pill"])

        # 네트워크가 돌아오면(online 이벤트) 스스로 다시 받는다.
        page.server["status"] = 200
        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_function("document.querySelector('.app').dataset.state === 'ready'", timeout=20000)
        self.assertEqual("유지", page.text_content("#statusBadge").strip())

    def test_failed_reload_keeps_the_content(self) -> None:
        page = self.open_page("steady")
        weight = page.text_content("#currentWeight")
        page.server["status"] = 500
        page.click("#reloadBtn")
        page.wait_for_function("document.querySelector('#lastSync .sync-text').textContent.includes('새로고침 실패')", timeout=10000)
        self.assertEqual("새로고침 실패(서버 응답 500) · 이전 자료 표시 중", page.text_content("#lastSync .sync-text"))
        self.assertEqual(("ready", weight), (page.evaluate("document.querySelector('.app').dataset.state"), page.text_content("#currentWeight")))

    def test_measurement_age_uses_the_real_date(self) -> None:
        """재검토 FE8: 수집이 멈추면 요약의 마지막 날이 오늘이 아니다. 며칠 전 측정이 "오늘 측정"으로 남으면 안 된다."""
        summary = self.summaries["steady"]
        self.assertEqual(("2030-02-28", 1), (summary["coverage"]["lastMeasurementAt"], summary["coverage"]["daysSinceLastMeasurement"]))
        on_time = self.open_page("steady", fixed_time="2030-03-01T09:00:00+09:00")
        self.assertEqual("1일 전", on_time.text_content("#lastEntry"))
        late = self.open_page("steady", fixed_time="2030-03-06T09:00:00+09:00")  # 요약은 3월 1일에 멈춰 있다
        self.assertEqual("6일 전", late.text_content("#lastEntry"))
        self.assertIn("마지막 측정 6일 전", late.text_content("#lastSync .sync-text"))

    def test_page_left_open_refreshes_when_it_is_shown_again(self) -> None:
        """재검토 FE8: 열어 둔 화면은 스스로 갱신되지 않았다. 10분이 지나 다시 보이면 요약을 다시 받는다."""
        page = self.open_page("steady", fixed_time="2030-03-01T09:00:00+09:00")
        self.assertEqual(1, page.server["requests"])
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_timeout(300)
        self.assertEqual(1, page.server["requests"], "a fresh page does not reload")
        page.clock.set_fixed_time("2030-03-01T09:11:00+09:00")
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_function("!document.querySelector('.app').dataset.busy", timeout=10000)
        self.assertEqual(2, page.server["requests"])

    # --- 재검토 Q4: 이상 측정과 신뢰 띠 ---------------------------------------------------

    def test_stray_measurement_is_marked_on_the_chart(self) -> None:
        """재검토 MD8: 추세에 일부만 반영한 측정은 속이 빈 점으로 그리고, 범례와 툴팁이 그 뜻을 말한다."""
        summary = self.summaries["stray"]
        stray_date = summary["series"]["daily"][STRAY_DAY]["date"]
        self.assertEqual([stray_date], summary["modelDiagnostics"]["dataQuality"]["limitedDates"])
        self.assertAlmostEqual(84.0, summary["current"]["weightEwmaKg"], delta=0.15)  # 70kg 한 건이 추세를 끌고 가지 않는다

        page = self.open_page("stray")
        facts = page.evaluate(f"""() => {{
          const norm = {NORMALIZE_COLOR_JS};
          const chart = Chart.getChart(document.getElementById('weightChart'));
          const index = chart.data.datasets.findIndex((d) => d.label === '실제');
          const points = chart.data.datasets[index].data;
          const elements = chart.getDatasetMeta(index).data;
          const marked = points.map((p, i) => (p.limited ? i : -1)).filter((i) => i >= 0);
          const style = (i) => {{ const o = elements[i].options; return [norm(o.backgroundColor), norm(o.borderColor), o.radius]; }};
          const label = chart.options.plugins.tooltip.callbacks.label;
          return {{
            marked: marked.map((i) => window.GWAppHelpers.dayIso(points[i].x)),
            markedStyle: style(marked[0]), plainStyle: style(0),
            white: norm('#fff'), accent: norm('#FF6F61'),
            legend: [...document.querySelectorAll('[data-legend="limited"]')].map((n) => n.hidden),
            markedLabel: label({{ dataset: {{ label: '실제' }}, formattedValue: '70', raw: points[marked[0]] }}),
            plainLabel: label({{ dataset: {{ label: '실제' }}, formattedValue: '84', raw: points[0] }}),
            help: document.querySelector('#detailQuality .quality-row-label').title,
            count: document.querySelector('#detailQuality .quality-val').textContent,
          }};
        }}""")
        self.assertEqual([stray_date], facts["marked"])
        self.assertEqual([facts["white"], facts["accent"], 4], facts["markedStyle"])
        self.assertNotEqual(facts["markedStyle"], facts["plainStyle"])
        self.assertEqual([False, False], facts["legend"])
        self.assertEqual("실제: 70 · 추세에 일부만 반영", facts["markedLabel"])
        self.assertEqual("실제: 84", facts["plainLabel"])
        self.assertIn("일부만 반영", facts["help"])
        self.assertEqual("낮음 1", facts["count"])

        clean = self.open_page("steady")
        self.assertEqual([True, True], clean.evaluate("[...document.querySelectorAll('[data-legend=limited]')].map((n) => n.hidden)"))

    def test_band_has_no_step_between_neighbouring_weeks(self) -> None:
        """재검토 MD3: 8주 → 9주에 폭이 1.8배로 뛰던 계단이 차트에 없다."""
        page = self.open_page("long")
        half = page.evaluate("""() => {
          const chart = Chart.getChart(document.getElementById('weightChart'));
          const pick = (label) => chart.data.datasets.find((d) => d.label === label).data;
          const upper = pick('ciUpper'), line = pick('예측');
          return upper.map((p, i) => p.y - line[i].y);
        }""")
        self.assertEqual(13, len(half))
        self.assertAlmostEqual(0.0, half[0], places=6)
        for earlier, later in zip(half[1:], half[2:]):
            self.assertGreaterEqual(later + 1e-9, earlier)
            self.assertLessEqual(later, earlier * 1.5 + 0.01)

    def test_no_console_warnings(self) -> None:
        """P8(W5): 콘솔 경고가 없다(Playwright가 서비스 워커를 막는다는 안내는 테스트 환경 탓이라 뺀다)."""
        messages: list[str] = []
        self.open_page("steady", console=messages)
        problems = [m for m in messages if m.split(":")[0] in ("warning", "error") and "Service Worker registration blocked" not in m]
        self.assertEqual([], problems)


if __name__ == "__main__":
    unittest.main()
