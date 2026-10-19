#!/usr/bin/env python3
"""Auditable, trip-weighted lower-tail calibration. All timestamps remain estimates.

The interval [last visible, first successful absence] is conditional on disappearance
meaning passage. It is NOT GPS ground truth. Never train on est_arrival_ts.
"""
import datetime as dt
import math
from collections import Counter, defaultdict

KST = dt.timezone(dt.timedelta(hours=9))
VERSION = 1
FALLBACK_SEC = 240
MIN_TRIPS = 20
MAX_GAP_SEC = 180


def timestamp(value):
    try:
        t = dt.datetime.fromisoformat(value)
        return t.timestamp() if t.tzinfo else None
    except (ValueError, TypeError):
        return None


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def local_day(ts):
    return dt.datetime.fromtimestamp(ts, KST).date().isoformat()


def bucket(row):
    p, loc = number(row.get('predict_sec')), number(row.get('location_no'))
    lead = 'near' if p is not None and p <= 300 else 'mid' if p is not None and p <= 600 else 'far'
    distance = 'last' if loc is not None and loc <= 1 else 'other'
    return lead + ':' + distance


def match_trips(predictions, arrivals):
    """Exact vehicle + closed tracking interval + plate; reject ambiguous assignments."""
    audit = Counter({k: 0 for k in ('invalid_timestamp','duplicate_prediction','duplicate_trip',
                                    'invalid_trip_interval','unmatched_trip','plate_mismatch',
                                    'invalid_trip_predictions','excluded_gap_or_reason',
                                    'sample_count_mismatch','missing_endpoints','quick_reappearance','overlapping_trip')})
    audit.update(prediction_rows=len(predictions), arrival_rows=len(arrivals))
    rows, seen = [], set()
    for r in predictions:
        t, p = timestamp(r.get('ts_kst')), number(r.get('predict_sec'))
        if t is None:
            audit['invalid_timestamp'] += 1
            continue
        key = (t, r.get('vehId', ''))
        if key in seen:
            audit['duplicate_prediction'] += 1
            continue
        seen.add(key)
        rows.append({**r, '_t': t, '_p': p})
    rows.sort(key=lambda r: r['_t'])
    candidates, trip_keys = [], set()
    for a in arrivals:
        start, end, closed = (timestamp(a.get(k)) for k in ('first_seen_ts', 'last_seen_ts', 'ts_kst'))
        key = (a.get('vehId'), start, end)
        if key in trip_keys:
            audit['duplicate_trip'] += 1
            continue
        trip_keys.add(key)
        if None in (start, end, closed) or not start <= end <= closed:
            audit['invalid_trip_interval'] += 1
            continue
        obs = [r for r in rows if r.get('vehId') == a.get('vehId') and start <= r['_t'] <= end]
        if not obs:
            audit['unmatched_trip'] += 1
            continue
        if any(a.get('plateNo') and r.get('plateNo') and a['plateNo'] != r['plateNo'] for r in obs):
            audit['plate_mismatch'] += 1
            continue
        valid = [r for r in obs if r['_p'] is not None and r['_p'] > 0]
        if not valid:
            audit['invalid_trip_predictions'] += 1
            continue
        following = next((r for r in rows if r['_t'] > end), None)
        # A confirmed no-bus/other vehicle response is stronger than a delayed close timestamp.
        upper = following['_t'] if following and following.get('vehId') != a.get('vehId') else closed
        lower = end
        signal = obs[-1].get('state_cd') == '1'
        if signal:
            lower, upper = end - 60, end
        gaps = [b['_t'] - a['_t'] for a, b in zip(obs, obs[1:])]
        max_gap = max(gaps + [upper - end])
        quality = 'api_signal_interval' if signal else 'disappearance_interval'
        eligible = a.get('departure_reason') in ('observed_arrival', 'estimated_arrival') and 0 <= upper - lower <= MAX_GAP_SEC and max_gap <= MAX_GAP_SEC
        if not eligible:
            audit['excluded_gap_or_reason'] += 1
        if number(a.get('samples')) != len(obs):
            audit['sample_count_mismatch'] += 1
        if obs[0]['_t'] != start or obs[-1]['_t'] != end:
            eligible = False
            audit['missing_endpoints'] += 1
        # A short reappearance of the same ID can be API dropout, not a new trip.
        if any(r.get('vehId') == a.get('vehId') and upper < r['_t'] <= upper + 180 for r in rows):
            eligible = False
            audit['quick_reappearance'] += 1
        candidates.append({'id': f"{a['vehId']}@{start}", 'vehId': a['vehId'], 'day': local_day(start),
                           'start': start, 'end': end, 'closed': closed, 'lower': lower, 'upper': upper,
                           'estimate': timestamp(a.get('est_arrival_ts')), 'reason': a.get('departure_reason'),
                           'quality': quality, 'eligible': eligible, 'rows': valid,
                           'max_gap_sec': max_gap})
    ownership = Counter((r['_t'], r.get('vehId')) for t in candidates for r in t['rows'])
    for t in candidates:
        if any(ownership[(r['_t'], r.get('vehId'))] > 1 for r in t['rows']):
            t['eligible'] = False
            audit['overlapping_trip'] += 1
    audit['short_track_trips'] = sum(len(t['rows']) < 2 for t in candidates)
    audit['reasons'] = dict(Counter(t['reason'] for t in candidates))
    audit['matched_trips'] = len(candidates)
    audit['eligible_trips'] = sum(t['eligible'] for t in candidates)
    audit['api_signal_trips'] = sum(t['quality'] == 'api_signal_interval' for t in candidates)
    audit['no_bus_rows'] = sum(r.get('vehId', '') in ('', '0') for r in rows)
    audit['unmatched_vehicle_rows'] = sum(r.get('vehId', '') not in ('', '0') and not ownership[(r['_t'], r.get('vehId'))] for r in rows)
    return candidates, dict(audit)


def lower_quantile(values, alpha):
    """Finite-sample lower order statistic. Each value is one trip's WORST error."""
    rank = math.floor((len(values) + 1) * alpha)
    return sorted(values)[rank - 1] if rank >= 1 and len(values) >= MIN_TRIPS else None


def fit_model(trips, alpha=.05):
    groups, means = defaultdict(list), defaultdict(list)
    seen_trips = set()
    for t in trips:
        if t['id'] in seen_trips:
            continue
        seen_trips.add(t['id'])
        if not t['eligible']:
            continue
        errors = defaultdict(list)
        for r in t['rows']:
            residual = t['lower'] - (r['_t'] + r['_p'])
            errors['global'].append(residual)
            errors[bucket(r)].append(residual)
        for key, vals in errors.items():
            groups[key].append(min(vals))
            means[key].append(sum(vals) / len(vals) + (t['upper'] - t['lower']) / 2)
    bins = {}
    for key, vals in groups.items():
        q = lower_quantile(vals, alpha)
        bins[key] = {'trips': len(vals), 'offset_sec': math.floor(min(0, q)) if q is not None else -FALLBACK_SEC,
                     'mean_offset_sec': round(sum(means[key]) / len(means[key])),
                     'method': 'trip_lower_quantile' if q is not None else 'fixed_margin'}
    return {'version': VERSION, 'alpha': alpha, 'min_trips': MIN_TRIPS, 'fallback_sec': FALLBACK_SEC,
            'trained_through': max((t['day'] for t in trips), default=None), 'bins': bins,
            'arrival_truth': 'conditional_interval_not_measured'}


def calibration(model, row):
    bins = model.get('bins', {})
    b = bins.get(bucket(row), {})
    if b.get('method') != 'trip_lower_quantile':
        b = bins.get('global', {})
    b = b or {'offset_sec': -FALLBACK_SEC, 'mean_offset_sec': 0, 'method': 'fixed_margin', 'trips': 0}
    # One trip contributes multiple horizon bins. A global trip-worst floor avoids
    # claiming that several marginal tail estimates jointly give 95% coverage.
    global_bin = bins.get('global', {})
    if global_bin.get('method') == 'trip_lower_quantile':
        b = {**b, 'offset_sec': min(b['offset_sec'], global_bin['offset_sec'])}
    return b


def safety_prediction(model, row, near_anchor=None):
    t, p = timestamp(row.get('ts_kst')), number(row.get('predict_sec'))
    if t is None or p is None or p < 0:
        return None
    c = calibration(model, row)
    api = t + p
    safe = api + c['offset_sec']
    stalled = near_anchor is not None and t - near_anchor >= 60 and 150 <= p <= 200 and number(row.get('location_no')) is not None and number(row.get('location_no')) <= 1
    if stalled:
        safe = min(safe, near_anchor)
    return {'api_arrival_ts': dt.datetime.fromtimestamp(api, KST).isoformat(),
            'corrected_arrival_ts': dt.datetime.fromtimestamp(api + c['mean_offset_sec'], KST).isoformat(),
            'safe_arrival_ts': dt.datetime.fromtimestamp(safe, KST).isoformat(),
            'offset_sec': round(safe - api), 'method': c['method'], 'sample_trips': c['trips'],
            'alpha': model.get('alpha', .05), 'stalled_last_stop': stalled,
            'confidence': 'conditional_estimate', 'observation_ts': row.get('ts_kst')}


def historical_slots(trips, holidays, today):
    """Same weekday, one run/day/30-minute slot, >=4 dates; fail closed on calendar."""
    date = dt.date.fromisoformat(today)
    result = {'date': today, 'slots': [], 'source': 'historical_not_realtime'}
    if date.isoweekday() > 5 or date.year not in holidays.get('years', []) or today in holidays.get('dates', {}):
        return result
    groups = defaultdict(list)
    for t in trips:
        day = dt.date.fromisoformat(t['day'])
        if not t['eligible'] or not 0 < (date-day).days <= 42 or day.weekday() != date.weekday() or t['day'] in holidays.get('dates', {}):
            continue
        clock = dt.datetime.fromtimestamp(t['lower'], KST)
        seconds = clock.hour * 3600 + clock.minute * 60 + clock.second
        groups[seconds // 1800].append((t['day'], seconds))
    for key, vals in sorted(groups.items()):
        dates = {d for d, _ in vals}
        times = [s for _, s in vals]
        # Multiple runs in one slot are ambiguous: do not guess vehicle identity.
        if len(dates) < 4 or len(dates) != len(vals) or max(times)-min(times) > 900:
            continue
        midnight = dt.datetime.combine(date, dt.time(), KST).timestamp()
        result['slots'].append({'id': f'{today}:{key}', 'earliest_arrival_ts': dt.datetime.fromtimestamp(midnight + min(times) - 120, KST).isoformat(),
                                'latest_arrival_ts': dt.datetime.fromtimestamp(midnight + max(times), KST).isoformat(),
                                'sample_days': len(dates), 'margin_sec': 120})
    return result
