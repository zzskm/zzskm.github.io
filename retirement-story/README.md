# Retirement Story (MVP)

A narrative presentation of the existing [Retirement Simulator](../retirement-simulator/). **The financial model has not been forked.**

## Running locally

```bash
cd retirement-story
npm ci
npm run dev
npm test
npm run build
npm run test:e2e
```

The Vite app imports `../retirement-simulator/src/model/*`, `src/state/backup.js`, and `src/insights/targets.js` directly. Both directories must be in the same checkout. The generated page is published under `/retirement-story/`.

## Persona-first quick setup (light theme)

Story now uses one light palette, regardless of OS appearance.

The introductory cards present **five fictitious household personas**:
1. 나만의 탐험가 (솔로)
2. 함께 걷는 동반자 (무자녀 부부)
3. 한 아이의 길잡이 (1자녀)
4. 두 아이의 항해자 (2자녀)
5. 세 아이의 설계자 (3자녀)

Every illustrated SVG avatar is original, with a simple older-age hair color change.
The starting numeric profile is sourced directly from the existing household starter
scenarios. **2026 statutory middle-income welfare thresholds are not observed
post-tax median wages**; the asset and expense samples are also illustrative.

The quick entry edits character name, current/retirement age, each spouse's
monthly net wages where relevant, basic living costs and separate liquid vs
investable assets. Housing, debt, pension-stage living expenses, children and
birth years are disclosed in a secondary section. The expense preview separates
automated child costs and housing outflows from basic living expenses.

Choosing a persona resets the **form draft only**. Submitting applies the
scenario **in the current tab only**, not to the original backup or simulator
localStorage. JSON import and the existing saved-plan workflow continue to work.
Hiding balances collapses the input editor as well.

## MVP

- Play / pause / 4× speed, scrub through every modeled year, skip to major events.
- Deterministic readiness, extra investable capital required **at retirement**, year-by-year assets and cashflow.
- Model-grounded retirement, pension, child, mortgage payoff, downsizing, long-life and depletion milestones.
- Import an existing Simulator JSON backup, or explicitly load `retirement-sim-v5` from the same-origin browser's localStorage.
- Compare retirement delay (+2 years), lower retirement living expenses (−30만/month), and buffered mortgage prepayment without touching the saved scenario.
- Hide balances during on-screen sharing. No upload API, analytics, or remote LLM generation.

### Accuracy constraints

- All amounts are 만원, converted to today's purchasing power by the Simulator.
- The 100% readiness metric is a **deterministic model threshold**, not a 100% probability of success.
- A year and life milestone are a *model projection*, not a prediction that a child will attend university or become independent.
- Monthly totals sum the **visible yearly model buckets**. Additional saving flows and asset-to-asset movements are not counted as consumption.
- Model limitations remain: annualized mortgage repayment, static rate, simplified pension/health and no account-specific pension withdrawal gates.
- The sample scenario is illustrative, not derived from actual user finances. JSON and same-origin localStorage are read only by user action. The page uses locally installed system fonts.

## Deployment

`.github/workflows/retirement-story.yml` installs dependencies, runs unit + Playwright tests, builds with relative asset paths, and publishes only `retirement-story/index.html` and `retirement-story/assets/` to `main` on successful main-branch workflows.
