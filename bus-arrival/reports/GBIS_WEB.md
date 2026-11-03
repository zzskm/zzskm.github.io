# GBIS 웹 노선 위치 수집 (관측 전용)

## 무엇을 더 수집하나

[GBIS 버스 검색 화면](https://www.gbis.go.kr/gbis2014/schBus.action?mapTabCd=1)이 노선을 그릴 때 쓰는 `schBusAPI.action?cmd=searchRouteJson&routeId=204000170` 응답을 매 조회(추적 중 60초, 버스 없음 120초)마다 1회 읽는다. 공공데이터포털 도착 API는 07511에 **가장 가까운 2대**의 예측만 주지만, 이 응답에는 3100번 **운행 차량 전체**의 현재 구간(출발 정류장 → 다음 정류장), 정류장 정차/구간 이동 여부(`busPosition` 1/2), 좌표(EPSG:3857), 잔여 좌석, 혼잡도가 들어 있다.

| 파일 | 내용 |
| --- | --- |
| `route_position_log.csv` | 조회 시각별 3100 전 차량 위치 원시 기록 (`from_order`/`to_order`는 노선 순번, 07511=6, 06004=12) |
| `route_pass_log.csv` | 차량의 출발 정류장 순번이 직전 조회 < 대상 ≤ 이번 조회일 때 07511/06004 **도달 구간** `(lower_ts, upper_ts]` |
| `status.json` → `gbis_web` | 성공 여부, 차량 수, 회차 대기 차량 수, 이번 도달 이벤트 수, 당일 호출 수, 오류 종류 |

`route_pass_log`는 지금 `arrival_log`가 쓰는 "예측초 + 차량 소실"보다 직접적인 도달 근거다. 같은 `veh_id`와 시각으로 두 로그를 맞춰 보면 기존 도착 추정치(`est_arrival_ts`)의 편향을 잴 수 있다. 다만 이 역시 GBIS가 보고한 위치이고 조회 간격만큼의 폭이 있는 구간이라 실제 정류장 도착 실측은 아니다.

## 기본 수집과 분리

- `BUS_GBIS_WEB=1`(워크플로 설정) 또는 `--gbis-web`일 때만 호출한다. 코드 기본값은 꺼짐이라 테스트와 로컬 실행은 네트워크에 나가지 않는다.
- 인증키를 보내지 않고 `daily_calls`(data.go.kr 900회 상한)에 포함하지 않는다. 호출 수는 `tracker_state.json`의 `gbis_web.calls`로 따로 센다.
- data.go.kr 요청이 끝난 뒤 호출하므로 `api_request_duration_sec`에 포함되지 않는다. 연결 5초·응답 10초 제한이며, **3회 연속 실패하면 10분간 호출하지 않는다.**
- 실패, 형식 변경, 예상 밖 예외 모두 `gbis_web` 상태에만 남는다. 3100 추적, `consec_fail`/`data_gap`, runner 교체(연결 시간 초과 연속 횟수), 알림·안전 모델, 게시 주기는 바뀌지 않는다.
- 오류 상세에는 종류/HTTP 상태/시간 초과 단계만 남기고 URL·응답 원문·예외 메시지는 남기지 않는다. `runner_diagnostics.py`는 `www.gbis.go.kr` DNS 주소도 기록한다.

## 도달 판정 규칙

- 차량별 직전 위치를 `tracker_state.json`의 `gbis_web.positions`에 둔다. 수집 구간 사이에도 이어지고, 20분(`STATE_MAX_AGE_SECONDS`)이 넘은 기록은 버린다. 공백이 20분을 넘으면 도달 이벤트를 만들지 않는다.
- 순번이 4 이상 되돌아가면 새 운행(회차, 40→1)으로 보고, 1~3 되돌아가는 흔들림은 무시해 같은 정류장을 두 번 세지 않는다.
- 여러 정류장을 한 번에 건너뛰면 사이에 있는 대상 정류장마다 1건씩 기록한다. `gap_sec`이 구간 폭이다.
- `busPosition=1`은 `from` 정류장에 정차 중, `2`는 `from → to` 구간 이동 중이다. 그래서 `cur_from_order=6, cur_bus_position=1`이면 그 조회 시점에 07511에 서 있었다.

2026-11-03 20:34~20:46 실측(20초 간격): 204001378이 `from 5, pos 2` (20:39:56) → `from 6, pos 1` (20:40:17)로 바뀌어 07511 도달 구간이 21초 폭으로 잡혔다. 같은 20:40:17에 받은 GBIS 웹 정류장 도착 응답(`searchBusStationJson`)에서는 3100 차량이 이미 빠져 있었다. 지금의 "1정거장 전 소실 = 도착 추정" 규칙이 다루는 바로 그 경우다.

## 제한

- GBIS 웹 화면용 내부 응답이라 공개 API처럼 형식이 보장되지 않는다. 형식이 바뀌면 `invalid_schema`로 실패한다.
- GitHub Actions runner(해외 IP)에서 접근 가능한지는 첫 수집 세션의 `status.json`/artifact로 확인해야 한다. 막혀 있어도 기본 수집은 그대로 동작한다.
- 알림에는 쓰지 않는다. 쓰려면 먼저 `route_pass_log`와 `arrival_log`를 날짜 분리로 비교하는 분석이 필요하다.

검증: `python -m unittest discover -s tests -p 'test_bus*.py'`. `tests/test_bus_gbis_web.py`가 파서, 오류 상세의 민감값 배제, 도달 구간·회차·흔들림·공백 처리, data.go.kr 호출 수 불변, 연속 실패 후 쉬기와 복구, 예외 격리를 가짜 응답·시계로 확인한다.
