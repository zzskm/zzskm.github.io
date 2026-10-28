# 개인용 통합 대시보드 작업 기록

작성일: 2026-10-28 (한국 시간)

## 요청과 목표

평소 열어 두는 다음 세 페이지를 한 탭에서 확인하도록 통합한다.

- 체중·활동: <https://zzskm.github.io/garmin-weight/index.html>
- 근무시간: <https://zzskm.github.io/work_hours_calculator.html>
- 퇴근 버스: <https://zzskm.github.io/bus-arrival/index.html>

주요 목적은 항상 열어 두는 탭과 중복 실행 자원을 줄이는 것이다. iframe 세 개를 나열하지 않고, 하나의 문서에서 근무시간·체중 요약과 기존 버스 기능을 실행한다. 로컬 Chrome 비교에서는 전용 커밋 메모리 중앙값이 약 47% 감소했다. 일상적으로 사용하는 브라우저에서의 절감량은 별도로 확인한다.

## 현재 상태

대시보드 구현, 로컬 검증, 메모리 비교, 커밋·푸시와 GitHub Pages 배포를 완료했다. 운영 주소는 **<https://zzskm.github.io/dashboard.html>**이다. 기존 계산기·버스의 설정 공유, 모바일 화면과 기존 세 페이지 동작도 운영 주소에서 확인했다.

진입 파일은 [`dashboard.html`](../dashboard.html)이다. 저장소의 페이지 목록 [`index.html`](../index.html)에도 대시보드 링크를 추가했다. 기존 세 페이지는 각자의 주소로 계속 접근할 수 있다.

| 영역 | 구현 내용 | 상태 |
| --- | --- | --- |
| 근무시간 | 남은 시간, 진행률, 출근·퇴근 입력, 실 근무·추가 근로, 휴게·기본 근로 설정, 퇴근 OS 알림 | 구현, 통합 검증 완료 |
| 체중·활동 | 최근 체중, 30일 변화, 30/60일 실측 차트, 목표·체지방·걸음·운동 요약 | 구현, 조회·오류 검증 완료 |
| 버스 | 기존 출발 판단, 도보·여유시간, 알림·차량 제외, 상세 기록, 시각 알람·타이머 | 공유 코드로 통합, 기존 30개 회귀 테스트 통과 |
| 화면 | 데스크톱 2열, 모바일 1열, 자동·밝게·어둡게 테마 | 화면 캡처 및 모바일 검증 완료 |
| 장애 대응 | 패널별 독립 오류 표시, 버스 재시도, 체중 이전 자료 유지 | 통합 검증 완료 |
| 배포 | GitHub Pages 반영 | 완료, 원격 CI 및 운영 주소 검증 통과 |
| 메모리 | 기존 세 탭과 대시보드 한 탭의 Chrome 프로세스 사용량 비교 | 로컬 3회 비교 완료, 전용 커밋 메모리 중앙값 약 47% 감소 |

## 구현 구조와 판단

### 하나의 문서와 기존 코드 재사용

- [`dashboard.html`](../dashboard.html): 화면 구조와 스크립트 진입점.
- [`dashboard.css`](../dashboard.css): 반응형 레이아웃과 테마. 외부 웹폰트를 추가하지 않는다.
- [`dashboard.js`](../dashboard.js): 설정 저장, 체중 조회·SVG 차트, 버스 화면 조립, 화면 갱신.
- [`dashboard-model.js`](../dashboard-model.js): 근무시간·야간 근무·체중 기록 필터링 계산.
- [`bus-arrival/app.js`](../bus-arrival/app.js): 기존 버스 페이지의 인라인 코드를 추출한 공통 컨트롤러. `BusApp.mount(root, options)`로 독립 페이지와 대시보드에서 재사용한다.
- [`bus-arrival/index.html`](../bus-arrival/index.html): 기존 마크업을 유지하고 공통 컨트롤러를 호출한다.

대시보드는 버스 HTML을 같은 사이트에서 한 번 읽어 필요한 마크업과 스타일을 Shadow DOM에 넣는다. 원본 HTML의 스크립트를 동적으로 평가하지 않는다. 알림 엔진 `alarm.js`, 표시 계산 `bus-arrival/dashboard.js`, 공통 컨트롤러를 명시적으로 로드한다. Shadow DOM으로 버스 스타일과 대시보드 스타일의 충돌을 막는다.

체중 요약은 기존 `garmin-weight/data/summary.json`과 `config.json`을 사용한다. 차트는 가벼운 SVG로 그리며 기존 체중 페이지의 Chart.js와 상세 분석 스크립트는 로드하지 않는다. 전체 예측·시나리오는 기존 분석 페이지의 링크로 접근한다.

### 기존 설정 호환

- 근무시간은 기존 `wht.state.v2` 키와 데이터 구조를 사용한다.
- 버스의 도보시간·알림·원장·타이머는 기존 저장소 키를 그대로 사용한다.
- 화면 색상은 운영체제의 밝게/어둡게 설정만 따른다. 수동 테마 전환은 2026-10-28에 제거했다(이전에 저장된 `personalDashboard.theme` 값은 사용하지 않는다).
- 실제 기존 설정을 이어 쓰려면 같은 브라우저 프로필의 `https://zzskm.github.io`에서 사용해야 한다. localhost에서 검증하면 저장소 출처가 달라 기존 운영 설정은 자동으로 보이지 않는다.

### 갱신과 자원 사용

- 화면이 보일 때 근무시간은 초 단위로 표시한다.
- 체중 자료는 처음 진입할 때, 수동 새로고침, 표시 중 30분 주기로 확인한다. 장시간 숨겼다가 복귀할 때도 필요하면 갱신한다.
- 버스는 기존 1분 조회와 알림 판정·보조 워커를 유지한다. 데이터 최신성·휴일·수집 시간 외 판정을 그대로 사용한다.
- 대시보드를 숨기면 근무·버스의 불필요한 화면 그리기를 줄인다. 버스 알림 판정은 유지한다.
- 알림은 탭이 열려 있어야 하며 브라우저 절전·탭 비활성화·OS 권한에 따라 지연될 수 있다. 통합했다고 탭이 닫힌 뒤에도 알림이 동작하는 것은 아니다.

## 검증 기록

2026-10-28 현재 확인한 결과:

- JavaScript 문법 검사 통과.
- Node 계산·기존 버스 엔진 테스트: 87개 통과.
- 기존 버스 정적 검사: 28개 통과.
- 대시보드 브라우저 통합 테스트: 5개 통과.
  - iframe 없는 단일 문서, 기존 근무 설정 불러오기·저장.
  - 버스 도보시간 변경과 실제 타이머 배너 실행.
  - 모바일 가로 넘침 방지, 다크 테마, 차트 기간 변경.
  - 체중 조회 실패와 오래된 버스 정보의 불확실성 표시.
  - 버스 화면 조회 실패 후 재시도.
  - 숨김 상태를 모의했을 때 근무·버스 화면 갱신을 멈추고 타이머 배너는 실행하며, 복귀 시 최신 시각을 반영.
- 기존 버스 브라우저 테스트: 30개 모두 통과. 모듈 분리 전 전역 변수에 직접 접근하던 일부 검증을 저장소·화면·사용자 입력 기준으로 바꾸고 전체 재실행했다.
- 검증 중 발견한 문제를 수정했다: 버스 설정·권한 도움말을 열 때 바깥쪽 상세도 함께 펼치기, 다크 테마 변수의 순환 참조 제거, 숨김 전 예약된 화면 그리기도 숨김 상태에서는 실행하지 않기.
- `git diff --check` 통과.

테스트 파일:

- [`tests/dashboard.test.mjs`](../tests/dashboard.test.mjs)
- [`tests/test_dashboard_browser.py`](../tests/test_dashboard_browser.py)
- [`tests/test_bus_arrival_static.py`](../tests/test_bus_arrival_static.py)
- [`tests/test_bus_safety_browser.py`](../tests/test_bus_safety_browser.py)

화면 캡처는 `_site/dashboard-preview/`에 있다. `_site/`는 Git에서 제외되므로 커밋 대상이 아니다.

- 데스크톱: `dashboard-desktop.png`
- 모바일 밝은 테마: `dashboard-mobile.png`
- 모바일 어두운 테마: `dashboard-mobile-dark.png`

CI의 버스 회귀 워크플로에도 대시보드·공통 컨트롤러 변경 경로와 대시보드 테스트를 추가했다. [원격 회귀 CI](https://github.com/zzskm/zzskm.github.io/actions/runs/40655936301)도 성공했다.

총 150개 검증을 통과했다. 브라우저 테스트는 로컬 서버와 고정된 테스트 자료를 사용한다. 실시간 운영 버스 도착이나 실제 OS 알림 전달까지 확인했다는 의미는 아니다.

### 재개 작업

- 2026-10-28 재개 시 대시보드 브라우저 테스트 5개와 Node 테스트 87개를 다시 통과했다. JavaScript 문법 검사와 `git diff --check`도 통과했다.
- [`scripts/measure-dashboard-memory.py`](../scripts/measure-dashboard-memory.py)를 추가했다. Windows 프로세스 API로 측정용 Chrome과 자식 프로세스의 전용 커밋 메모리(`PrivateUsage`)를 합산한다. 사용자 브라우저 프로필은 사용하지 않는다.
- 측정 대상은 현재 체크아웃의 기존 세 페이지와 새 대시보드다. 같은 로컬 서버·데이터·화면 크기를 사용하고, 매 실행마다 새 Chrome을 시작한다. 순서를 번갈아 총 3회씩 실행한다.
- 각 실행에서 페이지 준비 직후와 15초 대기 후의 값을 수집한다. 대기 후에는 2초 간격으로 3개 표본을 얻어 실행별 중앙값을 계산하고, 최종 비교에는 3회 실행의 중앙값을 사용한다. 강제 GC는 실행하지 않는다.
- 기존 체중 화면은 Chart.js 차트와 자료 로드 완료를 확인한다. JavaScript 오류 또는 요청 실패가 있으면 측정을 중단한다. 주요 JSON 자료의 해시가 도중에 달라져도 결과를 확정하지 않는다.
- 헤드리스 Chrome, 새 프로필, 로컬 자료로 비교하므로 평소 브라우저의 확장 기능·탭 절전·장시간 누적 사용을 재현한 수치는 아니다. JavaScript 힙 값은 참고용으로 수집하며 전체 프로세스 메모리와 구분한다.

### 로컬 메모리 비교 결과

Chrome 155.0.8059.85, Windows, 1280×1000 화면 크기에서 측정했다. 단위는 MiB(1,048,576바이트)이며, 브라우저 본체·렌더러·GPU 등 측정용 Chrome 프로세스 트리 전체를 포함한다.

| 비교 대상 | 페이지 준비 직후 중앙값 | 안정화 후 중앙값 | 프로세스 수 |
| --- | ---: | ---: | ---: |
| 기존 세 페이지 | 670.64 MiB | 649.96 MiB | 10 |
| 통합 대시보드 | 359.47 MiB | 346.63 MiB | 8 |

안정화 후 중앙값 기준 303.33 MiB, **46.67% 감소**했다. 실행별 안정화 값은 기존 세 페이지 649.96 / 655.61 / 528.77 MiB, 대시보드 345.58 / 346.63 / 348.18 MiB였다. 기존 세 페이지에서도 실행 간 차이가 있으므로 단일 수치를 보장치로 해석하지 않는다.

지표인 `PrivateUsage`는 Windows가 프로세스에 커밋한 전용 메모리다. 물리 RAM 상주량이나 Chrome 작업 관리자의 표시값과 동일한 지표는 아니다. 정의는 [Microsoft PROCESS_MEMORY_COUNTERS_EX 문서](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)를 따른다.

원시 결과와 입력 자료 해시는 [`dashboard-memory-results.json`](dashboard-memory-results.json)에 보존했다. 현재 체크아웃의 기존 페이지를 비교했으며, 버스 컨트롤러 추출 이전 커밋의 복제본을 비교한 것은 아니다.

### 배포 기록과 운영 검증

- 2026-10-28 사용자 승인 후 대시보드 관련 16개 파일만 분리해 커밋·푸시했다. 같은 작업 디렉터리의 런타임·보안 변경은 포함하지 않았다.
- 구현 커밋: [`90d6ccfb26`](https://github.com/zzskm/zzskm.github.io/commit/90d6ccfb26b69272bd9b2322e5e0285f4687962c).
- [GitHub Pages 빌드·배포](https://github.com/zzskm/zzskm.github.io/actions/runs/40655936498) 성공.
- 최신 원격 버스 수집 데이터 위에 변경을 반영했다. 데이터 수집 커밋은 덮어쓰지 않았다.
- 배포 전 별도 체크아웃에서도 Node 87개, 정적 28개, 대시보드 브라우저 5개, 기존 버스 브라우저 30개를 다시 통과했다.
- HTTPS 운영 주소에서 HTML·JavaScript·CSS 등 7개 파일의 내용을 구현 커밋과 직접 대조했다.
- 새 검증용 브라우저 컨텍스트에 기존 형식의 근무·도보 설정을 저장한 뒤 대시보드에서 읽는지 확인했다. 대시보드에서 바꾼 값도 기존 페이지에서 유지되었다. 사용자의 실제 브라우저 프로필은 열거나 변경하지 않았다.
- 운영 체중 차트와 버스 판단 표시, iframe 없는 단일 문서, 360px 모바일 가로 넘침 방지, 다크 테마, 기존 세 페이지의 로드와 체중 전체 차트를 확인했다. JavaScript 오류는 없었다.
- 검증 컨텍스트의 OS 알림 권한은 기본값이었다. 실제 OS 알림 전달이나 장시간 백그라운드 절전 동작을 운영 환경에서 확인한 것은 아니다.
- 운영 화면 캡처와 상세 결과는 Git에서 제외되는 `_site/dashboard-preview/dashboard-live-desktop.png`, `dashboard-live-mobile-dark.png`, `live-results.json`에 있다.

## 진행 계획

### 후속 개선 계획

2026-10-28 요청한 버스 알림·일반 알람 카드 분리와 UI·UX·사용성 개선은 [별도 계획서](dashboard-alarm-ui-plan.md)에 정리했다. 공통 알림 실행부·알람 카드 분리·화면 개선을 구현·검증해 배포했다. 구현 결과와 남은 항목은 계획서의 ‘구현 결과’에 있다. 아래 배포 완료 기록은 기존 버전에 대한 것이다.

### 기존 통합 대시보드 작업

1. **완료 — 기존 버스 회귀 검증**: 전역 변수를 참조하던 브라우저 테스트를 저장소·화면 등 관측 가능한 동작 기준으로 수정했다. 기존 30개와 통합 5개를 통과했다.
2. **완료 — 로컬 결과 정리**: 문법·정적 검사, 엔진·근무 계산, 화면 캡처, 기존 알림·타이머 회귀 검증을 마쳤다. 이 문서에 구현·검증·한계를 기록했다.
3. **완료 — GitHub Pages 배포**: 대시보드 관련 변경을 분리해 커밋·푸시하고 Pages 성공과 실제 운영 파일을 확인했다. 주소는 <https://zzskm.github.io/dashboard.html>이다.
4. **운영 화면 확인 완료 / 개인 사용 확인 남음**: 실제 출처에서 설정 공유·체중 자료·버스 화면·기존 페이지를 확인했다. 사용자의 기존 브라우저 프로필에서 알림 권한·소리·장시간 사용 상태는 사용하면서 확인한다.
5. **로컬 비교 완료 / 일상 환경 비교 남음**: 자동화된 로컬 Chrome 비교 결과와 원시 자료를 기록했다. 운영 배포 후에는 평소 브라우저·프로필·시간대에서도 기존 세 탭과 대시보드 한 탭의 작업 관리자 메모리를 비교한다. JavaScript 힙만으로 전체 탭 메모리 절감량을 주장하지 않는다.

## 로컬 확인 방법

저장소 루트에서 정적 서버를 시작한다.

```powershell
python -m http.server 8000
```

브라우저에서 `http://localhost:8000/dashboard.html`을 연다. HTML 파일을 `file://`로 직접 열면 자료 조회가 제한될 수 있다.

계산 테스트:

```powershell
node --test tests/dashboard.test.mjs tests/bus_alarm.test.mjs tests/bus_dashboard.test.mjs tests/bus_safety.test.mjs
```

브라우저 테스트는 Python Playwright와 Chromium이 필요하다. 설치된 Chrome을 사용할 경우 `BROWSER_EXECUTABLE` 환경변수에 실행 파일 경로를 지정할 수 있다.

```powershell
python -m unittest discover -s tests -p test_dashboard_browser.py -v
python -m unittest discover -s tests -p test_bus_safety_browser.py -v
```

임시 QA 도구는 저장소 의존성이나 운영 페이지에 추가하지 않았다.

Windows에서 메모리 비교를 다시 실행하려면 같은 Python Playwright 환경을 사용한다. 브라우저 실행 파일은 `--browser` 또는 `BROWSER_EXECUTABLE`로 지정한다.

```powershell
python scripts/measure-dashboard-memory.py
```

기본 결과 파일은 Git에서 제외되는 `_site/dashboard-preview/memory-results.json`이다. `--rounds`, `--settle`, `--samples`, `--output`으로 조건과 출력 경로를 변경할 수 있다. 비교용 정적 서버와 Chrome은 스크립트 종료 시 정리한다.
