# Garmin Weight Dashboard UX Hardening Plan

## 1. Current State Assessment

### Files inspected

- `index.html`
- `style.css`
- `enhancements.css`
- `app.js`
- `enhancements.js`
- `app.helpers.js`
- `data/summary.json`
- `tests/test_garmin_weight.py`

### Current repository observations

- The dashboard is already dense and functional, but the visual hierarchy is split across too many first-class blocks.
- `index.html` currently structures the page as:
  1. topbar
  2. insight card
  3. hero goal-progress-first
  4. bottom row of separate cards
  5. plateau card
  6. chart panel
  7. scenario cards
  8. activity panel
  9. footer
- The hero currently emphasizes goal progress before current status:
  - `index.html:49-117`
  - `app.js:39-123`
- Related trust signals are split across multiple cards:
  - 7-day range card: `index.html:119-132`
  - 30-day coverage card: `index.html:133-145`
  - data quality card: `index.html:146-155`
  - acceleration card: `index.html:156-165`
  - metabolic card: `index.html:166-181`
  - Kalman strip: `index.html:194-198`
- The chart remains central:
  - `index.html:194-276`
  - `app.js:462-674`
- Scenario controls are visible but abstract:
  - `index.html:247-273`
  - labels: 낙관 / 기준 / 보수
  - descriptions are shown inside cards.
- `enhancements.js` independently fetches `summary.json` again:
  - `enhancements.js:308-320`
- `enhancements.js` already handles low confidence behavior, prediction hiding, quality rendering, and model explanation:
  - `enhancements.js:149-298`
- `tests/test_garmin_weight.py` was not present in the current repository. Only backend hardening tests exist at `test_model_hardening.py`.

### Current data compatibility

Current `summary.json` already provides most UI data needed:

- `current.weightKg`
- `current.weightDate`
- `current.weightEwmaKg`
- `goal.remainingKg`
- `goal.etaDays`
- `coverage.last30Measured`, `coverage.last30Total`, `coverage.last30Pct`
- `rolling.last7WeightRangeKg`
- `rolling.lossRateDetail.windowSlopes`
- `modelDiagnostics.confidence`
- `modelDiagnostics.backtest`
- `modelDiagnostics.trendWindows`
- `predictionCI.series`

Optional recommended fields, if added later:

- `modelDiagnostics.trend`
- `modelDiagnostics.dataQuality`
- `modelDiagnostics.selectedModel`
- `modelDiagnostics.modelAudit`
- `modelDiagnostics.ciCalibration`
- `predictionCI.hitRate`
- `predictions.scenarios[].uiLabel`

The frontend should treat these as optional and fall back to existing fields.

### Visual reference mockup

The Variant mockup was successfully opened via the provided URL. It shows a status-first, dense, brutalist-style dashboard with:

- status badge: `예측 보류`
- current weight as the largest number
- trend weight and target remaining in the hero
- last entry and weekly change in the hero
- goal progress retained but secondary
- compact status strip with range / coverage / trend / MAE
- central chart
- action scenarios
- activity summary
- collapsed details summary: `Model validation · Efficiency · Trend Window`

This direction matches the requested UX goals and should be adopted selectively, without rewriting the app.

## 2. UX Goals

The dashboard should:

- Answer the current status first: losing, flat, gaining, prediction paused, or low confidence.
- Keep the page dense, but reduce perceived complexity.
- Keep the main chart as the central evidence area.
- Make low confidence feel like a valid paused state, not an error.
- Merge related trust signals into one compact summary strip.
- Preserve advanced diagnostics without letting them compete visually.
- Use action-based scenario labels.
- Keep the site as a one-page dashboard.
- Avoid removing useful data.
- Avoid duplicate explanations and card sprawl.
- Improve scanability on desktop and mobile.

## 3. Proposed Information Architecture

### Primary flow

1. Current status
2. Key evidence
3. Main chart
4. Action / scenario controls
5. Activity summary
6. Collapsed detailed analysis

### Recommended page structure

```text
Topbar
Status hero
Compact trust summary strip
Main chart panel
  - chart guard message when needed
  - chart controls
  - prediction / actual / trend visibility controls
Action scenario controls
Activity summary
Detailed analysis
Footer
```

### First-class vs collapsed content

#### First-class

- Current status
- Current weight
- Trend weight
- Target remaining
- Last measurement date
- Measurement coverage
- 7-day range
- 7d / 28d trend
- 14d MAE
- Main chart
- Scenario controls
- Activity summary

#### Collapsed details

- Acceleration signal
- Metabolic signature
- Exercise efficiency
- kcal/kg source
- Kalman comparison
- Model audit
- CI hit rate
- Full backtest details
- Trend windows beyond compact summary

## 4. Proposed Layout Structure

### Desktop layout

```text
------------------------------------------------------------
Topbar: brand · sync status · reload
------------------------------------------------------------
Status hero
- status badge
- current weight
- trend weight · remaining · last measured
- coverage · 14d error
- secondary goal progress bar
------------------------------------------------------------
Compact summary strip
Measured 15/30 days · Coverage 50% · Range 1.5 kg
7d −0.14 kg/w · 28d −0.10 kg/w · 14d MAE 0.63 kg
[compact 30-day dot grid]
------------------------------------------------------------
Main chart panel
- chart title
- period controls
- series controls
- guard message if needed
- chart
- compact model strip
------------------------------------------------------------
Action scenarios
- Exercise +2 sessions
- Current routine
- Exercise −2 sessions
------------------------------------------------------------
Activity summary
------------------------------------------------------------
Detailed analysis
------------------------------------------------------------
Footer
```

### Mobile layout

```text
Topbar
Status
Current weight
Compact summary strip
Chart
Scenario controls
Activity summary
Detailed analysis
Footer
```

Avoid horizontal card rows on small screens unless they are intentionally scrollable and clearly scannable.

## 5. Component-by-Component Changes

### 5.1 Hero Reframe

Files:

- `index.html:49-117`
- `style.css:173-353`
- `app.js:39-123`
- `enhancements.js:149-168`

Changes:

- Replace the current goal-progress-first hero with a status-first hero.
- Add a status badge near the top of the hero.
- Make current weight the dominant number.
- Move goal progress into a secondary compact block below the status line.
- Show `prediction paused` when:
  - confidence is low
  - trend is flat
  - trend is gaining
  - ETA is unavailable
- Show `low confidence` when confidence level is low but there is enough trend data to keep the dashboard useful.
- Show `losing`, `flat`, or `gaining` based on trend direction.
- Avoid blank `–` when the real state is paused, flat, gaining, or insufficient data.

Recommended hero hierarchy:

```text
Prediction paused
82.5 kg
Trend 83.2 kg · 3.2 kg to target · last measured 2 days ago
Measured 15/30 days · 14d error 0.63 kg
Goal progress: 24%
```

When trend is flat or gaining:

```text
Flat / slight gain
+0.10 kg/week
Prediction paused because the recent trend is not weight loss.
```

Suggested IDs/classes:

- `statusBadge`
- `statusReason`
- `heroStatus`
- `heroConfidence`
- `heroTrustLine`
- `goalProgressSecondary`

Fallback logic:

- If `modelDiagnostics.trend` exists, use:
  - `direction`
  - `weeklyChangeKg`
  - `weeklyLossRateKg`
  - `predictionEnabled`
  - `disabledReason`
- Otherwise infer from:
  - `rolling.lossRateDetail.blended`
  - `rolling.lossRateDetail.windowSlopes`
  - `modelDiagnostics.confidence.level`
  - `goal.etaDays`

### 5.2 Compact Summary Strip

Files:

- `index.html:119-182`
- `style.css:667-765`
- `app.js:361-420`
- `enhancements.js:68-92`

Changes:

- Replace the separate bottom cards with one compact summary strip.
- Keep the 30-day dot grid, but make it compact and secondary.
- Merge:
  - 7-day range
  - 30-day measurement coverage
  - data quality
  - last measurement
  - model validation summary
- Show one compact line:

```text
Measured 15/30 days · Coverage 50% · Range 1.5 kg
7d −0.14 kg/w · 28d −0.10 kg/w · 14d MAE 0.63 kg
```

- Move acceleration / metabolic details into `Detailed analysis`.
- Keep the strip small enough that it does not become another full-width card.

Suggested IDs/classes:

- `summaryStrip`
- `summaryMetric`
- `summaryDots`
- `summaryTrustLine`

### 5.3 Main Chart Panel

Files:

- `index.html:194-276`
- `style.css:355-497`
- `app.js:422-674`
- `enhancements.js:279-298`

Changes:

- Keep the chart as the central evidence area.
- Default visible series:
  - actual weight
  - EWMA trend
  - target line if supported
- Conditional series:
  - prediction line
  - 80% confidence band
  - 14-day average
- When confidence is low:
  - hide prediction and CI by default
  - keep actual and trend visible
  - show a compact guard message above the chart.

Example guard:

```text
Prediction hidden: recent measurement coverage is 50%.
Track actual weight and trend first.
```

When trend is flat/gaining:

```text
Prediction paused: recent trend is not weight loss.
Actual weight and trend remain visible.
```

- Change period controls from `role="tablist"` to `role="group"` if they are simple filters.
- Add clear labels to chart controls.
- Consider disabling or dimming the prediction checkbox when prediction is paused, with an explanation.

### 5.4 Scenario Controls

Files:

- `index.html:247-273`
- `style.css:499-588`
- `app.js:119-123`, `app.js:307-358`, `app.js:805-856`
- `enhancements.js:94-140`

Changes:

- Rename scenario labels:

| Current | Proposed |
|---|---|
| 낙관 | Exercise +2 sessions |
| 기준 | Current routine |
| 보수 | Exercise −2 sessions |

- Keep three controls.
- Reduce visible copy.
- Move long descriptions into:
  - `title`
  - compact secondary text
  - collapsed details
- When confidence is low, keep controls visible but mark them as reference-only.

Example reference-only message:

```text
Reference only · Prediction is paused until measurement coverage improves.
```

- Add `aria-pressed` to scenario buttons.
- Keep scenario selection state visible.

### 5.5 Activity Summary

Files:

- `index.html:278-311`
- `style.css:598-650`
- `app.js:676-803`

Changes:

- Keep activity summary after scenarios.
- Keep recent 7-day exercise minutes primary.
- Keep active days and average steps secondary.
- On mobile, simplify the row so it does not feel cramped.
- Consider moving the activity chart into a collapsible sub-area only if mobile height becomes too long.

### 5.6 Detailed Analysis Section

Files:

- `index.html:156-181`, `index.html:194-198`, `index.html:234-245`
- `style.css:1051-1151`
- `app.js:160-288`
- `enhancements.js:189-278`

Changes:

- Add a collapsed section titled `Detailed analysis`.
- Collapsed summary text:

```text
Model validation · trend windows · exercise efficiency
```

- Move these into the collapsed section:
  - acceleration signal
  - metabolic signature
  - exercise efficiency
  - kcal/kg source
  - Kalman comparison
  - model audit
  - CI hit rate
  - full backtest details

Suggested structure:

```html
<details class="details-panel">
  <summary>Detailed analysis</summary>
  <p>Model validation · trend windows · exercise efficiency</p>
  ...
</details>
```

Recommended subsections:

- Model validation
  - 7d / 14d / 28d MAE
  - selected model
  - baseline comparison if available
- Trend windows
  - 7d, 14d, 28d
  - acceleration interpretation
- Exercise efficiency
  - exercise efficiency
  - kcal/kg source
- Prediction CI
  - hit rate by horizon if available
- Kalman comparison
  - only show if data exists
  - avoid making it first-class unless recommended

### 5.7 Low Confidence Mode

Files:

- `app.js:39-123`
- `enhancements.js:149-298`
- `enhancements.css:62-100`
- `style.css:904-1020`

Changes:

- Treat low confidence as a valid dashboard state.
- Use explicit status language:

```text
Prediction paused
Measured only 15 of the last 30 days.
Measure for 7 consecutive days to restore goal-date prediction.
```

- Hide prediction line and CI by default.
- Keep actual and trend visible.
- Do not make low confidence look like a failure.
- Show next action clearly.
- Keep scenarios visible but reference-only.

### 5.8 Empty / Disabled State Cleanup

Files:

- `index.html`
- `app.js`
- `enhancements.js`

Changes:

- Replace ambiguous `–` with explicit states:
  - `Prediction paused`
  - `No positive loss trend`
  - `Insufficient coverage`
  - `Sample count too low`
  - `No ETA available`
- For ETA:
  - If no positive trend: show `ETA paused`
  - If insufficient coverage: show `ETA needs more measurements`
  - If target reached: show `Reached`
- For prediction:
  - If low confidence: show `Hidden by default`
  - If trend is not losing: show `Paused`
  - If unavailable due to missing data: show `No prediction data`

## 6. Mobile Layout Changes

Files:

- `style.css:896-1050`
- `index.html`

Changes:

- Use a single-column mobile order:
  1. status
  2. current weight
  3. compact summary strip
  4. chart
  5. scenario controls
  6. activity summary
  7. detailed analysis
- Avoid the current mobile pattern that forces multiple dense cards into a horizontal row.
- Summary strip should become a compact vertical list or two-line block on narrow screens.
- Scenario controls can remain compact but should not feel like tiny horizontal cards at 360px.
- Hide desktop-only shortcut hints on mobile.
- Keep chart height usable:
  - 360px width: approximately 220px
  - 412px width: approximately 240px
  - tablet: 260-300px
- Ensure focus rings and touch targets remain comfortable.

## 7. Accessibility Changes

Files:

- `index.html`
- `app.js`
- `enhancements.js`
- `style.css`

Changes:

### Period controls

Current:

```html
<div class="seg" role="tablist" aria-label="기간">
```

Recommended:

```html
<div class="seg" role="group" aria-label="기간">
  <button aria-pressed="true">30일</button>
</div>
```

Reason:

- These are simple filters, not tab panels.

### Scenario buttons

Add:

- `aria-pressed="true|false"`
- `aria-describedby` for reference-only or long descriptions
- visible active state

### Chart controls

- Ensure chips have accessible labels.
- Ensure prediction checkbox state is understandable when prediction is hidden.
- If prediction is hidden, provide text such as:
  - `예측 숨김: 최근 측정률이 낮습니다.`

### Low confidence behavior

- Do not rely only on color.
- Use text status and icon/badge.
- Keep focus visible.
- Ensure the prediction guard is not hidden from screen readers.

### Keyboard shortcuts

- Keep desktop shortcuts.
- Hide or reduce shortcut hints on mobile.
- Ensure keyboard activation works for:
  - period controls
  - scenario buttons
  - chart series chips
  - details toggle

### Color and contrast

- Use status colors carefully.
- Avoid red-only treatment for low confidence.
- Use amber or neutral paused styling for low confidence.
- Keep current ink/muted hierarchy from `style.css`.

## 8. Frontend Data-Flow Cleanup

Files:

- `app.js`
- `enhancements.js`

Current issue:

- `app.js` fetches `summary.json` and `config.json`:
  - `app.js:868-884`
- `enhancements.js` fetches `summary.json` again:
  - `enhancements.js:308-320`

Recommended cleanup:

- Let `app.js` own loading of:
  - `summary.json`
  - `config.json`
- After both are loaded, dispatch a custom event:

```js
window.dispatchEvent(new CustomEvent('garmin-weight:summary-ready', {
  detail: { summary: state.summary, config: state.config }
}));
```

- Let `enhancements.js` listen to that event and render:
  - quality strip
  - scenario subtext
  - model explanation
  - summary mode
  - prediction guard
  - model audit
- Remove duplicate summary fetch from `enhancements.js`.
- Ensure render order is deterministic:
  1. `app.js` renders core layout
  2. `app.js` dispatches summary-ready
  3. `enhancements.js` applies enhancements and mode-specific UX

Recommended event listener:

```js
window.addEventListener('garmin-weight:summary-ready', (event) => {
  renderQuality(event.detail.summary);
  renderScenarioSub(event.detail.summary);
  renderSummaryMode(event.detail.summary);
});
```

Optional helper:

- Add a small shared state object in `app.js` if multiple modules need to read summary data.
- Avoid creating a framework or route layer.

## 9. Implementation Phases

### Phase 1: Plan and Visual Mapping

Files:

- `index.html`
- `style.css`
- `app.js`
- `enhancements.js`
- `data/summary.json`

Tasks:

- Compare current layout to the Variant mockup.
- Map current sections to the new hierarchy.
- Decide what stays first-class:
  - status
  - current weight
  - chart
  - scenarios
  - activity
- Decide what moves into details:
  - acceleration
  - metabolic
  - model audit
  - Kalman
  - CI hit rate
- Confirm no backend model logic needs to change.

### Phase 2: Hero Reframe

Files:

- `index.html`
- `app.js`
- `style.css`
- `enhancements.js`

Tasks:

- Add status badge.
- Make current weight dominant.
- Move goal progress into secondary hero block.
- Add trust line:
  - coverage
  - 14d MAE
  - last measurement
- Add fallback status inference from current summary fields.
- Add low confidence / paused copy.

### Phase 3: Summary Strip Consolidation

Files:

- `index.html`
- `app.js`
- `style.css`
- `enhancements.css`

Tasks:

- Replace bottom cards with one compact summary strip.
- Preserve:
  - measured days
  - coverage
  - 7-day range
  - 7d trend
  - 28d trend
  - 14d MAE
  - compact 30-day dots
- Move quality, acceleration, and metabolic details into `Detailed analysis`.

### Phase 4: Chart and Prediction Guard

Files:

- `index.html`
- `app.js`
- `style.css`
- `enhancements.js`

Tasks:

- Add prediction guard message.
- Hide prediction and CI by default when low confidence or paused.
- Keep actual and EWMA visible.
- Add clearer chart control labels.
- Review y-axis range and target line behavior.

### Phase 5: Scenario Simplification

Files:

- `index.html`
- `app.js`
- `style.css`
- `enhancements.js`

Tasks:

- Rename scenario labels.
- Reduce visible scenario copy.
- Move long descriptions into tooltip/details.
- Add reference-only mode when confidence is low.
- Add `aria-pressed`.

### Phase 6: Advanced Details Collapse

Files:

- `index.html`
- `app.js`
- `style.css`
- `enhancements.js`

Tasks:

- Add `<details>` section.
- Move advanced diagnostics into it.
- Keep collapsed summary short.
- Render model validation, trend windows, efficiency, kcal/kg, Kalman, CI hit rate, and backtest details only when data exists.

### Phase 7: Mobile and Accessibility Pass

Files:

- `style.css`
- `index.html`
- `app.js`
- `enhancements.js`

Tasks:

- Implement mobile order.
- Remove cramped horizontal rows.
- Use single-column layout on small screens.
- Fix roles:
  - period controls as `role="group"`
  - buttons with `aria-pressed`
- Improve focus states.
- Hide desktop shortcut hints on mobile.

### Phase 8: Data Flow Cleanup

Files:

- `app.js`
- `enhancements.js`

Tasks:

- Remove duplicate `summary.json` fetch from `enhancements.js`.
- Dispatch `garmin-weight:summary-ready` from `app.js`.
- Make `enhancements.js` subscribe to loaded data.
- Ensure low confidence rendering happens after core rendering.

### Phase 9: Validation

Files:

- `tests/test_garmin_weight.py` if added later
- Manual browser validation

Tasks:

- Validate low confidence state.
- Validate normal confidence state.
- Validate no-prediction state.
- Validate flat/gaining trend state.
- Validate missing measurement state.
- Validate mobile 360px width.
- Validate mobile 412px width.
- Validate tablet width.
- Validate desktop width.
- Validate keyboard navigation.
- Validate chart controls.
- Validate scenario controls.

## 10. Validation Checklist

### Functional

- Current status answers losing / flat / gaining / paused.
- Current weight remains the largest number.
- Goal progress remains visible but secondary.
- Prediction is hidden when confidence is low.
- Actual and trend remain visible when prediction is hidden.
- Scenarios remain visible but marked reference-only when paused.
- Advanced diagnostics are still accessible in collapsed details.

### Data

- Existing `summary.json` fields continue to work.
- New optional fields are backward-compatible.
- Fallback logic works when `modelDiagnostics.trend` is absent.
- Fallback logic works when `predictionCI.hitRate` is absent.
- No dashboard field depends on a backend change for the first implementation.

### Layout

- Desktop remains dense but less card-heavy.
- Mobile uses single-column order.
- No important metric is hidden unintentionally.
- Chart remains central.
- Summary strip does not become a large standalone card.

### Accessibility

- Period controls use `role="group"`.
- Period buttons use `aria-pressed`.
- Scenario buttons use `aria-pressed`.
- Prediction guard is readable by screen readers.
- Focus states are visible.
- Color is not the only signal for low confidence.
- Keyboard shortcuts still work on desktop.

### Performance

- `summary.json` is fetched once.
- Rendering remains deterministic.
- No duplicate chart rebuild loops are introduced.
- `enhancements.js` does not fetch `summary.json` independently.

## 11. Out-of-Scope Items

- Do not rewrite the dashboard as a framework app.
- Do not create multiple routes.
- Do not remove advanced diagnostics entirely.
- Do not change backend model logic for this UX pass unless optional UI state fields are already being added.
- Do not remove scenario controls.
- Do not remove the main chart.
- Do not remove the 30-day dot grid entirely.
- Do not make the dashboard sparse.
- Do not commit changes during planning.

## Acceptance Criteria

The final implementation should make the dashboard feel:

- dense but not cluttered
- status-first
- chart-centered
- action-oriented
- one-page
- less card-heavy
- easier to scan
- clearer when prediction is paused
- still useful when data quality is low
