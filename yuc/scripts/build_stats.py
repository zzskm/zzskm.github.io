#!/usr/bin/env python3
import argparse,csv,datetime as dt,json,os
from collections import defaultdict
LOW=2; SAFE=5; KST=dt.timezone(dt.timedelta(hours=9)); MS=420; ME=660

def pa():
 p=argparse.ArgumentParser(); p.add_argument('--input-csv',default='yuc/parking_log.csv'); p.add_argument('--output-json',default='yuc/daily_stats.json'); p.add_argument('--exclude-dates',default='yuc/excluded_dates.txt'); p.add_argument('--target-name',default=os.getenv('YUC_TARGET_NAME','YUC parking lot')); p.add_argument('--min-morning-samples',type=int,default=4); return p.parse_args()
def tm(s):
 x=dt.datetime.fromisoformat(s.strip().replace('Z','+00:00')); return (x if x.tzinfo else x.replace(tzinfo=KST)).astimezone(KST)
def iso(x): return x.astimezone(KST).replace(microsecond=0).isoformat() if x else None
def mi(x): x=x.astimezone(KST); return x.hour*60+x.minute
def ex(path):
 r=set()
 if os.path.exists(path):
  for raw in open(path,encoding='utf-8'):
   s=raw.split('#',1)[0].strip()
   if s: dt.date.fromisoformat(s); r.add(s)
 return r
def rows(path,target):
 if not os.path.exists(path): return []
 rs=[r for r in csv.reader(open(path,encoding='utf-8',newline='')) if len(r)>=3]
 if not rs: return []
 f=[c.strip() for c in rs[0]]; h={'timestamp_kst','lot_name','available'}.issubset(set(f))
 data=rs[1:] if h else rs; ti=f.index('timestamp_kst') if h else 0; ni=f.index('lot_name') if h else 1; ai=f.index('available') if h else 2
 out=[]
 for r in data:
  try:
   if r[ni].strip()==target: out.append({'t':tm(r[ti]),'v':int(float(r[ai]))})
  except Exception: pass
 return sorted(out,key=lambda x:x['t'])
def conf(p,c):
 if not p: return 'unknown'
 g=(c['t']-p['t']).total_seconds()/60
 return 'high' if g<=6 else 'medium' if g<=12 else 'low' if g<=25 else 'unknown'
def first_low(ss):
 p=None
 for c in ss:
  if c['v']<=LOW: return {'observed_at':iso(c['t']),'interval_start':iso(p['t'] if p else c['t']),'interval_end':iso(c['t']),'previous_available':p['v'] if p else None,'available':c['v'],'confidence':conf(p,c)}
  p=c
 return None
def eff(ss):
 for i,c in enumerate(ss):
  if c['v']>LOW: continue
  lim=c['t']+dt.timedelta(minutes=20); later=[x for x in ss[i+1:] if x['t']<=lim]
  if not any(x['v']>=SAFE for x in later): return {'observed_at':iso(c['t']),'available':c['v'],'reason':'stable_low'}
 return None
def q(v,qq):
 if not v: return None
 v=sorted(v); n=len(v)
 if n==1: return v[0]
 p=(n-1)*qq; lo=int(p); hi=min(lo+1,n-1); f=p-lo
 return int(round(v[lo]*(1-f)+v[hi]*f))
def build(ss,target,exc,mincnt):
 by=defaultdict(list)
 for s in ss: by[s['t'].date().isoformat()].append(s)
 days=[]; mins=[]
 for dk in sorted(by,reverse=True):
  d=dt.date.fromisoformat(dk); wd=d.weekday(); ms=[s for s in sorted(by[dk],key=lambda x:x['t']) if MS<=mi(s['t'])<ME]; ev=first_low(ms); why=[]
  if wd>=5: why.append('weekend')
  if dk in exc: why.append('manual_exclude')
  if len(ms)<mincnt: why.append('insufficient_morning_samples')
  if not ev: why.append('no_low_threshold_observed')
  elif ev['confidence']=='unknown': why.append('unknown_low_threshold_confidence')
  inc=not why
  if inc: mins.append(mi(tm(ev['observed_at'])))
  days.append({'date':dk,'weekday':wd,'sample_count':len(ms),'first_le_2':ev,'effective_full':eff(ms),'min_available_morning':min((s['v'] for s in ms),default=None),'included_in_summary':inc,'exclude_reasons':why})
 return {'schema_version':1,'target':target,'source_latest_at':iso(max((s['t'] for s in ss),default=None)),'thresholds':{'low':LOW,'safe':SAFE,'morning_start':'07:00','morning_end':'11:00'},'exclude_policy':{'weekdays_only':True,'manual_exclude_dates':sorted(exc),'min_morning_samples':mincnt,'summary_requires_first_le_2':True,'summary_requires_known_confidence':True},'summary':{'p10':q(mins,.10),'p25':q(mins,.25),'median':q(mins,.50),'p75':q(mins,.75),'p90':q(mins,.90),'included_days':len(mins),'excluded_days':sum(1 for d in days if not d['included_in_summary'])},'days':days}
def main():
 a=pa(); payload=build(rows(a.input_csv,a.target_name),a.target_name,ex(a.exclude_dates),a.min_morning_samples); os.makedirs(os.path.dirname(os.path.abspath(a.output_json)),exist_ok=True); json.dump(payload,open(a.output_json,'w',encoding='utf-8'),ensure_ascii=False,indent=2); open(a.output_json,'a',encoding='utf-8').write('\n'); print('wrote',a.output_json,'days=',len(payload['days']),'included=',payload['summary']['included_days'])
if __name__=='__main__': main()
