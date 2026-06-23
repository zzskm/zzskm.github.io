# Plan: Frontend / UI / UX / Layout 개선

## 현재 문제 분석

### 시각적 계층 (Hierarchy) 문제
- Hero 섹션과 Summary Strip이 시각적 경쟁을 함 (둘 다 3px 두꺼운 테두리, 높은 대비)
- 상대적으로 덜 중요한 정보(Activity Logs, 모델 스트립)가 주요 정보와 비슷한 무게로 보임
- 너무 많은 요소가 `font-weight: 900` + `text-transform: uppercase`라 스캔이 어려움
- Hero의 오른쪽 메트릭(Trend / To Target / Last Entry)이 큰 체중 숫자와 시각적으로 분리되어 흐름이 끊김

### Mobile 레이아웃 붕괴
- `.panels-grid`가 데스크탑 `1fr 1fr` 그대로 유지되어 모바일에서 두 컬럼이 겹치거나 좁아짐
- `.summary-strip-outer`가 `flex-wrap: wrap`인데 내부 `.summary-status-block`의 `flex: 1 1 280px`이 모바일에서 이상하게 동작할 수 있음
- 시나리오 카드(`.scenario`)의 `font-size: 34px`가 320px 폰에서 비대해 보일 수 있음

---

## 구현 계획

### 1. 시각적 계층 재정비 (style.css)

#### Hero 영역
- `.hero` 테두리 3px → 2px 로 약화, 배경을 `#fff`로 유지
- `.hero-metric` 패딩 `40px` → `28px` 로 축소하고 label/value 크기 차이를 더 극명하게
- `.hero-metric-val`는 클수록 강조되도록 기존 clamp 유지하되 모바일에서 컨트롤
-롤
- `.hero-stats-row`의 3개 항목을 좀 더 작고 연하게 처리 (secondary tier)
- Hero 오른쪽 메트릭들을 왼쪽 큰 숫자와 자연스럽게 연결되도록 여백 조정

#### Summary Strip 약화
- `.summary-strip-outer` 테두리 3px → 1.5px
- `.summary-status-block` 배경을 `#fff`가 아니라 `var(--bg)` 또는 반투명으로 변경해 hero와의 대비 낮춤
- `.summary-grid-value` `font-size: 16px` → `14px`, `font-weight: 900` → `800`  
- `.summary-status-value` `font-size: 18px` → `16px`
- 라벨과 값의 대비(색상/무게)를 키워서 "라벨은 작고 연하게, 값은 크고 진하게" 패턴 강화

#### Activity Blocks 약화
- `.activity-block-num` `font-size: 42px` → `32px`
- 테두리 두께 1.5px 유지하되 `background: var(--panel-alt)`를 `var(--bg)`에 가깝게

#### 전역 타이포그래피 정리
- `text-transform: uppercase`를 값(number)에는 적용하지 않기 (현재 일부에 적용됨)
  - `.hero-stat-value`, `.summary-grid-value`, `.scenario-val` 등에서 `text-transform: uppercase` 제거
  - 라벨/카테고리(10-12px)만 uppercase 유지
- `font-weight: 900`을 최상위 헤드라인과 값(number)에만 집중하고, 서브 텍스트는 600-700으로 낮춤

### 2. Mobile 레이아웃 수정 (style.css)

#### 패널 그리드
```css
@media (max-width: 720px) {
  .panels-grid { grid-template-columns: 1fr; }
}
```
- Activity Logs와 AI Insight 카드가 세로로 쌓이도록

#### 히어로 메트릭 모바일
- 720px 이하에서 `.hero-metrics` grid 레이아웃은 `grid-template-rows: auto` 유지하되 padding 축소
- `.hero-metric` padding을 `28px`로 줄여서 화면 높이 절약

#### 시나리오 모바일
- 520px 이하에서 `.scenario-val` font-size를 `28px`로 제한
- `.scenario` padding을 `20px 16px`로 축소

#### 요약 스트립 모바일
- 720px 이하에서 `.summary-status-block`은 `flex: 1 1 auto; min-width: unset; border-bottom: 1.5px solid var(--ink);`
- `.summary-grid`가 자연스럽게 2열 → `minmax(140px, 1fr)`로 조정

#### 차트 높이
- 720px 이하에서 `.chart-wrap` 높이를 `220px`로 낮춤

### 3. 추가 여백/구분선 정리

- 각 major section(`.hero`, `.summary-strip`, `.panel`, `.panels-grid`) 사이 margin을 일관되게 조정
- overlapping border trick(`margin-top: -3px`)은 유지하되 시각적 충격 최소화

---

## 변경 파일
- `style.css` — 주요 변경 (계층 재정비 + mobile responsive 추가)
- `index.html` — 최소 변경 (필요 시 class 추가/삭제)

## 비고
- JS 로직은 건드리지 않음 (데이터 흐름/기능 동일)
- `enhancements.css` / `enhancements.js`도 건드리지 않음 (기존 보조 스타일 유지)