import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const A=createRequire(import.meta.url)('../bus-arrival/alarm.js');
const T=Date.parse('2026-10-19T18:00:00+09:00'), MIN=60000;
const iso=t=>new Date(t).toISOString();
const cfg={enabled:true,leads:[5],windows:[],armedAtMs:T-3600000};
const status=(poll=T,predict=600,extra={})=>({last_poll:iso(poll),predict_sec:predict,current_veh_id:11,...extra});
const snap=(s,now=T)=>A.assessStatus(s,now,{safetyMode:true,maxAgeMin:13});
const evaluate=(s,now=T,extra={})=>A.evaluate({cfg,snap:s,nowMs:now,ledger:A.emptyLedger(),walkMinutes:5,marginSec:60,...extra});
const history={date:'2026-10-19', slots:[{id:'2026-10-19:36',sample_days:4,
  earliest_arrival_ts:iso(T+6*MIN),latest_arrival_ts:iso(T+10*MIN)}]};
const h=(extra={})=>A.evaluateHistorical({cfg,history,nowMs:T,walkMinutes:5,enabled:true,
  snap:{why:'no_bus',usable:false},ledger:{},busLedger:A.emptyLedger(),...extra});

test('safe mode separates API, mean prediction, lower arrival bound and departure',()=>{
  const s=snap(status(T,900,{safety:{observation_ts:iso(T),safe_arrival_ts:iso(T+10*MIN),
    corrected_arrival_ts:iso(T+12*MIN),method:'trip_lower_quantile',sample_trips:50}}));
  assert.equal(s.arrivalAtMs,T+15*MIN);
  assert.equal(s.correctedArrivalAtMs,T+12*MIN);
  assert.equal(s.safeArrivalAtMs,T+10*MIN);
  const out=evaluate(s);
  assert.equal(out.view.safeDepartureAtMs,T+4*MIN);
  assert.equal(out.view.nextFireAtMs,T+4*MIN);
  assert.equal(out.actions.length,0);
});

test('fallback is conservative, mismatched or invalid model output cannot move alarm later',()=>{
  const fallback=snap(status());
  assert.equal(fallback.safeArrivalAtMs,T-MIN);
  for(const safety of [
    {observation_ts:iso(T-MIN),safe_arrival_ts:iso(T+MIN)},
    {observation_ts:iso(T),safe_arrival_ts:iso(T+20*MIN)},
    {observation_ts:iso(T),safe_arrival_ts:'bad'}]){
    assert.equal(snap(status(T,600,{safety})).safeArrivalAtMs,fallback.safeArrivalAtMs);
  }
});

test('safety departure handles overdue lower bound while API ETA is still future, once per vehicle',()=>{
  const s=snap(status(T,180));
  const out=evaluate(s);
  assert.equal(out.actions.length,1);
  assert.equal(out.actions[0].type,'fire');
  assert.equal(out.actions[0].kind,'late');
  assert.match(A.formatFireMessage(out.actions[0]).body,/실제 도착은 미확인/);
  assert.equal(evaluate(s,T+1000,{ledger:out.ledger}).actions.length,0);
  assert.equal(evaluate(s,T,{cfg:{...cfg,armedAtMs:T}}).actions.length,1);
});

test('freshness for departure is 3 minutes, preserves legacy assessment contract and timers',()=>{
  assert.equal(snap(status(T-4*MIN,900)).why,'too_old');
  assert.equal(snap({last_poll:iso(T-4*MIN),error:'no_bus'}).why,'too_old');
  assert.equal(A.assessStatus(status(T-4*MIN,900),T,{maxAgeMin:13}).why,'ok');
  assert.equal(snap(status(T+10*MIN,900)).why,'clock_skew');
  const timer=A.newTimer(1,'timer',T);
  const result=A.evaluateTimers({timers:[timer],nowMs:T+MIN});
  assert.equal(result.actions[0].type,'timer');
});

test('walk and N-minute settings use the earlier departure, windows and skip remain effective',()=>{
  const s=snap(status(T,1200,{safety:{observation_ts:iso(T),safe_arrival_ts:iso(T+16*MIN),
    method:'trip_lower_quantile',sample_trips:50}})); // API+20 safe+16 departure+10
  assert.equal(evaluate(s).view.nextFireAtMs,T+10*MIN);
  assert.equal(evaluate(s,T,{cfg:{...cfg,leads:[10]},walkMinutes:0,marginSec:0}).view.nextFireAtMs,T+6*MIN);
  assert.equal(evaluate(s,T,{cfg:{...cfg,windows:[{start:'19:00',end:'20:00',days:[1]}]}}).view.target,null);
  const skipped=A.skipTarget(A.emptyLedger(),A.pickTarget(s,{},T,[]));
  assert.equal(evaluate(s,T,{ledger:skipped}).view.target,null);
});

test('historical prealert is distinct, persists once, and is inactive with low support or holiday data',()=>{
  const out=h();
  assert.equal(out.actions[0].type,'historical');
  assert.deepEqual(out.actions[0].leads,[5]);
  assert.equal(h({ledger:out.ledger}).actions.length,0);
  assert.equal(h({enabled:false}).actions.length,0);
  assert.equal(h({history:{...history,slots:[{...history.slots[0],sample_days:3}]}}).actions.length,0);
  assert.equal(h({history:{date:'2026-10-18',slots:history.slots}}).actions.length,0);
  assert.equal(h({history:{...history,slots:[]}}).actions.length,0);
  assert.equal(h({snap:{why:'too_old'}}).actions.length,0);
  assert.equal(h({snap:{why:'api_error'}}).actions.length,0);
  assert.equal(h({cfg:{...cfg,enabled:false}}).actions.length,0);
  assert.equal(h({cfg:{...cfg,windows:[{start:'19:00',end:'20:00',days:[1]}]}}).actions.length,0);
});

test('historical time candidate never completes the real-time vehicle ledger',()=>{
  const pre=h();
  const s=snap(status(T,480));
  const confirmed=h({snap:s,ledger:pre.ledger});
  assert.equal(confirmed.actions[0].type,'historical_candidate');
  assert.equal(confirmed.busLedger.fired['11|5'],undefined);
  const departure=evaluate(s,T,{ledger:confirmed.busLedger});
  assert.equal(departure.actions[0].type,'fire');
  assert.equal(evaluate(s,T,{ledger:departure.ledger}).actions.length,0);
  assert.equal(h({snap:s,ledger:confirmed.ledger,busLedger:confirmed.busLedger}).actions.length,0);
  const competing={...s,next:{vehId:22,arrivalAtMs:T+9*MIN}};
  assert.equal(h({snap:competing,ledger:pre.ledger}).actions.length,0);
  assert.equal(evaluate(competing).actions[0].type,'fire');
  const duplicate={...history,slots:history.slots.concat([{...history.slots[0],id:'2026-10-19:37'}])};
  assert.equal(h({history:duplicate,snap:s,ledger:pre.ledger}).actions.length,0);
});

test('prealert honors changed N-minute levels without replaying already fired ones',()=>{
  const pre=h();
  const second=h({cfg:{...cfg,leads:[10,5]},ledger:pre.ledger});
  assert.deepEqual(second.actions[0].leads,[10]);
  assert.equal(h({nowMs:T+20*MIN,ledger:pre.ledger}).actions.length,0);
});


test('189-second reservation survives freshness expiry and reload, with one uncertain warning',()=>{
  const status0=status(T,1200,{safety:{observation_ts:iso(T),safe_arrival_ts:iso(T+549000),
      corrected_arrival_ts:iso(T+1100000),method:'trip_lower_quantile',sample_trips:89}});
  let out=evaluate(snap(status0),T);
  assert.equal(out.view.nextFireAtMs,T+189000);
  out=evaluate(snap(status0,T+180000),T+180000,{prevTarget:out.prevTarget,ledger:out.ledger});
  assert.equal(out.actions.length,0);
  out=evaluate(snap(status0,T+189000),T+189000,{prevTarget:JSON.parse(JSON.stringify(out.prevTarget)),ledger:out.ledger});
  assert.equal(out.actions[0].uncertain,true);
  assert.match(A.formatFireMessage(out.actions[0]).body,/現在|현재 미확인/);
  assert.equal(evaluate(snap(status0,T+190000),T+190000,{prevTarget:out.prevTarget,ledger:out.ledger}).actions.length,0);
});

test('unvalidated stale data cannot create a reservation; fresh disappearance and clock skew cancel warning',()=>{
  const st=status(T,1800,{safety:{observation_ts:iso(T),safe_arrival_ts:iso(T+600000),method:'trip_lower_quantile',sample_trips:30}});
  const first=evaluate(snap(st),T);
  assert.equal(evaluate(snap(st,T+240000),T+240000).actions.length,0);
  const known={prevTarget:first.prevTarget,ledger:first.ledger};
  assert.equal(evaluate({why:'no_bus',usable:false},T+240000,known).prevTarget,null);
  assert.equal(evaluate({why:'clock_skew',usable:false},T+240000,known).actions.length,0);
  assert.equal(evaluate({why:'too_old',usable:false},T+601000,known).actions.length,0);
  assert.equal(evaluate({why:'too_old',usable:false},T+240000,{...known,cfg:{...cfg,enabled:false}}).actions.length,0);
  assert.equal(evaluate({why:'too_old',usable:false},T+240000,{...known,ledger:A.skipTarget({},first.prevTarget)}).actions.length,0);
});

test('retained stale-model margin is accepted as a margin without pretending to be a fresh quantile',()=>{
  const s=snap(status(T,1800,{safety:{observation_ts:iso(T),safe_arrival_ts:iso(T+1012000),
      method:'retained_margin',sample_trips:0}}));
  assert.equal(s.safetyMethod,'retained_margin');
  assert.equal(s.safeArrivalAtMs,T+1012000);
});
