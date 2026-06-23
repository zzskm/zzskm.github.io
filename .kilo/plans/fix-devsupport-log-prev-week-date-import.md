# Fix Dev Support log previous-week date import

## Goal
`devsupport_log.html`에서 “다른 날짜에서 가져오기”가 현재 주차뿐 아니라 지난 주차의 로그도 가져올 수 있도록 개선한다.

## Root cause hypothesis
현재 구현은 `openTransferModal(null, null, targetDayIdx)`에서 가져오기 후보를 `state.days`로만 필터링한다. 따라서 대상 날짜가 비어 있을 때 같은 주차의 다른 날짜만 후보로 표시되고, 이전 주차에 작성된 로그는 `hasSource` 검사에서 제외되어 “가져올 수 있는 로그가 현재 주차에 없습니다.”로 막힌다.

## Implementation plan
1. `devsupport_log.html`의 이동/복사 모달 구조를 최소 변경으로 확장한다.
   - 기존 `transferContext`에 `sourceWeekStart` 같은 선택 필드를 추가한다.
   - `renderTransferTargets()`가 현재 주차뿐 아니라 이전 주차도 후보로 표시할 수 있게 만든다.
2. 이전 주차 후보 UI를 추가한다.
   - 빈 날짜의 “다른 날짜에서 가져오기”에서 현재 주차 후보와 함께 “지난 주차” 섹션 또는 버튼을 제공한다.
   - 지난 주차 후보는 `weeksByStart[state.weekStart 이전 월요일]`에서 `isTransferableLine`인 로그만 포함한다.
3. 가져오기 적용 로직을 보강한다.
   - `transferAllLinesFromSource`가 `sourceWeekStart`를 받아 해당 주차의 원본 로그를 읽도록 수정한다.
   - 이동/복사 중 “복사”는 기존 주차 데이터를 유지하고, “이동”일 때만 원본 주차에서 제거한다.
   - 제거 후 빈 날짜 배열도 `stripTrailingEmpty` 처리한다.
4. 저장/복원 안전성을 유지한다.
   - `snapshotCurrentWeek()`를 호출해 현재 주차 상태를 저장한 뒤 이전 주차 로그를 읽어온다.
   - 대상 날짜에 추가 후 `renderDays()`와 `scheduleSave()`를 수행한다.
5. 검증한다.
   - 현재 주차와 지난 주차에 샘플 로그가 있을 때 빈 날짜에서 가져오기가 보이는지 확인한다.
   - 복사/이동 모드 모두 동작하는지 확인한다.
   - HTML 저장 후에도 localStorage 기반 복원이 깨지지 않는지 확인한다.

## Validation checklist
- 빈 날짜의 “다른 날짜에서 가져오기”에서 현재 주차 + 지난 주차 로그를 선택할 수 있다.
- 지난 주차에서 가져온 로그가 대상 날짜 마지막 줄 뒤에 추가된다.
- “이동” 모드에서 지난 주차 원본 로그가 제거되고, “복사” 모드에서는 유지된다.
- 기존 같은 주차 내 이동/복사 기능이 그대로 동작한다.
