"""Regenerate mock-data before/after UI evidence (requires Playwright Chromium and Git).
Run from the repository root: python tests/capture_bus_ui.py
"""
import importlib.util,json,datetime as dt,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=root/'bus-arrival/reports/ui-ux';out.mkdir(exist_ok=True)
baseline=tempfile.TemporaryDirectory(prefix='bus-ui-before-')
before=Path(baseline.name);(before/'bus-arrival').mkdir()
for name in ['index.html','alarm.js','dashboard.js']:
 data=subprocess.check_output(['git','-c',f'safe.directory={root.as_posix()}','show',f'96e32207ad:bus-arrival/{name}'],cwd=root)
 (before/'bus-arrival'/name).write_bytes(data)
sp=importlib.util.spec_from_file_location('b',root/'tests/test_bus_safety_browser.py');m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
results=[]
for version,source in [('before',before),('after',root)]:
 m.ROOT=source;c=m.SafetyBrowserTests;c.setUpClass();o=c()
 try:
  for state in ['waiting','overdue','stale','skipped','next']:
   st=o.ready_status()
   if state=='overdue':st['safety']['safe_arrival_ts']=(m.T+dt.timedelta(minutes=5)).isoformat()
   if state=='stale':st['last_poll']=(m.T-dt.timedelta(minutes=4)).isoformat()
   if state=='next':st.update(next_veh_id=22,next_predict_sec=1800)
   p,errors=o.open_page(st)
   try:
    if state in ['skipped','next']:
     p.locator('#alarm-skip').click();p.wait_for_function('JSON.parse(localStorage.getItem("busAlarm.v1.fired")).skipped["11"]')
     if state=='next':p.wait_for_function("document.querySelector('#verdict-text').textContent.startsWith('다음 차량 ·')")
     if state=='skipped' and version=='after':p.wait_for_function("document.querySelector('#verdict-text').textContent.includes('이번 차량 제외됨')")
    if version=='after':p.wait_for_function('!renderQueued')
    p.evaluate('window.scrollTo(0,0)')
    p.screenshot(path=str(out/f'{version}-{state}-390.png'))
    results.append({'version':version,'state':state,'verdict':p.locator('#verdict-text').inner_text(),'overflow':p.evaluate('document.documentElement.scrollWidth>innerWidth'),'errors':errors})
    if version=='after' and state=='waiting':
     for width in [360,1280]:
      p.set_viewport_size({'width':width,'height':844});p.clock.fast_forward(250);p.screenshot(path=str(out/f'after-waiting-{width}.png'))
     p.set_viewport_size({'width':390,'height':844});p.emulate_media(color_scheme='dark');p.clock.fast_forward(250);p.screenshot(path=str(out/'after-waiting-dark-390.png'))
     p.emulate_media(color_scheme='light');p.locator('#open-settings').click();p.locator('#window-add').click();p.locator('#clock-create summary').click();p.locator('#timer-create summary').click()
     p.evaluate('document.documentElement.style.zoom="2"; window.dispatchEvent(new Event("resize"))');p.clock.fast_forward(250)
     p.evaluate('window.scrollTo(0,0)');p.screenshot(path=str(out/'after-zoom200-390.png'),full_page=True)
     results.append({'version':'after','zoom':200,'width':390,'overflow':p.evaluate('document.documentElement.scrollWidth>innerWidth'),'errors':errors})
   finally:p.close()
 finally:c.tearDownClass()
(out/'capture-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False,indent=2))

baseline.cleanup()
