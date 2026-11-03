# 카카오맵 폴백 인계 (수집 모듈 완료 · scrape.py 연결 전)

> **2026-11-03 연결 완료.** 카카오는 GBIS 실패 시 폴백이 아니라 교대 조회 출처 중 하나로 연결했다. 현재 동작·결정 사항은 [SOURCES.md](SOURCES.md)를 본다. 아래는 인계 당시 기록이다.

2026-11-03. 사용자 요청: GBIS 공식 API(apis.data.go.kr) 조회가 실패하는 경우가 있어 카카오맵 정류장 정보를 **폴백**으로 쓰고 싶다. 사용자가 분담을 정했다. 이 세션은 수집 모듈만 만들고, `scrape.py` 연결은 주 세션에서 한다.

## 현재 상태

- 추가 파일 (untracked, 미커밋): `bus-arrival/scripts/kakao_stop.py`, `tests/test_bus_kakao_stop.py`, 이 문서.
- 기존 파일은 수정하지 않았다. 작업 트리는 주 세션 브랜치 `feature/bus-arrival-gbis-web-20261103`(`397c06f24a`, GBIS 웹 노선 위치 수집) 위에 있다.
- 검증: `cd tests && PYTHONUTF8=1 python -m unittest test_bus_kakao_stop` → 8개 통과. 기존 bus 테스트는 다시 돌리지 않았다(기존 파일 변경 없음).

## 확인된 사실

- `GET https://map.kakao.com/bus/stop.json?busstopid=BS73661` (유라코퍼레이션.SK케미칼, 07511): 인증 없이 JSON으로 29개 노선을 준다. 3100번은 `lines[].id == "B70088"`, `arrival.order == 6`(GBIS staOrder와 같음).
- **vehId가 없다.** 차량번호(`vehicleNumber`)만 있다. `predict_log.csv`의 차량번호와 vehId는 8대 모두 1:1이다.
- 값은 GBIS를 재배포한 것으로 보인다. 같은 차량 204001378/경기70아7046의 GBIS 값은 20:34:02에 445초·2정거장이고, 카카오 값은 20:34경 436초·2정거장이다. 20:43 실호출은 3100 차량 없음(`NOVEHICLE`)이었고, GBIS도 20:41부터 버스 없음이었다. 새로운 실측 정보는 없으며, 다른 호스트를 거치는 우회 경로라는 점이 이점이다.
- 카카오에 없는 값: `stateCd`(도착/출발), 잔여 좌석, `flag`(PASS/STOP), 2차 정류장. `vehicleState`는 0=운행, 1001=차량 없음, 1002=1정거장 전·곧 도착으로 보이지만 의미가 확인되지 않았다.
- **위험:** 공개 API가 아니라 카카오맵 웹 내부 주소라 예고 없이 바뀌거나 막힐 수 있다. `map.kakao.com/robots.txt`는 `User-agent: * / Disallow: /`(루트만 허용)이다. 사용자는 이를 알고도 폴백 용도로 진행하기로 했다. 그래서 GBIS가 실패한 조회에서만 부르도록 연결해야 한다.
- **미검증:** GitHub Actions runner(해외 IP)에서 map.kakao.com에 접근 가능한지는 확인하지 못했다(국내 로컬망에서만 확인).

## 모듈 API (`kakao_stop.py`)

| 함수 | 역할 |
| --- | --- |
| `fetch_info(plate_vid, stop_id="BS73661", line_id="B70088", sta_order=6, *, diagnostics=None, timeout=10)` | 실패하면 `None`을 돌려주고 `diagnostics`에 종류만 남긴다. 성공하면 `{"info", "raw"}`. `info`는 `scrape.no_bus_info()`와 **키가 같아** `observe()`에 그대로 넣을 수 있다. |
| `load_plate_map(predict_log_path)` | `predict_log.csv`에서 차량번호→vehId 표를 만든다. 나중 관측이 우선이고, `source`가 비었거나 `gbis`인 행만 쓴다. |
| `learn_plates(plate_vid, gbis_info)` | GBIS 정상 응답의 `veh_id/plate_no`, `next_veh_id/next_plate_no`로 표를 갱신한다. |
| `python bus-arrival/scripts/kakao_stop.py` | 1회 조회해 정규화 결과를 출력한다. 실패 시 종료 코드 1. runner 접근 확인용. |

- 첫 차량 번호가 표에 없으면 `unknown_vehicle` 실패다. vehId 없는 차량을 "버스 없음"으로 넘기면 추적이 잘못 종료되기 때문이다. 후속 차량 번호를 모르면 `next_veh_id=None`이고 번호만 채운다.
- 아래는 차량 없음이 아니라 실패로 처리한다: `invalid_response`, `line_missing`, `direction_mismatch`, `duplicate_direction`, `not_realtime`, `collect_status`, `invalid_vehicle`, 정류장 전 노선이 빈 `all_lines_empty`.
- 네트워크 실패: `timeout`(phase connect/read/other), `connection_error`, `http_error`(http_status), `unexpected_error`. URL·응답 원문·예외 메시지는 남기지 않는다.
- `state_cd`, `remain_seat`, `predict_min`은 None이고 `flag`는 `""`다(값을 만들어 넣지 않음). `raw`에 카카오 원래 값(vehicleState 등)이 있다.

## 연결 작업 (scrape.py, 현재 `397c06f24a` 기준)

1. **켜기 스위치:** GBIS 웹 패턴을 따라 `--kakao-fallback`(BooleanOptionalAction, 기본 꺼짐)과 `BUS_KAKAO_FALLBACK=1`을 추가한다. 워크플로 env에서만 켠다. 기존 테스트의 `simulate()`(`tests/test_bus_arrival_logic.py`)는 `fetch_arrival`만 가짜로 바꾸므로, 기본값이 켜져 있으면 테스트가 실제 카카오를 호출한다.
2. **호출 위치:** `run_loop`의 1차 조회 블록(`if args.primary_mode == "station-list": … else: …`) 직후, `api_latency_sec` 계산 전에 `gbis_failed = info is None`을 저장한다. 그다음 `gbis_failed`이면 `fetch_info()`를 부르고, 결과가 있으면 `info = result["info"]`, `primary_source = "kakao_fallback"`으로 둔다.
3. **runner 교체 유지 (필수):** `connection_failed`가 지금 `info is None and …`이다. 폴백이 성공하면 연속 연결 실패 횟수가 초기화되어 runner 교체가 멈추므로 `gbis_failed`로 바꾼다. 교체(8회 연속 연결 시간 초과 → 75)는 그대로 두고, 폴백은 교체 전 몇 분을 메우는 역할로 보는 것을 권한다. 사용자와 확정한 사항은 아니다.
4. **2차 정류장 조회:** 조건에 `primary_source != "kakao_fallback"`을 추가한다. GBIS가 실패한 상태라 다시 15초 시간 초과가 날 수 있다.
5. **호출 수:** `daily_calls`(data.go.kr 상한)에 넣지 않는다. `state["kakao"] = {date, calls, consec_fail, skip_until}`로 따로 센다. GBIS 웹처럼 3회 연속 실패 시 10분 쉬기를 권한다.
6. **차량번호 표:** `state["plate_vid"]`가 비었으면 `load_plate_map(predict_path)`로 채운다. GBIS 1차 성공 시마다 `learn_plates()`를 호출한다. `poll_gbis_web` 결과의 `vehicles`(veh_id, plate_no)는 3100 운행 차량 전체를 담고 있어 표 갱신에 가장 좋다.
7. **기록:**
   - `predict_log.csv`에 `source` 열(`gbis`/`kakao`)을 추가한다. `append_csv`가 첫 기록 때 헤더를 확장해 파일을 다시 쓴다(행 수 불변, `guard_rows` 영향 없음).
   - `arrival_log.csv`에 카카오 표본 수나 종료 근거 출처를 남길지 정한다.
8. **status.json:**
   - 폴백 성공 시 `primary_source: "kakao_fallback"`, `gbis_error_detail`(= `api_error_detail`), 카카오 호출 수를 기록한다.
   - 둘 다 실패하면 기존 `error: "api_error"`를 유지하고 `kakao_error_detail`을 추가한다.
   - `alarm.js`와 `dashboard.js`는 `error`/`no_bus`만 보므로 폴백 성공 시 알림은 그대로 동작한다.

## 결정이 필요한 것

- **`consec_fail`/`data_gap`:** 폴백이 성공하면 `observe()`가 `consec_fail=0`으로 만들어 `data_gap` 분류가 사라진다. 데이터가 이어졌다는 뜻이라 맞는 동작으로 보인다. 화면용으로 `gbis_consec_fail`을 따로 둘지 정한다.
- **카카오 차량 없음:** 추적 중 카카오가 차량 없음이라고 하면 `observe()`가 근거리(≤180초 또는 1정거장 전)일 때 즉시 종료한다. 목록 API 소실을 항목 조회로 재확인하던 규칙(`station_list_confirmed`)은 GBIS가 죽은 상태라 적용할 수 없다. 그대로 믿을지, 실패로 다룰지 정한다.
- **관측 시각:** GBIS 시간 초과 뒤 받은 카카오 값(조회 시작 후 최대 약 30초)을 조회 시작 시각 `ts`로 기록하면 안전 예측 도착이 그만큼 이르게 나온다(보수적 방향). 응답 수신 시각을 쓸지 정한다.
- **학습 제외:** `safety_model.match_trips`에서 `source == "kakao"` 행이 섞인 운행을 학습에서 뺄지 정한다. 모델은 GBIS 예측초 기준으로 보정되어 있다.
- **GBIS 웹과의 관계:** www.gbis.go.kr도 apis.data.go.kr과 다른 호스트다. vehId와 위치는 있지만 예측초는 없다. 1차 폴백을 카카오로 할지, GBIS 웹 위치를 보조 근거로 함께 쓸지 정한다.

## 나머지

- **`runner_diagnostics.py`:** `gbis_web_addresses`처럼 `map.kakao.com` DNS를 기록하고, runner에서 접근 가능한지 첫 세션에서 확인한다.
- **화면(선택):** `app.js` `renderSystem()`에 "카카오맵 대체 정보 · GBIS <오류>" 표시를 추가한다. `apiFailureLabel({api_error_detail: st.gbis_error_detail})`를 재사용할 수 있다.
- **문서:** `scrape.py` docstring을 갱신하고, `GBIS_WEB.md`와 같은 형식의 `reports/KAKAO_FALLBACK.md`를 작성한다.
- **테스트:** `simulate()`에 카카오 가짜 응답을 추가해 아래를 확인한다.
  - GBIS 성공 시 카카오 미호출
  - GBIS 실패 + 카카오 성공 시 추적 지속, `daily_calls` 불변, 2차 정류장 미호출, `source=kakao`
  - 둘 다 실패 시 기존 `api_error`
  - 폴백이 성공해도 8회 연속 연결 시간 초과면 75
  - 모르는 차량번호는 실패
  - 기본값 꺼짐

## 범위 밖 발견 (확인 필요)

`scrape.py`는 `logging.basicConfig(level=INFO)`이고 httpx 로거를 낮추지 않는다. httpx는 INFO로 `HTTP Request: GET <URL>`을 남기는데, data.go.kr 요청 URL에는 `serviceKey`가 들어 있다. GitHub Actions는 secret 원문만 가리므로, 키가 URL 인코딩으로 바뀌면 공개 저장소 Actions 로그에 노출될 수 있다. Actions 로그를 확인하고, 필요하면 `logging.getLogger("httpx").setLevel(logging.WARNING)`으로 막는다.

## 검증 명령

```sh
cd tests && PYTHONUTF8=1 python -m unittest test_bus_kakao_stop
PYTHONUTF8=1 python -m unittest discover -s tests -p 'test_bus*.py'
PYTHONUTF8=1 python bus-arrival/scripts/kakao_stop.py   # 실제 1회 호출
```
