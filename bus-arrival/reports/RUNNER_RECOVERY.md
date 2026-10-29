# API 연결 시간 초과와 runner 자동 교체

2026-10-29에는 기존 Actions 실행이 연결 단계에서 계속 시간 초과됐고, 해당 실행을 중단한 뒤 새 runner에서 같은 코드와 키로 정상 수집됐다. 특정 IP 차단이나 경로 장애 중 무엇이 원인인지는 확정하지 않았다.

## 교체 조건과 보존

- `BUS_MAX_CONNECT_TIMEOUTS=8`: 기본 정류장 조회가 **8회 연속 연결 시간 초과**일 때 scraper가 상태와 오류 상세를 저장하고 종료 코드 75를 반환한다. 실패 중 조회 간격은 기존 60초다.
- 목록 API와 항목 폴백을 모두 호출했으면 **둘 다** 연결 시간 초과여야 1회로 센다. 정상 목록 응답 뒤 차량 소실 재확인만 실패한 경우와 보조 정류장 오류는 교체 조건이 아니다.
- 정상 응답(차량 없음 포함), 응답 대기 시간 초과, 인증/호출 한도/HTTP 오류 등 다른 결과는 연결 실패 연속 횟수를 초기화한다. `BUS_MAX_CONNECT_TIMEOUTS=0`이면 자동 교체를 끈다.
- `session.sh`의 여러 scraper 프로세스는 같은 임의 세션 ID로 실패 횟수를 이어간다. 새 세션은 이 횟수만 다시 세며, 당일 호출량, 차량 추적, API 연속 실패에 따른 `data_gap` 판단과 다음 조회 시각은 이어받는다.
- 세션은 scraper가 75로 종료해도 기존 게시 절차를 먼저 실행한다. 상태/CSV/요약 게시가 성공한 뒤 75로 종료하고, 워크플로의 복구 artifact도 보존한다. 게시가 실패하면 기존 재시도와 artifact 보존 경로를 사용하며 게시 성공으로 보고하지 않는다.
- `status.json`에는 `consecutive_connect_timeouts`와 임계값 도달 시 `recovery_action: rotate_runner`를 기록한다. 다음 정상 조회에는 교체 요청이 남지 않는다. API 오류를 차량 없음이나 도착으로 바꾸지 않는다.

## 다음 실행과 제한

기존 concurrency와 30분 간격 예약을 유지한다. 연결 불능 실행이 종료되면 대기 실행이 새 runner에서 최신 main을 받아 수집한다. 대기 실행이 없으면 다음 예약을 기다리며, cron/runner 할당/Pages 배포 지연 때문에 복구 시간은 보장하지 않는다. API 전체 장애라면 새 runner도 실패할 수 있다. 추가 API 재시도나 자동 workflow dispatch 권한은 도입하지 않는다.

## 진단

수집 시작 전에 지역(Azure 메타데이터의 location만 조회), 외부 IP(ipify), API DNS 주소와 runner/run 식별자를 최선 노력으로 기록한다. 진단 실패는 수집을 막지 않는다. 지역 조회가 지원되지 않으면 null이며 Actions의 `Set up job` 로그에 있는 Region도 함께 확인한다.

결과는 `bus-arrival-network-<run_id>-<run_attempt>` artifact에 14일 보존한다. 공개 Pages/Git 데이터에는 외부 IP를 넣지 않는다. 인증키, 환경변수 전체, 응답 원문, 예외 메시지는 기록하지 않는다. 실패 단계는 기존 상태 JSON과 수집 로그의 `api_error_detail` 및 `station_list_error_detail`로 비교한다. artifact에 실행 시도 번호를 포함해 재실행 간 이름 충돌을 피한다.

검증: `python -m unittest discover -s tests -p 'test_bus*.py'`, `bash -n bus-arrival/scripts/session.sh`. 신규 테스트는 임계값, 구간 사이 누적, 새 runner 초기화, 상태·호출량 보존, 오류 종류 구분, 게시 후 종료 순서 및 진단 실패/민감값 배제를 가짜 API·시계·명령으로 확인한다.

참고: [GitHub runner 할당](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job), [예약 실행 지연](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Azure 인스턴스 메타데이터](https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service).
