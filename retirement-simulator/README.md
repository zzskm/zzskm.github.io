# 은퇴 시뮬레이터

독립 Vite + React 정적 앱. 소스 HTML 진입점은 `app/index.html`이다. `npm ci`, `npm run dev`, `npm test`, `npm run build`.
결과물 `dist/`를 `/retirement-simulator/`에 배치한다. 자산 경로는 상대 경로다.
이전 `/retirement_simulator.html`은 동일 origin의 새 경로로 이동한다.

계산·정책 상수는 기존 HTML blob `8fff3945ddcfced9027b7de668f96f6c1c101612`에서 그대로 추출했다.
정책 가정 버전 `kr-v6-2026-10`과 금액 단위(만원, 현재가치), 수익률 단위(명목 연 %)를 보존한다.
세후 연 소득이 코어의 기준이며 세전/월 입력은 UI에서 변환한다.
`calculateScenario(input)`은 `yearlyAssetFlow`, `depletionAge`, `bridgeShortfall`,
`assetBucketsAtEnd`, `readinessRatio`, `assumptionVersion`을 반환한다.
모델 필드는 `src/model/defaults.js`, 마이그레이션은 `src/state/migration.js`를 참고한다.
기본값의 통계 기준은 `src/model/defaultBenchmarks.js`와 화면의 '중위 수준 참고 기본값'에 기록한다.
2025년 가계금융복지조사의 전국 가구 세전 소득 중위값 5,800만원(2024년 소득),
순자산 중위값 23,860만원(2025-03-31)을 참고한다. 복지급여의 '기준 중위소득'과 구분한다.
본인/배우자 연봉 3,600/2,200만원, 금융 6,000만원(저축 4,000/투자 2,000),
주택 30,000만원/대출 12,000만원은 계산용 예시 배분이다. 순자산은 24,000만원으로 반올림했다.
가구 총소득에는 근로 외 소득도 포함되므로 이를 전부 두 사람의 근로소득으로 보는 것은 단순화 가정이다.
각 항목의 중위값이나 실제 한 가구를 뜻하지 않으며, 가구 구성·생활비·수익률도 계획용 가정이다.
신한은행 Mydata Unit '보통사람 금융생활 보고서 2024'(2023년 취업자 조사)는 평균 수치가 주로 제시되어
중위값의 직접 출처로 사용하지 않는다. 새 계획·초기화에만 적용하고 기존 저장값은 덮어쓰지 않는다.
계산식·정책 상수·과거 golden fixture는 유지한다. 과거 golden 테스트는 고정된 구 기본입력으로 실행한다.
현재 나이의 출생연도는 모델과 동일하게 `CURRENT_YEAR - age`로 표시하며 생일 미반영을 안내한다.
주거·자산 인출은 하나의 연도별 상태 전이를 공유하므로 `cashflow.js` 안에 유지했다.

`tests/fixtures/legacy-model.cjs`는 변경하지 않는 기존 계산 기준이다.
대표·경계 시나리오의 모든 연도별 결과, 수익률 밴드, 고정 시드 MC를 비교하며
기본 시나리오의 2026년 지표는 별도 JSON 기준값으로 보관한다.
기준값 변경은 정책 변경과 별도로 검토한다. 자동으로 재생성하지 않는다.
국민연금·세금 정책 상수 변경 시 출처, 기준일, 가정 버전을 함께 갱신한다.

GitHub Pages는 기존 main 브랜치 / 루트를 서비스한다. `retirement-simulator/index.html`과
`assets/`는 컴파일된 공개 파일이며 JSX 진입점을 직접 서비스하지 않는다.
`npm run build && npm run publish:static`으로 공개 파일을 갱신한다.
main의 앱 변경은 테스트 후 빌드 결과를 이 두 경로에만 커밋하고 Pages 빌드를 요청한다.
데이터 동기화 중 main이 이동해도 최신 파일을 보존하고 앱 소스가 바뀌면 오래된 빌드를 게시하지 않는다.
다른 앱의 파일·워크플로·Pages 설정은 유지한다. 저장 키 `retirement-sim-v5` 및
v4/v3/v2 마이그레이션을 유지한다. 경로 이동은 동일 origin이므로 localStorage를 공유한다.

시장 충격 진단의 비교 계획은 `projectionStress: true`를 저장한다. 기본 지표·수익률 밴드·
몬테카를로에 같은 충격 가정을 한 번 적용한다. 몬테카를로는 기존 표본 실질수익률에
충격 프리셋의 기준 수익률 대비 차이를 더한다(하한 -100%). 기존 입력의 계산은 유지한다.
JSON 백업은 개수 제한 없이 전체 시나리오를 보존하며 내보내기·가져오기 모두 UTF-8 2MB 제한을 적용한다.
직접 추가하는 비교 계획은 화면의 기존 비교 슬롯 제한을 유지한다.

