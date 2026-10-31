import datetime as dt
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'bus-arrival' / 'scripts' / 'analyze_route_signals_v2.py'
spec = importlib.util.spec_from_file_location('bus_route_study_v2', SCRIPT)
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)
KST = dt.timezone(dt.timedelta(hours=9))


def at(day, minute):
    return dt.datetime(2026, 10, day, 17, 0, tzinfo=KST) + dt.timedelta(minutes=minute)


def signal(t, vehicle=10, route=233000392, sec=300, rank=1):
    return {'ts_kst': t.isoformat(), 'route_id': str(route),
            'route_name': '6011' if route != study.TARGET_ROUTE_ID else '3100',
            'sta_order': '22' if route != study.TARGET_ROUTE_ID else '6',
            'vehicle_rank': str(rank), 'veh_id': str(vehicle), 'predict_sec': str(sec)}


def sample(day, visits=(0,), arrival=15, last=60):
    ticks = [{'ts_kst': at(day, m).isoformat(), 'vehId': ''} for m in range(last + 1)]
    signals = [signal(at(day, v), vehicle=1000 * day + i) for i, v in enumerate(visits)]
    arrivals = [] if arrival is None else [{
        'departure_reason': 'estimated_arrival',
        'est_arrival_ts': at(day, arrival).isoformat(),
        'arrival_lower_ts': at(day, arrival - 1).isoformat(),
        'arrival_upper_ts': at(day, arrival).isoformat(),
    }]
    return signals, ticks, arrivals


class RouteStudyV2Tests(unittest.TestCase):
    def test_positive_negative_and_censored_are_not_confused(self):
        a, b, c = sample(1, visits=(0,), arrival=15)
        x, y, z = sample(2, visits=(0,), arrival=None)
        u, v, w = sample(3, visits=(30,), arrival=50, last=40)
        result = study.summarize(a + x + u, b + y + v, c + z + w)
        route = result['candidate_routes'][0]
        self.assertEqual((route['matched'], route['nonmatched'], route['censored']), (1, 1, 1))
        self.assertEqual(route['observed_days'], 3)
        self.assertFalse(route['eligible_for_alert_use'])
        self.assertFalse(result['prediction_model_changed'])
        self.assertFalse(result['api_calls_changed'])

    def test_duplicate_vehicle_polls_collapse_at_first_sighting(self):
        a, b, c = sample(1)
        a += [signal(at(1, 1), vehicle=1000, sec=120), signal(at(1, 0), vehicle=1000)]
        route = study.summarize(a, b, c)['candidate_routes'][0]
        self.assertEqual(route['vehicle_events'], 1)
        self.assertEqual(route['matched'], 1)

    def test_simultaneous_target_eta_including_over_ten_minutes(self):
        a, b, c = sample(1)
        a.append(signal(at(1, 0), vehicle=999, route=study.TARGET_ROUTE_ID, sec=900))
        r = study.summarize(a, b, c)['candidate_routes'][0]
        self.assertEqual(r['simultaneous_eta_pairs'], 1)
        self.assertEqual(r['candidate_eta_before_target_eta'], 1)
        self.assertEqual(r['median_simultaneous_lead_min'], 10)
        self.assertEqual(r['target_absent_at_first_signal'], 0)

    def test_gaps_are_censored_not_false_negatives(self):
        a, b, _ = sample(1, arrival=None)
        b = [p for p in b if int(p['ts_kst'][14:16]) not in range(9, 18)]
        route = study.summarize(a, b, [])['candidate_routes'][0]
        self.assertEqual(route['nonmatched'], 0)
        self.assertEqual(route['censored'], 1)

    def test_interval_overlapping_boundary_is_ambiguous(self):
        t = at(1, 5)
        self.assertIsNone(study.label_target({'2026-10-01': [(t - dt.timedelta(minutes=1), t)]},
                                             '2026-10-01', t, t + study.HORIZON))

    def test_forward_split_has_prior_only_baseline_and_per_day_controls(self):
        signals, polls, arrivals = [], [], []
        for day in range(1, 13):
            s, p, a = sample(day, visits=(0, 1, 2), arrival=15 if day % 2 else None)
            signals.extend(s)
            polls.extend(p)
            arrivals.extend(a)
        route = study.summarize(signals, polls, arrivals)['candidate_routes'][0]
        test = route['forward_date_test']
        self.assertEqual(test['train_days'], 7)
        self.assertEqual(test['test_days'], 5)
        self.assertEqual(test['test_events'], 15)
        self.assertEqual(test['status'], 'screening_only')
        self.assertIsNotNone(test['time_only_hit_rate'])
        self.assertFalse(route['eligible_for_alert_use'])
        replaced = [a for a in arrivals if not a['est_arrival_ts'].startswith('2026-10-09')]
        other = study.summarize(signals, polls, replaced)['candidate_routes'][0]
        self.assertEqual(other['forward_date_test']['time_only_hit_rate'], test['time_only_hit_rate'])

    def test_rank_two_and_invalid_records_are_excluded(self):
        a, b, c = sample(1)
        a += [signal(at(1, 0), vehicle=444, rank=2),
              signal(at(1, 0), vehicle=555, sec=-1),
              signal(at(1, 0), vehicle=666, sec=601)]
        route = study.summarize(a, b, c)['candidate_routes'][0]
        self.assertEqual(route['vehicle_events'], 1)


if __name__ == '__main__':
    unittest.main()
