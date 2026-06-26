'use strict';
(() => {
  const LOT_NAME = "수지노외 공영주차장";
  const AUTO_REFRESH_MS = 60 * 1000;
  const DEFAULT_CSV = "./parking_log.csv";
  const DAILY_STATS_URL = "./daily_stats.json";
  const STATUS_URL = "./status.json";
  const LOW_THRESHOLD = 2;
  const KST_TZ = "Asia/Seoul";
  const fmtTimeLabel = new Intl.DateTimeFormat("ko-KR", { timeZone: KST_TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const fmtTimeOnly = new Intl.DateTimeFormat("ko-KR", { timeZone: KST_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const fmtHourKST = new Intl.DateTimeFormat("en-GB", { timeZone: KST_TZ, hour: "2-digit", hourCycle: "h23" });
  const fmtYmdKST = new Intl.DateTimeFormat("en-CA", { timeZone: KST_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const ymdKST = d => fmtYmdKST.format(d);
  const hourKST = d => parseInt(fmtHourKST.format(d), 10);
  const minuteText = m => Number.isFinite(m) ? `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` : "N/A";
  const isoTime = v => { if (!v) return "N/A"; const d = new Date(v); return Number.isNaN(d.getTime()) ? "N/A" : fmtTimeOnly.format(d); };
  const clsConf = c => `confidence-${c || "unknown"}`;
  function ymdDaysAgo(n) { const t = new Date(`${ymdKST(new Date())}T00:00:00+09:00`); return ymdKST(new Date(t.getTime() - n * 86400000)); }
  function projectToBaseDate(base, d) { return new Date(base.getFullYear(), base.getMonth(), base.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()); }
  function minuteToBaseDate(base, m) { return new Date(base.getTime() + m * 60000); }
  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
  function todayStats(stats) { const today = ymdKST(new Date()); return stats?.days?.find(d => d.date === today) || null; }

  function downsample(data, intervalMs = 5 * 60 * 1000) {
    if (data.length <= 100) return data;
    const out = []; let last = null;
    for (const d of data) if (!last || d.t - last >= intervalMs) { out.push(d); last = d.t; }
    return out;
  }

  function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map(r => r.split(",")).filter(r => r.length >= 3);
    if (!rows.length) throw new Error("CSV 데이터 없음");
    const first = rows[0].map(v => v.trim());
    const hasHeader = first.includes("timestamp_kst") && first.includes("lot_name") && first.includes("available");
    const header = hasHeader ? first : ["timestamp_kst", "lot_name", "available"];
    const tsIdx = header.indexOf("timestamp_kst"), nameIdx = header.indexOf("lot_name"), avIdx = header.indexOf("available");
    const all = (hasHeader ? rows.slice(1) : rows)
      .map(r => ({ t: new Date(r[tsIdx]), name: r[nameIdx], v: Number(r[avIdx]) }))
      .filter(r => r.name === LOT_NAME && !Number.isNaN(r.v) && !Number.isNaN(r.t.getTime()))
      .sort((a, b) => a.t - b.t);
    const t0 = ymdDaysAgo(0), t1 = ymdDaysAgo(1), t7start = ymdDaysAgo(7);
    const todayArr = [], yestArr = [], bucketsByHour = Array.from({ length: 24 }, () => []);
    for (const d of all) {
      const ymd = ymdKST(d.t);
      if (ymd === t0) todayArr.push(d);
      if (ymd === t1) yestArr.push(d);
      if (ymd >= t7start && ymd < t0) bucketsByHour[hourKST(d.t)].push(d.v);
    }
    const d7MinMax = []; let lastMin = null, lastMax = null;
    for (let hour = 0; hour < 24; hour++) {
      const vals = bucketsByHour[hour]; let minV, maxV;
      if (vals.length) { minV = Math.min(...vals); maxV = Math.max(...vals); lastMin = minV; lastMax = maxV; }
      else if (lastMin === null) { minV = 0; maxV = 0; }
      else { minV = lastMin; maxV = lastMax; }
      d7MinMax.push({ t: new Date(1970, 0, 1, hour, 0, 0, 0), min: minV, max: maxV });
    }
    if (todayArr.length) { const last = todayArr[todayArr.length - 1]; todayArr.push({ t: new Date(), name: last.name, v: last.v }); }
    const latestT = todayArr.length ? todayArr[todayArr.length - 1].t : yestArr.length ? yestArr[yestArr.length - 1].t : null;
    return { todayArr: downsample(todayArr), yestArr: downsample(yestArr), d7MinMax, latestT };
  }

  function computeFirstLow(todayArr) {
    let prev = null;
    for (const s of todayArr) {
      if (s.v <= LOW_THRESHOLD) return { observed_at: s.t.toISOString(), interval_start: (prev || s).t.toISOString(), interval_end: s.t.toISOString(), previous_available: prev ? prev.v : null, available: s.v, confidence: "unknown" };
      prev = s;
    }
    return null;
  }

  function renderSummary(data) {
    const el = document.getElementById("summary"); if (!el) return;
    const last = data.todayArr.length ? data.todayArr[data.todayArr.length - 1] : null;
    const day = todayStats(data.stats), firstLow = day?.first_le_2 || computeFirstLow(data.todayArr), s = data.stats?.summary || null;
    const latest = data.status?.last_success_at || (data.latestT ? data.latestT.toISOString() : null);
    const included = s?.included_days || 0;
    const cards = [
      { l: "현재 가능 대수", v: last ? `${last.v}대` : "N/A", n: latest ? `성공 ${isoTime(latest)}` : "수집 성공 없음", c: last && last.v <= LOW_THRESHOLD ? "alert" : "" },
      { l: "오늘 첫 2대 이하", v: firstLow ? isoTime(firstLow.observed_at) : "아직 없음", n: firstLow ? `신뢰도 ${firstLow.confidence || "unknown"}` : "관측 전", c: firstLow ? clsConf(firstLow.confidence) : "muted" },
      { l: "평일 위험 구간", v: s?.p25 != null && s?.p75 != null ? `${minuteText(s.p25)}~${minuteText(s.p75)}` : "N/A", n: included ? `노이즈 제외 ${included}일 기준` : "통계 부족", c: included ? "" : "muted" },
      { l: "중앙값", v: s?.median != null ? minuteText(s.median) : "N/A", n: s?.p10 != null && s?.p90 != null ? `p10~p90 ${minuteText(s.p10)}~${minuteText(s.p90)}` : "분위수 없음", c: included ? "" : "muted" }
    ];
    el.innerHTML = cards.map(x => `<div class="summary-card ${x.c}"><div class="summary-label">${x.l}</div><div class="summary-value">${x.v}</div><div class="summary-note">${x.n}</div></div>`).join("");
  }

  function fmtXTick(d, endDate) { return d.getTime() === endDate.getTime() ? "24:00" : d3.timeFormat("%H:%M")(d); }
  function initChart(container) {
    d3.select(container).selectAll("*").remove();
    const svg = d3.select(container).append("svg").attr("class", "chart-svg chart-root").attr("role", "img").attr("aria-label", `${LOT_NAME} 주차 가능 대수 추이 차트`);
    const g = svg.append("g").attr("class", "plot");
    ["grid x-grid", "grid y-grid", "threshold-bands", "axis x-axis", "axis y-axis", "areas", "lines", "end-marks", "markers", "legend"].forEach(c => g.append("g").attr("class", c));
    d3.select("body").selectAll(".tooltip").remove();
    const tooltip = d3.select("body").append("div").attr("class", "tooltip").attr("id", "chart-tooltip").attr("role", "tooltip").attr("aria-live", "polite").style("position", "absolute").style("opacity", 0).style("pointer-events", "none");
    return { container, svg, g, tooltip };
  }

  function renderBands(g, stats, x, height, baseDate) {
    const s = stats?.summary, ok = s && [s.p10, s.p25, s.median, s.p75, s.p90].every(Number.isFinite);
    const bands = ok ? [{ cls: "band-outer", a: s.p10, b: s.p90 }, { cls: "band-inner", a: s.p25, b: s.p75 }] : [];
    const bg = g.select(".threshold-bands");
    const r = bg.selectAll("rect.threshold-band").data(bands, d => d.cls);
    r.exit().remove();
    r.enter().append("rect").attr("class", d => `threshold-band ${d.cls}`).merge(r).attr("x", d => x(minuteToBaseDate(baseDate, d.a))).attr("y", 0).attr("width", d => Math.max(1, x(minuteToBaseDate(baseDate, d.b)) - x(minuteToBaseDate(baseDate, d.a)))).attr("height", height);
    const m = bg.selectAll("line.median-line").data(ok ? [s.median] : []);
    m.exit().remove();
    m.enter().append("line").attr("class", "median-line").merge(m).attr("x1", d => x(minuteToBaseDate(baseDate, d))).attr("x2", d => x(minuteToBaseDate(baseDate, d))).attr("y1", 0).attr("y2", height);
  }

  function renderFirstMarker(g, data, xScale, yScale, baseDate, width) {
    const f = todayStats(data.stats)?.first_le_2 || computeFirstLow(data.todayArr);
    const d = f ? [{ t: projectToBaseDate(baseDate, new Date(f.observed_at)), v: f.available, confidence: f.confidence || "unknown" }] : [];
    const mg = g.select(".markers");
    const c = mg.selectAll("circle.today-first-marker").data(d);
    c.exit().remove();
    c.enter().append("circle").attr("r", 5).attr("tabindex", "0").merge(c)
      .attr("class", m => `today-first-marker ${clsConf(m.confidence)}`)
      .attr("cx", m => xScale(m.t)).attr("cy", m => yScale(m.v))
      .attr("aria-label", m => `오늘 첫 2대 이하: ${m.v}대, 시간: ${fmtTimeOnly.format(m.t)}, 신뢰도: ${m.confidence}`);
    const lab = mg.selectAll("text.today-first-label").data(d);
    lab.exit().remove();
    lab.enter().append("text").attr("class", "today-first-label").attr("aria-hidden", "true").merge(lab)
      .attr("x", m => Math.min(xScale(m.t) + 8, width - 90)).attr("y", m => Math.max(12, yScale(m.v) - 8))
      .text(m => `첫 ≤2 ${fmtTimeOnly.format(m.t)}`);
  }

  function renderChart(ctx, data) {
    const { container, svg, g, tooltip } = ctx, { todayArr, yestArr, d7MinMax } = data;
    const W = container.clientWidth || window.innerWidth || 1000, H = Math.max(200, W * 0.6), isSmall = W < 480;
    const margin = { top: 16, right: isSmall ? 48 : 200, bottom: 44, left: isSmall ? 32 : 48 };
    const width = Math.max(300, W - margin.left - margin.right), height = Math.max(200, H - margin.top - margin.bottom), fullW = width + margin.left + margin.right, fullH = height + margin.top + margin.bottom;
    svg.attr("width", fullW).attr("height", fullH).attr("viewBox", `0 0 ${fullW} ${fullH}`); g.attr("transform", `translate(${margin.left},${margin.top})`);
    const baseDate = new Date(`${ymdKST(new Date())}T00:00:00+09:00`), endDate = new Date(baseDate.getTime() + 86400000);
    const pToday = todayArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v })), pYest = yestArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v })), pD7 = d7MinMax.map(d => ({ t: projectToBaseDate(baseDate, d.t), min: d.min, max: d.max }));
    const maxY = Math.max(10, ...pToday.map(d => d.v), ...pYest.map(d => d.v), ...pD7.map(d => d.max));
    const x = d3.scaleTime().domain([baseDate, endDate]).range([0, width]), y = d3.scaleLinear().domain([0, maxY]).nice().range([height, 0]);
    g.select(".x-grid").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(d3.timeHour.every(4)).tickSize(-height).tickFormat(""));
    g.select(".y-grid").call(d3.axisLeft(y).ticks(6).tickSize(-width).tickFormat(""));
    renderBands(g, data.stats, x, height, baseDate);
    g.select(".x-axis").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(d3.timeHour.every(4)).tickFormat(d => fmtXTick(d, endDate)));
    g.select(".y-axis").call(d3.axisLeft(y).ticks(6));
    const line = d3.line().curve(d3.curveMonotoneX).x(d => x(d.t)).y(d => y(d.v));
    const area = d3.area().curve(d3.curveMonotoneX).x(d => x(d.t)).y0(d => y(d.min)).y1(d => y(d.max));
    const areaSel = g.select(".areas").selectAll("path.area.d7range").data(pD7.length ? [pD7] : []);
    areaSel.exit().remove(); areaSel.enter().append("path").attr("class", "area d7range").attr("fill", "var(--green)").attr("opacity", 0.15).attr("aria-describedby", "chart-tooltip").merge(areaSel).attr("d", area);
    const linesG = g.select(".lines");
    [{ data: pYest, cls: "yesterday", color: "var(--blue)", w: 1.5, op: .8 }, { data: pToday, cls: "today", color: "var(--orange)", w: 4, op: 1 }].forEach(grp => {
      const sel = linesG.selectAll(`path.line.${grp.cls}`).data(grp.data.length ? [grp.data] : []);
      sel.exit().remove(); sel.enter().append("path").attr("class", `line ${grp.cls}`).attr("fill", "none").attr("aria-describedby", "chart-tooltip").merge(sel).attr("stroke", grp.color).attr("stroke-width", grp.w).attr("opacity", grp.op).attr("d", line);
    });
    const todayPath = linesG.select("path.line.today");
    if (!todayPath.empty() && pToday.length) {
      const showAt = (event, d) => { tooltip.transition().duration(150).style("opacity", .95); tooltip.html(`오늘<br>시간: ${fmtTimeOnly.format(d.t)}<br>대수: ${d.v}`).style("left", (event.pageX + 10) + "px").style("top", (event.pageY - 28) + "px"); };
      todayPath.on("mouseover touchstart", function(event) { const [mx] = d3.pointer(event, this), x0 = x.invert(mx), i = d3.bisectLeft(pToday.map(d => d.t), x0, 1), d0 = pToday[i - 1], d1 = pToday[i] || d0; showAt(event, x0 - d0.t > d1.t - x0 ? d1 : d0); }).on("mousemove touchmove", event => tooltip.style("left", (event.pageX + 10) + "px").style("top", (event.pageY - 28) + "px")).on("mouseout touchend", () => tooltip.transition().duration(300).style("opacity", 0));
    }
    const endG = g.select(".end-marks"), last = pToday.length ? pToday[pToday.length - 1] : null;
    const endLabel = endG.selectAll("text.end-label.today").data(last ? [last] : []);
    endLabel.exit().remove(); endLabel.enter().append("text").attr("class", "end-label today").attr("aria-hidden", "true").merge(endLabel).attr("x", d => Math.min(x(d.t) + 8, width - 80)).attr("y", d => y(d.v)).attr("opacity", .95).text(d => `오늘 ${d.v} (${fmtTimeOnly.format(d.t)})`);
    const endDot = endG.selectAll("circle.end-dot.today").data(last ? [last] : []);
    endDot.exit().remove(); endDot.enter().append("circle").attr("class", "end-dot today").attr("r", 4).attr("fill", "var(--orange)").attr("tabindex", "0").merge(endDot).attr("cx", d => x(d.t)).attr("cy", d => y(d.v)).attr("aria-label", d => `오늘 마지막 값: ${d.v} 대, 시간: ${fmtTimeOnly.format(d.t)}`).attr("opacity", .95);
    renderFirstMarker(g, data, x, y, baseDate, width);
    const legendItems = [{ key: "오늘", cls: "today", color: "var(--orange)", sw: 3, op: 1 }, { key: "어제", cls: "yesterday", color: "var(--blue)", sw: 1.5, op: 1 }, { key: "7일 범위", cls: "d7range", color: "var(--green)", sw: 1.5, op: .6 }, { key: "평일 위험", cls: "riskband", color: "var(--orange)", sw: 6, op: .35 }];
    const legendG = g.select(".legend").attr("transform", isSmall ? `translate(${width / 2 - 80}, -8)` : `translate(${width + 16}, 8)`);
    const item = legendG.selectAll(".legend-item").data(legendItems, d => d.cls); item.exit().remove();
    const enter = item.enter().append("g").attr("class", d => `legend-item ${d.cls}`); enter.append("line").attr("x1", 0).attr("x2", 18).attr("y1", 6).attr("y2", 6); enter.append("text").attr("x", 24).attr("y", 9).attr("dominant-baseline", "middle");
    const all = enter.merge(item).attr("transform", (d, i) => isSmall ? `translate(${i * 84}, 0)` : `translate(0, ${i * 20})`); all.select("line").attr("stroke", d => d.color).attr("stroke-width", d => d.sw).attr("opacity", d => d.op); all.select("text").text(d => d.key);
    linesG.select("path.line.today").raise(); endG.selectAll(".end-label.today, .end-dot.today").raise(); g.select(".markers").raise();
  }

  let chartCtx = null, cachedData = null, failCount = 0, retryTimer = null;
  function setStatus(text) { const el = document.getElementById("status"); if (el) el.textContent = text; }
  function buildStatusLine(data) { const latest = data.latestT ? fmtTimeLabel.format(data.latestT) : "N/A", scraper = data.status?.status ? ` · scraper: ${data.status.status}` : ""; return `${LOT_NAME} · 오늘 ${data.todayArr.length}개 · 어제 ${data.yestArr.length}개 · 7일 min-max ${data.d7MinMax.length}개 · 최신: ${latest}${scraper}`; }
  async function fetchOptionalJSON(path) { try { const r = await fetch(path, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch (e) { console.warn(`${path} 로딩 실패`, e); return null; } }
  async function fetchAndRender(path = DEFAULT_CSV) {
    try {
      if (!cachedData) setStatus("데이터 불러오는 중…");
      const [csvResp, stats, status] = await Promise.all([fetch(path, { cache: "no-store" }), fetchOptionalJSON(DAILY_STATS_URL), fetchOptionalJSON(STATUS_URL)]);
      if (!csvResp.ok) throw new Error(`CSV 로딩 실패: ${csvResp.status}`);
      const data = parseCSV(await csvResp.text()); data.stats = stats; data.status = status; cachedData = data; failCount = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      renderSummary(data); renderChart(chartCtx, data); setStatus(buildStatusLine(data));
    } catch (e) { failCount += 1; console.error(e); setStatus(`로딩 실패(${failCount}): ${e.message} · 5초 후 재시도`); if (retryTimer) clearTimeout(retryTimer); retryTimer = setTimeout(() => fetchAndRender(path), 5000); }
  }
  function bindUI() {
    const chartEl = document.getElementById("chart"); chartCtx = initChart(chartEl);
    const reloadBtn = document.getElementById("reloadBtn"); reloadBtn && reloadBtn.addEventListener("click", () => fetchAndRender());
    setInterval(() => { if (document.visibilityState === "visible") fetchAndRender(); }, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fetchAndRender(); });
    window.addEventListener("resize", debounce(() => { if (cachedData) renderChart(chartCtx, cachedData); }, 200));
    document.addEventListener("touchstart", e => { if (!chartEl.contains(e.target)) chartCtx.tooltip.style("opacity", 0); }, { passive: true });
    fetchAndRender();
  }
  window.addEventListener("load", bindUI);
})();
