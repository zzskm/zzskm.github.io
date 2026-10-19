import copy
import json
from pathlib import Path
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
T=1792400400000


def case(**changes):
    value={'id':'reservation','startMs':T,'endMs':T+300000,'events':[{'atMs':T,'status':{
        'last_poll':'2026-10-19T18:00:00+09:00','current_veh_id':11,'predict_sec':1200,
        'safety':{'observation_ts':'2026-10-19T18:00:00+09:00',
                  'safe_arrival_ts':'2026-10-19T18:09:09+09:00',
                  'method':'trip_lower_quantile','sample_trips':89}}}],
        'cfg':{'enabled':True,'leads':[5],'windows':[],'armedAtMs':T-1},
        'walkMinutes':5,'marginSec':60,'safetyMode':True}
    value.update(changes)
    return value


class ProductionReplayTests(unittest.TestCase):
    def replay(self, *cases):
        result=subprocess.run(['node',str(ROOT/'bus-arrival/scripts/replay_alarm.mjs')],
                              input=json.dumps({'cases':cases}),capture_output=True,text=True,check=True)
        return json.loads(result.stdout)

    def test_actual_engine_reservation_survives_expiry_and_reload(self):
        result=self.replay(case(reloads=[T+189000]))[0]
        fires=[e for e in result['actions'] if e['action']['type']=='fire']
        self.assertEqual(len(fires),1)
        self.assertEqual(fires[0]['atMs'],T+189000)
        self.assertTrue(fires[0]['action']['uncertain'])

    def test_hidden_tab_catches_up_once_and_fresh_no_bus_cancels(self):
        hidden=case(id='hidden',pauses=[[T+180000,T+250000]])
        gone=case(id='gone')
        gone['events'].append({'atMs':T+180000,'status':{'last_poll':'2026-10-19T18:03:00+09:00','error':'no_bus'}})
        results=self.replay(hidden,gone)
        fires=[e for e in results[0]['actions'] if e['action']['type']=='fire']
        self.assertEqual(len(fires),1)
        self.assertEqual(fires[0]['atMs'],T+250000)
        self.assertEqual([e for e in results[1]['actions'] if e['action']['type']=='fire'],[])

    def test_stale_data_first_seen_does_not_create_warning(self):
        value=case(startMs=T+240000)
        self.assertEqual(self.replay(value)[0]['actions'],[])


if __name__=='__main__': unittest.main()
