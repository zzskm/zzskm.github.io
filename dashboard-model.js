/* Small, dependency-free calculations shared by the dashboard and its tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PersonalDashboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const defaults = () => ({start:{h:9,m:0},end:{h:18,m:0},baseH:8,baseM:0,breakH:1,breakM:0,notifyEnabled:false});
  const integer = (value, max, fallback) => Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;
  function normalize(value) {
    const d = defaults(), s = value || {};
    for (const k of ['start','end']) {
      d[k].h = integer(s[k]?.h, 23, d[k].h);
      d[k].m = integer(s[k]?.m, 59, d[k].m);
    }
    for (const k of ['baseH','baseM','breakH','breakM']) d[k] = integer(s[k], k.endsWith('H') ? 23 : 59, d[k]);
    d.notifyEnabled = s.notifyEnabled === true;
    return d;
  }
  const minutes = t => t.h * 60 + t.m;
  function work(state, now = new Date()) {
    const s = normalize(state), from = minutes(s.start), to = minutes(s.end);
    const start = new Date(now), end = new Date(now);
    start.setHours(s.start.h, s.start.m, 0, 0);
    end.setHours(s.end.h, s.end.m, 0, 0);
    if (to <= from) {
      end.setDate(end.getDate() + 1);
      if (now < start) {
        start.setDate(start.getDate() - 1);
        end.setDate(end.getDate() - 1);
      }
    }
    const total = (end - start) / 1000;
    const phase = now < start ? 'waiting' : now >= end ? 'done' : 'working';
    const elapsed = Math.max(0, Math.min(total, (now - start) / 1000));
    const remain = Math.max(0, Math.ceil((end - (now < start ? start : now)) / 1000));
    const breakM = s.breakH * 60 + s.breakM;
    const workM = Math.round(total / 60) - breakM;
    return {start,end,phase,elapsed,remain,percent:100 * elapsed / total,workM,breakM,extraM:workM - s.baseH * 60 - s.baseM};
  }
  function points(summary, days = 30) {
    const daily = summary?.series?.daily || [];
    const lastDate = daily.at(-1)?.date;
    if (!lastDate) return [];
    const cutoff = Date.parse(lastDate) - (days - 1) * 86400000;
    return daily.filter(p => Number.isFinite(p.valueKg) && Number.isFinite(Date.parse(p.date)) && Date.parse(p.date) >= cutoff);
  }
  function weightChange(summary) {
    const p = points(summary, 30);
    return p.length > 1 ? p.at(-1).valueKg - p[0].valueKg : null;
  }
  return { defaults, normalize, work, points, weightChange };
});
