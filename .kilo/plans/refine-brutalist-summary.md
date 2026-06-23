# Brutalist-Summary 정합성 계획

## Gap 분석

### 1. Summary Strip (가장 큰 불일치)
**현재**: 단일 flex-row (커버리지+도트 | 레인지 | 트렌드 텍스트)
**시안**: 2단 brutalist 레이아웃
- 좌측: `status (15/30 50%)` + 15개 dot-grid
- 우측: 5개 메트릭 박스 그리드 (`7d Range`, `7d Change`, `28d Change`, `14d Mae`, `Last Entry`)
- 배경: 우측은 `#F9F7F5`

### 2. Details Panel - Data Quality
**현재**: Status / Coverage / Backtest 14d 텍스트
**시안**: Noise + Variance 수평 막대바 (brutalist-border 박스 내)
- Noise: `w-1/4` (Low)
- Variance: `w-3/4` (High)

### 3. Activity Logs (부분 불일치)
**현재**: Primary + Secondary 아이템
**시안**: 3개 brutalist-border 박스 그리드 (Duration, Active Days, Avg Steps)
- `bg-[#F9F7F5] border border-[#3C2F2F]`

### 4. 삭제된 요소 정리
- `goalProgressPct`, `goalProgressPctWrap`, `progressFill`, `progressMarker`, `startWeight`, `targetWeight` → `heroProgressFill`, `heroProgressMarker`, `heroProgressStart`, `heroProgressTarget`로 대체됨
- `trendWeight` → 새 요소로 복구됨

## 실행 단계

### Step 1: `index.html` Summary Strip 재구조화
- 기존 `summary-strip-inner` → `summary-strip-outer` (flex-wrap, brutalist-border)
- 좌측: `.summary-status-block` (flex, border-r, p-8)
  - Status 라벨 + 숫자 (15/30 + 50% span)
  - `.dot-grid` 15개 (`.summary-dots`와 분리)
- 우측: `.summary-grid` (grid-cols-5, bg-[#F9F7F5])
  - 5개 `.summary-grid-item` (p-8, border-r)

### Step 2: `index.html` Activity Logs 재구조화
- `activity-summary` → 3컬럼 brutalist-border 그리드
- 각 박스: `bg-[#F9F7F5] border border-[#3C2F2F]`
- Duration / Active Days / Avg Steps

### Step 3: `style.css` 스타일 추가/수정
- `.summary-strip-outer`: brutalist-border, flex-wrap
- `.summary-status-block`: flex, align-center, gap-8, p-8, border-r, flex-1, min-w-[300px]
- `.summary-grid`: grid-cols-5 (mobile: grid-cols-2, md: grid-cols-5), flex-[2], bg-panel-alt
- `.summary-grid-item`: p-8, border-r
- `.summary-grid-item:last-child`: border-r-0
- `.dot-grid`: grid-cols-15, gap-1.5 (기존 `.summary-dots` 수정)
- Activity 박스 border/bg 조정
- Detail quality bar 스타일 추가:
  - `.quality-bar-track`: brutalist-border, bg-line, h-3, overflow-hidden
  - `.quality-bar-fill`: h-full, bg-ink / bg-accent

### Step 4: `app.js` 데이터 바인딩 수정
- `renderHero()`:
  - `summaryCoverageText`: `"15/30"`
  - `summaryCoveragePct`: `"(50%)"`
  - `summaryRangeBox`: `"1.5kg"` (기존 `summaryRange`에서 숫자만)
  - `summaryChange7d`: `"-0.14/w"` (trend7에서 /주 → /w)
  - `summaryChange28d`: `"-0.10/w"`
  - `summaryMae14d`: `"0.63kg"`
  - `summaryLastEntry`: `"6. 16."` (fmtDateShort)

### Step 5: `enhancements.js` `renderDetails` 수정
- `detailQuality` HTML 교체:
  - Noise 레벨 + bar (outlierCandidates 기반)
  - Variance 레벨 + bar (recentCoveragePct 기반)
- `renderQuality` 함수: 기존 `#qualityStatus` 등이 더 이상 없으므로, 요소 존재 체크 추가하거나 summary strip과 연동

### Step 6: `enhancements.js` `renderQuality` 정리 또는 제거
- 기존 `#qualityStatus`, `#qualityCoverage`, `#qualitySync`, `#qualityBacktest`, `#qualityReason` 요소가 HTML에 없으므로 no-op 방지

## 구현 우선순위
1. Summary Strip HTML + CSS (가장 큰 시각적 차이)
2. Summary Strip JS 바인딩
3. Details Data Quality 바인딩
4. Activity Logs 스타일 정리
5. renderQuality 정리

## 테스트
- 기존 pytest 13개 통과 유지
- 수동: `localhost:8080/garmin-weight/index.html`에서 시안 대비 확인
