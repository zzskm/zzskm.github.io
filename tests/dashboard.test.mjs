import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../dashboard-model.js');

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
