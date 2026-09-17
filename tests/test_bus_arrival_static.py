from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "bus-arrival" / "index.html").read_text(encoding="utf-8")


def test_bus_arrival_verdict_leads_the_hero():
    """출발/대기 판정이 ETA보다 위에 오고, 색 외에 글리프로도 구분된다."""
    assert 'id="verdict"' in HTML
    assert 'id="verdict-glyph"' in HTML
    assert HTML.index('id="verdict"') < HTML.index('id="eta-num"')
    for state in ("verdict.go", "verdict.wait", "verdict.warn", "verdict.danger"):
        assert state in HTML


def test_bus_arrival_eta_splits_number_and_unit():
    """긴 한글 문장을 거대 폰트로 렌더하지 않고 숫자/단위를 분리한다."""
    assert 'id="eta-num"' in HTML
    assert 'id="eta-unit"' in HTML
    assert ".eta-num { font-size:clamp(52px,15vw,86px)" in HTML
    assert "function etaParts(sec)" in HTML


def test_bus_arrival_staleness_follows_scrape_cadence():
    """고정 10분 임계 대신 cron 수집 주기(퇴근 15분 / 그 외 30분)를 따른다."""
    assert "10 * 60 * 1000" not in HTML
    assert "function cadenceMinutes" in HTML or "const cadenceMinutes" in HTML
    assert "(h >= 16 && h < 22) ? 15 : 30" in HTML
    assert "cadence + 3" in HTML
    assert "cadence * 2 + 3" in HTML


def test_bus_arrival_stale_data_is_visually_demoted():
    """오래된 정보일 때 거대 ETA 숫자를 감쇠하고 배지를 노출한다."""
    assert ".hero.is-stale .eta-row { opacity:.45" in HTML
    assert 'id="stale-badge"' in HTML
    assert ".hero.is-stale .stale-badge { display:inline-block; }" in HTML
    assert "실시간 아님" in HTML


def test_bus_arrival_shows_relative_time_and_countdown():
    """기계식 타임스탬프 대신 상대 시간 + 경과분 차감 카운트다운."""
    assert "function relTime(ageMin)" in HTML
    assert "분 전 갱신" in HTML
    assert "n - (now - pollMs) / 1000" in HTML
    assert "setInterval(paint, 1000)" in HTML


def test_bus_arrival_confidence_classes_are_actually_applied():
    """정의만 되어 있던 신뢰도 색상 클래스를 JS가 실제로 부여한다."""
    assert ".conf-high { color:var(--go); }" in HTML
    assert 'confEl.className = "card-value " + conf.cls' in HTML
    assert 'cls:"conf-high"' in HTML
    assert 'cls:"conf-medium"' in HTML
    assert 'cls:"conf-low"' in HTML
    # 색상 단독 전달 금지: 점 + 텍스트 라벨 병기
    assert 'class=\\"dot\\" aria-hidden=\\"true\\"' in HTML


def test_bus_arrival_state_colors_do_not_collide():
    """--stale 이중 선언 제거, 상태별 역할 색 토큰만 사용."""
    assert ".confidence-low" not in HTML
    assert ".stale {" not in HTML
    for token in ("--go:", "--wait:", "--warn:", "--danger:"):
        assert token in HTML


def test_bus_arrival_cards_prioritise_decision_inputs():
    """빈자리/다음 버스/신뢰도를 카드로 승격하고 디버깅 지표는 접이식으로 이동."""
    assert 'id="card-seat"' in HTML
    assert 'id="card-next"' in HTML
    assert 'id="card-conf"' in HTML
    assert ".cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr))" in HTML
    # 표본/도착 기록은 카드가 아니라 접이식 수집 상세로 이동
    render_system = HTML[HTML.index("function renderSystem"):]
    assert "오늘 표본 " in render_system
    assert "누적 도착 기록 " in render_system
    assert "<details class=\"panel\"><summary>상세 수집 정보 보기</summary>" in HTML


def test_bus_arrival_chart_maps_value_to_height_forward():
    """막대 높이가 값에 정방향 비례하고, 데이터 없는 표본은 회색 최소 높이."""
    assert "100 - value / max * 88" not in HTML
    assert "Math.max(8, Math.round(p.sec / max * 100))" in HTML
    assert "bar bar-empty" in HTML
    assert 'Number(r.vehId || 0) !== 0 && Number.isFinite(sec) && sec > 0' in HTML


def test_bus_arrival_chart_is_scrollable_and_responsive():
    """30개 막대를 잘라내지 않고 폭에 맞춰 개수를 줄이고 스크롤을 허용한다."""
    assert ".chart { display:flex; align-items:flex-end; gap:4px; height:164px; overflow-x:auto" in HTML
    assert "const chartLimit = () =>" in HTML
    assert 'window.addEventListener("resize"' in HTML


def test_bus_arrival_empty_states_are_explicit():
    assert "도착 기록 수집 대기 중입니다." in HTML
    assert "수집된 예측 기록이 아직 없습니다." in HTML
    assert 'id="error-card"' in HTML
    assert 'role="alert"' in HTML
    assert "body.loading .skeleton" in HTML


def test_bus_arrival_live_region_is_scoped_not_whole_hero():
    """히어로 전체 aria-live 제거, 판정 변화만 알리는 전용 status 영역."""
    assert '<section class="hero" id="hero">' in HTML
    assert 'class="hero" aria-live' not in HTML
    assert HTML.count('aria-live="polite"') == 1
    assert 'id="sr-live" class="sr-only" role="status" aria-live="polite"' in HTML
    assert "if (announce !== lastAnnounced)" in HTML


def test_bus_arrival_accessibility_basics():
    assert 'name="color-scheme" content="light dark"' in HTML
    assert "@media (prefers-color-scheme: dark)" in HTML
    assert ":focus-visible { outline:2px solid var(--brand)" in HTML
    assert "font-variant-numeric:tabular-nums" in HTML
    assert 'aria-label="정류장까지 걸리는 도보 시간(분)"' in HTML
    assert '<label for="walk">' in HTML
    assert "@media (prefers-reduced-motion:reduce)" in HTML
    # 10px 소형 텍스트 제거
    assert "font-size:10px" not in HTML
