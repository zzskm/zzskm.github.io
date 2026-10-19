#!/usr/bin/env python3
"""Date-blocked comparisons that execute alarm.js via Node. No API or raw-log edits."""
import argparse
import copy
import datetime as dt
import hashlib
import json
import subprocess
from pathlib import Path
from statistics import mean
from backtest_safety import read, pct
from safety_model import KST, timestamp, match_trips, fit_model, safety_prediction, publication_decision, model_for_day

SCRIPTS = Path(__file__).resolve().parent


def events_for(rows, trips, model, policy, delay):
    changes = {t[k] for t in trips for k in ('start', 'closed')}
    events, last_publish = [], float('-inf')
    since, anchor_p, previous_vid = None, None, None
    for row in sorted(rows, key=lambda r: timestamp(r.get('ts_kst')) or 0):
        t = timestamp(row.get('ts_kst'))
        if t is None:
            continue
        vid = row.get('vehId') or None
        try:
            p, loc = float(row.get('predict_sec', '')), float(row.get('location_no', ''))
        except (TypeError, ValueError):
            p, loc = None, None
        near = p is not None and loc is not None and loc <= 1 and 150 <= p <= 200
        if vid != previous_vid or not near:
            since, anchor_p = None, None
        if near and (since is None or abs(p-anchor_p)>15):
            since, anchor_p = t, p
        previous_vid = vid
        day_model = model_for_day(model, dt.datetime.fromtimestamp(t,KST).date().isoformat())
        prediction = safety_prediction(day_model,row,since) if vid else None
        decision = publication_decision(p,loc,prediction,row['ts_kst'])
        if policy == 'legacy_api':
            cadence = 300
        elif policy == 'previous_safe':
            cadence = 60 if (p is not None and p<=900) or (loc is not None and loc<=2) else 300
        else:
            cadence = decision['publish_interval_sec']
        if t not in changes and t-last_publish<cadence:
            continue
        last_publish = t
        status = {'last_poll':row['ts_kst'],'current_veh_id':int(vid) if vid else None,'predict_sec':p,
                  'location_no':loc,'safety':prediction}
        if not vid:
            status['error']='no_bus'
        events.append({'atMs':round((t+delay)*1000),'status':status})
    return events


def metrics(trips, events, actions, model, walk_sec=300, margin_sec=60):
    records=[]
    for t in trips:
        fires=[a for a in actions if a['action']['type']=='fire' and str(a['action']['vehId'])==t['vehId']
               and a.get('pollMs') is not None and t['start']<=a['pollMs']/1000<=t['end']]
        fire=min((a['atMs']/1000 for a in fires),default=None)
        station=fire+walk_sec if fire is not None else None
        low=max(0,t['lower']-station) if station is not None else None
        high=max(0,t['upper']-station) if station is not None else None
        known=[e['atMs']/1000 for e in events if str(e['status'].get('current_veh_id'))==t['vehId']
               and t['start']<=timestamp(e['status']['last_poll'])<=t['end']]
        records.append({'id':t['id'],'day':t['day'],'possible_miss':station is None or station>t['lower'],
                        'certain_miss':station is None or station>t['upper'],'omitted':fire is None,
                        'wait_lower':low,'wait_upper':high,'recognition_lead':t['lower']-t['start'],
                        'delivery_delay':min(known)-t['start'] if known else None,
                        'uncertain_alert':any(a['action'].get('uncertain') for a in fires)})
    def coverage(t):
        safe=[];since=anchor=None
        for r in t['rows']:
            try: near=float(r.get('location_no',''))<=1 and 150<=r['_p']<=200
            except (ValueError,TypeError): near=False
            if not near: since=anchor=None
            elif since is None or abs(r['_p']-anchor)>15: since,anchor=r['_t'],r['_p']
            value=safety_prediction(model,r,since) if model else None
            safe.append((timestamp(value['safe_arrival_ts']) if value else r['_t']+r['_p'])<=t['lower'])
        return all(safe)
    waits=[r for r in records if r['wait_lower'] is not None]
    return {'trips':len(records),'possible_miss_rate':pct(sum(r['possible_miss'] for r in records),len(records)),
            'certain_miss_rate':pct(sum(r['certain_miss'] for r in records),len(records)),
            'notification_omission_rate':pct(sum(r['omitted'] for r in records),len(records)),
            'trip_early_coverage':pct(sum(coverage(t) for t in trips),len(trips)),
            'wait_lower_mean_sec':round(mean(r['wait_lower'] for r in waits),1) if waits else None,
            'wait_upper_mean_sec':round(mean(r['wait_upper'] for r in waits),1) if waits else None,
            'wait_denominator':len(waits),'uncertain_alert_trips':sum(r['uncertain_alert'] for r in records),
            'first_recognition_lead_min_sec':min((r['recognition_lead'] for r in records),default=None),
            'first_recognition_lead_mean_sec':round(mean(r['recognition_lead'] for r in records),1) if records else None,
            'first_delivery_delay_mean_sec':mean(r['delivery_delay'] for r in records if r['delivery_delay'] is not None) if any(r['delivery_delay'] is not None for r in records) else None,
            'daily_possible_miss_rates':{day:pct(sum(r['possible_miss'] for r in records if r['day']==day),sum(r['day']==day for r in records)) for day in sorted({r['day'] for r in records})}}


def run_report(predictions,arrivals,reference_engine=None):
    trips,audit=match_trips(predictions,arrivals)
    days=sorted({t['day'] for t in trips})
    if len(days)<5:
        raise ValueError('At least five dates are needed for blocked replay')
    cutoff=days[int(len(days)*.7)]
    splits=[('holdout',cutoff,[d for d in days if d>=cutoff])]
    splits += [('rolling:'+day,day,[day]) for day in days[4:]]
    cases=[]; specifications=[]
    for name,cut,test_days in splits:
        train=[t for t in trips if t['day']<cut]
        eligible=[t for t in trips if t['day'] in test_days and t['eligible']]
        for policy in (['legacy_api','previous_safe'] if reference_engine else ['legacy_api'])+['safe_p05','safe_p10','research_bucket_only']:
            model=fit_model(train,.10 if policy=='safe_p10' else .05)
            if policy=='research_bucket_only': model['use_global_floor']=False
            for delay in ([0,60,120,180,300] if name=='holdout' else [60]):
                if policy=='research_bucket_only' and delay!=60: continue
                events=events_for(predictions,trips,model,policy,delay)
                ids=[]
                for day in test_days:
                    day_trips=[t for t in eligible if t['day']==day]
                    if not day_trips: continue
                    start=dt.datetime.combine(dt.date.fromisoformat(day),dt.time(16),KST).timestamp()
                    end=start+6*3600+delay
                    day_events=[e for e in events if start*1000<=e['atMs']<=end*1000]
                    case_id=f'{name}:{policy}:{delay}:{day}'
                    cases.append({'id':case_id,'startMs':round(start*1000),'endMs':round(end*1000),'events':day_events,
                                  'cfg':{'enabled':True,'leads':[5],'windows':[],'armedAtMs':round(start*1000)-1},
                                  'walkMinutes':5,'marginSec':60,'safetyMode':policy!='legacy_api','reference':policy=='previous_safe'})
                    ids.append(case_id)
                specifications.append((name,policy,delay,model,eligible,events,ids))
    result=subprocess.run(['node',str(SCRIPTS/'replay_alarm.mjs')],input=json.dumps({'cases':cases,'referenceEngine':str(Path(reference_engine).resolve()) if reference_engine else None}),
                          text=True,capture_output=True,check=True)
    replays={r['id']:r['actions'] for r in json.loads(result.stdout)}
    report={'engine':'production alarm.js; 1-second ticks; persistent ledger and reservations',
            'audit':audit,'split':{'cutoff':cutoff,'train_dates':[d for d in days if d<cutoff],'test_dates':[d for d in days if d>=cutoff]},
            'truth':'Conditional disappearance intervals; no measured actual arrivals',
            'assumptions':{'walk_sec':300,'lead_sec':300,'margin_sec':60,'delivery_delay_default_sec':60,
                           'publication_history_measured':False,'first_visibility_delay_measured':False,
                           'holidays_prealerts_replayed':False,'validation_unit':'trip and entire held-out dates'},
            'holdout':{},'rolling':{}}
    for name,policy,delay,model,eligible,events,ids in specifications:
        m=metrics(eligible,events,[a for key in ids for a in replays[key]],model if policy!='legacy_api' else None)
        if name=='holdout': report['holdout'].setdefault(policy,{})[str(delay)]=m
        else: report['rolling'].setdefault(name.split(':',1)[1],{})[policy]=m
    report['research_policy']='bucket-only margins are evaluated for waiting-time reduction; production retains the global floor'
    report['engine_sha256']=hashlib.sha256((SCRIPTS.parent/'alarm.js').read_bytes()).hexdigest()
    if reference_engine: report['reference_engine_sha256']=hashlib.sha256(Path(reference_engine).read_bytes()).hexdigest()
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--base',default='bus-arrival')
    p.add_argument('--reference-engine')
    p.add_argument('--source-ref')
    p.add_argument('--output',default='bus-arrival/reports/engine-backtest.json')
    args=p.parse_args();base=Path(args.base)
    report=run_report(read(base/'predict_log.csv'),read(base/'arrival_log.csv'),args.reference_engine)
    report['source']={'git_ref':args.source_ref,'sha256':{name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in ('predict_log.csv','arrival_log.csv')}}
    Path(args.output).parent.mkdir(parents=True,exist_ok=True)
    Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({policy:values['60'] for policy,values in report['holdout'].items()},indent=2))


if __name__=='__main__': main()
