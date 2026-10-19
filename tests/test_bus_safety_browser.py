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

    def open_page(self, status, summary=None, history=None, config=None):
        page=self.browser.new_page(viewport={'width':390,'height':844})
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.clock.install(time=T)
        cfg={'enabled':True,'leads':[5],'windows':[],'armedAtMs':MS-3600000,**(config or {})}
        page.add_init_script('localStorage.setItem("busAlarm.v1.cfg",'+json.dumps(json.dumps(cfg))+');')
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
            page.locator('.hero-evidence summary').click()
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
            self.assertIn('현재 위치 미확인',page.locator('#hero-detail').inner_text())
            self.assertIn('최신 좌석 정보 필요',page.locator('#card-seat-sub').inner_text())
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
            expect(page.locator('#alarm-next')).to_contain_text('버스를 기다리는 중')
            expect(page.locator('#verdict-text')).not_to_contain_text('다음 차량')
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

    def test_skip_current_bus_updates_primary_departure_to_next_bus(self):
        from playwright.sync_api import expect
        status={**self.ready_status(),'next_veh_id':22,'next_plate_no':'후속 차량','next_predict_sec':1800}
        page,errors=self.open_page(status)
        try:
            expect(page.locator('#hero-detail')).to_contain_text('테스트 3100')
            page.locator('#alarm-skip').click()
            expect(page.locator('#verdict-text')).to_contain_text('다음 차량')
            expect(page.locator('#hero-detail')).to_contain_text('22')
            expect(page.locator('#journey-timeline')).to_contain_text('후속 알림 대상 차량 확인')
            expect(page.locator('#card-seat')).to_have_text('미제공')
            page.locator('.hero-evidence summary').click()
            expect(page.locator('#model-note')).to_contain_text('고정 11분 여유')
            expect(page.locator('#safety-detail')).to_contain_text('고정 11분 여유')
            expect(page.locator('#safety-detail')).not_to_contain_text('하위 분위수')
            self.assertEqual(errors,[])
        finally: page.close()

    def test_api_error_shows_last_success_time_and_original_vehicle(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(self.ready_status())
        try:
            page.clock.fast_forward(4*60*1000)
            page.route('**/status.json?*',lambda r:r.fulfill(json={
                'last_poll':(T+dt.timedelta(minutes=4)).isoformat(),'last_success':T.isoformat(),'error':'api_error',
                'consec_fail':1,'collect_window':'16:00-22:00','poll_interval_sec':60}))
            page.locator('#refresh').click()
            expect(page.locator('#verdict-text')).to_contain_text('최신 정보 없음')
            expect(page.locator('#freshness')).to_contain_text('4분 전')
            expect(page.locator('#hero-detail')).to_contain_text('마지막 정상 확인 기준 차량 11')
            expect(page.locator('#journey-timeline')).to_contain_text('마지막 정상 정보에서 차량 확인')
            expect(page.locator('#journey-timeline')).not_to_contain_text('후속 알림 대상 차량 확인')
            self.assertEqual(errors,[])
        finally: page.close()

    def test_api_error_first_visit_uses_last_success_without_fabricated_observations(self):
        from playwright.sync_api import expect
        status={'last_poll':T.isoformat(),'last_success':(T-dt.timedelta(minutes=5)).isoformat(),
                'error':'api_error','collect_window':'16:00-22:00','poll_interval_sec':60}
        page,errors=self.open_page(status)
        try:
            expect(page.locator('#freshness')).to_contain_text('5분 전')
            expect(page.locator('#verdict-text')).to_contain_text('출발 판단 보류')
            expect(page.locator('#journey-timeline')).not_to_contain_text('차량 확인')
            self.assertEqual(errors,[])
        finally: page.close()

    def test_window_selected_next_alarm_is_separate_from_current_bus_timeline(self):
        from playwright.sync_api import expect
        status={**self.ready_status(),'next_veh_id':22,'next_predict_sec':1800}
        page,errors=self.open_page(status,config={'windows':[{'start':'18:25','end':'18:40','days':[1]}]})
        try:
            expect(page.locator('#alarm-next')).to_contain_text('알림 대상 차량 22')
            expect(page.locator('#hero-next')).to_contain_text('후속 차량 22 알림')
            expect(page.locator('#hero-detail')).to_contain_text('테스트 3100')
            expect(page.locator('#verdict-text')).to_contain_text('8분')
            expect(page.locator('#journey-timeline')).not_to_contain_text('다음 알림')
            self.assertEqual(errors,[])
        finally: page.close()

    def test_walk_and_margin_preferences_sync_between_tabs_and_reschedule(self):
        from playwright.sync_api import expect
        page,errors=self.open_page(self.ready_status())
        other=page.context.new_page()
        try:
            other.clock.install(time=T)
            other.add_init_script('localStorage.setItem("busAlarm.v1.cfg",'+json.dumps(json.dumps({'enabled':True,'leads':[5],'windows':[],'armedAtMs':MS-3600000}))+');')
            other.route('**/status.json?*',lambda r:r.fulfill(json=self.ready_status()))
            other.route('**/summary.json?*',lambda r:r.fulfill(json={'recent_predictions':[],'recent_arrivals':[],'today':{},'historical_alerts':{'date':'2026-10-19','slots':[]}}))
            other.route('**/holidays.json?*',lambda r:r.fulfill(json={'years':[2026],'dates':{}}))
            other.route('**/arrival_log.csv?*',lambda r:r.fulfill(body='ts_kst,vehId,est_arrival_ts\n'))
            other.goto(f'http://127.0.0.1:{self.server.server_port}/bus-arrival/')
            other.wait_for_function('!document.body.classList.contains("loading")')
            page.locator('#open-settings').click()
            other.locator('#open-settings').click()
            page.locator('#walk').fill('10')
            page.locator('#walk').dispatch_event('change')
            expect(other.locator('#walk')).to_have_value('10')
            expect(other.locator('#verdict-text')).to_contain_text('3분')
            page.locator('#safety-margin').fill('2')
            page.locator('#safety-margin').dispatch_event('change')
            expect(other.locator('#safety-margin')).to_have_value('2')
            expect(other.locator('#verdict-text')).to_contain_text('2분')
            expect(other.locator('#alarm-next')).to_contain_text('18:02')
            self.assertEqual(errors,[])
        finally:
            other.close();page.close()

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
