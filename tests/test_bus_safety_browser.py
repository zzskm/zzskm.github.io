"""Optional headless browser smoke test; no live API or notification permission needed."""
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
T = dt.datetime(2026,10,19,18,tzinfo=dt.timezone(dt.timedelta(hours=9)))
MS = int(T.timestamp()*1000)


class SafetyBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = os.getenv('BUS_REQUIRE_BROWSER_TESTS') == '1'
        if not importlib.util.find_spec('playwright'):
            if required: raise RuntimeError('Required Playwright browser tests unavailable')
            raise unittest.SkipTest('optional Playwright unavailable')
        from playwright.sync_api import sync_playwright
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        try:
            cls.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=str(ROOT)))
        except PermissionError:
            if required: raise
            raise unittest.SkipTest('sandbox prohibits local sockets; browser test needs a network-enabled runner')
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(executable_path=shutil.which('chromium') or cls.pw.chromium.executable_path,headless=True,args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def open_page(self, status):
        page=self.browser.new_page(viewport={'width':390,'height':844})
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.clock.install(time=T)
        page.add_init_script('localStorage.setItem("busAlarm.v1.cfg",'+json.dumps(json.dumps({'enabled':True,'leads':[5],'windows':[],'armedAtMs':MS-3600000}))+');')
        page.route('**/status.json?*',lambda r:r.fulfill(json=status))
        page.route('**/summary.json?*',lambda r:r.fulfill(json={'recent_predictions':[],'recent_arrivals':[],'today':{},'historical_alerts':{'date':'2026-10-19','slots':[]}}))
        page.route('**/holidays.json?*',lambda r:r.fulfill(json={'years':[2026],'dates':{}}))
        page.route('**/arrival_log.csv?*',lambda r:r.fulfill(body='ts_kst,vehId,est_arrival_ts\n'))
        page.goto(f'http://127.0.0.1:{self.server.server_port}/bus-arrival/')
        page.wait_for_function('!document.body.classList.contains("loading")')
        return page, errors

    def test_mobile_decision_uses_safety_and_preserves_settings_and_clock_timer_ui(self):
        status={'last_poll':T.isoformat(),'current_veh_id':11,'predict_sec':1200,'location_no':4,
                'collect_window':'16:00-22:00','poll_interval_sec':60,'safety':{
                    'observation_ts':T.isoformat(),'api_arrival_ts':(T+dt.timedelta(minutes=20)).isoformat(),
                    'safe_arrival_ts':(T+dt.timedelta(minutes=14)).isoformat(),
                    'corrected_arrival_ts':(T+dt.timedelta(minutes=18)).isoformat(),
                    'method':'trip_lower_quantile','sample_trips':50}}
        page, errors=self.open_page(status)
        try:
            self.assertIn('8분',page.locator('#verdict-text').inner_text())
            self.assertIn('18:14',page.locator('#safety-detail').inner_text())
            self.assertIn('실제 도착 미측정',page.locator('#safety-detail').inner_text())
            self.assertEqual(page.locator('#eta-num').inner_text(),'18')
            from playwright.sync_api import expect
            expect(page.locator('#alarm-next')).to_contain_text('18:08')
            page.locator('#walk').fill('10')
            page.locator('#walk').dispatch_event('change')
            self.assertIn('3분',page.locator('#verdict-text').inner_text())
            page.locator('#safety-margin').fill('2')
            page.locator('#safety-margin').dispatch_event('change')
            self.assertIn('2분',page.locator('#verdict-text').inner_text())
            self.assertEqual(page.evaluate('localStorage.getItem("busWalkMinutes")'),'10')
            self.assertEqual(page.locator('#clock-once').count(),1)
            self.assertEqual(page.locator('#timer-custom').count(),1)
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
            page.screenshot(path='/tmp/bus-safety-mobile.png',full_page=True)
            self.assertEqual(errors,[])
        finally:
            page.close()

    def test_old_data_keeps_uncertainty_and_suppresses_live_alarm(self):
        page,errors=self.open_page({'last_poll':(T-dt.timedelta(minutes=4)).isoformat(),
                                   'current_veh_id':11,'predict_sec':900,'collect_window':'16:00-22:00'})
        try:
            self.assertIn('판단 보류',page.locator('#verdict-text').inner_text())
            self.assertIn('알림을 믿을 수 없습니다',page.locator('#alarm-next').inner_text())
            self.assertTrue(page.locator('#alarm-banner').is_hidden())
            self.assertEqual(errors,[])
        finally:
            page.close()

    def test_reserved_warning_remains_visible_after_expiry_and_reload(self):
        status={'last_poll':T.isoformat(),'current_veh_id':11,'predict_sec':1200,'location_no':3,
                'collect_window':'16:00-22:00','safety':{
                    'observation_ts':T.isoformat(),'safe_arrival_ts':(T+dt.timedelta(seconds=549)).isoformat(),
                    'method':'trip_lower_quantile','sample_trips':89}}
        page,errors=self.open_page(status)
        try:
            from playwright.sync_api import expect
            expect(page.locator('#alarm-next')).to_contain_text('18:03')
            page.clock.fast_forward(120000)
            page.reload()
            page.wait_for_function('!document.body.classList.contains("loading")')
            page.clock.fast_forward(69000)
            expect(page.locator('#alarm-banner')).to_be_visible()
            expect(page.locator('#alarm-banner-text')).to_contain_text('최신 정보 없음')
            self.assertEqual(errors,[])
        finally:
            page.close()


if __name__=='__main__':
    unittest.main()
