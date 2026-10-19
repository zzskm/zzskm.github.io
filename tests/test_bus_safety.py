import csv
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bus-arrival/scripts'))
import safety_model as M
import backtest_safety as B
import prepare_publish as P
from test_bus_arrival_logic import SCRAPER, bus, simulate, NO_BUS

START = dt.datetime(2026, 10, 19, 18, tzinfo=M.KST)


def row(t, p=300, vid='11', plate='plate', loc='1'):
    return {'ts_kst': (START+dt.timedelta(seconds=t)).isoformat(), 'vehId': vid, 'plateNo': plate,
            'predict_sec': str(p), 'location_no': loc, 'state_cd': ''}


def arrival(start=0, end=60, close=120, **extra):
    return {'vehId': '11', 'plateNo': 'plate', 'first_seen_ts': row(start)['ts_kst'],
            'last_seen_ts': row(end)['ts_kst'], 'ts_kst': row(close)['ts_kst'], 'samples': '2',
            'est_arrival_ts': row(9999)['ts_kst'], 'departure_reason': 'observed_arrival', **extra}


class SafetyDataTests(unittest.TestCase):
    def test_matches_vehicle_and_interval_without_using_estimate_as_truth(self):
        rows = [row(0), row(60), row(120, vid='22'), row(3600), row(3660), row(3720, vid='22')]
        trips, audit = M.match_trips(rows, [arrival(), arrival(3600, 3660, 3720)])
        self.assertEqual([len(t['rows']) for t in trips], [2, 2])
        self.assertEqual(trips[0]['lower'], START.timestamp()+60)
        self.assertEqual(trips[0]['upper'], START.timestamp()+120)
        self.assertEqual(audit['eligible_trips'], 2)
        self.assertEqual(audit['api_signal_trips'], 0)
        self.assertNotEqual(trips[0]['estimate'], trips[0]['upper'])

    def test_rejects_gaps_mismatches_overlapping_and_duplicates(self):
        rows = [row(0), row(60), row(120, vid='22')]
        _, audit = M.match_trips(rows+[row(60)], [arrival(), arrival()])
        self.assertEqual(audit['duplicate_prediction'], 1)
        self.assertEqual(audit['duplicate_trip'], 1)
        self.assertEqual(M.match_trips(rows, [arrival(plateNo='wrong')])[1]['plate_mismatch'], 1)
        overlap, audit = M.match_trips(rows, [arrival(), arrival(0, 60, 121)])
        # same tracking interval is a duplicate, not an independent calibration trip
        self.assertEqual(len(overlap), 1)
        gap, _ = M.match_trips([row(0), row(600)], [arrival(0,600,660)])
        self.assertFalse(gap[0]['eligible'])
        overlapping, _ = M.match_trips(rows, [arrival(), arrival(0,0,120)])
        self.assertFalse(any(t['eligible'] for t in overlapping))

    def test_api_signal_has_separate_interval_and_missing_values_fail_closed(self):
        rows = [row(0), {**row(60), 'state_cd':'1'}, row(120,vid='22')]
        trips, _ = M.match_trips(rows, [arrival()])
        self.assertEqual(trips[0]['quality'], 'api_signal_interval')
        self.assertEqual(trips[0]['lower'], START.timestamp())
        self.assertEqual(trips[0]['upper'], START.timestamp()+60)
        self.assertIsNone(M.timestamp('2026-10-19T12:00:00'))
        self.assertIsNone(M.number('nan'))

    def test_calibration_counts_trips_and_handles_lower_tail_small_sample(self):
        trips, _ = M.match_trips([row(0),row(60),row(120,vid='22')], [arrival()])
        trip = trips[0]
        model = M.fit_model([{**trip,'rows':trip['rows']*100}])
        self.assertEqual(model['bins']['global']['trips'], 1)
        self.assertEqual(model['bins']['global']['offset_sec'], -240)
        self.assertEqual(M.lower_quantile(list(range(20)), .05), 0)
        self.assertIsNone(M.lower_quantile(list(range(19)), .05))
        self.assertEqual(M.lower_quantile(list(range(20)), .10), 1)
        fit = M.fit_model([trip]*20)
        self.assertLessEqual(fit['bins']['global']['offset_sec'], 0)

    def test_stall_anchor_cannot_drift_forward(self):
        r = row(120, 180)
        basic = M.safety_prediction({}, r)
        stalled = M.safety_prediction({}, r, START.timestamp())
        self.assertTrue(stalled['stalled_last_stop'])
        self.assertLessEqual(M.timestamp(stalled['safe_arrival_ts']), M.timestamp(basic['safe_arrival_ts']))
        self.assertLessEqual(M.timestamp(stalled['safe_arrival_ts']), START.timestamp())
        self.assertFalse(M.safety_prediction({}, row(120,180,loc='3'), START.timestamp())['stalled_last_stop'])

    def test_calendar_and_distinct_day_support_limit_historical_alerts(self):
        trips=[]
        for days in (7,14,21,28):
            start=START-dt.timedelta(days=days)
            trips.append({'eligible':True,'day':start.date().isoformat(), 'lower':start.timestamp()})
        cal={'years':[2026], 'dates':{}}
        h=M.historical_slots(trips, cal, '2026-10-19')
        self.assertEqual(len(h['slots']),1)
        self.assertEqual(h['slots'][0]['sample_days'],4)
        self.assertEqual(M.timestamp(h['slots'][0]['earliest_arrival_ts']), START.timestamp()-120)
        for calendar in ({}, {'years':[2026],'dates':{'2026-10-19':'holiday'}}):
            self.assertEqual(M.historical_slots(trips, calendar, '2026-10-19')['slots'], [])
        self.assertEqual(M.historical_slots(trips[:3], cal, '2026-10-19')['slots'], [])
        self.assertEqual(M.historical_slots(trips+trips[:1], cal, '2026-10-19')['slots'], [])

    def test_real_snapshot_split_is_chronological_and_reports_uncertainty(self):
        report=B.analyze(B.read(ROOT/'bus-arrival/predict_log.csv'),B.read(ROOT/'bus-arrival/arrival_log.csv'))
        self.assertLess(max(report['split']['train_dates']), min(report['split']['test_dates']))
        self.assertEqual(report['source_counts']['prediction_rows'], len(B.read(ROOT/'bus-arrival/predict_log.csv')))
        self.assertFalse(report['assumptions']['publication_delay_measured'])
        old, new=report['legacy'], report['candidates']['p05']['metrics']
        self.assertEqual(old['trips'],new['trips'])
        # Candidate calibration never includes a holdout date.
        self.assertLess(report['candidates']['p05']['model']['trained_through'],report['split']['cutoff'])

    def test_publish_timestamp_is_preparation_not_deployment(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'status.json'
            p.write_text(json.dumps({'last_poll':START.isoformat()}))
            P.prepare(p,START+dt.timedelta(seconds=61))
            out=json.loads(p.read_text())
            self.assertEqual(out['poll_to_publish_prepare_sec'],61)
            self.assertEqual(out['publication_stage'],'prepared_not_deployed')

    def test_urgent_publication_keeps_poll_cadence_and_quota(self):
        with tempfile.TemporaryDirectory() as d:
            times=[]
            _, state=simulate(d,[bus(11,800),bus(11,740)],START,poll_times=times)
            self.assertEqual((times[1]-times[0]).total_seconds(),60)
            status=json.loads((Path(d)/'status.json').read_text())
            self.assertTrue(status['urgent_publication'])
            self.assertEqual(status['publish_interval_sec'],60)
            self.assertEqual(status['api_request_duration_sec'],0)
        with tempfile.TemporaryDirectory() as d:
            secondary=[]
            _,state=simulate(d,[bus(11,600)],START, state={'date':'2026-10-19','daily_calls':899},secondary=secondary)
            self.assertEqual(state['daily_calls'],900)
            self.assertEqual(secondary,[])

    def test_collector_persists_stall_and_adds_arrival_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            arrivals,state=simulate(d,[bus(11,180,1),bus(11,183,1)],START)
            status=json.loads((Path(d)/'status.json').read_text())
            self.assertTrue(status['safety']['stalled_last_stop'])
            self.assertEqual(state['near_stall_since'],START.isoformat())
            simulate(d,[NO_BUS],START+dt.timedelta(seconds=120))
            with (Path(d)/'arrival_log.csv').open() as f:
                arrivals=list(csv.DictReader(f))
            self.assertEqual(arrivals[0]['arrival_evidence'],'prediction_and_disappearance')
            self.assertTrue(arrivals[0]['arrival_lower_ts'])
            self.assertTrue(arrivals[0]['arrival_upper_ts'])

    def test_urgent_exit_on_same_vehicle_and_normal_mode_keep_expected_publication_boundary(self):
        initial={'date':'2026-10-19','cur_vid':11,'samples':2,'first_seen':(START-dt.timedelta(seconds=120)).isoformat(),
                 'last_seen':(START-dt.timedelta(seconds=60)).isoformat(),'last_poll':(START-dt.timedelta(seconds=60)).isoformat(),
                 'last_predict':1500,'min_predict':1500,'max_predict':1600,'last_location':4}
        with tempfile.TemporaryDirectory() as d:
            times=[]
            simulate(d,[bus(11,800,3),bus(11,740,3)],START,state=initial,poll_times=times,extra_args=('--exit-on-change',))
            self.assertEqual(len(times),1)  # same ID, so this is specifically the imminent-publication boundary
        with tempfile.TemporaryDirectory() as d:
            times=[]
            simulate(d,[bus(11,1500,4),bus(11,1440,4)],START,state=initial,poll_times=times,extra_args=('--exit-on-change',))
            self.assertEqual(len(times),2)
            self.assertFalse(json.loads((Path(d)/'status.json').read_text())['urgent_publication'])

    def test_session_refuses_stale_checkout_and_retains_commits_on_rebase_conflict(self):
        script=(ROOT/'bus-arrival/scripts/session.sh').read_text().rsplit('main "$@"',1)[0]
        failed_start=subprocess.run(['bash'],input=script+\
            '\ngit() { return 1; }\npython() { echo unexpected-collection; return 99; }\nmain\n',capture_output=True,text=True)
        self.assertNotEqual(failed_start.returncode,0)
        self.assertIn('최신 브랜치 동기화 실패',failed_start.stdout)
        self.assertNotIn('unexpected-collection',failed_start.stdout)
        fake_commands=r'''
python() { return 0; }
sleep() { :; }
git() {
  echo "git $*" >&2
  if [[ $1 == rev-list ]]; then echo 1; return 0; fi
  if [[ $1 == diff ]]; then return 1; fi
  if [[ $1 == rebase ]]; then echo rebase-aborted; return 0; fi
  if [[ $* == *" pull "* ]]; then return 1; fi
  return 0
}
publish
'''
        conflict=subprocess.run(['bash'],input=script+fake_commands,capture_output=True,text=True)
        self.assertNotEqual(conflict.returncode,0)
        self.assertIn('git commit',conflict.stderr)
        self.assertEqual(conflict.stdout.count('rebase-aborted'),3)
        self.assertNotIn('reset',conflict.stderr)
        self.assertNotIn('checkout',conflict.stderr)


if __name__ == '__main__':
    unittest.main()
