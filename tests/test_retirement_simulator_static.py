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


def test_retirement_simulator_boot_fallback_runs_before_cdn_scripts_and_recovers():
    # 부트 폴백이 CDN 스크립트보다 먼저 실행돼야 로딩 실패 이벤트를 놓치지 않는다
    boot = HTML.index("window.showBootError = function")
    assert boot < HTML.index("cdn.tailwindcss.com/3.4.17")
    assert boot < HTML.index("@babel/standalone@")
    # 느린 망에서 늦게 로딩이 끝나면 오류 안내를 걷어낸다
    assert "window.hideBootError" in HTML
    # 폰트 CSS(LINK) 실패로 앱 전체를 숨기지 않는다
    assert 'target.tagName === "SCRIPT"' in HTML
    assert 'target.tagName === "LINK"' not in HTML


def test_retirement_simulator_cdn_scripts_are_pinned_and_non_blocking():
    # 미고정 URL은 메이저 업데이트가 그대로 서비스에 반영된다
    assert "@babel/standalone/babel.min.js" not in HTML
    assert "@babel/standalone@8.0.6/babel.min.js" in HTML
    assert 'src="https://cdn.tailwindcss.com"' not in HTML
    # 동기 스크립트는 body 렌더링(로딩 표시)을 막으므로 defer
    assert 'defer src="https://cdn.tailwindcss.com/3.4.17"' in HTML
    assert 'defer src="https://unpkg.com/@babel/standalone@8.0.6/babel.min.js"' in HTML


def test_retirement_simulator_policy_constants_match_2026():
    # 2026 연금개혁·A값·상하한·기초연금·건강보험료율
    assert "pensionReplacementRate: 0.43" in HTML
    assert "pensionAValueMonthly: 319" in HTML
    assert "npMaxBaseMonthly: 659" in HTML
    assert "monthlyFull: 34.97" in HTML
    assert "incomeThresholdSingle: 247" in HTML
    assert "incomeThresholdCouple: 395.2" in HTML
    assert "rate: 0.0719" in HTML
    assert 'version: "kr-v6-2026-10"' in HTML


def test_retirement_simulator_core_inputs_are_not_hidden_in_advanced_mode():
    # 가구(배우자·자녀)·주거 섹션은 기본 모드에서도 편집 가능해야 한다
    assert '<Section title="가구"' in HTML
    assert '<Section title="주거"' in HTML
    assert "{advancedMode && (\n              <Section title=\"주거\"" not in HTML
    assert "{advancedMode && (\n              <Section title=\"배우자\"" not in HTML


def test_retirement_simulator_controls_are_labelled():
    assert 'role="switch"' in HTML
    assert "aria-checked" in HTML
    assert "htmlFor={id}" in HTML
    assert "aria-label={`${label} 감소`}" in HTML
    assert "aria-label={`${label} 증가`}" in HTML
