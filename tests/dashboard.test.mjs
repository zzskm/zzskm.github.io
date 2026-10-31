import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../dashboard-model.js');

test('minute nudges carry across hours and wrap midnight in both directions', () => {
  assert.deepEqual(M.nudgeTime({h:8,m:59},5),{h:9,m:4});
  assert.deepEqual(M.nudgeTime({h:0,m:0},-1),{h:23,m:59});
  assert.deepEqual(M.nudgeTime({h:23,m:55},10),{h:0,m:5});
});

test('weight chart shares one history window, preserves forecast values and aligns confidence bands', () => {
  const s = {series:{daily:[{date:'2026-10-28',valueKg:84},{date:'2026-10-29',valueKg:null}],
    ewma:[{date:'2026-09-01',valueKg:85},{date:'2026-10-29',valueKg:83.98}],
    prediction:[{date:'bad',valueKg:90},{date:'2026-11-05',valueKg:84.07},{date:'2026-11-12',valueKg:null}]},
    predictionCI:{series:[{date:'2026-11-05',central:84,lower80:83,upper80:85},{date:'2026-11-12',central:84,lower80:null,upper80:85}]}};
  const chart = M.weightChart(s);
  assert.deepEqual(chart.trend,[{date:'2026-10-29',valueKg:83.98}]);
  assert.deepEqual(chart.prediction,[{date:'2026-11-05',valueKg:84.07}]);
  assert.deepEqual(chart.band,[{date:'2026-11-05',lower:83.07,upper:85.07}]);
  assert.deepEqual(M.weightChart(s,30,false).band,[]);
  assert.deepEqual(M.weightChart({...s,modelDiagnostics:{trend:{predictionEnabled:false}}}).prediction,[]);
  assert.deepEqual(M.weightChart(null).actual,[]);
});

test('weight chart shows only the first 4 of 12 forecast weeks without changing published predictions', () => {
  const s = {
    series: {
      daily:[{date:'2026-10-31',valueKg:84}],
      prediction:[
        {date:'2026-10-31',valueKg:84},
        {date:'2026-11-07',valueKg:83.8},
        {date:'2026-11-28',valueKg:83.2},
        {date:'2026-12-05',valueKg:83},
        {date:'2027-01-23',valueKg:82}
      ]
    },
    predictionCI:{series:[
      {date:'2026-11-28',central:83.2,lower80:82.2,upper80:84.2},
      {date:'2026-12-05',central:83,lower80:82,upper80:84}
    ]},
    predictions:{threeMonthWeightKg:82}
  };
  const chart = M.weightChart(s,30,true);
  assert.deepEqual(chart.prediction.map(p => p.date),['2026-10-31','2026-11-07','2026-11-28']);
  assert.deepEqual(chart.band.map(p => p.date),['2026-11-28']);
  assert.equal(s.predictions.threeMonthWeightKg,82);
  assert.deepEqual(M.weightChart(s,30,false).prediction,[]);
});

test('weight data rejects malformed dates, missing values and invalid series without losing valid points', () => {
  const s = {series:{daily:[null,{date:'2026-10-28',valueKg:84},{date:'2026-10-01',valueKg:86},{date:'2026-10-29',valueKg:null},{date:'2026-10-29<script>',valueKg:90}],ewma:{},prediction:[null]}};
  assert.deepEqual(M.points(s).map(p => p.valueKg),[86,84]);
  assert.equal(M.weightChange(s),-2);
  assert.deepEqual(M.weightChart(s).prediction,[]);
});

test('work settings preserve the existing storage shape and reject malformed values', () => {
  const s = M.normalize({start:{h:8,m:37},end:{h:17,m:40},breakH:0,breakM:45,notifyEnabled:true});
  assert.deepEqual(s.start,{h:8,m:37});
  assert.equal(s.breakM,45);
  assert.equal(s.notifyEnabled,true);
  assert.equal(M.normalize({start:{h:-1,m:'bad'},baseH:Infinity}).baseH,8);
  assert.deepEqual(M.normalize({start:{h:-1,m:'bad'}}).start,{h:9,m:0});
});
test('work countdown, overtime, waiting and completion use wall time', () => {
  const s = {...M.defaults(),end:{h:18,m:30}};
  let v = M.work(s,new Date(2026,9,28,17,30,15));
  assert.equal(v.remain,3585);
  assert.equal(v.phase,'working');
  assert.equal(v.workM,510);
  assert.equal(v.extraM,30);
  v = M.work(s,new Date(2026,9,28,8));
  assert.equal(v.phase,'waiting');
  assert.equal(v.percent,0);
  v = M.work(s,new Date(2026,9,28,19));
  assert.equal(v.phase,'done');
  assert.equal(v.remain,0);
  assert.equal(v.percent,100);
});
test('overnight shifts include the early hours and complete at their end', () => {
  const s = {...M.defaults(),start:{h:22,m:0},end:{h:6,m:0}};
  const v = M.work(s,new Date(2026,9,29,1,30));
  assert.equal(v.phase,'working');
  assert.equal(v.remain,4.5*3600);
  assert.equal(v.start.getDate(),28);
  assert.equal(v.workM,420);
  assert.equal(M.work(s,new Date(2026,9,29,6)).phase,'done');
});
test('weight chart ignores missing measurements and filters by calendar days', () => {
  const s = {series:{daily:[{date:'2026-09-28',valueKg:90},{date:'2026-09-29',valueKg:88},
    {date:'2026-10-01',valueKg:null},{date:'2026-10-15',valueKg:86},{date:'2026-10-28',valueKg:84.3}]}};
  assert.equal(M.points(s).length,3);
  assert.ok(Math.abs(M.weightChange(s) + 3.7) < 1e-9);
  assert.deepEqual(M.points(null),[]);
  assert.equal(M.weightChange({series:{daily:[{date:'2026-10-28',valueKg:84}]}}),null);
});
