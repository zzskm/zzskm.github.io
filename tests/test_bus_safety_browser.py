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

    def open_page(self, status, summary=None, history=None):
        page=self.browser.new_page(viewport={'width':390,'height':844})
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.clock.install(time=T)
        page.add_init_script('localStorage.setItem("busAlarm.v1.cfg",'+json.dumps(json.dumps({'enabled':True,'leads':[5],'windows':[],'armedAtMs':MS-3600000}))+');')
        page.route('**/status.json?*',lambda r:r.fulfill(json=status))
        page.route('**/summary.json?*',lambda r:r.fulfill(json=summary or {'recent_predictions':[],'recent_arrivals':[],'today':{},'historical_alerts':{'date':'2026-10-19','slots':[]}}))
        page.route('**/holidays.json?*',lambda r:r.fulfill(json={'years':[2026],'dates':{}}))
        page.route('**/arrival_log.csv?*',lambda r:r.fulfill(body=history or 'ts_kst,vehId,est_arrival_ts\n'))
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
            page.locator('#open-settings').click()
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
            page.screenshot(path='/tmp/bus-ui-mobile.png',full_page=True)
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

    def ready_status(self):
        return {'last_poll':T.isoformat(),'first_seen_ts':(T-dt.timedelta(minutes=5)).isoformat(),
                'current_veh_id':11,'current_plate':'테스트 3100','predict_sec':1200,'location_no':4,'remain_seat':12,
                'collect_window':'16:00-22:00','poll_interval_sec':60,'safety':{
                    'observation_ts':T.isoformat(),'safe_arrival_ts':(T+dt.timedelta(minutes=14)).isoformat(),
                    'corrected_arrival_ts':(T+dt.timedelta(minutes=18)).isoformat(),
                    'method':'trip_lower_quantile','sample_trips':50}}

    def test_timeline_shows_engine_reservation_and_settings_preview(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(self.ready_status())
        try:
            expect(page.locator('#journey-timeline')).to_contain_text('17:55')
            expect(page.locator('#journey-timeline')).to_contain_text('18:08')
            expect(page.locator('#journey-timeline')).to_contain_text('계산된 예정')
            expect(page).to_have_title(__import__('re').compile('출발 8분'))
            self.assertFalse(page.locator('#alarm-settings').evaluate('(el)=>el.open'))
            page.locator('#open-settings').click()
            page.locator('#walk').fill('10')
            page.locator('#walk').dispatch_event('change')
            expect(page.locator('#alarm-next')).to_contain_text('18:03')
            expect(page.locator('#hero-next')).to_contain_text('18:03')
            expect(page.locator('#journey-timeline')).to_contain_text('18:03')
            expect(page).to_have_title(__import__('re').compile('출발 3분'))
            page.locator('#alarm-chips [data-lead="10"]').click()
            expect(page.locator('#alarm-next')).to_contain_text('18:03')
            page.reload()
            page.wait_for_function('!document.body.classList.contains("loading")')
            expect(page.locator('#verdict-text')).to_contain_text('3분')
            self.assertEqual(errors,[])
        finally: page.close()

    def test_skip_undo_keeps_other_vehicle_ledger(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(self.ready_status())
        try:
            page.evaluate('localStorage.setItem("busAlarm.v1.fired", JSON.stringify({fired:{"22|5":{a:Date.now()+1200000,k:"ontime"}},skipped:{}}))')
            page.locator('#alarm-skip').click()
            expect(page.locator('#alarm-undo-skip')).to_be_visible()
            page.wait_for_function('JSON.parse(localStorage.getItem("busAlarm.v1.fired")).skipped["11"]')
            page.locator('#alarm-undo-skip').click()
            expect(page.locator('#alarm-next')).to_contain_text('18:08')
            ledger=page.evaluate('JSON.parse(localStorage.getItem("busAlarm.v1.fired"))')
            self.assertNotIn('11',ledger['skipped'])
            self.assertIn('22|5',ledger['fired'])
            self.assertEqual(errors,[])
        finally: page.close()

    def test_chart_modes_gaps_and_mobile_dark_layout(self):
        from playwright.sync_api import expect
        rows=[{'ts_kst':(T-dt.timedelta(minutes=n)).isoformat(),'vehId':11,'predict_sec':1200+n*30} for n in [5,4,0]]
        page,errors=self.open_page(self.ready_status(),summary={'recent_predictions':rows,'recent_arrivals':[],'today':{},'historical_alerts':{'date':'2026-10-19','slots':[]}})
        try:
            expect(page.locator('#chart-note')).to_contain_text('당시 API 도착 예정 시각')
            expect(page.locator('#chart-note')).to_contain_text('공백')
            self.assertEqual(page.locator('#chart .line').count(),2)
            self.assertEqual(page.locator('#chart .corrected').count(),1)
            page.locator('#chart-remaining').click()
            expect(page.locator('#chart-note')).to_contain_text('당시 API 잔여시간')
            for width in [360,390,1280]:
                page.set_viewport_size({'width':width,'height':844})
                page.emulate_media(color_scheme='dark' if width==390 else 'light',reduced_motion='reduce')
                self.assertFalse(page.evaluate('document.documentElement.scrollWidth > window.innerWidth'))
                page.screenshot(path=f'/tmp/bus-ui-{width}.png',full_page=True)
            page.clock.fast_forward(181000)
            expect(page.locator('#chart .corrected')).to_have_count(0)
            self.assertEqual(errors,[])
        finally: page.close()

    def test_no_bus_and_off_hours_do_not_claim_no_service_or_live_departure(self):
        from playwright.sync_api import expect
        page,errors=self.open_page({**self.ready_status(),'current_veh_id':0,'error':'no_bus'})
        try:
            expect(page.locator('#verdict-text')).to_contain_text('실시간에서 확인된 차량 없음')
            expect(page.locator('#journey-timeline .planned')).to_have_count(0)
            page.route('**/status.json?*',lambda r:r.fulfill(json={**self.ready_status(),'collect_window':'16:00-17:00'}))
            page.locator('#refresh').click()
            expect(page.locator('#verdict-text')).to_contain_text('수집 시간 외')
            expect(page.locator('#journey-timeline .planned')).to_have_count(0)
            self.assertEqual(errors,[])
        finally: page.close()

    def test_clock_and_timer_forms_work_when_collapsed(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(self.ready_status())
        try:
            page.locator('#clock-create summary').click()
            page.locator('#clock-time').fill('19:00')
            page.locator('#clock-label').fill('퇴근 정리')
            page.locator('#clock-form button[type="submit"]').click()
            page.locator('#clock-create summary').click()
            expect(page.locator('#clock-list')).to_contain_text('19:00')
            page.locator('#timer-create summary').click()
            page.locator('#timer-custom').fill('1')
            page.locator('#timer-label').fill('준비')
            page.locator('#timer-form button[type="submit"]').click()
            page.locator('#timer-create summary').click()
            expect(page.locator('#timer-list')).to_contain_text('준비')
            page.clock.fast_forward(60000)
            expect(page.locator('#alarm-banner-text')).to_contain_text('준비')
            page.locator('#alarm-ack').click()
            expect(page.locator('#alarm-banner')).to_be_hidden()
            self.assertEqual(errors,[])
        finally: page.close()

    def test_same_weekday_plot_uses_trip_points_and_labels_estimates(self):
        from playwright.sync_api import expect
        history='ts_kst,vehId,first_seen_ts,est_arrival_ts,departure_reason\n2026-10-12T18:01:00+09:00,11,2026-10-12T17:45:00+09:00,2026-10-12T18:00:00+09:00,estimated_arrival\n'
        page,errors=self.open_page(self.ready_status(),history=history)
        try:
            page.locator('.history-panel > summary').click()
            expect(page.locator('#history-chart-note')).to_contain_text('1일 · 1운행')
            self.assertEqual(page.locator('#history-chart .dot').count(),1)
            page.locator('.history-panel details summary').click()
            expect(page.locator('#history-table')).to_contain_text('2026-10-12')
            self.assertEqual(errors,[])
        finally: page.close()


if __name__=='__main__':
    unittest.main()
