"""Dashboard integration checks with a local server and deterministic bus data."""
import datetime as dt
import functools
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
T = dt.datetime(2026, 10, 28, 18, tzinfo=dt.timezone(dt.timedelta(hours=9)))


class DashboardBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not importlib.util.find_spec('playwright'):
            raise unittest.SkipTest('Playwright unavailable')
        from playwright.sync_api import sync_playwright
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args): pass
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=os.getenv('BROWSER_EXECUTABLE') or shutil.which('chromium') or cls.pw.chromium.executable_path,headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def open_page(self, width=1280, fail_weight=False, fail_bus=False, stale=False, storage=None):
        context = self.browser.new_context(viewport={'width':width,'height':1000},timezone_id='Asia/Seoul',color_scheme='light')
        self.addCleanup(context.close)
        page = context.new_page()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.clock.install(time=T)
        state={'start':{'h':8,'m':37},'end':{'h':18,'m':30},'baseH':8,'baseM':0,'breakH':1,'breakM':0,'notifyEnabled':False}
        cfg={'enabled':True,'leads':[5],'windows':[],'armedAtMs':int(T.timestamp()*1000)-3600000}
        page.add_init_script('localStorage.setItem("wht.state.v2",'+json.dumps(json.dumps(state))+');localStorage.setItem("busAlarm.v1.cfg",'+json.dumps(json.dumps(cfg))+');'
            +''.join(f'localStorage.setItem({json.dumps(k)},{json.dumps(json.dumps(v))});' for k,v in (storage or {}).items()))
        status={'last_poll':(T-dt.timedelta(minutes=4) if stale else T).isoformat(),'current_veh_id':11,'predict_sec':1200,'location_no':4,
                'remain_seat':16,'collect_window':'16:00-22:00','poll_interval_sec':60,'safety':{
                    'observation_ts':T.isoformat(),'api_arrival_ts':(T+dt.timedelta(minutes=20)).isoformat(),
                    'safe_arrival_ts':(T+dt.timedelta(minutes=14)).isoformat(),
                    'corrected_arrival_ts':(T+dt.timedelta(minutes=18)).isoformat(),
                    'method':'trip_lower_quantile','sample_trips':50}}
        page.route('**/bus-arrival/status.json?*',lambda r:r.fulfill(json=status))
        page.route('**/bus-arrival/summary.json?*',lambda r:r.fulfill(json={'recent_predictions':[],'recent_arrivals':[],'today':{}}))
        page.route('**/holidays.json?*',lambda r:r.fulfill(json={'years':[2026],'dates':{}}))
        page.route('**/arrival_log.csv?*',lambda r:r.fulfill(body='ts_kst,vehId,est_arrival_ts\n'))
        page.route('**/garmin-weight/data/summary.json',lambda r:r.fulfill(json={
            'generatedAt':T.isoformat(),
            'current':{'weightKg':84.3,'weightDate':'2026-10-28','bodyFatPercent':29.2},
            'rolling':{'last7StepsAvg':7359,'last7ExerciseMinutes':190,'lossRateDetail':{'blended':-0.09},'exerciseTrend':{'deltaPct':0.026}},
            'predictions':{'oneMonthWeightKg':84.34,'threeMonthWeightKg':85.07},
            'modelDiagnostics':{'confidence':{'level':'low','reasons':['최근 측정률이 낮음']},'trend':{'predictionEnabled':True}},
            'predictionCI':{'series':[{'date':'2026-11-26','central':84.34,'lower80':83.26,'upper80':85.42},{'date':'2027-01-21','central':85.07,'lower80':83.2,'upper80':86.9}]},
            'series':{'daily':[{'date':'2026-10-01','valueKg':84.8},{'date':'2026-10-14','valueKg':None},{'date':'2026-10-28','valueKg':84.3}],
                'ewma':[{'date':'2026-10-01','valueKg':84.7},{'date':'2026-10-28','valueKg':83.98}],
                'prediction':[{'date':'2026-10-29','valueKg':83.98},{'date':'2026-11-26','valueKg':84.34},{'date':'2027-01-21','valueKg':85.07}]}}))
        page.route('**/garmin-weight/config.json',lambda r:r.fulfill(json={'targetWeightKg':78}))
        if fail_weight: page.route('**/garmin-weight/data/summary.json',lambda r:r.fulfill(status=503,body='unavailable'))
        if fail_bus: page.route('**/bus-arrival/index.html',lambda r:r.fulfill(status=503,body='unavailable'))
        page.goto(f'http://127.0.0.1:{self.server.server_port}/dashboard.html')
        return page,errors

    def test_one_document_shared_settings_and_bus_controls(self):
        from playwright.sync_api import expect
        page,errors=self.open_page()
        expect(page.locator('#weight')).to_have_text('84.3')
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        artifact=os.getenv('DASHBOARD_SCREENSHOT_DIR')
        if artifact:
            Path(artifact).mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(Path(artifact)/'dashboard-desktop.png'),full_page=True)
        self.assertEqual(len(page.frames),1)
        self.assertIsNone(page.evaluate('window.Chart'))
        self.assertEqual(page.locator('#work-start').input_value(),'08:37')
        self.assertEqual(page.locator('#remain').inner_text(),'00:30')
        page.locator('#work-end').fill('19:00')
        page.locator('#work-end').dispatch_event('change')
        self.assertEqual(page.evaluate('JSON.parse(localStorage.getItem("wht.state.v2")).end.h'),19)
        expect(page.locator('#remain')).to_have_text('01:00')
        page.locator('#open-settings').click()
        expect(page.locator('#alarm-settings')).to_have_attribute('open','')
        page.locator('#walk').fill('10')
        page.locator('#walk').dispatch_event('change')
        expect(page.locator('#verdict-text')).to_contain_text('3분')
        self.assertEqual(page.evaluate('localStorage.getItem("busWalkMinutes")'),'10')
        expect(page.locator('#clock-card')).to_have_count(0)
        expect(page.locator('#clock-view')).to_have_count(0)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        self.assertEqual(errors,[])

    def test_bus_card_stays_light_inside_dark_dashboard(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(width=360)
        expect(page.locator('#weight-chart svg')).to_be_visible()
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        artifact=os.getenv('DASHBOARD_SCREENSHOT_DIR')
        if artifact:
            Path(artifact).mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(Path(artifact)/'dashboard-mobile.png'),full_page=True)
        # The surrounding dashboard may follow the OS, but the bus tile is light-only.
        self.assertEqual(page.locator('#theme').count(),0)
        page.emulate_media(color_scheme='dark')
        bus_ink=page.locator('#hero').evaluate('e=>getComputedStyle(e.getRootNode().host).getPropertyValue("--ink").trim()')
        self.assertEqual(bus_ink,'#13161d')
        bus_bg=page.locator('#bus-panel').evaluate('e=>getComputedStyle(e).backgroundColor')
        self.assertEqual(bus_bg,'rgb(255, 255, 255)')
        self.assertEqual(page.locator('#arrival-main-time').inner_text(),'18:20')
        self.assertEqual(page.locator('#departure-time-main').inner_text(),'출발 18:08')
        dashboard_ink=page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()")
        self.assertEqual(dashboard_ink,'#edf2e9')
        page.locator('[data-days="60"]').click()
        expect(page.locator('[data-days="60"]')).to_have_attribute('aria-pressed','true')
        self.assertEqual(errors,[])
        artifact=os.getenv('DASHBOARD_SCREENSHOT_DIR')
        if artifact:
            Path(artifact).mkdir(parents=True,exist_ok=True)
            page.evaluate("document.activeElement.blur(); window.scrollTo({top:0,behavior:'instant'})")
            page.screenshot(path=str(Path(artifact)/'dashboard-mobile-dark.png'),full_page=True)

    def test_partial_failures_keep_work_and_stale_bus_uncertainty(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(fail_weight=True,stale=True)
        expect(page.locator('#weight-status')).to_contain_text('불러오지 못했습니다')
        expect(page.locator('#verdict-text')).to_contain_text('판단 보류')
        expect(page.locator('#remain')).to_have_text('00:30')
        self.assertEqual(errors,[])

    def test_time_nudges_save_wrap_and_update_countdown(self):
        from playwright.sync_api import expect
        page,errors=self.open_page()
        page.get_by_role('button',name='퇴근 5분 늦추기',exact=True).click()
        expect(page.locator('#work-end')).to_have_value('18:35')
        expect(page.locator('#remain')).to_have_text('00:35')
        page.get_by_role('button',name='출근 1분 앞당기기',exact=True).click()
        expect(page.locator('#work-start')).to_have_value('08:36')
        self.assertEqual(page.evaluate('JSON.parse(localStorage.getItem("wht.state.v2")).start.m'),36)
        page.locator('#work-end').fill('23:59')
        page.locator('#work-end').dispatch_event('change')
        page.get_by_role('button',name='퇴근 1분 늦추기',exact=True).click()
        expect(page.locator('#work-end')).to_have_value('00:00')
        expect(page.locator('#work-message')).to_contain_text('퇴근 00:00')
        page.get_by_role('button',name='퇴근 5분 앞당기기',exact=True).focus()
        page.keyboard.press('Enter')
        expect(page.locator('#work-end')).to_have_value('23:55')
        self.assertEqual(page.evaluate('JSON.parse(localStorage.getItem("wht.state.v2")).end'),{'h':23,'m':55})
        self.assertEqual(errors,[])

    def test_forecast_toggle_confidence_missing_data_and_refresh_failure(self):
        from playwright.sync_api import expect
        page,errors=self.open_page()
        expect(page.locator('#weight-month')).to_have_text('84.3 kg')
        expect(page.locator('#weight-quarter')).to_have_text('85.1 kg')
        expect(page.locator('#weight-trend')).to_have_text('+0.09 kg/주')
        expect(page.locator('#weight-prediction-note')).to_contain_text('신뢰도 낮음')
        expect(page.locator('#weight-prediction-note')).to_contain_text('최근 측정률이 낮음')
        expect(page.locator('.chart-band')).to_have_count(1)
        expect(page.locator('.chart-trend')).to_have_count(1)
        page.locator('#weight-prediction-toggle').click()
        expect(page.locator('.chart-prediction')).to_have_count(0)
        expect(page.locator('.chart-band')).to_have_count(0)
        expect(page.locator('#chart-end')).to_have_text('10.28')
        page.locator('[data-days="60"]').click()
        expect(page.locator('#weight-prediction-toggle')).to_have_attribute('aria-pressed','false')
        page.locator('#weight-prediction-toggle').click()
        expect(page.locator('.chart-prediction')).to_have_count(1)
        page.route('**/garmin-weight/data/summary.json',lambda r:r.fulfill(status=503))
        page.locator('#weight-refresh').click()
        expect(page.locator('#weight-status')).to_contain_text('마지막으로 받은 자료')
        expect(page.locator('.chart-prediction')).to_have_count(1)
        page.route('**/garmin-weight/data/summary.json',lambda r:r.fulfill(json={
            'current':{'weightKg':84},'series':{'daily':[{'date':'2026-10-28','valueKg':84}]},
            'predictions':{'oneMonthWeightKg':80},'modelDiagnostics':{'trend':{'predictionEnabled':False,'disabledReason':'측정일 부족'}}}))
        page.locator('#weight-refresh').click()
        expect(page.locator('#weight-prediction-note')).to_have_text('예측 보류 · 측정일 부족')
        expect(page.locator('#weight-month')).to_have_text('예측 보류')
        expect(page.locator('.chart-prediction')).to_have_count(0)
        expect(page.locator('.chart-dot')).to_have_count(1)
        self.assertEqual(errors,[])

    def test_responsive_controls_navigation_and_expanded_forms(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(width=320)
        expect(page.locator('#weight-chart svg')).to_be_visible()
        page.emulate_media(reduced_motion='reduce')
        for width in (320,360,390,768,1024,1440):
            page.set_viewport_size({'width':width,'height':1000})
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'),width)
            self.assertTrue(page.locator('#weight-chart').evaluate('e=>e.querySelector("svg").getBoundingClientRect().bottom <= e.getBoundingClientRect().bottom + 1'),width)
            # Minute controls have generous vertical touch targets at all sizes.
            self.assertTrue(page.locator('[data-start-nudge]').evaluate_all('els=>els.every(e=>e.getBoundingClientRect().height >= 44)'))
        page.set_viewport_size({'width':320,'height':1000})
        page.locator('.section-nav a[href="#weight-panel"]').click()
        expect(page.locator('#weight-panel')).to_be_focused()
        expect(page.locator('.section-nav a')).to_have_count(3)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        self.assertEqual(errors,[])

    def test_published_weight_data_matches_original_forecast(self):
        from playwright.sync_api import expect
        page,errors=self.open_page()
        expect(page.locator('#weight')).to_have_text('84.3')
        page.unroute('**/garmin-weight/data/summary.json')
        page.locator('#weight-refresh').click()
        source=json.loads((ROOT/'garmin-weight/data/summary.json').read_text(encoding='utf-8'))
        predicted=source.get('predictions',{}).get('threeMonthWeightKg')
        enabled=source.get('modelDiagnostics',{}).get('trend',{}).get('predictionEnabled') is not False
        # JavaScript Intl.NumberFormat rounds decimal ties half-up, unlike Python's ties-to-even.
        from decimal import Decimal, ROUND_HALF_UP
        expected=(f'{Decimal(str(predicted)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)} kg'
                  if enabled and isinstance(predicted,(int,float)) else '예측 보류')
        expect(page.locator('#weight-quarter')).to_have_text(expected)
        self.assertEqual(page.locator('.chart-trend').count(),1)
        artifact=os.getenv('DASHBOARD_SCREENSHOT_DIR')
        if artifact:
            for width,scheme,name in ((1440,'light','desktop'),(390,'light','mobile'),(390,'dark','mobile-dark')):
                page.set_viewport_size({'width':width,'height':1000})
                page.emulate_media(color_scheme=scheme,reduced_motion='reduce')
                page.evaluate("document.activeElement.blur(); window.scrollTo({top:0,behavior:'instant'})")
                page.screenshot(path=str(Path(artifact)/f'dashboard-real-{name}.png'),full_page=True)
        self.assertEqual(errors,[])

    def test_failed_bus_can_retry_without_losing_other_panels(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(fail_bus=True)
        expect(page.locator('#bus-error')).to_be_visible()
        expect(page.locator('#weight')).to_have_text('84.3')
        page.unroute('**/bus-arrival/index.html')
        page.locator('#bus-retry').click()
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        expect(page.locator('#bus-error')).to_be_hidden()
        self.assertEqual(errors,[])

    def test_hidden_dashboard_skips_painting_then_refreshes_on_visibility(self):
        from playwright.sync_api import expect
        page,errors=self.open_page()
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        remain=page.locator('#remain').inner_text()
        page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.fakeHidden});window.fakeHidden=true;")
        page.clock.fast_forward(60000)
        expect(page.locator('#alarm-banner')).to_be_hidden()
        expect(page.locator('#remain')).to_have_text(remain)
        page.evaluate("window.fakeHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.locator('#remain')).not_to_have_text(remain)
        expect(page.locator('#verdict-text')).to_contain_text('7분')
        self.assertEqual(errors,[])

    def test_no_general_alarm_card_even_if_bus_widget_fails(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(fail_bus=True)
        expect(page.locator('#bus-error')).to_be_visible()
        expect(page.locator('#weight')).to_have_text('84.3')
        expect(page.locator('#clock-card')).to_have_count(0)
        expect(page.locator('#clock-view')).to_have_count(0)
        expect(page.locator('#alarm-banner')).to_be_hidden()
        self.assertEqual(errors,[])

    def test_saved_generic_clock_alarms_cannot_fire_on_dashboard(self):
        from playwright.sync_api import expect
        now=int(T.timestamp()*1000)
        clocks=[{'id':'old','time':'18:00','days':[1,2,3,4,5],
                 'enabled':True,'since':now-86400000,'label':'종료된 기능'}]
        timers=[{'id':'oldtimer','endsAtMs':now-1000,'minutes':1,'label':'종료된 타이머'}]
        page,errors=self.open_page(storage={'busAlarm.v1.clocks':clocks,'busAlarm.v1.timers':timers})
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        expect(page.locator('#clock-card')).to_have_count(0)
        expect(page.locator('#alarm-banner')).to_be_hidden()
        page.clock.fast_forward(3000)
        expect(page.locator('#alarm-banner')).to_be_hidden()
        self.assertEqual(errors,[])


if __name__ == '__main__':
    unittest.main()
