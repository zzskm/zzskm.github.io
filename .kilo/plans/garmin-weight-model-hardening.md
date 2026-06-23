# Garmin Weight Model Hardening Plan

## Goal

Use accumulated Garmin weight logs to determine whether the current trend/prediction model is better than simpler regression and baseline models. Keep the current model unless a candidate beats it by a clear backtest margin.

## Current Diagnosis

- The current summary shows no active loss trend because `weeklyLossRateKg` is only exposed when the blended weekly loss rate is positive.
- Current `lossRateDetail.blended` is negative, so goal ETA and base prediction are correctly disabled.
- Current confidence is low because recent measurement coverage is only 50% and residual noise is high.
- Existing Kalman comparison does not justify adoption. V1 currently beats Kalman on 7d/14d/28d MAE.
- `model_audit.py` already compares simple baselines, but its output is not fully wired into `summary.json`.

## Relevant Files

- `scripts/sync_garmin.py`: main summary builder and production model pipeline.
- `scripts/sync_modeling.py`: trend, prediction, CI, backtest, and confidence helpers.
- `scripts/model_audit.py`: standalone baseline/Kalman audit script.
- `scripts/kalman_predictor.py`: current Kalman candidate implementation.
- `data/summary.json`: generated schema to extend while preserving UI-compatible fields.

## Phase 1: Data Quality Diagnostics

Add `modelDiagnostics.dataQuality` in `scripts/sync_garmin.py` or a helper in `scripts/sync_modeling.py`.

Include:

- `totalDays`
- `measuredDays`
- `recent30CoveragePct`
- `recent30MeasuredDays`
- `recent30TotalDays`
- `longestMissingStreak`
- `outlierCount`
- `usableForRegression`
- `recentMeasurementCadence`
- `confidencePenalties`

Rules:

- `recent30CoveragePct < 70` adds a low-confidence penalty.
- `longestMissingStreak >= 5` adds a regression-confidence penalty.
- Absolute daily delta `>= 1.5kg` marks an outlier candidate.
- Outlier candidates should be counted and optionally flagged in regression inputs, but not blindly removed unless the robust regression path explicitly uses robust weighting.

Acceptance criteria:

- `modelDiagnostics.dataQuality` exists on empty and non-empty summaries.
- Existing `modelDiagnostics.coverage` and `coverage` fields remain for compatibility.
- Missing-streak and recent-coverage penalties are visible in confidence reasons or a dedicated confidence field.

## Phase 2: Candidate Model Interface

Implement a common candidate interface in `scripts/sync_modeling.py`, with optional migration of audit code from `scripts/model_audit.py`.

Candidate result shape:

```json
{
  "name": "linear_regression_56d",
  "predictedWeight": 82.9,
  "weeklyChangeEstimateKg": -0.21,
  "reason": null
}
```

Use `weeklyChangeEstimateKg` with negative = gaining/increasing, positive = losing. Keep current schema terms where necessary.

Candidates:

1. `flat_baseline`
2. `ma7_baseline`
3. `ewma_baseline`
4. `current_multi_window_ewma_blend`
5. `linear_regression_28d`
6. `linear_regression_56d`
7. `linear_regression_84d`
8. `weighted_linear_regression_56d`
9. `robust_regression_56d`
10. `kalman`

Candidate requirements:

- Each candidate trains only on rows before the cutoff during backtest.
- Each candidate returns an unavailable reason when it cannot predict.
- Current multi-window EWMA blend must use the same logic as production so comparisons are fair.
- Kalman should reuse `kalman_predictor.py` or wrap it behind the common interface.

Acceptance criteria:

- All candidates are available to the audit/selection path.
- Candidates can be evaluated for 7d, 14d, and 28d horizons.
- Regression candidates are visible in `modelDiagnostics.modelAudit`.

## Phase 3: Rolling Backtest

Generalize backtest logic around the candidate interface.

For each cutoff:

1. Train only on rows before the cutoff.
2. Predict 7d, 14d, and 28d.
3. Match the actual measurement within ±3 days.
4. Record `predicted - actual` error.

Metrics per candidate per horizon:

- `sampleCount`
- `maeKg`
- `rmseKg`
- `biasKg`
- `status`

Status values:

- `ok` when `sampleCount >= 20` for selection decisions.
- `insufficient` when fewer than 20 usable samples exist.
- `unavailable` when a candidate cannot produce predictions.

Acceptance criteria:

- Backtest does not leak future measurements into training.
- The same actual-matching rule is used for all candidates.
- Current model backtest remains available for compatibility under `modelDiagnostics.backtest`.

## Phase 4: Model Selection Gate

Implement a conservative selection gate.

Do not adopt a candidate unless all are true:

- `sampleCount >= 20`.
- MAE improves by at least `0.05kg` or at least `8%` versus current.
- Absolute bias does not materially worsen versus current.
- Candidate wins at least 2 of 3 horizons.

Default behavior:

- Keep current production model.
- Run all candidates in shadow mode.
- Expose selected model and audit result in `summary.json`.

Suggested `modelDiagnostics.selectedModel`:

```json
{
  "name": "current_multi_window_ewma_blend",
  "status": "kept_current",
  "reason": "No candidate beat current model by the adoption gate.",
  "gate": {
    "minImprovementKg": 0.05,
    "minImprovementPct": 0.08,
    "minSampleCount": 20,
    "minHorizonWins": 2
  }
}
```

Acceptance criteria:

- Shadow candidates are evaluated even when current model is retained.
- Selection does not switch to a candidate that only wins one horizon.
- Bias worsening blocks adoption when material.

## Phase 5: Trend Exposure

Add `modelDiagnostics.trend`.

Expose:

```json
{
  "direction": "flat",
  "weeklyChangeKg": 0.096,
  "weeklyLossRateKg": null,
  "predictionEnabled": false,
  "disabledReason": "No positive loss trend detected."
}
```

Rules:

- Direction:
  - `losing` when weekly loss estimate is clearly positive.
  - `gaining` when weekly change estimate is clearly positive.
  - `flat` when estimate is near zero.
  - `unknown` when insufficient data.
- `weeklyChangeKg` should preserve sign: negative = gaining, positive = losing.
- `weeklyLossRateKg` should remain positive for loss trends and `null` otherwise.
- ETA and base prediction stay disabled when trend is not positive loss.

Acceptance criteria:

- Negative current trend exposes `weeklyChangeKg` but disables ETA/prediction.
- UI compatibility fields `rolling.weeklyLossRateKg`, `predictions.oneMonthWeightKg`, and `goal.etaDays` remain null when disabled.

## Phase 6: CI Calibration Replay

Replace approximate CI hit-rate logic with real model replay.

For each historical cutoff:

1. Generate the selected model's central prediction for 7d, 14d, and 28d.
2. Generate the selected model's 80% CI band for the same horizon.
3. Compare the actual measurement within ±3 days.
4. Compute hit rate by horizon.

Expose:

```json
{
  "predictionCI": {
    "hitRate": {
      "7d": 0.82,
      "14d": 0.76,
      "28d": 0.69
    },
    "calibration": {
      "status": "ok",
      "targetHitRate": 0.8,
      "notes": []
    }
  },
  "modelDiagnostics": {
    "ciCalibration": {
      "hitRate": {
        "7d": 0.82,
        "14d": 0.76,
        "28d": 0.69
      },
      "status": "ok"
    }
  }
}
```

Acceptance criteria:

- `model_audit.py` no longer describes CI hit rate as approximate.
- `predictionCI.hitRate.7d`, `.14d`, and `.28d` are derived from replayed selected-model predictions.
- `ciCalibration.status` explains insufficient samples or missing CI bands when applicable.

## Phase 7: Summary Schema

Extend `summary.json` while preserving existing UI fields.

Add under `modelDiagnostics`:

- `selectedModel`
- `dataQuality`
- `trend`
- `modelAudit`
- `ciCalibration`

Keep existing fields for compatibility:

- `model`
- `confidence`
- `coverage`
- `trendWindows`
- `residualStdKg`
- `backtest`
- `kcalPerKg`
- `kcalPerKgSource`
- `calibration`
- `modelComparison`
- `notes`

Acceptance criteria:

- Existing dashboard consumers continue to read old fields.
- New diagnostics are present on generated summaries.
- `data/summary.json` can be regenerated with `scripts/sync_garmin.py --skip-garmin`.

## Phase 8: Tests

Add tests in a lightweight local test file or module, depending on existing project conventions. If no test runner exists, add a small pytest-compatible test file and note the dependency in the implementation.

Required tests:

1. Regression candidates are included in audit.
2. Selected model requires minimum improvement.
3. Negative trend exposes `weeklyChangeKg` but disables ETA.
4. CI hit rate uses replayed selected model.
5. Outliers do not dominate robust regression.
6. Missing streak lowers confidence.

Acceptance criteria:

- Tests run without Garmin credentials.
- Tests use small synthetic rows and deterministic dates.
- Tests validate schema keys and gate behavior, not just helper functions.

## Implementation Approach

1. Add reusable modeling helpers to `scripts/sync_modeling.py`:
   - data-quality diagnostics
   - candidate interface and candidate functions
   - generalized rolling backtest
   - selection gate
   - trend exposure
   - CI calibration replay
2. Update `scripts/sync_garmin.py` to call the new helpers and merge results into `summary.json`.
3. Update `scripts/model_audit.py` to use the same candidate/backtest logic where practical, avoiding duplicate formulas.
4. Keep `scripts/kalman_predictor.py` as the Kalman implementation and wrap it behind the common candidate interface.
5. Add tests for the required hardening behaviors.
6. Regenerate `data/summary.json` in skip-Garmin mode and verify old fields remain compatible.

## Validation Commands

Run after implementation:

```bash
python scripts/sync_garmin.py --skip-garmin --output-csv garmin-weight/data/daily_metrics.csv --output-summary garmin-weight/data/summary.json
python scripts/model_audit.py --csv garmin-weight/data/daily_metrics.csv --summary garmin-weight/data/summary.json --output garmin-weight/data/model_audit.json
python -m pytest
```

If pytest is not installed or no test runner exists, run the new tests with the project’s available Python test command or document the exact command used.

## Risks and Notes

- The current data has low recent coverage, so model selection may keep the current model even if a candidate has slightly better MAE.
- Robust regression should reduce outlier influence without hiding the fact that outliers exist.
- CI replay should use the selected model, not an approximation from flat-baseline outcomes.
- Preserve schema compatibility first; optimize naming later only if it does not break existing consumers.
