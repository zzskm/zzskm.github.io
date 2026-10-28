"""Compare local pages in isolated Chrome runs on Windows (requires Playwright).

Reports process-tree private committed bytes, not just JavaScript heap or shared RSS.
No browser profile, extension, forced GC, or page data mock is used.
"""
import argparse
import ctypes
from ctypes import wintypes
import datetime as dt
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import statistics
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SCENARIOS = {
    'three_tabs': ['garmin-weight/index.html', 'work_hours_calculator.html', 'bus-arrival/index.html'],
    'dashboard': ['dashboard.html'],
}


class ProcessEntry(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
                ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]


class MemoryCounters(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize',
        'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
        'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]


def process_memory(browser_pid):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    for name in ('Process32FirstW', 'Process32NextW'):
        fn = getattr(kernel, name)
        fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
        fn.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    parents = {}
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            ok = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    owned = {browser_pid}
    while True:
        found = {pid for pid, parent in parents.items() if parent in owned}
        if found <= owned:
            break
        owned |= found
    private = 0
    for pid in owned:
        handle = kernel.OpenProcess(0x410, False, pid)
        if not handle:
            # An incomplete sample must not silently look like reduced memory use.
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            counters = MemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                raise ctypes.WinError(ctypes.get_last_error())
            private += counters.PrivateUsage
        finally:
            kernel.CloseHandle(handle)
    return {'private_bytes': private, 'process_count': len(owned)}


def run(pw, args, origin, scenario, round_number):
    with pw.chromium.launch(executable_path=args.browser, headless=True) as browser:
        context = browser.new_context(viewport={'width': 1280, 'height': 1000}, timezone_id='Asia/Seoul')
        errors, failed_requests, sessions = [], [], []
        for path in SCENARIOS[scenario]:
            page = context.new_page()
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('requestfailed', lambda req: failed_requests.append({'url': req.url, 'error': req.failure}))
            page.goto(f'{origin}/{path}', wait_until='load', timeout=60000)
            if path.startswith('garmin-weight'):
                page.wait_for_selector('.app[data-state="ready"]', timeout=60000)
                page.wait_for_function('!!window.Chart.getChart(document.querySelector("#weightChart"))')
            elif path == 'dashboard.html':
                page.wait_for_selector('#weight-chart svg')
                page.wait_for_function('!!document.querySelector("#bus-widget").shadowRoot?.querySelector("#verdict-text")')
            elif path.startswith('bus-arrival'):
                page.wait_for_selector('#verdict-text')
            session = context.new_cdp_session(page)
            session.send('Performance.enable')
            sessions.append(session)
        if errors or failed_requests:
            raise RuntimeError(json.dumps({'errors': errors, 'failed_requests': failed_requests}))
        cdp = browser.new_browser_cdp_session()
        browser_pid = next(int(p['id']) for p in cdp.send('SystemInfo.getProcessInfo')['processInfo'] if p['type'] == 'browser')

        def sample():
            result = process_memory(browser_pid)
            result['js_heap_used_bytes'] = sum(next(m['value'] for m in s.send('Performance.getMetrics')['metrics']
                                                  if m['name'] == 'JSHeapUsedSize') for s in sessions)
            return result

        initial = sample()
        time.sleep(args.settle)
        samples = []
        for i in range(args.samples):
            if i:
                time.sleep(2)
            samples.append(sample())
        if errors or failed_requests:
            raise RuntimeError(json.dumps({'errors': errors, 'failed_requests': failed_requests}))
        result = {'round': round_number, 'scenario': scenario, 'chrome': browser.version,
                  'initial': initial, 'settled': samples,
                  'settled_private_bytes_median': statistics.median(s['private_bytes'] for s in samples)}
        context.close()
        print(json.dumps(result), flush=True)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default=os.getenv('BROWSER_EXECUTABLE', 'C:/Program Files/Google/Chrome/Application/chrome.exe'))
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--settle', type=int, default=15)
    parser.add_argument('--samples', type=int, default=3)
    parser.add_argument('--output', type=Path, default=ROOT / '_site/dashboard-preview/memory-results.json')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('Process private-byte measurement currently supports Windows only.')
    if args.rounds < 1 or args.samples < 1 or args.settle < 0:
        parser.error('rounds/samples must be positive and settle must be nonnegative.')
    from playwright.sync_api import sync_playwright

    class QuietHandler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    hashes = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in (
        'garmin-weight/data/summary.json', 'garmin-weight/config.json', 'bus-arrival/status.json', 'bus-arrival/summary.json')}
    results = []
    try:
        with sync_playwright() as pw:
            for i in range(args.rounds):
                # Alternate order to reduce consistent first-run/cache bias.
                order = list(SCENARIOS) if i % 2 == 0 else list(reversed(SCENARIOS))
                for scenario in order:
                    results.append(run(pw, args, f'http://127.0.0.1:{server.server_port}', scenario, i + 1))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    for path, digest in hashes.items():
        if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest:
            raise RuntimeError(f'Data changed during measurement: {path}. Repeat with stable input files.')
    summary = {}
    for scenario in SCENARIOS:
        rows = [r for r in results if r['scenario'] == scenario]
        summary[scenario] = {phase: statistics.median(
            r['initial']['private_bytes'] if phase == 'initial' else r['settled_private_bytes_median']
            for r in rows) for phase in ('initial', 'settled')}
    summary['settled_reduction_percent'] = (1 - summary['dashboard']['settled'] / summary['three_tabs']['settled']) * 100
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'recorded_at': dt.datetime.now().astimezone().isoformat(),
        'conditions': {'headless': True, 'rounds': args.rounds, 'settle_seconds': args.settle,
                       'samples_per_run': args.samples, 'sample_interval_seconds': 2,
                       'viewport': '1280x1000', 'data_sha256': hashes},
        'results': results, 'summary': summary}, indent=2), encoding='utf-8')
    print(json.dumps({'summary': summary, 'output': str(args.output)}), flush=True)


if __name__ == '__main__':
    main()
