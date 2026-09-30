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
    """고정 임계 대신 게시 주기(5분)와 현재 조회 간격을 따르고, 수집 시간대/휴일 밖은 따로 구분한다."""
    assert "10 * 60 * 1000" not in HTML
    assert "const PUBLISH_MINUTES = 5;" in HTML
    # 조회 간격(status.poll_interval_sec)이 길어지면 최신성 임계값도 늘어난다 (alarm.js 와 공유)
    assert "BA.freshnessLimits(PUBLISH_MINUTES, intervalSec)" in HTML
    assert "limits.fresh" in HTML and "limits.aging" in HTML
    assert "poll_interval_sec" in HTML
    # 수집 시간대는 status.json 의 collect_window 를 따르고, 기본값은 평일 퇴근 시간대
    assert "parseWindow(st && st.collect_window)" in HTML
    assert 'WINDOW_RE.exec("16:00-22:00")' in HTML
    assert "c.day >= 1 && c.day <= 5" in HTML
    assert 'if (state !== "fresh" && !collecting) state = "off";' in HTML
    assert 'statusLabel = holiday ? "휴일" : "수집 시간 외"' in HTML
    # 휴일은 holidays.json 을 수집기와 함께 쓴다
    assert 'get("holidays.json", false)' in HTML
    assert "!isHoliday(c.date)" in HTML


def test_bus_arrival_reads_recent_rows_from_summary():
    """1분마다 전체 CSV 를 받지 않도록 summary.json 의 최근 기록을 우선 사용한다."""
    assert "summary.recent_predictions" in HTML
    assert "summary.recent_arrivals" in HTML
    assert "r.est_arrival_ts || r.ts_kst" in HTML
    for reason in ("vanished:", "stale:"):
        assert reason in HTML


def test_bus_arrival_stale_data_is_visually_demoted():
    """오래된 ETA를 계속 앞으로 주장할 때만 감쇠를 걸고, 통과 추정 표시 중에는 해제한다.
    최신성 표시는 상태 칩과 갱신 문장으로 통일하고 별도 배지는 두지 않는다."""
    assert ".hero.is-stale:not(.is-passed) .eta-row { opacity:.45" in HTML
    assert 'id="stale-badge"' not in HTML
    assert "실시간 아님" in HTML
    assert 'classList.toggle("is-passed", passed)' in HTML


def test_bus_arrival_reports_how_long_ago_the_bus_passed():
    """도착 예정 시각이 지났으면 '판단 보류' 대신 통과 후 경과 시간을 알린다."""
    assert "판단 보류 · 정보가 오래되었습니다" not in HTML
    assert "도착 예정 시각 지남" not in HTML
    assert "function passedParts(min)" in HTML
    assert "function agoText(min)" in HTML
    assert "통과 추정" in HTML
    assert 'text = agoText(passedMin) + " 통과 추정 · 다음 버스를 확인하세요"' in HTML
    # 통과 판정은 예정 시각 대비 경과분에서 계산되며, 표시는 감쇠 대상이 아니다
    assert "const passedMin = rawAdj != null && rawAdj < 0 ? -rawAdj / 60 : null;" in HTML
    assert "const passed = passedMin != null && passedMin >= 2;" in HTML
    # 통과 추정이 수집 오류보다 뒤, stale 판단보다 앞에 놓인다
    assert HTML.index("수집 오류 · 실시간 아님") < HTML.index('agoText(passedMin) + " 통과 추정')
    assert HTML.index('agoText(passedMin) + " 통과 추정') < HTML.index('" · 판단 보류"')


def test_bus_arrival_shows_relative_time_and_countdown():
    """기계식 타임스탬프 대신 상대 시간 + 경과분 차감 카운트다운."""
    assert "function relTime(ageMin)" in HTML
    assert 'return agoText(ageMin) + " 갱신";' in HTML
    assert '"분 전"' in HTML
    assert "n - (now - pollMs) / 1000" in HTML
    # 1초 tick 하나가 화면과 알림 판정을 함께 갱신한다
    assert "setInterval(tick, 1000)" in HTML
    assert "function tick()" in HTML


def test_bus_arrival_confidence_moves_to_details():
    """신뢰도는 판단 카드 대신 접이식 상세에 남긴다."""
    assert 'id="card-conf"' not in HTML
    assert 'id="quality-chip"' not in HTML
    render_system = HTML[HTML.index("function renderSystem"):]
    assert "예측 신뢰도 " in render_system
    assert 'high:    { label:"높음"' in HTML


def test_bus_arrival_state_colors_do_not_collide():
    """--stale 이중 선언 제거, 상태별 역할 색 토큰만 사용."""
    assert ".confidence-low" not in HTML
    assert ".stale {" not in HTML
    for token in ("--go:", "--wait:", "--warn:", "--danger:"):
        assert token in HTML


def test_bus_arrival_cards_prioritise_decision_inputs():
    """빈자리/다음 버스/현재 위치(N정거장 전)를 카드로 두고, 버스가 없으면 접으며, 디버깅 지표는 접이식으로 둔다."""
    assert 'id="card-seat"' in HTML
    assert 'id="card-next"' in HTML
    assert 'id="card-stops"' in HTML
    assert "const stopsText = (n) =>" in HTML
    assert ".cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr))" in HTML
    assert '$("#cards").hidden = !(vehOk && !off);' in HTML
    # 표본/도착 기록은 카드가 아니라 접이식 수집 상세로 이동
    render_system = HTML[HTML.index("function renderSystem"):]
    assert "오늘 표본 " in render_system
    assert "추적 표본 " in render_system
    assert "누적 도착 기록 " in render_system
    assert "조회 간격 " in render_system
    assert '<details class="panel"><summary>상세 수집 정보 보기</summary>' in HTML


def test_bus_arrival_chart_plots_current_vehicle_trend():
    """원시 폴링 막대 대신 현재 차량의 도착 예측 추이 선 그래프 + 알림 기준선 + 스크린리더용 표."""
    assert "bar-empty" not in HTML
    assert "function renderChart()" in HTML
    assert "Number(r.vehId || 0) === veh" in HTML
    assert 'class=\\"line\\"' in HTML and 'class=\\"proj\\"' in HTML
    assert 'class=\\"lead\\"' in HTML          # 알림 N분 전 기준선
    assert 'id="chart-table"' in HTML          # 그림에 의존하지 않는 대체 표
    assert "현재 추적 중인 차량이 없습니다." in HTML


def test_bus_arrival_chart_is_responsive():
    """SVG viewBox 로 폭에 맞게 줄고, 리사이즈 시 다시 그린다."""
    assert 'viewBox=\\"0 0 " + W + " " + H' in HTML
    assert ".trend { display:block; width:100%; height:auto" in HTML
    assert 'window.addEventListener("resize"' in HTML


def test_bus_arrival_empty_states_are_explicit():
    assert "도착 기록 수집 대기 중입니다." in HTML
    assert "예측 추이는 차량이 2회 이상 관측되면 표시됩니다." in HTML
    assert 'id="error-card"' in HTML
    assert 'role="alert"' in HTML
    assert "body.loading .skeleton" in HTML


def test_bus_arrival_surfaces_data_state_and_decision_reason():
    """최신성·도보 비교가 접힌 상세 영역 밖에 표시되고, 판단 근거 문장은 이상 상태에서만 나온다."""
    assert 'id="status-chip"' in HTML
    assert 'id="decision-note"' in HTML
    assert 'statusLabel = "오래된 정보"' in HTML
    assert 'statusLabel = "현재 버스 없음"' in HTML
    assert '도보 " + walk + "분' in HTML
    assert '$("#decision-note").hidden = !decisionNote;' in HTML
    assert "최근 도착 기록" in HTML
    # 표는 목록으로 바뀌어 좁은 화면에서도 가로 스크롤이 없다
    assert '<ul class="arrival-list" id="arrivals">' in HTML
    assert '<table id="arrivals">' not in HTML


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


def test_bus_arrival_keeps_last_good_status_on_fetch_failure():
    """일시적인 조회 실패가 카운트다운/알림을 끊지 않도록 마지막 정상 데이터를 유지한다."""
    assert "cache.netError = Boolean(cache.status);" in HTML
    assert "cache.status = status;" in HTML
    assert "cache.status = null" not in HTML
    assert "연결 불안정 · 마지막 정상 " in HTML


def test_bus_arrival_alarm_panel_and_engine_are_wired():
    """도착 N분 전 알림: 순수 엔진(alarm.js) + 패널/배너/권한/소리/다중 탭 방지."""
    assert '<script src="alarm.js"></script>' in HTML
    assert HTML.index('<script src="alarm.js"></script>') < HTML.index("const BA = window.BusAlarm")
    for element in ("alarm-toggle", "alarm-chips", "alarm-custom", "alarm-next", "alarm-test",
                    "alarm-skip", "alarm-banner", "alarm-ack", "alarm-perm", "alarm-sound"):
        assert f'id="{element}"' in HTML
    assert 'role="switch"' in HTML
    assert 'id="alarm-banner" role="alert"' in HTML
    assert "const PRESET_LEADS = [5, 7, 10];" in HTML       # 기본 5분: 버스는 도착 약 11분 전에야 표시된다
    assert "Notification.requestPermission()" in HTML
    assert "requireInteraction:true" in HTML
    assert 'navigator.locks.request("busAlarm:eval"' in HTML   # 여러 탭에서 중복 발화 방지
    assert "BA.beepSchedule(seconds)" in HTML
    assert "BA.evaluate({" in HTML
    assert 'const CFG_KEY = "busAlarm.v1.cfg"' in HTML
    assert "3분 이하 알림은 예측이 멈춘 채" in HTML          # 정확도 한계를 솔직하게 알린다


def test_bus_arrival_alarm_survives_hidden_tabs_and_reloads():
    """숨겨진 탭(타이머 스로틀링)과 탭 복귀/재연결에서도 제시간에 판정한다."""
    assert "new Worker(URL.createObjectURL(new Blob(" in HTML
    assert "if (document.hidden) tick();" in HTML
    assert 'document.addEventListener("visibilitychange"' in HTML
    assert 'window.addEventListener("online", refreshNow)' in HTML
    assert 'window.addEventListener("pageshow"' in HTML
    # 재로드 뒤 소리 잠김은 첫 사용자 입력에서 푼다
    assert '["pointerdown", "keydown"].forEach(ev => window.addEventListener(ev, unlockAudio))' in HTML
    assert "소리 잠김 · 클릭하여 활성화" in HTML
    # 저장소를 쓸 수 없는 환경에서도 동작한다
    assert "catch (e) { /* 저장 불가 환경 */ }" in HTML


def test_bus_arrival_alarm_can_be_tried_without_a_real_bus():
    """?mock=<초> 와 알림 테스트 버튼으로 실제 버스 없이 알림을 끝까지 시험할 수 있다."""
    assert 'new URLSearchParams(location.search).get("mock")' in HTML
    assert 'id="alarm-test"' in HTML


def test_bus_arrival_walk_stepper_and_tab_title():
    """도보 시간은 −/+ 스텝퍼로 바로 저장하고, 탭 제목/파비콘에 남은 시간을 보여 준다."""
    assert 'id="walk-dec"' in HTML and 'id="walk-inc"' in HTML
    assert 'walkInput.addEventListener("input"' in HTML
    assert "min-height:44px" in HTML                    # 터치 목표
    assert 'const title = bell + (etaShort ? etaShort + " · " : "") + BASE_TITLE;' in HTML
    assert 'id="favicon"' in HTML
    assert "function setFavicon(text)" in HTML


def test_bus_arrival_hero_is_decluttered():
    """정류장 정보 중복, 디버그 지표, 빈 ETA 를 히어로에서 걷어낸다."""
    assert 'class="hero-label"' not in HTML
    assert 'class="station-box"' not in HTML
    assert "추적 표본 " not in HTML[:HTML.index("function renderSystem")]
    assert '$("#eta-row").hidden = parts.num === "--";' in HTML
