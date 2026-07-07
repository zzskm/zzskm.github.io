# 일정 중간에 추가하는 기능

## 목표
현재는 각 날짜별 로그 라인이 있고, 맨 아래 `+ 추가` 버튼으로만 새 일정을 추가할 수 있음.  
기존 라인 사이에 새 일정을 삽입할 수 있는 기능을 추가한다.

## 분석
- 각 라인은 `buildLineRow()` (`devsupport_log.html:1141`)에서 렌더링됨
- 라인 row 구조: `[time pickers] [text 영역] [actions 버튼들]`
- actions: `↗` (링크열기) / `이동` (이동/복사) / `✕` (삭제)
- 라인 추가는 하단 `timehelper`의 `+ 추가` 버튼으로만 가능 (`push` 방식)

## 변경사항

### 1. buildLineRow() — "위에 삽입" 버튼 추가
- `actions` div 안, `이동` 버튼과 `✕` 버튼 사이에 새 버튼을 추가
- 버튼 텍스트: `+`, title: `위에 삽입`
- CSS 클래스는 기존 `iconbtn` 재사용 (별도 스타일 추가 불필요)

### 2. 버튼 클릭 핸들러
1. `exitActiveEditor(true)` — 현재 편집 중인 라인 commit
2. 직전 라인의 end 시간을 start 기본값으로 사용 (첫 라인이면 `workStartTime`)
3. end = start + 1hour
4. `state.days[dayIdx].lines.splice(li, 0, { start, end, text: "", url: "" })`로 현재 위치에 삽입
5. `renderLinesContainer(dayIdx, container, onLineTimeChanged)` 재렌더링
6. `scheduleSave()` 호출

### 3. (선택) 삽입 후 자동 편집 모드 진입
- 삽입 직후 새 라인을 바로 편집할 수 있도록 edit mode 자동 진입을 고려했으나,  
  UX 일관성과 구현 복잡도를 고려하여 생략. 사용자가 직접 클릭해서 편집.
  (필요시 추후 개선 가능)

## 영향 범위
- `devsupport_log.html` 내 JavaScript (`buildLineRow` 함수)만 수정
- CSS / HTML 구조 변경 없음
- 기존 데이터 구조 변경 없음
