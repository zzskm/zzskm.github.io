import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const BD=require('../bus-arrival/dashboard.js');
const BA=require('../bus-arrival/alarm.js');
const NOW=Date.parse('2026-10-19T18:00:00+09:00'), M=60000;
const iso=t=>new Date(t).toISOString();
const status=(extra={})=>({last_poll:iso(NOW),first_seen_ts:iso(NOW-2*M),current_veh_id:11,predict_sec:1200,
 safety:{observation_ts:iso(NOW),safe_arrival_ts:iso(NOW+14*M),corrected_arrival_ts:iso(NOW+18*M),method:'trip_lower_quantile',sample_trips:50},...extra});
function view(st=status(), opts={}) { return BD.buildView({status:st,snapshot:BA.assessStatus(st,NOW,{maxAgeMin:3,safetyMode:true}),
 nowMs:NOW,walkMinutes:5,marginSec:60,...opts}); }

test('departure model uses safe bound and engine selected deadline',()=>{
 const v=view(); assert.equal(v.departureAtMs,NOW+8*M); assert.equal(v.correctedAtMs,NOW+18*M); assert.match(v.title,/8분/);
 const av={target:{vehId:11,pollMs:NOW},safeDepartureAtMs:NOW+8*M,nextFireAtMs:NOW+6*M};
 const aligned=view(status(),{alarmView:av}); assert.equal(aligned.departureAtMs,av.safeDepartureAtMs);assert.equal(aligned.nextFireAtMs,av.nextFireAtMs);
});
test('next vehicle alarm cannot masquerade as current vehicle event',()=>{
 const v=view(status(),{alarmView:{target:{vehId:22},safeDepartureAtMs:NOW+25*M,nextFireAtMs:NOW+20*M}});
 assert.equal(v.departureAtMs,NOW+8*M);assert.equal(v.nextFireAtMs,null);
});
test('N-minute and walking settings use actual engine fire time',()=>{
 const st=status(),snap=BA.assessStatus(st,NOW,{safetyMode:true});
 const out=BA.evaluate({cfg:{enabled:true,leads:[10],windows:[],armedAtMs:NOW-1},snap,ledger:{},nowMs:NOW,walkMinutes:5,marginSec:60});
 const v=view(st,{alarmView:out.view});assert.equal(v.nextFireAtMs,NOW+4*M);assert.equal(v.departureAtMs,NOW+8*M);
});
test('past planned milestones stay planned and never become actual arrivals',()=>{
 const v=view(status(),{walkMinutes:30});assert.equal(v.state,'due');
 const departure=v.timeline.find(e=>e.label==='출발 권장');assert.equal(departure.kind,'planned');assert.equal(departure.elapsed,true);
 assert.ok(!v.timeline.some(e=>e.label==='도착 완료'));
 const st=status({predict_sec:0,safety:null});assert.equal(view(st).state,'elapsed');assert.match(view(st).title,/통과 미확인/);
});
test('stale first contact has no fabricated departure or live ETA',()=>{
 const v=view(status({last_poll:iso(NOW-4*M)}));assert.equal(v.state,'unavailable');assert.equal(v.departureAtMs,null);assert.equal(v.correctedAtMs,null);
 assert.ok(!v.timeline.some(e=>e.kind==='planned'));
});
test('validated pending warning is uncertain and has no fresh corrected ETA',()=>{
 const av={pendingUncertain:true,target:{vehId:11,safeArrivalAtMs:NOW+10*M},safeDepartureAtMs:NOW+4*M,nextFireAtMs:NOW+4*M};
 const v=view(status({last_poll:iso(NOW-4*M)}),{alarmView:av});assert.equal(v.state,'reserved');assert.equal(v.correctedAtMs,null);
 assert.ok(v.timeline.filter(e=>e.kind==='planned').every(e=>e.label.includes('마지막 확인 기준')));
});
test('off hours and fresh no-bus override old reservation',()=>{
 const av={pendingUncertain:true,target:{vehId:11},safeDepartureAtMs:NOW+M};
 assert.equal(view(status(),{off:true,alarmView:av}).state,'off');
 const v=view(status({current_veh_id:0,error:'no_bus'}),{alarmView:av});assert.equal(v.state,'no_bus');assert.equal(v.departureAtMs,null);
});
test('clock skew and API errors with no reservation do not produce live advice',()=>{
 assert.equal(view(status({last_poll:iso(NOW+3*M)})).departureAtMs,null);
 assert.equal(view(status({error:'network'})).departureAtMs,null);
});
test('first recognition uses metadata rather than earliest truncated prediction',()=>{
 const v=view(status(),{predictions:[{ts_kst:iso(NOW-M),vehId:11,predict_sec:1300}]});
 assert.equal(v.timeline.find(e=>e.label==='차량 최초 확인').atMs,NOW-2*M);
 const partial=view(status({first_seen_ts:null}),{predictions:[{ts_kst:iso(NOW-M),vehId:11,predict_sec:1300}]});
 assert.ok(partial.timeline.some(e=>e.label==='표시 가능한 기록 시작'));
});
test('reused vehicle IDs and future rows cannot join different runs',()=>{
 const rows=[{ts_kst:iso(NOW-20*M),vehId:11,predict_sec:1600},{ts_kst:iso(NOW-15*M),vehId:0,predict_sec:0},
 {ts_kst:iso(NOW-M),vehId:11,predict_sec:1100},{ts_kst:iso(NOW+M),vehId:11,predict_sec:1000}];
 const p=BD.currentSeries(status({first_seen_ts:null}),rows);assert.deepEqual(p.map(x=>x.t),[NOW-M,NOW]);
});
test('chart gaps remain discontinuous and duplicate polls use current status',()=>{
 const pts=BD.currentSeries(status({first_seen_ts:iso(NOW-10*M)}),[
 {ts_kst:iso(NOW-8*M),vehId:11,predict_sec:1600},{ts_kst:iso(NOW),vehId:11,predict_sec:500}]);
 assert.equal(pts[1].remainingSec,1200);assert.equal(BD.splitGaps(pts,60).length,2);
});
test('new observation changes departure without countdown causing false updates',()=>{
 const prev={vehId:11,pollMs:NOW-M,departureAtMs:NOW+10*M};assert.equal(view(status(),{previous:prev}).changeMinutes,-2);
 assert.equal(view(status(),{previous:{...prev,pollMs:NOW}}).changeMinutes,null);
 assert.equal(view(status(),{previous:{...prev,vehId:22}}).changeMinutes,null);
});
test('browser timeline excludes other vehicles, earlier trips and future events',()=>{
 const events=[{type:'fire',vehId:11,atMs:NOW-M},{type:'fire',vehId:22,atMs:NOW-M},
 {type:'fire',vehId:11,atMs:NOW-5*M},{type:'fire',vehId:11,atMs:NOW+M}];
 const fired=view(status(),{events}).timeline.filter(e=>e.label.includes('브라우저'));assert.equal(fired.length,1);assert.equal(fired[0].kind,'observed');
});
test('weekday plot counts trips, excludes gaps, today and duplicate records',()=>{
 const row={vehId:11,first_seen_ts:'2026-10-12T17:40:00+09:00',est_arrival_ts:'2026-10-12T18:00:00+09:00',departure_reason:'estimated_arrival'};
 const rows=[row,row,{...row,departure_reason:'data_gap',vehId:12}, {...row,est_arrival_ts:'2026-10-13T18:00:00+09:00'}, {...row,est_arrival_ts:'2026-10-19T17:59:00+09:00'}];
 const pts=BD.historyPoints(rows,NOW);assert.equal(pts.length,1);assert.equal(pts[0].date,'2026-10-12');
});

test('old alarm view cannot override a new observation departure or add an old reservation',()=>{
 const old={target:{vehId:11,pollMs:NOW-M},safeDepartureAtMs:NOW+20*M,nextFireAtMs:NOW+20*M};
 const v=view(status(),{alarmView:old});assert.equal(v.departureAtMs,NOW+8*M);assert.equal(v.nextFireAtMs,null);
});

test('uncertain next vehicle reservation does not inherit current vehicle observations',()=>{
 const av={pendingUncertain:true,target:{vehId:22,pollMs:NOW-4*M,safeArrivalAtMs:NOW+10*M},safeDepartureAtMs:NOW+4*M,nextFireAtMs:NOW+4*M};
 const v=view(status({last_poll:iso(NOW-4*M)}),{alarmView:av});
 assert.equal(v.targetVehId,22);assert.ok(!v.timeline.some(e=>e.label==='차량 최초 확인'));
 assert.ok(v.timeline.some(e=>e.label==='후속 알림 대상 차량 확인'));
});
