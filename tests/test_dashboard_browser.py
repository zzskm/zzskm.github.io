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

    def open_page(self, width=1280, fail_weight=False, fail_bus=False, stale=False):
        context = self.browser.new_context(viewport={'width':width,'height':1000},timezone_id='Asia/Seoul',color_scheme='light')
        self.addCleanup(context.close)
        page = context.new_page()
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.clock.install(time=T)
        state={'start':{'h':8,'m':37},'end':{'h':18,'m':30},'baseH':8,'baseM':0,'breakH':1,'breakM':0,'notifyEnabled':False}
        cfg={'enabled':True,'leads':[5],'windows':[],'armedAtMs':int(T.timestamp()*1000)-3600000}
        page.add_init_script('localStorage.setItem("wht.state.v2",'+json.dumps(json.dumps(state))+');localStorage.setItem("busAlarm.v1.cfg",'+json.dumps(json.dumps(cfg))+');')
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
            'rolling':{'last7StepsAvg':7359,'last7ExerciseMinutes':190},
            'series':{'daily':[{'date':'2026-10-01','valueKg':84.8},{'date':'2026-10-14','valueKg':None},{'date':'2026-10-28','valueKg':84.3}]}}))
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
        # Expanded details preserve keyboard controls, clocks and timers.
        page.locator('#timer-create summary').click()
        page.locator('#timer-custom').fill('1')
        page.locator('#timer-form button[type=submit]').click()
        expect(page.locator('#timer-list')).to_contain_text('1:00')
        page.clock.fast_forward(60000)
        expect(page.locator('#alarm-banner')).to_be_visible()
        page.locator('#alarm-ack').click()
        self.assertEqual(errors,[])

    def test_mobile_dark_theme_and_single_measurement_chart(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(width=360)
        expect(page.locator('#weight-chart svg')).to_be_visible()
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        artifact=os.getenv('DASHBOARD_SCREENSHOT_DIR')
        if artifact:
            Path(artifact).mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(Path(artifact)/'dashboard-mobile.png'),full_page=True)
        page.locator('#theme').click()
        page.locator('#theme').click()
        self.assertEqual(page.evaluate('document.documentElement.dataset.theme'),'dark')
        bus_ink=page.locator('#hero').evaluate('e=>getComputedStyle(e.getRootNode().host).getPropertyValue("--ink").trim()')
        self.assertEqual(bus_ink,'#edf2e9')
        page.locator('[data-days="60"]').click()
        expect(page.locator('[data-days="60"]')).to_have_attribute('aria-pressed','true')
        self.assertEqual(errors,[])
        artifact=os.getenv('DASHBOARD_SCREENSHOT_DIR')
        if artifact:
            Path(artifact).mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(Path(artifact)/'dashboard-mobile-dark.png'),full_page=True)

    def test_partial_failures_keep_work_and_stale_bus_uncertainty(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(fail_weight=True,stale=True)
        expect(page.locator('#weight-status')).to_contain_text('불러오지 못했습니다')
        expect(page.locator('#verdict-text')).to_contain_text('판단 보류')
        expect(page.locator('#remain')).to_have_text('00:30')
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

    def test_hidden_dashboard_skips_painting_but_keeps_timer_alarm(self):
        from playwright.sync_api import expect
        page,errors=self.open_page()
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        page.locator('.dashboard-bus-details > summary').click()
        page.locator('#timer-create summary').click()
        page.locator('#timer-custom').fill('1')
        page.locator('#timer-form button[type=submit]').click()
        remain=page.locator('#remain').inner_text()
        page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.fakeHidden});window.fakeHidden=true;")
        page.clock.fast_forward(60000)
        expect(page.locator('#alarm-banner')).to_be_visible()
        expect(page.locator('#remain')).to_have_text(remain)
        expect(page.locator('#verdict-text')).to_contain_text('8분')
        page.evaluate("window.fakeHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        expect(page.locator('#remain')).not_to_have_text(remain)
        expect(page.locator('#verdict-text')).to_contain_text('7분')
        self.assertEqual(errors,[])


if __name__ == '__main__':
    unittest.main()
