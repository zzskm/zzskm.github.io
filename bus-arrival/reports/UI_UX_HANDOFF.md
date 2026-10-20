# bus-arrival UI·UX 구현 체크포인트 인계

> 후속 작업에서 잔여 구현과 검증을 완료했다. 최종 동작·검증·전후 화면은 [UI_UX.md](UI_UX.md)를 기준으로 한다. 아래는 스테이징 인계 당시의 기록이며 역사 보존용이다.

2026-10-20. 사용자가 구현 도중 다음 세션에서 계속하기로 요청하여 중간 상태를 보존했다. **완료된 기능 전체가 아니며, PR·배포 가능한 최종 검증 상태로 간주하지 않는다.**

## 저장소와 브랜치

- 저장소: zzskm/zzskm.github.io, 로컬 `E:/Work/zzskm.github.io`.
- 브랜치: `codex/bus-arrival-ui-ux`. 이번 세션은 `origin/main`의 `96e32207ad`(자동 데이터 커밋)에서 분기했다.
- 현재 브랜치의 **스테이징된 변경**에서 이어간다. 체크포인트 커밋은 Git user.name/user.email 미설정으로 실패했다. 새 브랜치 생성이나 초기화로 기존 작업을 잃지 말 것.
- 원격 main은 자동 데이터 커밋으로 계속 변한다. 시작 시 status/log/diff를 확인하고, 최종 PR 전에 최신 main과의 호환성을 확인한다.
- 이번 세션은 스테이징된 변경과 패치 백업을 보존했다. 체크포인트 커밋 시도는 author identity unknown으로 실패했으며 커밋·push·PR·main 병합은 수행되지 않았다. 기존 Git 작성자 설정을 확인해 적절한 신원을 설정한 후 커밋할 것. 최종 완료 시 push·PR 생성 및 채팅 연결까지 진행한다.

## 확정된 제품 기준

- 대상 경기 3100번. 출발 판단 → 알림 준비 → 차량·최신성 → 간단 타임라인 → 상세·설정 순으로 이해하게 한다.
- 권장 출발 시각을 **지나면 즉시** 주의 상태. 첫 1분은 1분 미만 지남, 이후 완료된 경과분. 실제 도착·통과·탑승 실패를 확정하지 않는다.
- 차량 제외 후 대체 대상이 없으면 이번 차량 제외됨·다음 차량 확인 중. 제외 차량으로 출발을 권장하지 않는다.
- 사용자가 제외하여 후속 차량을 선택하면 상단·타임라인·카드·그래프를 선택 차량으로 통일한다. 그래프 이력이 없으면 현재 후속 API 점 1개와 이력 부족 안내를 제공한다.
- 시간대 설정만으로 후속 차량에 알리는 기존 동작은 현재 차량의 출발 판단을 유지하고 알림 대상 차이를 명시한다.
- GitHub Pages·Actions, 기존 예측·안전 보정 정책과 엔진 책임 분리, 공개 CSV/JSON·원본 로그·설정 키를 보존한다.
- 중앙값 기반 안전 알림, 근거 없는 확률 구간·도착 보장, PWA/푸시·추가 고정바·프리셋·차량 선택 확장은 이번 범위 밖이다.
- 별도 브랜치 커밋·PR까지 진행하며 main에는 직접 병합하지 않는다. 비밀정보를 출력/커밋하지 않는다.

## 구현한 부분

### 순수 표시 모델: dashboard.js

- `overdue`, `skipped` 상태 및 `departureElapsedSec`, `observationAtMs` 추가.
- 출발 전 60초 미만/정확한 시각/경과 표시. 경과는 warn 색상이며 예정 사건은 계속 planned로 유지.
- 제외한 현재/알림 대상의 안내 억제. 유효한 후속 대상 선택 시 기존 엔진 값을 사용.
- `relativeTime`, `buildReadiness`, `targetSeries` 순수 함수 추가.
- 전체 timeline을 유지하며 `summaryTimeline`(최대 4개)과 `detailTimeline`으로 나눔.
- 실제 표시 차량·현재/후속 구분·운행 시작·도보·여유의 `comparisonKey`로 변화 안내 비교 범위 제한.

### index.html 1차 연결

- 출발 판단 강조, 도착 예상 보조화, 모델/조기 대비 근거 접이식 정리.
- 상단에 설정 켜짐/OS 권한/소리 상태 요약 및 버튼 연결. 기존 하단 패널과 같은 준비 모델 사용.
- 제외/30초 되돌리기를 상단 차량 정보 근처로 이동하고 제외할 차량 ID 표시.
- 마지막 정상 확인 절대시각+경과시간 표시. 타임라인 기본/상세 분리 및 상대시간 표시.
- 모바일 카드 2열+다음 차량 전체 폭, 주요 보조 글자 14px, 주요 터치 영역 44px 유지.
- 현재·요일 비교 그래프가 컨테이너 폭을 사용하도록 1차 수정. 선택 후속 차량 그래프 점 1개 표시.
- `appliedWalk`/`appliedMargin`과 입력 초안 분리. 빈칸·잘못된 입력은 기존 적용값 유지. 유효 입력은 change/Enter, 스테퍼는 즉시 적용. 적용값 요약과 필드 오류 추가.
- 다른 탭 도보/여유 적용값 동기화 시 편집 중인 필드의 초안은 덮어쓰지 않음.
- `queueRender`로 주요 표시 호출을 합치기 시작함. 알림 평가·발화는 rAF 밖 기존 엔진에 유지.
- live 안내 키를 상태·차량·신뢰도로 변경하여 매분 카운트다운 반복 안내 감소.

### 회귀 테스트

- Node 신규 6개: 출발 경계, 제외/꺼짐/예약, 후속 그래프, 요약 타임라인, 준비 상태, 설정/운행 비교 경계.
- Chromium 신규 4개: 경과 즉시 경고, 제외 후 안내 제거/되돌리기, 빈칸 편집 보호와 확정, 후속 차량 그래프.
- 기존 정적 검사와 브라우저 검사는 의도된 구조/표시 변경에 맞춰 수정. 프레임 반영 대기는 Playwright expect 사용.
- `alarm.js`, 수집/예측 Python, 공개 데이터 파일은 수정하지 않았다.

## 다음 세션의 우선 작업

1. **현재 변경 재검토와 P0 복합 상태 보강**: 최신성·예약 경고·제외·알림 꺼짐·후속 차량이 겹치는 상황을 점검한다. 특히 `targetSeries`는 현재 `selectedNext`를 기준으로 분기하므로, 최신성 만료 후 `reserved` 상태의 후속 대상에서 선행 차량 그래프가 섞이지 않는지 보강해야 한다. 현재 차량 모델 정보/정체 안내가 후속 그래프에 섞이지 않도록 확인한다.
2. **200% 확대 가로 넘침 수정**: 390px에서 CSS zoom 2로 확인 시 가로 넘침이 있다. 폼 입력·버튼·차트·타임라인을 실제 원인별로 확인한다. 단순 overflow 숨김으로 조작 요소를 가리지 말 것.
3. **핵심 정보 우선 로딩**: `load()`는 아직 예전 방식으로 status/summary/휴일/CSV까지 모두 await한다. 기존 검증 조건을 보존하면서 핵심 상태를 먼저 반영하고 보조 영역은 따로 로딩/오류를 표시한다.
4. **새로고침 제어**: 동일 핵심 요청 Promise 합류, 요청별 10초 timeout/AbortController, 응답 세대 검사, 새 자료 반영/자료 동일/확인 실패 피드백을 구현한다. 마지막 정상 정보·원래 관측 시각 유지. `refresh-status`, `aux-status` 요소는 만들어졌으나 아직 기능 연결 전이다.
5. **초점과 편집 위치 보존**: `renderWindows`, 알림 칩, 시각 알람 목록 등은 여전히 innerHTML 전체 교체가 남아 있다. 상태/값만 갱신하거나 항목/조작별 초점 복원. 삭제 후 다음 항목/추가 버튼으로 초점 이동. 마지막 요일/리드 제거 불가 이유, 인접 시간대 오류/aria-describedby 제공.
6. **알림 준비 세부 마무리**: OS 차단 해결 안내를 구체화하고 미지원 오디오 표시를 상·하단에서 일치시킨다. AudioContext statechange/권한 상태 변경/실패 처리를 검증한다. 설정 켜짐과 전달 보장을 구별한다.
7. **렌더링 정리 완성**: 직접 renderAlarm/paint/renderChart 호출이 아직 일부 남아 있다. 같은 데이터·평가 결과의 최종 화면을 한 번 갱신하고, 차트는 데이터/대상/설정/폭 변화 때만 그린다. 알림·원장·Web Locks·숨김 탭 동작을 렌더 스케줄에 종속시키지 않는다.
8. **사용성·시각 검증 완성**: 상단/도착 문구 중복·반복 모델 설명 정리, 설정 저장 실패 피드백의 정확성, 펼침/스크롤/초점 유지, 단일 live 영역의 의미 있는 변화만 안내 확인. 타이머·시각 알람·다중 탭·권한·오디오 회귀 보강.
9. 전체 회귀·360/390/1280·밝음/어두움·200% 확대·키보드·초점·대비 확인. 전후 화면과 미검증 항목으로 UI_UX.md를 최종 갱신. 완료 후 커밋/push/PR 생성·CI 확인·채팅 연결. main 직접 병합 금지.

## 검증 결과

- `node --test tests/bus_dashboard.test.mjs tests/bus_alarm.test.mjs tests/bus_safety.test.mjs`: **82/82 통과**.
- 아래 Python 전체 버스 6개 파일 명령: **93 통과, 1 실패**(총 94). 이 중 Chromium **18/18 통과**.
- 남은 실패: `tests/test_bus_safety.py::SafetyDataTests::test_session_refuses_stale_checkout_and_retains_commits_on_rebase_conflict`.
- 실패 원인 진단: Windows `subprocess.run(..., input=script, text=True)`가 LF를 CRLF로 바꾸어 Bash stdin에 전달함. stderr에서 `set: pipefail\n: invalid option name`, `$'\r': command not found`, `publish() {\r` 구문 오류를 확인했다. 세션 스크립트는 이번 변경에서 수정하지 않았다. Linux CI 또는 LF를 보존하는 테스트 입력으로 재검증할 것. 테스트 무작정 삭제/skip 금지.
- 최초 실행의 cp949 오류는 Python UTF-8 모드로 해소했다.
- `git diff --check` 통과.
- 모의 waiting/overdue/stale/skipped/next 390px 전후 캡처: pageerror 없고 일반 배율 가로 넘침 없음. 360/1280/다크 화면도 저장했으나 전체 시각 QA 완료를 의미하지 않는다. 200% 확대는 넘침 확인됨.
- 실제 모바일 터치·햇빛·실제 스크린리더·실제 OS 알림 전달/음량·Pages 배포는 미검증.

## 로컬 테스트 환경과 실행법

- 임시 가상환경: `C:/Users/z/AppData/Local/Temp/bus-ui-ux-venv/Scripts/python.exe`.
- 설치됨: bus-arrival/requirements.txt, pytest, playwright, Chromium. 전역 Python에는 pytest가 없다.
- Windows에서는 Python `-X utf8` 및 `PYTHONUTF8=1` 권장. 테스트 실행 예:

```powershell
$taskPython = Join-Path $env:TEMP 'bus-ui-ux-venv\Scripts\python.exe'
$env:BUS_REQUIRE_BROWSER_TESTS = '1'
$env:PYTHONUTF8 = '1'
$env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH
& $taskPython -X utf8 -m pytest tests/test_bus_alarm_node.py tests/test_bus_arrival_logic.py tests/test_bus_arrival_static.py tests/test_bus_engine_replay.py tests/test_bus_safety.py tests/test_bus_safety_browser.py -q
```

- 기본 exec/node_repl는 sandbox helper setup refresh 오류가 났다. `functions.exec` 안의 `tools.exec_command`를 require_escalated로 실행하면 읽기/쓰기/테스트가 동작했다. 이는 자동 승인 거절이 아니라 실행기 초기화 오류였다.
- Git 소유자 차이 때문에 매 명령에 `git -c safe.directory=E:/Work/zzskm.github.io ...`를 사용했다. 전역 Git 설정은 바꾸지 않았다.
- 별도 UI 네이티브 자동화 대신 기존 Playwright 회귀 테스트를 사용했다.

## 비교 화면 및 재현 자료

- 변경 전 소스 3개 복사: `C:/Users/z/AppData/Local/Temp/bus-ui-ux-before/bus-arrival/`.
- 캡처/스크립트/JSON: `C:/Users/z/.codex/visualizations/2026/10/20/01a15950-a23d-71a2-8222-30240f5a2ac1/bus-ui-checkpoint/`.
- `before-{waiting,overdue,stale,skipped,next}-390.png`, 대응하는 `checkpoint-...` 파일.
- 추가 `checkpoint-waiting-{360,1280}.png`, `checkpoint-waiting-dark-390.png`, `checkpoint-waiting-zoom200.png`.
- `capture.py`는 기존 테스트 모듈을 읽고 고정된 모의 응답·시계로 캡처한다. `capture-results.json`에 표시 문구/오류/넘침 결과가 있다.
- 위 임시·시각화 경로의 파일은 커밋하지 않았다. 최종 PR 증거는 CI artifact 또는 적절한 문서 자산으로 다시 보존할 것.

## 패치 백업

Git 작성자 미설정으로 커밋이 없으므로 위 스테이징 상태를 초기화하지 말 것. 같은 시각화 폴더의 `checkpoint.patch`에 `git diff --cached --binary`도 저장했다. 문서 작성 시점 HEAD는 여전히 `96e32207ad`이다. 패치는 동일 변경이 이미 있는 작업 트리에 다시 적용하지 말고 복구가 필요한 경우에만 검토한다.
