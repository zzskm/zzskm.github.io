# garmin-weight

Garmin Connect에서 하루 집계(체중·체성분·걸음·심박·수면·활동)를 받아 `data/daily_metrics.csv`에 쌓는다. 그 CSV로 추세·예측·진단을 담은 `data/summary.json`을 만들고, 이 폴더의 정적 페이지(GitHub Pages)와 루트의 개인 대시보드가 그 요약을 읽는다.

작업 이력과 판단 근거는 `reports/`에 있다(`INSPECTION_2026-11-25.md`, `PLAN_2026-11-25.md`, 구현 뒤의 재검토와 후속 작업은 `REVIEW_2026-11-25.md`).

## 흐름

| 단계 | 파일 | 하는 일 |
|---|---|---|
| 수집 | `scripts/sync_garmin.py` | garminconnect로 로그인해 최근 N일을 받고 CSV와 필드 단위로 병합한다. 이어서 요약을 만든다. |
| 모델 | `scripts/sync_modeling.py` | EWMA 추세, 감량률, 감쇠 곡선 예측, 시나리오, 백테스트(모든 모델 같은 표본), 신뢰구간, 인사이트를 계산한다. |
| 보조 | `scripts/kalman_predictor.py`, `scripts/model_audit.py` | Kalman 섀도 후보, 오프라인 감사(요약과 같은 코드 경로). |
| 화면 | `index.html`, `app.js`, `app.helpers.js`, `enhancements.js`, `style.css`, `sw.js` | 요약을 읽어 그린다. 서비스 워커가 오프라인을 맡는다. |

## 워크플로

| 워크플로 | 언제 | 하는 일 |
|---|---|---|
| `garmin weight sync` | 매일 00:41, 09:41 KST, 수동 실행 | 수집 → CSV·요약 커밋(`main`에서만). 수집이 실패하면 커밋하지 않고 실패로 끝난다(실패 알림). 실패는 모든 호출 실패, 중간에 멈춤(첫 429 또는 연속 실패 5건), Garmin이 응답하지 않아 토큰 로그인을 못 한 경우다. 커밋은 수집 스텝의 결과만 본다. 수집 뒤의 뒷정리가 실패해도 받은 데이터는 커밋한다. |
| `garmin weight probe` | `garmin-probe/**` 브랜치 푸시, 수동 실행 | `--dry-run`으로 받아 보기만 한다. 결과(건수·상태·키와 타입만, 값 없음)는 그 브랜치의 `probe-results/`에 커밋된다. |
| `garmin weight tests` | 코드·테스트·워크플로 변경 | 단위 테스트(워크플로의 셸 스텝을 떼어 bash로 돌리는 테스트 포함), 고정한 garminconnect의 메서드 검사, 브라우저 테스트, 서비스 워커 테스트. |

## 시크릿

| 이름 | 필수 | 내용 |
|---|---|---|
| `GARMIN_EMAIL`, `GARMIN_PASSWORD` | 예 | 비밀번호 로그인. 토큰 캐시가 없거나 거부될 때의 대체 경로라 항상 있어야 한다. |
| `GARMIN_TOKENS` | 권장 | **토큰 캐시 암호화 키다(Garmin 토큰이 아니다).** 이름은 예전 것을 그대로 쓴다. 워크플로 셸 스텝만 읽고 Python에는 넘기지 않는다. 비우면 매번 비밀번호로 로그인한다. 바꾸거나 지우면 기존 캐시를 풀지 못해 한 번 비밀번호로 로그인한 뒤 새 키로 다시 저장한다. 새 값은 `openssl rand -base64 32`로 만든다. |
| `GARMIN_IS_CN` | 아니오 | 중국 계정이면 `true`. |

### 토큰 캐시

1. `actions/cache/restore`로 `garmin-tokens-v1-` 접두사의 최신 캐시를 받는다(`main`에서만). 캐시 키는 실행마다 새로 만든다. 캐시는 바꿀 수 없기 때문이다.
2. `openssl enc -aes-256-cbc -pbkdf2 -iter 200000`으로 `$RUNNER_TEMP/garmin-tokens/garmin_tokens.json`에 푼다. 실패하면 파일 없이 진행한다.
3. `sync_garmin.py --token-dir`(환경 변수 `GARMIN_TOKEN_DIR`)은 다음 순서로 로그인한다.
   - 먼저 토큰으로 로그인한다. 이때 자격 증명 없는 클라이언트를 써서, 토큰이 안 되면 예외가 나게 한다.
   - **토큰이 거부됐을 때(401·403)만** 파일을 지우고 비밀번호로 로그인한다. garminconnect가 새 토큰을 같은 파일에 쓴다.
   - Garmin이 일시적으로 응답하지 못할 때(429·5xx·네트워크 오류)는 토큰을 그대로 두고 실패로 끝낸다(`garmin unavailable`). 다음 실행이 같은 토큰으로 다시 시도한다. 장애나 속도 제한 때마다 러너에서 비밀번호 로그인이 일어나지 않게 하려는 것이다.
   - 액세스 토큰은 금방 만료되므로 실행마다 갱신이 먼저 일어난다. 갱신이 실패하면 라이브러리는 이유를 버리고 API의 401만 보여 준다. 그래서 401·403이 나오면 갱신 함수(`_refresh_di_token`)를 한 번 직접 불러 토큰 엔드포인트의 답을 본다. 400·401·403이면 거부, 429·5xx·연결 오류면 일시 오류, 성공하면 새 토큰으로 다시 로그인한다. 이 함수는 라이브러리의 비공개 함수라서 `library` CI 잡이 있는지 확인한다.
   - 공개 로그에는 `garmin auth=token|password`, `token_cache=loaded|saved|unsaved`, 실패 때의 예외 클래스와 HTTP 상태만 남긴다.
4. 토큰이 바뀌었을 때만 다시 암호화해 저장한다(`main`에서만). 수집이 실패해도 한다. 평문 파일은 마지막에 지운다.
5. `main`이 아닌 브랜치에서 수동 실행하면 캐시를 받지도 저장하지도 않고 비밀번호로 로그인한다. `main`의 토큰을 다른 브랜치가 갱신해 버리면 캐시에 남은 리프레시 토큰이 무효가 되기 때문이다.
6. probe는 `garmin-tokens-probe-v1-` 접두사를 쓴다. `main`의 캐시를 쓰지 않는다. 캐시는 브랜치 범위라서 같은 probe 브랜치에 커밋을 더 푸시하면 앞 실행의 토큰을 받는다. 커밋 메시지에 `[probe-bad-key]`를 넣으면 일부러 틀린 키로 풀어 대체 경로를 시험한다.

### MFA

지원하지 않는다. 계정에 MFA를 켜면, 토큰이 살아 있는 동안은 수집이 되지만 토큰이 거부되는 순간 비밀번호 로그인이 막힌다. 그러면 수집이 실패로 끝나고 실패 알림이 온다. 켜야 한다면 그때 로그인 방식을 따로 설계해야 한다.

## 로컬 실행

```sh
# 요약만 다시 만들기(CSV는 그대로). 커밋하지 말 것: 데이터 파일은 봇만 커밋한다.
python garmin-weight/scripts/sync_garmin.py --skip-garmin --output-summary /tmp/summary.json

# 받아 보기만(파일을 쓰지 않음). GARMIN_EMAIL/GARMIN_PASSWORD 필요, garminconnect==0.3.20 설치 필요.
python garmin-weight/scripts/sync_garmin.py --dry-run --backfill-days 3 --stats-output /tmp/probe.json
python garmin-weight/scripts/sync_garmin.py --dry-run --probe-dates 2026-11-19,2026-09-27 --stats-output /tmp/probe.json

# 모델 감사(요약과 같은 숫자, 전체 통계)
python garmin-weight/scripts/model_audit.py --output /tmp/audit.json

# 테스트
PYTHONUTF8=1 python -m unittest discover -s tests -p 'test_garmin*.py'
node --test tests/garmin_weight_sw.test.mjs
# 브라우저 테스트(Playwright + 시스템 Chrome). 브라우저가 없으면 건너뛴다. 뒤의 것은 서비스 워커 수명 주기(약 40초)다.
BROWSER_EXECUTABLE="C:/Program Files/Google/Chrome/Application/chrome.exe" GARMIN_REQUIRE_BROWSER_TESTS=1 \
  python -m unittest tests.test_garmin_weight_browser tests.test_garmin_weight_sw_browser

# 실제 garminconnect로 도는 테스트. requirements.txt를 설치한 환경에서만 돈다(없으면 건너뛴다).
GARMIN_REQUIRE_LIBRARY_TESTS=1 python -m unittest tests.test_garmin_library
```

Garmin 호출을 바꿨으면 로컬 성공만 믿지 말고 probe 브랜치로 러너에서 확인한다. 결과는 `git fetch`로 읽고 브랜치를 지운다.

## 공개 로그 규칙

엔드포인트 이름, 예외 클래스, HTTP 상태만 남긴다. 예외 문자열에는 표시 이름이 든 URL이 섞일 수 있어 남기지 않는다. probe의 응답 구조는 키·타입·리스트 길이만 남기고, 숫자·ID 형태의 키는 `<id>`로 가린다.

- garminconnect 로거는 수준과 무관하게 끈다(`configure_logging`). 라이브러리는 재시도가 끝난 5xx와 네트워크 오류를 `logger.exception`으로 남기는데, 거기에 요청 경로가 들어가고 일일 요약·심박·수면 경로에는 표시 이름이 있다. ERROR로 묶는 것으로는 막히지 않았다. 실패는 `safe_call`이 한 줄로 남긴다.
- urllib3는 DEBUG에서 요청 경로를 찍는다. `--log-level DEBUG`로 돌려도 WARNING 아래는 내지 않는다.
- 주석(`::notice::` 등)과 오류 문구에는 입력 원문이나 셀 내용을 넣지 않는다.
- `library` CI 잡이 실제 라이브러리로 503·연결 오류·타임아웃을 만들어 표시 이름이 로그에 없는지 본다.

## 수집이 멈추는 조건

실패가 이어지는데 남은 호출을 끝까지 보내면 속도 제한을 키우고, 응답이 없는 장애에서는 작업 제한 시간(10분)을 넘긴다.

- 첫 429에서 멈춘다(`garmin stopped early reason=rate_limited`).
- 호출이 연속 5건 실패하면 멈춘다(`reason=consecutive_failures`). 사이에 성공한 호출이 있으면 다시 센다. 한 엔드포인트만 계속 실패하는 경우는 멈추지 않고 `partial`로 끝난다.
- 멈춘 수집은 그때까지 받은 것이 있어도 실패다. CSV를 쓰지 않고 종료 코드 1로 끝난다.

## CSV (`data/daily_metrics.csv`)

하루 한 행(KST 날짜)이다. 마지막 행은 아직 끝나지 않은 오늘이다.

| 컬럼 | 원천 | 비고 |
|---|---|---|
| `weight_kg`, `weight_measure_count`, `visceral_fat`, `body_fat_percent` | `get_body_composition` | |
| `metabolic_age` | 같음 | Garmin은 나이를 ms 길이(나이 × 31,556,926,000ms, 1년 = 365.2422일)로 준다. 그 배수일 때만 나이로 바꾼다. 세 단위 값도 받는다. |
| `steps` | `get_stats` | |
| `resting_hr` | `get_heart_rates` → `get_sleep_data` → `get_stats` 중 처음 값 | |
| `sleep_hours`, `sleep_score` | `get_sleep_data`(`dailySleepDTO`) | 밤에 기기를 찬 날만 있다. |
| `activity_count`, `exercise_minutes`, `exercise_calories`, `exercise_source` | 활동(`get_activities_fordate`, 실패하면 `get_activities_by_date`) | 활동이 없는 날은 일일 요약의 강도 운동 시간(보통+격렬, 실제 분)과 하루 활동 칼로리를 쓰고 `exercise_source=intensity`로 적는다. |
| `training_load_acute` | `get_training_readiness` → `get_training_status` | 그날 항목만 쓴다. 이 계정에는 데이터가 없다(2026-11-25 확인). |

활동 조회:
- `get_activities_fordate`는 게이트웨이 응답이다. `ActivitiesForDay`의 `successful`이 거짓이거나 `statusCode`가 400 이상이면 HTTP가 200이어도 실패로 센다.
- CSV에 활동이 있던 날인데 빈 목록이 오면 `get_activities_by_date`로 한 번 더 확인한다. 두 경로가 모두 빈 목록일 때만 0건으로 본다.

병합 규칙:
- 원천 호출이 실패한 필드는 기존 값을 유지한다.
- 호출이 성공했는데 값이 없으면 비운다.
- 핵심 필드가 한꺼번에 비면 일시적인 빈 응답으로 보고 기존 행을 유지한다.
- 4일 이상을 다시 받을 때(보호 병합)는 값이 있던 칸을 비우거나 0으로 만들지 않고, 활동 수와 체중 측정 횟수를 낮추지 않는다. 활동 수를 지킨 날은 운동 시간·칼로리·출처도 함께 지킨다.
- 병합은 행을 지우지 않는다.

CSV를 손으로 고쳤다면:
- 모든 행에 `YYYY-MM-DD` 날짜가 하나씩 있어야 한다. 헤더에 `date`가 없거나, 날짜가 비었거나 겹치거나 형식이 다르면 수집이 `garmin csv unreadable` 오류로 끝나고 아무것도 쓰지 않는다.
- BOM(Excel의 "CSV UTF-8", 메모장)과 헤더의 대소문자 차이는 받아들인다. 다시 쓸 때는 BOM 없이 쓴다.
- 요약은 `--skip-garmin`으로 다시 만들 수 있지만 커밋은 봇의 다음 수집에 맡긴다.

## 요약 (`data/summary.json`)과 소비자

| 소비자 | 읽는 곳 |
|---|---|
| 이 페이지 | 대부분: `current`, `rolling`, `predictions`(시나리오 `series` 포함), `goal`, `insight`, `predictionCI`, `modelDiagnostics`, `coverage`, `sync`, `series` |
| 개인 대시보드(`/dashboard.js`, `/dashboard-model.js`) | `tests/test_garmin_weight.py`의 `DASHBOARD_FIELDS`. 바꿀 때 그 목록과 `tests/test_dashboard_browser.py`의 픽스처를 함께 본다. |

주요 블록:

- **`sync`**: 마지막 수집의 상태다.
  - `status`(ok/partial/failed), `auth`, `lastAttemptAt`, `lastSuccessAt`, 호출 집계, `failedEndpoints`가 있다.
  - 화면의 동기화 표시는 `lastSuccessAt` 기준이고, 24시간이 지나면 경고 색이 된다.
- **`coverage`**: 최근 30일 측정률이다. 완료된 날만 세고 오늘 행은 넣지 않는다.
  - `windowStart`~`windowEnd`가 센 창이다. 화면의 측정 점은 이 날짜들을 그린다.
  - `modelDiagnostics.coverage`와 `modelDiagnostics.dataQuality`(`recentMeasuredDays`, `recentCoveragePct`)도 같은 창을 센다. 세 곳의 숫자가 같아야 한다.
  - `dataQuality.outlierCandidates`는 최근 `outlierWindowDays`(60)일 안에서 직전 측정과 크게 벌어진 측정 수다.
- **`insight`**: 상태별 안내 문구다. 첫 줄의 "오늘 Xkg"는 그 체중이 요약의 마지막 날에 잰 것일 때만 쓴다. 아니면 "최근 측정(월/일) Xkg"이다.
- **`plateau`**: 추세가 14일 동안 평평한지다. 14일 창 양 끝의 변화와 창 끝 7일의 기울기가 모두 주 0.05kg 미만이어야 한다. 양 끝만 보면 내려갔다 올라온 구간도 평평이 된다. 화면은 이 블록을 직접 읽지 않고 `insight`의 문구로 본다.
- **`predictions.scenarios.<낙관|기준|보수>.series`**: 0~12주 13점과 80% 구간이다. 카드 값은 이 시계열의 마지막 점이다.
- **`goal`**: `etaStatus`는 `reached`/`date`/`beyond`/`no_loss`/`unknown`이다. ETA는 곡선이 `목표 + etaToleranceKg`에 처음 닿는 날이고, 최대 104주까지 계산한다.
- **`modelDiagnostics`**:
  - `confidence`: 최근 측정과 2주 예측 오차로 매기는 등급이다(0~6점: 측정률 0~3, 일별 변동 0~1, 14일 MAE 0~2). 측정률 점수는 30일 중 20일·22일·24일에서 한 단계씩 오른다. 3개월 값의 품질은 보지 않는다.
  - `longRange`: 84일 예측이 "변화 없음"보다 나은지다. `status`는 `ok`/`worse_than_flat`/`unverified`(표본 부족)다. `ok`가 아니면 화면이 3개월 값(시나리오 안내 문구)과 목표 도달일 옆에 "장기 추정"을 붙이고, 개인 대시보드도 그렇게 적는다.
  - `trend.direction`: 추세 배지다. 7일 기울기로 정한다. 주간 변화·예측·ETA·인사이트는 혼합 감량률을 쓰므로 둘이 다른 방향을 가리키는 날이 있다(아래 "모델에 대해 알아 둘 것").
  - `backtest`: 운영 모델의 7/14/28/84일 성적이다.
  - `backtestSampleCounts`: 모든 모델이 공유하는 표본 수다.
  - `modelAudit`: 섀도 후보의 성적이다. 화면용 필드만 담는다.
  - `selectedModel`: 섀도 게이트 결과(`shadow_leader`/`no_change`)다. 예측에는 쓰지 않는다.
  - `ciCalibration`: 시점별로 재현한 80% 구간 적중률이다.

## 모델에 대해 알아 둘 것

- 예측 곡선은 목표 체중으로 수렴하는 감쇠 곡선이다. **`targetWeightKg`를 바꾸면 예측과 백테스트 수치가 함께 바뀐다.**
- 84일 예측은 지금 "변화 없음"보다 성적이 나쁘다. 2027-02-25에 감량기 데이터로 다시 비교한다(계획 P7 기록).
- 섀도 후보가 게이트를 통과해도 운영 모델은 자동으로 바뀌지 않는다.
- **추세 배지와 주간 변화는 기준이 다르다.** 배지("감량 중"/"증량 중"/"유지")는 최근 7일 기울기이고, 주간 변화·예측·ETA·인사이트는 3/7/14/28일 혼합 감량률이다. 배지를 혼합 감량률로 통일하지 않기로 했다(2026-11-25 사용자 결정). 실제 이력을 날짜별로 재생하면 243일 중 14일에 배지와 주간 변화의 부호가 다르다. "N일째 평평" 문구와 움직이는 배지가 함께 나오는 경우(11일)는 정체 판정을 고쳐 없앴다.

## `config.json`

| 키 | 기본 | 뜻 |
|---|---|---|
| `targetWeightKg` | | 목표 체중. 곡선의 수렴점이다. |
| `heightCm` | | 체지방이 없을 때 BMI로 kcal/kg를 정한다. |
| `exerciseTrendWindow` | 28 | 감량률·운동 추세 창(일). |
| `kcalToKgFactor` | 7700 | 체지방·BMI가 모두 없을 때의 kcal/kg. |
| `scenarioExercisePctDelta` | ±0.3 | 활동 기록이 없을 때 시나리오의 하루 활동량 변화율. |
| `etaToleranceKg` | 0.3 | ETA 판정 여유. |
| `features.*` | 모두 false | 수면·부하 측정 가중치, 부하로 정체 유형 나누기. 백테스트로 나빠지지 않을 때만 켠다. |

## backfill

`garmin weight sync`를 수동 실행한다.

- 입력:
  - `backfill_days`는 1~60의 정수다. 앞에 0을 붙이지 않는다(`08`, `030`은 거절된다).
  - `end_date`는 `YYYY-MM-DD`(KST)이고 비우면 오늘이다. 실제로 없는 날짜와 미래 날짜는 거절된다. 그날부터 거꾸로 센다.
  - CSV 첫 날짜(2026-03-13)보다 앞으로 넘어가는 창은 첫 날짜에서 잘린다(`garmin window cut at the first CSV day`). 그 앞의 행은 생기지 않는다.
  - 형태는 워크플로가, 범위와 날짜의 뜻은 `sync_garmin.py`가 본다. 잘못된 입력은 로그인 전에 `::error::`로 끝난다.
- 4일 이상이면 보호 병합으로 돈다(`garmin protect=on`). 위 병합 규칙대로 값이 있던 칸을 비우거나 0으로 만들지 않는다.
- 실행마다 주석이 남는다. 긴 backfill 뒤에는 `zeroed=0 cleared=0`인지 본다.
  - `garmin merge new_days= filled= changed= zeroed= cleared= protected=`: 기존 CSV와 달라진 칸 수다. `zeroed`는 0이 아니던 값이 0이 된 칸, `cleared`는 빈 값이 된 칸이다.
  - `garmin changed|zeroed|cleared|protected fields=이름:건수,…`: 어느 컬럼에서 일어났는지다.
- 30일씩 나눠 한 번에 하나만 돌린다. 같은 워크플로가 대기 중이면 새 실행이 대기 실행을 취소한다.
- 3일이 지난 잘못된 값(예: Garmin에서 지운 측정)을 바로잡으려면 `end_date`를 그 날짜로, `backfill_days`를 1~3으로 준다. 3일 이하는 보호 없이 돌아서 Garmin에서 사라진 값이 CSV에서도 비워진다.

## 자산 버전과 서비스 워커

- 로컬 자산의 버전은 `sw.js`의 `ASSET_VERSION` 한 곳에서 정한다. `index.html`과 `manifest.webmanifest`의 `?v=` 값이 이것과 같아야 한다. 테스트가 이를 검사한다.
- 자산을 바꾸면 이 값을 올린다.
- 캐시는 셋이다.

  | 캐시 | 내용 | 버전을 올리면 |
  |---|---|---|
  | `gw-shell-<ASSET_VERSION>` | 화면과 로컬 자산 13개(`SHELL_ASSETS`) | 새로 만들고 예전 것은 지운다 |
  | `gw-data-v1` | `data/summary.json`, `config.json`(쿼리를 뗀 주소가 키) | 그대로 둔다 |
  | `gw-runtime-v1` | CDN 자산(Chart.js, 글꼴 CSS와 글꼴 파일) | 그대로 둔다 |

- 설치할 때:
  - 셸은 HTTP 캐시를 거치지 않고 받는다(`cache: 'reload'`). Pages의 `max-age=600` 때문에, 거치면 배포 직후 10분 동안 예전 `index.html`이 새 캐시에 들어간다.
  - 요약, 설정, Chart.js, Pretendard CSS를 미리 받는다. 그래서 한 번만 방문해도 오프라인에서 차트까지 나온다. 미리 받기는 실패해도 설치를 막지 않는다.
- 요약과 설정은 네트워크가 먼저다. 네트워크가 안 되거나 응답이 404·5xx면 마지막으로 받은 사본을 준다. 그 응답에는 `X-GW-From-Cache: 1`이 붙고 화면의 동기화 표시에 "오프라인 사본"이 나온다.
- 셸은 캐시가 먼저고 뒤에서 새로 받아 둔다(재검증 요구, `cache: 'no-cache'`). 배포 뒤 첫 방문은 예전 화면이고 그다음 방문부터 새 화면이다.
- 화면 주소(폴더 주소와 `index.html`)는 쿼리가 붙어 와도 쿼리를 뗀 주소로 찾는다. 셸 목록에 없는 파일(CSV, 문서, 예전 버전의 자산)은 워커가 맡지 않는다.
- 활성화할 때는 `gw-`로 시작하는 예전 캐시만 지운다. 캐시 저장소는 출처(`zzskm.github.io`) 전체가 함께 쓰므로 다른 앱의 캐시를 건드리지 않는다.
- CDN 자산(Chart.js, Pretendard)은 `integrity`와 `crossorigin`을 붙여 서비스 워커가 저장한다. jsDelivr가 즉석에서 만드는 `.min` 파일에는 SRI를 걸 수 없으므로 원본 파일을 쓴다. `sw.js`의 `CDN_ASSETS`는 `index.html`이 쓰는 주소와 같아야 한다(테스트가 검사한다).
- 테스트는 두 층이다. `tests/garmin_weight_sw.test.mjs`는 Cache API를 흉내 내 설치·활성화·요청 처리를 본다. `tests/test_garmin_weight_sw_browser.py`는 실제 브라우저로 한 번 방문 뒤 오프라인, 배포 뒤 다음 방문, 요약 404를 본다.
