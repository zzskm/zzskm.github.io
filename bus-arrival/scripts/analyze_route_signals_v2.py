#!/usr/bin/env python3
"""Offline candidate-route study. Never changes 3100 predictions or alert timing.

Labels are derived from the 3100 API/disappearance logs, NOT measured arrivals.
Events without complete observation coverage are censored, never negatives.
"""
import argparse
import bisect
import csv
import datetime as dt
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import median

KST = dt.timezone(dt.timedelta(hours=9))
TARGET_ROUTE_ID = 204000170
HORIZON = dt.timedelta(minutes=20)
MAX_GAP = dt.timedelta(seconds=180)
MIN_DAYS = 10
MIN_TRAIN_DAYS = 5
MIN_TEST_DAYS = 3
MIN_TEST_EVENTS = 10


def read_rows(path):
    with Path(path).open(newline='', encoding='utf-8') as stream:
        return list(csv.DictReader(stream))


def instant(value):
    try:
        t = dt.datetime.fromisoformat(value)
        return t.astimezone(KST) if t.utcoffset() is not None else None
    except (ValueError, TypeError, OverflowError):
        return None


def integer(value):
    try:
        result = int(value)
        return result if result >= 0 else None
    except (ValueError, TypeError):
        return None


def day_key(t):
    return t.date().isoformat()


def slot(t):
    return t.hour * 2 + t.minute // 30


def build_polls(rows):
    days = defaultdict(set)
    for row in rows:
        t = instant(row.get('ts_kst'))
        if t is not None:
            days[day_key(t)].add(t)
    return {day: sorted(times) for day, times in days.items()}


def covered(times, start, end):
    """Need a continuous poll trace from the event until its entire outcome horizon."""
    if not times or end <= start:
        return False
    first = bisect.bisect_left(times, start)
    if first >= len(times) or times[first] - start > MAX_GAP:
        return False
    prev = start
    # A sample strictly before the horizon cannot prove that no bus arrived later.
    while first < len(times):
        if times[first] - prev > MAX_GAP:
            return False
        prev = times[first]
        if prev >= end:
            return True
        first += 1
    return False


def build_targets(rows):
    targets = defaultdict(list)
    for row in rows:
        reason = row.get('departure_reason')
        if reason not in ('observed_arrival', 'estimated_arrival', 'vanished', 'stale', 'data_gap', 'vehicle_changed'):
            continue
        est = instant(row.get('est_arrival_ts'))
        if est is None:
            continue
        lower = instant(row.get('arrival_lower_ts'))
        upper = instant(row.get('arrival_upper_ts'))
        if lower is None or upper is None or lower > upper or upper - lower > MAX_GAP:
            lower = upper = est
        trusted = reason in ('observed_arrival', 'estimated_arrival')
        targets[day_key(est)].append((lower, upper, trusted))
    for values in targets.values():
        values.sort()
    return targets


def label_target(targets, day, start, end):
    """Conservative interval label. Boundary overlaps are ambiguous/censored."""
    positive = False
    ambiguous = False
    for item in targets.get(day, ()):
        low, high = item[:2]
        trusted = item[2] if len(item) > 2 else True
        if trusted and low >= start and high <= end:
            positive = True
        elif high >= start and low <= end:
            ambiguous = True
    if positive:
        return True
    return None if ambiguous else False


def events_from_signals(rows):
    """One immutable first eligible sighting per vehicle/day/direction, rank 1 only."""
    first = {}
    target_at_poll = {}
    seen_polls = set()
    discarded = 0
    for row in rows:
        t = instant(row.get('ts_kst'))
        route = integer(row.get('route_id'))
        order = integer(row.get('sta_order'))
        vehicle = integer(row.get('veh_id'))
        eta_sec = integer(row.get('predict_sec'))
        rank = integer(row.get('vehicle_rank'))
        if None in (t, route, order, vehicle, eta_sec) or rank != 1 or eta_sec <= 0:
            discarded += 1
            continue
        seen_polls.add(t)
        if route == TARGET_ROUTE_ID:
            target_at_poll[t] = min(target_at_poll.get(t, math.inf), eta_sec)
            continue
        if eta_sec > 600:
            discarded += 1
            continue
        key = (day_key(t), route, order, vehicle)
        if key not in first or t < first[key]['at']:
            first[key] = {'at': t, 'eta': t + dt.timedelta(seconds=eta_sec),
                          'route_id': route, 'route_name': row.get('route_name') or str(route),
                          'sta_order': order, 'veh_id': vehicle}
    return first.values(), target_at_poll, seen_polls, discarded


def make_event(event, targets, polls, target_at_poll):
    t, eta = event['at'], event['eta']
    day = day_key(t)
    end = eta + HORIZON
    # Never borrow the next day's unrelated collector session to label an event.
    valid = day_key(end) == day and covered(polls.get(day, []), t, end)
    outcome = label_target(targets, day, eta, end) if valid else None
    other_eta = target_at_poll.get(t)
    delta = (other_eta - (eta - t).total_seconds()) / 60 if other_eta is not None else None
    return {**event, 'day': day, 'slot': slot(eta), 'covered': valid,
            'hit': outcome, 'target_eta_gap_min': delta,
            'target_visible_same_poll': other_eta is not None}


def slot_baselines(polls, targets, train_days):
    """Time-of-day control: average *per-day* 30-min slot rates, not per-poll rates."""
    per_slot = defaultdict(list)
    for day in train_days:
        sums = defaultdict(list)
        times = polls.get(day, [])
        for t in times:
            end = t + HORIZON
            if day_key(end) != day or not covered(times, t, end):
                continue
            hit = label_target(targets, day, t, end)
            if hit is not None:
                sums[slot(t)].append(int(hit))
        for k, values in sums.items():
            per_slot[k].append(sum(values) / len(values))
    return {k: sum(values) / len(values) for k, values in per_slot.items()
            if len(values) >= MIN_TRAIN_DAYS}


def summarize(signals, predictions, arrivals):
    polls = build_polls(predictions)
    targets = build_targets(arrivals)
    first, target_at_poll, signal_polls, discarded = events_from_signals(signals)
    groups = defaultdict(list)
    for event in first:
        item = make_event(event, targets, polls, target_at_poll)
        groups[(item['route_id'], item['sta_order'])].append(item)
    candidates = []
    for (route_id, order), items in groups.items():
        items.sort(key=lambda x: x['at'])
        dates = sorted({e['day'] for e in items})
        valid = [e for e in items if e['hit'] is not None]
        matched = [e for e in valid if e['hit']]
        simultaneous = [e['target_eta_gap_min'] for e in items
                        if e['target_eta_gap_min'] is not None]
        result = {'status': 'insufficient_days', 'test_events': 0,
                  'candidate_hit_rate': None, 'time_only_hit_rate': None,
                  'difference_pp': None}
        if len(dates) >= MIN_DAYS:
            split = max(MIN_TRAIN_DAYS, math.floor(len(dates) * 0.6))
            train_days, test_days = dates[:split], dates[split:]
            if len(test_days) >= MIN_TEST_DAYS:
                base = slot_baselines(polls, targets, train_days)
                assessed = [(e, base[e['slot']]) for e in valid
                            if e['day'] in test_days and e['slot'] in base]
                result['test_events'] = len(assessed)
                result['train_days'] = len(train_days)
                result['test_days'] = len(test_days)
                if len(assessed) >= MIN_TEST_EVENTS:
                    actual = sum(int(e['hit']) for e, _ in assessed) / len(assessed)
                    expected = sum(rate for _, rate in assessed) / len(assessed)
                    result.update(status='screening_only', candidate_hit_rate=round(actual, 3),
                                  time_only_hit_rate=round(expected, 3),
                                  difference_pp=round((actual - expected) * 100, 1))
                else:
                    result['status'] = 'insufficient_labelled_test_events'
            else:
                result['status'] = 'insufficient_test_days'
        candidates.append({
            'route_id': route_id, 'route_name': items[0]['route_name'], 'sta_order': order,
            'observed_days': len(dates), 'vehicle_events': len(items),
            'labelled_events': len(valid), 'matched': len(matched),
            'nonmatched': len(valid) - len(matched),
            'censored': len(items) - len(valid),
            'proxy_hit_rate': round(len(matched) / len(valid), 3) if valid else None,
            'target_absent_at_first_signal': sum(not e['target_visible_same_poll'] for e in items),
            'simultaneous_eta_pairs': len(simultaneous),
            'candidate_eta_before_target_eta': sum(gap > 0 for gap in simultaneous),
            'median_simultaneous_lead_min': round(median(simultaneous), 2) if simultaneous else None,
            'forward_date_test': result,
            'eligible_for_alert_use': False,
        })
    candidates.sort(key=lambda x: (-x['labelled_events'], -x['observed_days'], x['route_id']))
    return {
        'schema_version': 2, 'purpose': 'offline_related_route_screening',
        'target_route_id': TARGET_ROUTE_ID, 'prediction_model_changed': False,
        'api_calls_changed': False, 'eligible_for_alert_use': False,
        'arrival_truth': 'target_api_derived_proxy_not_measured_arrival',
        'poll_coverage_max_gap_sec': int(MAX_GAP.total_seconds()),
        'window_minutes': int(HORIZON.total_seconds() / 60),
        'observed_station_list_polls': len(signal_polls),
        'prediction_poll_days': len(polls), 'discarded_signal_rows': discarded,
        'candidate_routes': candidates,
        'warning': 'ETA and 3100 disappearance are not real arrival ground truth. '
                   'Same-day events correlate; date holdout is screening, not safety validation. '
                   'Never use this study to delay or suppress existing alerts.',
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--signals', default='bus-arrival/route_signal_log.csv')
    parser.add_argument('--predictions', default='bus-arrival/predict_log.csv')
    parser.add_argument('--arrivals', default='bus-arrival/arrival_log.csv')
    parser.add_argument('--output', default='bus-arrival/reports/route-study-v2.json')
    args = parser.parse_args()
    report = summarize(read_rows(args.signals), read_rows(args.predictions), read_rows(args.arrivals))
    report['generated_at'] = dt.datetime.now(KST).isoformat()
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.json.tmp')
    temp.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


if __name__ == '__main__':
    main()
