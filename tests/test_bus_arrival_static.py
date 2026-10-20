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
    assert ".eta-num { font-size:22px; }" in HTML
    assert "function etaParts(sec)" in HTML


def test_bus_arrival_staleness_follows_scrape_cadence():
    """출발 판단은 엔진의 3분 최신성 검증을 공유하고 휴일/시간 외를 구분한다."""
    assert "BA.assessStatus(st, now, { maxAgeMin:3, safetyMode:true })" in HTML
    assert 'get("holidays.json", false)' in HTML
    assert "isHoliday(kstClock(now).date)" in HTML
    assert 'statusLabel = holiday ? "휴일" : "수집 시간 외"' in HTML



def test_bus_arrival_reads_recent_rows_from_summary():
    """1분마다 전체 CSV 를 받지 않도록 summary.json 의 최근 기록을 우선 사용한다."""
    assert "summary.recent_predictions" in HTML
    assert "summary.recent_arrivals" in HTML
    assert "r.est_arrival_ts || r.ts_kst" in HTML
    for reason in ("vanished:", "stale:"):
        assert reason in HTML


def test_bus_arrival_stale_data_is_visually_demoted():
    assert 'classList.toggle("is-stale", !available)' in HTML
    assert '$("#eta-row").hidden = parts.num === "--";' in HTML
    assert '최신 차량 정보로 다시 판단합니다.' in HTML



def test_bus_arrival_reports_how_long_ago_the_bus_passed():
    """API 시각 경과를 실제 통과로 확정하지 않는다."""
    assert 'view.state === "elapsed"' in HTML
    assert '예상 시각이 지났지만 실제 통과를 확인한 것은 아닙니다.' in HTML
    assert '통과 추정 · 다음 버스를 확인하세요' not in HTML



def test_bus_arrival_shows_relative_time_and_countdown():
    assert 'view.ageSec' in HTML
    assert '차량 정보 확인' in HTML
    assert 'view.departureAtMs-now' in HTML
    assert 'setInterval(tick, 1000)' in HTML



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
    """API 이력과 현재 보정 한 건을 구분하고 관측 공백을 연결하지 않는다."""
    assert 'BD.targetSeries(st, cache.predictions, dashboardView)' in HTML
    assert 'BD.splitGaps(pts,st && st.poll_interval_sec)' in HTML
    assert 'id="chart-table"' in HTML
    assert 'id="chart-arrival"' in HTML and 'id="chart-remaining"' in HTML
    assert '과거 보정 이력이나 확률 구간이 아닙니다.' in HTML
    assert '오차가 ±3분' not in HTML



def test_bus_arrival_chart_is_responsive():
    assert 'viewBox="0 0 ' in HTML
    assert '.trend { display:block; width:100%; height:auto' in HTML
    assert 'window.addEventListener("resize"' in HTML



def test_bus_arrival_empty_states_are_explicit():
    assert '운행 기록 수집 대기 중입니다.' in HTML
    assert '관측 한 건만 있어 추이는 아직 알 수 없습니다.' in HTML
    assert 'id="error-card"' in HTML
    assert 'role="alert"' in HTML
    assert 'body.loading .skeleton' in HTML



def test_bus_arrival_surfaces_data_state_and_decision_reason():
    assert 'id="status-chip"' in HTML and 'id="decision-note"' in HTML
    assert '오래되거나 불확실한 정보' in HTML
    assert '실시간에서 확인된 차량 없음' in HTML
    assert '최근 운행 기록' in HTML
    assert '<ul class="arrival-list" id="arrivals">' in HTML
    assert '실제 도착을 측정한 기록이 아닙니다.' in HTML



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
    assert "도착 시각은 추정이며" in HTML


def test_bus_arrival_alarm_survives_hidden_tabs_and_reloads():
    """숨겨진 탭(타이머 스로틀링)과 탭 복귀/재연결에서도 제시간에 판정한다."""
    assert "new Worker(URL.createObjectURL(new Blob(" in HTML
    assert "if (document.hidden) tick();" in HTML
    assert 'document.addEventListener("visibilitychange"' in HTML
    assert 'window.addEventListener("online", refreshNow)' in HTML
    assert 'window.addEventListener("pageshow"' in HTML
    # 재로드 뒤 소리 잠김은 첫 사용자 입력에서 푼다
    assert '["pointerdown", "keydown"].forEach(ev => window.addEventListener(ev, unlockAudio))' in HTML
    assert '["#alarm-sound",readiness.sound,readiness.soundReady]' in HTML
    # 저장소를 쓸 수 없는 환경에서도 동작한다
    assert "catch (e) { /* 저장 불가 환경 */ return false; }" in HTML


def test_bus_arrival_alarm_can_be_tried_without_a_real_bus():
    """?mock=<초> 와 알림 테스트 버튼으로 실제 버스 없이 알림을 끝까지 시험할 수 있다."""
    assert 'new URLSearchParams(location.search).get("mock")' in HTML
    assert 'id="alarm-test"' in HTML


def test_bus_arrival_walk_stepper_and_tab_title():
    """도보 시간은 −/+ 스텝퍼로 바로 저장하고, 탭 제목/파비콘에 남은 시간을 보여 준다."""
    assert 'id="walk-dec"' in HTML and 'id="walk-inc"' in HTML
    assert 'input.addEventListener("input"' in HTML
    assert 'input.addEventListener("change", () => commitPreference' in HTML
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


def test_bus_arrival_alarm_windows_limit_which_buses_alert():
    """퇴근 시간대(버스 도착 시각 기준)를 지정해 원치 않는 시간대의 버스 알림을 막는다."""
    for element in ("alarm-windows", "window-add", "window-hint"):
        assert f'id="{element}"' in HTML
    assert 'type=\\"time\\" data-f=\\"start\\"' in HTML
    assert "BA.sanitizeWindows(next)" in HTML
    assert "끝 시각은 시작 시각보다 늦어야 해요." in HTML
    assert "알림 시간대(" in HTML                      # 시간대 밖 버스는 알리지 않는다는 안내
    assert "시간대 제한 없음" in HTML                  # 시간대를 모두 지우면 모든 버스에 알림


def test_bus_arrival_custom_clock_alarms_and_timers_replace_the_extension():
    """참고한 확장 프로그램처럼 시각 알람(요일 반복/한 번)과 타이머를 등록할 수 있다."""
    for element in ("clock-panel", "clock-form", "clock-time", "clock-label", "clock-days", "clock-weekdays", "clock-bus",
                    "clock-list", "timer-presets", "timer-form", "timer-custom", "timer-label", "timer-list", "clock-notice"):
        assert f'id="{element}"' in HTML
    assert 'type="time" id="clock-time"' in HTML
    assert "요일을 고르지 않으면 다음에 오는 그 시각에 한 번만 울립니다." in HTML
    assert 'const CLOCKS_KEY = "busAlarm.v1.clocks"' in HTML
    assert 'TIMERS_KEY = "busAlarm.v1.timers"' in HTML
    # 버스 알림과 같은 잠금 안에서 판정해 여러 탭에서도 한 번만 울린다
    assert "BA.evaluateClocks({" in HTML and "BA.evaluateTimers({" in HTML
    assert "BA.rearmClock(c, Date.now())" in HTML
    assert "function showRing(msg, tag, silent)" in HTML
    assert 'action.type === "clock_missed"' in HTML     # 놓친 알람은 소리 없이 알린다
    assert "BA.busHint(snap, now)" in HTML               # 알람 메시지에 다음 버스 정보를 덧붙인다


def test_bus_arrival_clock_alarms_default_to_weekday_repeat():
    """시각 알람 폼은 평일 반복으로 시작해 울린 뒤에도 꺼지지 않고, 한 번짜리는 '한 번만'으로 고른다."""
    assert 'dayButtons([1, 2, 3, 4, 5])' in HTML
    assert 'id="clock-once"' in HTML and 'id="clock-everyday"' in HTML
    assert '$("#clock-once").addEventListener("click", () => pickDays([]))' in HTML
    assert "기본은 평일 반복입니다." in HTML


def test_bus_arrival_shows_same_weekday_arrivals_from_previous_weeks():
    """도착 알림 패널에 지난 4주 같은 요일에 알림 시간대 안으로 도착한 버스 범위를 안내한다."""
    assert 'id="alarm-history"' in HTML and 'id="alarm-history-note"' in HTML
    assert "BA.weeklyArrivalSlots({" in HTML and "BA.formatSlot(s, r.weeksWithData)" in HTML
    # 30일치 로그를 10분에 한 번만 받아 쓴다 (summary.json 의 최근 30건으로는 지난주를 알 수 없다)
    assert 'get("arrival_log.csv", true,generation)' in HTML
    assert "HISTORY_REFRESH_MS = 10 * 60000" in HTML
    assert "renderHistory();" in HTML

def test_bus_ui_progressive_disclosure_and_timeline_order():
    for element in ('journey-timeline','alarm-settings','settings-summary','clock-create','timer-create','open-settings'):
        assert f'id="{element}"' in HTML
    assert HTML.index('id="hero"') < HTML.index('id="journey-timeline"') < HTML.index('id="cards"') < HTML.index('id="alarm"')
    assert '<script src="dashboard.js"></script>' in HTML
    assert 'BD.buildView(' in HTML


def test_bus_ui_timeline_and_browser_events_do_not_claim_delivery():
    assert '이 브라우저의 알림 실행은 OS 알림 전달 완료를 뜻하지 않습니다.' in HTML
    assert '계산된 예정' in HTML
    assert 'busDashboard.v1.events' in HTML
    assert 'id="alarm-undo-skip"' in HTML
    assert '같은 요일 운행 시각 비교' in HTML
    assert '점 하나가 운행 하나입니다.' in HTML
