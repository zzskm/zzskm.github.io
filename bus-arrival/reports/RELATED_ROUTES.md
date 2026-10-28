# 07511 정류장 전체 노선 관측 · 연관 노선 발굴

## 변경 범위

- 기본 07511 조회를 경기도 GBIS `getBusArrivalListv2`(정류장 전체 노선)로 대체한다.
- 이 중 **3100번(노선 ID 204000170, staOrder 6)**만 기존 `predict_log.csv`, `arrival_log.csv`, `status.json`, 실시간 안전 알림의 입력으로 사용한다.
- 나머지 노선은 같은 응답에서 `route_signal_log.csv`에 별도로 기록한다. 노선 ID, 이름, 방향(staOrder), 차량 ID, 차례, ETA와 위치를 보관한다. 타 노선의 차량번호판은 기록하지 않는다.
- `analyze_related_routes.py`가 `reports/related-routes.json`을 생성한다. 차량별 중복 조회를 묶어, 다른 노선의 ETA 신호와 추정된 3100번 도착 사이의 0~20분 선행 사례를 요약한다.
- **현재 알림 기준 및 안전 모델을 변경하지 않는다.** 신호의 연관성을 실제 도착 측정이나 성능 향상으로 주장하지 않는다.

## API 호출량 및 장애 대비

- 정상: 07511 기본 조회는 이전과 같은 **1회**. 3100번 차량이 잡혔을 때만 기존 보조 정류장(06004) 항목조회 **1회**.
- 목록 응답 실패: 기존 `getBusArrivalItemv2` 한 번 재시도. 이때 기본 정류장 호출이 2회가 될 수 있다.
- 이미 추적하던 3100번이 목록에서 갑자기 사라지면, 잘못된 도착 확정을 줄이기 위해 기존 항목조회로 **1회 확인**한다.
- 남은 호출 한도가 부족하면 추가 호출하지 않는다. `daily_calls`는 실제 호출 수를 기록한다.
- `status.json`의 `primary_source`는 `item`, `station_list`, `item_fallback`, `station_list_confirmed`, `station_list_error` 중 하나로 기록한다. `station_list_error_detail`에는 통제된 오류 유형과 코드만 기록한다.
- 장애/오검출 의심 시 워크플로 환경변수 `BUS_PRIMARY_MODE=item`으로 즉시 이전 수집 방식으로 되돌릴 수 있다. 자동 실행에는 `station-list`를 명시한다.
- 사용자 지정 `--route-id`/`--sta-order` 옵션도 유지한다.

## 보고서 해석 기준

`route_signal_log.csv`는 실제 통과 시각이 아닌 API의 **도착 예상치**다. 3100번의 기존 `arrival_log.csv` 역시 실제 정류장 도착 실측값이 아니다. 중복 관측은 차량·노선·방향·날짜 기준으로 1건으로 묶는다.

- 관측 운행일 10일, 후보 차량 15건, 3100번 후행 사례 10건을 충족해야 `sufficient_for_screening=true`이다. 이는 **발굴용 최소 표본**, 예측 적용 승인 기준이 아니다.
- 퇴근 시간대 주기성, 두 노선의 교통 상황 동조, 다차량 배차 때문에 우연히 선행할 수 있다. 현재의 선행 비율만으로 유용한 예측 변수라고 결정하면 안 된다.
- 다음 단계: 날짜 기준 훈련/검증 분리, 시간대·요일별 조건부 기준선, 연관 노선이 **아직 도착하지 않았을 때**의 음성 사례, 3100번 자체 ETA 대비 오차 개선 여부, 놓칠 가능성(조기 출발 안전율) 검증.
- 조기 출발 위험이 늘어나거나 개선폭이 없으면 관련 노선을 모델에 반영하지 않는다.
- `getBusArrivalListv2` 실제 운영 응답과 3100번 항목조회 결과의 일치율, 누락률을 우선 확인해야 한다.

출처: https://gbis.go.kr/gbis2014/publicService.action?cmd=mBusArrivalStation
