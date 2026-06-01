from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "retirement_simulator.html").read_text(encoding="utf-8")


def test_retirement_simulator_has_runtime_failure_fallback():
    assert 'id="boot-error"' in HTML
    assert "showBootError" in HTML
    assert "window.addEventListener(\"error\"" in HTML


def test_retirement_simulator_dialogs_are_named_and_modal():
    assert 'aria-labelledby="assumptions-title"' in HTML
    assert 'id="assumptions-title"' in HTML
    assert 'aria-label="모델 가정 닫기"' in HTML
    assert 'aria-labelledby="wizard-title"' in HTML
    assert 'id="wizard-title"' in HTML
    assert 'aria-label="빠른 설정 닫기"' in HTML
    assert HTML.count('role="dialog"') >= 2
    assert HTML.count('aria-modal="true"') >= 2


def test_retirement_simulator_mobile_tabs_expose_state():
    assert 'role="tablist"' in HTML
    assert 'role="tab"' in HTML
    assert 'aria-controls="results-panel"' in HTML
    assert 'aria-controls="inputs-panel"' in HTML
    assert 'aria-selected={mobileView === "results"}' in HTML
    assert 'aria-selected={mobileView === "inputs"}' in HTML


def test_retirement_simulator_status_regions_and_chart_labels_exist():
    assert 'role="status"' in HTML
    assert 'role="alert"' in HTML
    assert 'aria-live="polite"' in HTML
    assert 'aria-label="자산 흐름 차트"' in HTML
    assert 'aria-label="자산 구성 변화 차트"' in HTML
    assert 'aria-label="월 현금흐름 차트"' in HTML
