from pathlib import Path
import json
import subprocess
ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'retirement-simulator'
SRC = APP / 'src'

def test_legacy_redirect():
    html = (ROOT / 'retirement_simulator.html').read_text()
    assert './retirement-simulator/' in html
    assert 'location.replace' in html
    assert 'location.search + location.hash' in html

def test_static_build():
    html = (APP / 'index.html').read_text()
    assert 'type="module"' in html
    for old in ['text/babel', 'cdn.tailwindcss', 'esm.sh']:
        assert old not in html
    package = json.loads((APP / 'package.json').read_text())
    assert all(not v.startswith(('^', '~')) for v in package['dependencies'].values())
    assert 'base: "./"' in (APP / 'vite.config.js').read_text()

def test_core_is_independent():
    for path in (SRC / 'model').glob('*.js'):
        code = path.read_text()
        for browser in ['from "react"', 'localStorage', 'document.']:
            assert browser not in code

def test_policy_constants():
    code = (SRC / 'model/assumptions.js').read_text()
    for constant in ['version: "kr-v6-2026-10"', 'pensionReplacementRate: 0.43', 'pensionAValueMonthly: 319', 'npMaxBaseMonthly: 659', 'monthlyFull: 34.97', 'incomeThresholdSingle: 247', 'incomeThresholdCouple: 395.2', 'rate: 0.0719']:
        assert constant in code

def test_accessibility_and_sections():
    code = (SRC / 'App.jsx').read_text()
    for label in ['자산 흐름 차트', '자산 구성 변화 차트', '월 현금흐름 차트']:
        assert f'aria-label="{label}"' in code
    assert 'role="tablist"' in code
    assert '<Section title="가구"' in code
    assert '<Section title="주거"' in code
    for file in ['features/wizard/SetupWizard.jsx', 'components/Modal.jsx']:
        assert 'aria-modal="true"' in (SRC / file).read_text()

def test_regression():
    subprocess.run(['node', '--test', str(APP / 'tests/model/regression.test.js')], check=True)
