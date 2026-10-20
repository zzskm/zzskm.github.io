# 은퇴 시뮬레이터

독립 Vite + React 정적 앱. `npm ci`, `npm run dev`, `npm test`, `npm run build`.
결과물 `dist/`를 `/retirement-simulator/`에 배치한다. 자산 경로는 상대 경로다.
이전 `/retirement_simulator.html`은 동일 origin의 새 경로로 이동한다.

계산·정책 상수는 기존 HTML blob `8fff3945ddcfced9027b7de668f96f6c1c101612`에서 그대로 추출했다.
정책 가정 버전 `kr-v6-2026-10`과 금액 단위(만원, 현재가치), 수익률 단위(명목 연 %)를 보존한다.
세후 연 소득이 코어의 기준이며 세전/월 입력은 UI에서 변환한다.
`calculateScenario(input)`은 `yearlyAssetFlow`, `depletionAge`, `bridgeShortfall`,
`assetBucketsAtEnd`, `readinessRatio`, `assumptionVersion`을 반환한다.
모델 필드는 `src/model/defaults.js`, 마이그레이션은 `src/state/migration.js`를 참고한다.
주거·자산 인출은 하나의 연도별 상태 전이를 공유하므로 `cashflow.js` 안에 유지했다.

`tests/fixtures/legacy-model.cjs`는 변경하지 않는 기존 계산 기준이다.
대표·경계 시나리오의 모든 연도별 결과, 수익률 밴드, 고정 시드 MC를 비교하며
기본 시나리오의 2026년 지표는 별도 JSON 기준값으로 보관한다.
기준값 변경은 정책 변경과 별도로 검토한다. 자동으로 재생성하지 않는다.
국민연금·세금 정책 상수 변경 시 출처, 기준일, 가정 버전을 함께 갱신한다.

GitHub Actions는 전체 정적 사이트를 보존하고 새 앱의 빌드 결과만 교체한 미리보기 artifact를 만든다.
실제 배포는 main의 수동 workflow_dispatch로 실행한다. Pages source가 GitHub Actions인지 먼저 확인한다.
다른 앱의 기존 워크플로는 변경하지 않는다. 저장 키 `retirement-sim-v5` 및
v4/v3/v2 마이그레이션을 유지한다. 경로 이동은 동일 origin이므로 localStorage를 공유한다.

시장 충격 진단의 비교 계획은 `projectionStress: true`를 저장한다. 기본 지표·수익률 밴드·
몬테카를로에 같은 충격 가정을 한 번 적용한다. 몬테카를로는 기존 표본 실질수익률에
충격 프리셋의 기준 수익률 대비 차이를 더한다(하한 -100%). 기존 입력의 계산은 유지한다.
JSON 백업은 개수 제한 없이 전체 시나리오를 보존하며 내보내기·가져오기 모두 UTF-8 2MB 제한을 적용한다.
직접 추가하는 비교 계획은 화면의 기존 비교 슬롯 제한을 유지한다.
