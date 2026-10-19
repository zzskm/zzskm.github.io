#!/usr/bin/env python3
"""Historical approximation retained for the v1 report; use backtest_engine.py for production replay."""
import argparse
import csv
import datetime as dt
import json
import hashlib
from collections import defaultdict
from pathlib import Path
from statistics import mean

from safety_model import (bucket, fit_model, match_trips, safety_prediction, timestamp,
                          lower_quantile, KST)


def read(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def pct(n, total):
    return round(n / total, 4) if total else None


def publication_events(predictions, adaptive):
    """Zero push/deploy delay scenario; no measured publication history exists."""
    events, last_pub, previous_vid = [], float('-inf'), None
    for r in sorted(predictions, key=lambda r: timestamp(r.get('ts_kst')) or 0):
        t = timestamp(r.get('ts_kst'))
        if t is None:
            continue
        vid = r.get('vehId') or None
        try:
            p, loc = float(r.get('predict_sec', '')), float(r.get('location_no', ''))
        except ValueError:
            p, loc = float('inf'), float('inf')
        cadence = 60 if adaptive and (p <= 900 or loc <= 2) else 300
        if vid != previous_vid or t - last_pub >= cadence:
            events.append((t, r))
            last_pub = t
        previous_vid = vid
    return events


def replay(trips, predictions, model, improved, walk_sec=300, lead_sec=300, margin_sec=60, delivery_delay_sec=60):
    events = [(t + delivery_delay_sec, r) for t, r in publication_events(predictions, improved)]
    results = []
    for trip in trips:
        matching = [(t, r) for t, r in events if r.get('vehId') == trip['vehId'] and trip['start'] <= timestamp(r['ts_kst']) <= trip['end']]
        fire, first = None, None
        # Reconstruct the collector's persisted stall anchor over ALL successful polls.
        anchors, since, anchor_p = {}, None, None
        for r in trip['rows']:
            try:
                near = float(r.get('location_no', '')) <= 1 and 150 <= r['_p'] <= 200
            except (ValueError, TypeError):
                near = False
            if not near:
                since, anchor_p = None, None
            elif since is None or abs(r['_p'] - anchor_p) > 15:
                since, anchor_p = r['_t'], r['_p']
            anchors[r['_t']] = since
        # Compare both methods on the identical collection rows, independent of publish cadence.
        coverage = []
        for r in trip['rows']:
            safe = timestamp(safety_prediction(model, r, anchors[r['_t']])['safe_arrival_ts']) if improved else r['_t'] + r['_p']
            coverage.append(safe <= trip['lower'])
        for i, (published, row) in enumerate(matching):
            first = first or published
            near_anchor = anchors.get(timestamp(row['ts_kst']))
            api = timestamp(row['ts_kst']) + float(row['predict_sec'])
            prediction = safety_prediction(model, row, near_anchor) if improved else None
            safe = timestamp(prediction['safe_arrival_ts']) if prediction else api
            notify = safe - (max(lead_sec, walk_sec + margin_sec) if improved else lead_sec)
            # Browser sees a snapshot at publication and counts down until replaced.
            next_event = next((t for t, _ in events if t > published), float('inf'))
            due = max(published, notify)
            if due < next_event and due <= trip['upper'] and fire is None and (not improved or due - timestamp(row['ts_kst']) <= 180):
                # Legacy suppresses alerts <60s; safety path still warns when API ETA remains future.
                if api - due >= (0 if improved else 60):
                    fire = due
        station = fire + walk_sec if fire is not None else None
        results.append({'id': trip['id'], 'day': trip['day'], 'fire': fire,
                        'possible_miss': station is None or station > trip['lower'],
                        'certain_miss': station is None or station > trip['upper'],
                        'wait_lower': max(0, trip['lower']-station) if station is not None else None,
                        'wait_upper': max(0, trip['upper']-station) if station is not None else None,
                        'coverage': all(coverage) if coverage else None,
                        'first_recognition_lead_sec': trip['lower']-trip['start'],
                        'first_publication_delay_sec': first-trip['start'] if first is not None else None})
    waits = [r for r in results if r['wait_lower'] is not None]
    return {'trips': len(results), 'possible_miss_rate': pct(sum(r['possible_miss'] for r in results), len(results)),
            'certain_miss_rate': pct(sum(r['certain_miss'] for r in results), len(results)),
            'notification_omission_rate': pct(sum(r['fire'] is None for r in results), len(results)),
            'wait_lower_mean_sec': round(mean(r['wait_lower'] for r in waits), 1) if waits else None,
            'wait_upper_mean_sec': round(mean(r['wait_upper'] for r in waits), 1) if waits else None,
            'excess_wait_lower_mean_sec': round(mean(max(0,r['wait_lower']-margin_sec) for r in waits),1) if waits else None,
            'excess_wait_upper_mean_sec': round(mean(max(0,r['wait_upper']-margin_sec) for r in waits),1) if waits else None,
            'wait_denominator_alerted_trips': len(waits),
            'trip_simultaneous_early_coverage': pct(sum(r['coverage'] is True for r in results), sum(r['coverage'] is not None for r in results)),
            'first_recognition_lead_min_sec': min((r['first_recognition_lead_sec'] for r in results), default=None),
            'first_recognition_lead_mean_sec': round(mean(r['first_recognition_lead_sec'] for r in results), 1) if results else None,
            'daily_possible_miss_rates': {day: pct(sum(r['possible_miss'] for r in results if r['day'] == day), sum(r['day'] == day for r in results)) for day in sorted({r['day'] for r in results})},
            'first_publication_and_fetch_delay_mean_sec': mean(r['first_publication_delay_sec'] for r in results if r['first_publication_delay_sec'] is not None) if any(r['first_publication_delay_sec'] is not None for r in results) else None}


def audit_segments(segments, trips):
    counts = {'rows':len(segments), 'matched':0, 'unmatched':0, 'ambiguous':0, 'invalid_timestamp':0}
    for r in segments:
        t = timestamp(r.get('ts_kst'))
        if t is None:
            counts['invalid_timestamp'] += 1
            continue
        matches = [trip for trip in trips if trip['vehId'] == r.get('vehId') and trip['start'] <= t <= trip['end']]
        counts['matched' if len(matches) == 1 else 'unmatched' if not matches else 'ambiguous'] += 1
    counts['interpretation'] = 'same_veh_at_both confirms API identity co-occurrence, not measured segment travel or arrival'
    return counts


def analyze(predictions, arrivals, segments=()):
    trips, audit = match_trips(predictions, arrivals)
    days = sorted({t['day'] for t in trips})
    cutoff = days[max(1, int(len(days)*.7))] if len(days) > 1 else None
    train = [t for t in trips if cutoff and t['day'] < cutoff]
    test = [t for t in trips if cutoff and t['day'] >= cutoff and t['eligible']]
    errors = defaultdict(dict)
    for t in trips:
        if not t['eligible']:
            continue
        for r in t['rows']:
            hour = dt.datetime.fromtimestamp(r['_t'], KST).hour
            for key in ('all', bucket(r), f'hour:{hour}'):
                error = t['lower'] - (r['_t'] + r['_p'])
                errors[key][t['id']] = min(errors[key].get(t['id'], float('inf')), error)
    strata = {}
    for key, vals in sorted(errors.items()):
        x = sorted(vals.values())
        strata[key] = {'independent_trips': len(x), 'worst_early_error_sec': round(min(x)),
                       'p05_trip_worst_error_sec': lower_quantile(x, .05), 'p10_trip_worst_error_sec': lower_quantile(x, .10),
                       'early_trip_fraction': pct(sum(v < 0 for v in x), len(x))}
    scenarios = {}
    for alpha in (.05, .10):
        m = fit_model(train, alpha)
        scenarios[f'p{round(alpha*100):02}'] = {'model': m, 'metrics': replay(test, predictions, m, True)}
    estimate_errors = [min(t['estimate'] - r['_t'] - r['_p'] for r in t['rows'])
                       for t in trips if t['eligible'] and t['estimate'] is not None]
    return {'source_counts': audit, 'segment_audit': audit_segments(segments, trips),
            'estimate_only_reference': {'label': 'Legacy est_arrival_ts comparison, NOT measured accuracy or calibration truth',
                                        'trips':len(estimate_errors),
                                        'p05_trip_worst_error_sec':lower_quantile(estimate_errors,.05),
                                        'p10_trip_worst_error_sec':lower_quantile(estimate_errors,.10)}, 'truth': 'No measured arrivals; conditional disappearance intervals. est_arrival_ts is never ground truth.',
            'split': {'train_dates': sorted({t['day'] for t in train}), 'test_dates': sorted({t['day'] for t in test}),
                      'cutoff': cutoff, 'unit': 'trip; entire dates held out; days may remain correlated'},
            'strata_scope': 'All dates, descriptive only; not used to fit holdout models',
            'strata': strata, 'legacy': replay(test, predictions, {}, False), 'candidates': scenarios,
            'assumptions': {'walk_sec': 300, 'lead_sec': 300, 'additional_margin_sec': 60, 'browser_fetch_sec': 60,
                            'push_deploy_delay_sec': 0, 'publication_delay_measured': False,
                            'first_api_visibility_delay_measured': False},
            'delay_sensitivity': {str(delay): {'legacy': replay(test, predictions, {}, False, delivery_delay_sec=delay),
                                            'safe': replay(test, predictions, fit_model(train), True, delivery_delay_sec=delay)} for delay in (0, 60, 120, 180, 300)}}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--base', default='bus-arrival')
    p.add_argument('--source-ref', default=None, help='Git commit identifying input logs, for reproducibility')
    p.add_argument('--output', default='bus-arrival/reports/safety-backtest.json')
    args = p.parse_args()
    report = analyze(read(Path(args.base)/'predict_log.csv'), read(Path(args.base)/'arrival_log.csv'), read(Path(args.base)/'segment_log.csv'))
    report['source'] = {'git_ref':args.source_ref, 'sha256':{name:hashlib.sha256((Path(args.base)/name).read_bytes()).hexdigest()
                       for name in ('predict_log.csv','arrival_log.csv','segment_log.csv')}}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'audit': report['source_counts'], 'split': report['split'], 'legacy': report['legacy'],
                      'safe': report['candidates']['p05']['metrics']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
