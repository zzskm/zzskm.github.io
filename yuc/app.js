'use strict';
(() => {
  const LOT_NAME = "수지노외 공영주차장";
  const AUTO_REFRESH_MS = 60 * 1000;
  const DEFAULT_CSV = "./parking_log.csv";
  const KST_TZ = "Asia/Seoul";

  // ---------- utils ----------
  const fmtTimeLabel = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST_TZ, month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: 'h23'
  });
  const fmtTimeOnly = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST_TZ, hour: "2-digit", minute: "2-digit", hourCycle: 'h23'
  });
  const fmtHourKST = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST_TZ, hour: "2-digit", hourCycle: 'h23'
  });
  const fmtYmdKST = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ, year: "numeric", month: "2-digit", day: "2-digit"
  });

  function ymdKST(date) {
    return fmtYmdKST.format(date);
  }
  function hourKST(date) {
    return parseInt(fmtHourKST.format(date), 10);
  }
  function ymdDaysAgo(n) {
    const kstToday = ymdKST(new Date());
    const kstMidnight = new Date(`${kstToday}T00:00:00+09:00`);
    return ymdKST(new Date(kstMidnight.getTime() - n * 86400000));
  }
  function projectToBaseDate(baseDate, originalDate) {
    return new Date(
      baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(),
      originalDate.getHours(), originalDate.getMinutes(),
      originalDate.getSeconds(), originalDate.getMilliseconds()
    );
  }
  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // ---------- parse ----------
  function downsample(data, intervalMs = 5 * 60 * 1000) {
    if (data.length <= 100) return data;
    const out = [];
    let last = null;
    for (const d of data) {
      if (!last || (d.t - last) >= intervalMs) {
        out.push(d);
        last = d.t;
      }
    }
    return out;
  }

  function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map(r => r.split(","));
    const header = rows.shift();
    const tsIdx = header.indexOf("timestamp_kst");
    const nameIdx = header.indexOf("lot_name");
    const avIdx = header.indexOf("available");
    if (tsIdx < 0 || nameIdx < 0 || avIdx < 0) {
      throw new Error("CSV 헤더 오류: timestamp_kst, lot_name, available 필요");
    }

    const all = rows
      .map(r => ({ t: new Date(r[tsIdx]), name: r[nameIdx], v: Number(r[avIdx]) }))
      .filter(r => r.name === LOT_NAME && !Number.isNaN(r.v) && !Number.isNaN(r.t.getTime()))
      .sort((a, b) => a.t - b.t);

    const t0 = ymdDaysAgo(0);
    const t1 = ymdDaysAgo(1);
    const t7start = ymdDaysAgo(7);

    const todayArr = [];
    const yestArr = [];
    const bucketsByHour = Array.from({ length: 24 }, () => []);

    for (const d of all) {
      const ymd = ymdKST(d.t);
      if (ymd === t0) todayArr.push(d);
      if (ymd === t1) yestArr.push(d);
      if (ymd >= t7start && ymd < t0) {
        bucketsByHour[hourKST(d.t)].push(d.v);
      }
    }

    const d7MinMax = [];
    let lastMin = null, lastMax = null;
    for (let hour = 0; hour < 24; hour++) {
      const vals = bucketsByHour[hour];
      let minV, maxV;
      if (vals.length > 0) {
        minV = Math.min(...vals);
        maxV = Math.max(...vals);
        lastMin = minV; lastMax = maxV;
      } else if (lastMin === null) {
        minV = 0; maxV = 0;
      } else {
        minV = lastMin; maxV = lastMax;
      }
      d7MinMax.push({ t: new Date(1970, 0, 1, hour, 0, 0, 0), min: minV, max: maxV });
    }

    if (todayArr.length > 0) {
      const last = todayArr[todayArr.length - 1];
      todayArr.push({ t: new Date(), name: last.name, v: last.v });
    }

    const latestT = todayArr.length ? todayArr[todayArr.length - 1].t
      : yestArr.length ? yestArr[yestArr.length - 1].t : null;

    return {
      todayArr: downsample(todayArr),
      yestArr: downsample(yestArr),
      d7MinMax,
      latestT
    };
  }

  // ---------- chart ----------
  function fmtXTick(d, endDate) {
    if (d.getTime() === endDate.getTime()) return "24:00";
    return d3.timeFormat("%H:%M")(d);
  }

  function initChart(container) {
    d3.select(container).selectAll("*").remove();
    const svg = d3.select(container).append("svg")
      .attr("class", "chart-svg chart-root")
      .attr("role", "img")
      .attr("aria-label", `${LOT_NAME} 주차 가능 대수 추이 차트`);
    const g = svg.append("g").attr("class", "plot");

    g.append("g").attr("class", "grid x-grid");
    g.append("g").attr("class", "grid y-grid");
    g.append("g").attr("class", "axis x-axis");
    g.append("g").attr("class", "axis y-axis");
    g.append("g").attr("class", "areas");
    g.append("g").attr("class", "lines");
    g.append("g").attr("class", "end-marks");
    g.append("g").attr("class", "legend");

    d3.select("body").selectAll(".tooltip").remove();
    const tooltip = d3.select("body").append("div")
      .attr("class", "tooltip")
      .attr("id", "chart-tooltip")
      .attr("role", "tooltip")
      .attr("aria-live", "polite")
      .style("position", "absolute")
      .style("opacity", 0)
      .style("pointer-events", "none");

    return { container, svg, g, tooltip };
  }

  function renderChart(ctx, data) {
    const { container, svg, g, tooltip } = ctx;
    const { todayArr, yestArr, d7MinMax } = data;

    const W = container.clientWidth || window.innerWidth || 1000;
    const H = Math.max(200, W * 0.6);
    const isSmall = W < 480;
    const margin = { top: 16, right: isSmall ? 48 : 200, bottom: 44, left: isSmall ? 32 : 48 };
    const width = Math.max(300, W - margin.left - margin.right);
    const height = Math.max(200, H - margin.top - margin.bottom);
    const fullW = width + margin.left + margin.right;
    const fullH = height + margin.top + margin.bottom;

    svg.attr("width", fullW).attr("height", fullH)
      .attr("viewBox", `0 0 ${fullW} ${fullH}`);
    g.attr("transform", `translate(${margin.left},${margin.top})`);

    const baseDate = new Date(`${ymdKST(new Date())}T00:00:00+09:00`);
    const endDate = new Date(baseDate.getTime() + 86400000);

    const pToday = todayArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));
    const pYest = yestArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));
    const pD7 = d7MinMax.map(d => ({
      t: projectToBaseDate(baseDate, d.t), min: d.min, max: d.max
    }));

    const maxY = Math.max(10,
      ...pToday.map(d => d.v),
      ...pYest.map(d => d.v),
      ...pD7.map(d => d.max)
    );
    const x = d3.scaleTime().domain([baseDate, endDate]).range([0, width]);
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([height, 0]);

    const hourStep = 4;
    const tickFormat = d => fmtXTick(d, endDate);

    g.select(".x-grid").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickSize(-height).tickFormat(""));
    g.select(".y-grid")
      .call(d3.axisLeft(y).ticks(6).tickSize(-width).tickFormat(""));
    g.select(".x-axis").attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickFormat(tickFormat));
    g.select(".y-axis").call(d3.axisLeft(y).ticks(6));

    const line = d3.line().curve(d3.curveMonotoneX).x(d => x(d.t)).y(d => y(d.v));
    const area = d3.area().curve(d3.curveMonotoneX)
      .x(d => x(d.t)).y0(d => y(d.min)).y1(d => y(d.max));

    // 7-day range area
    const areaSel = g.select(".areas").selectAll("path.area.d7range")
      .data(pD7.length ? [pD7] : []);
    areaSel.exit().remove();
    areaSel.enter().append("path")
      .attr("class", "area d7range")
      .attr("fill", "var(--green)")
      .attr("opacity", 0.15)
      .attr("aria-describedby", "chart-tooltip")
      .merge(areaSel)
      .attr("d", area);

    // Lines: yesterday (bg) then today (fg)
    const lineGroups = [
      { key: "어제", data: pYest, cls: "yesterday", colorVar: "var(--blue)", width: 1.5, opacity: 0.8 },
      { key: "오늘", data: pToday, cls: "today", colorVar: "var(--orange)", width: 4, opacity: 1 }
    ];

    const linesG = g.select(".lines");
    lineGroups.forEach(grp => {
      const sel = linesG.selectAll(`path.line.${grp.cls}`)
        .data(grp.data.length ? [grp.data] : []);
      sel.exit().remove();
      sel.enter().append("path")
        .attr("class", `line ${grp.cls}`)
        .attr("fill", "none")
        .attr("aria-describedby", "chart-tooltip")
        .merge(sel)
        .attr("stroke", grp.colorVar)
        .attr("stroke-width", grp.width)
        .attr("opacity", grp.opacity)
        .attr("d", line);
    });

    // Today hover tooltip
    const todayPath = linesG.select("path.line.today");
    if (!todayPath.empty() && pToday.length) {
      const showAt = (event, d) => {
        tooltip.transition().duration(150).style("opacity", 0.95);
        tooltip.html(`오늘<br>시간: ${fmtTimeOnly.format(d.t)}<br>대수: ${d.v}`)
          .style("left", (event.pageX + 10) + "px")
          .style("top", (event.pageY - 28) + "px");
      };
      const moveAt = (event) => {
        tooltip.style("left", (event.pageX + 10) + "px")
          .style("top", (event.pageY - 28) + "px");
      };
      const hide = () => tooltip.transition().duration(300).style("opacity", 0);

      todayPath
        .on("mouseover touchstart", function(event) {
          const [mx] = d3.pointer(event, this);
          const x0 = x.invert(mx);
          const i = d3.bisectLeft(pToday.map(d => d.t), x0, 1);
          const d0 = pToday[i - 1];
          const d1 = pToday[i] || d0;
          const d = (x0 - d0.t > d1.t - x0) ? d1 : d0;
          showAt(event, d);
        })
        .on("mousemove touchmove", moveAt)
        .on("mouseout touchend", hide);
    }

    // End label/dot for today
    const endG = g.select(".end-marks");
    const last = pToday.length ? pToday[pToday.length - 1] : null;
    const endLabelSel = endG.selectAll("text.end-label.today").data(last ? [last] : []);
    endLabelSel.exit().remove();
    endLabelSel.enter().append("text")
      .attr("class", "end-label today")
      .attr("aria-hidden", "true")
      .merge(endLabelSel)
      .attr("x", d => Math.min(x(d.t) + 8, width - 80))
      .attr("y", d => y(d.v))
      .attr("opacity", 0.95)
      .text(d => `오늘 ${d.v} (${fmtTimeOnly.format(d.t)})`);

    const endDotSel = endG.selectAll("circle.end-dot.today").data(last ? [last] : []);
    endDotSel.exit().remove();
    endDotSel.enter().append("circle")
      .attr("class", "end-dot today")
      .attr("r", 4)
      .attr("fill", "var(--orange)")
      .attr("tabindex", "0")
      .merge(endDotSel)
      .attr("cx", d => x(d.t))
      .attr("cy", d => y(d.v))
      .attr("aria-label", d => `오늘 마지막 값: ${d.v} 대, 시간: ${fmtTimeOnly.format(d.t)}`)
      .attr("opacity", 0.95);

    // Legend
    const legendItems = [
      { key: "오늘", cls: "today", colorVar: "var(--orange)", sw: 3, fill: "none", op: 1 },
      { key: "어제", cls: "yesterday", colorVar: "var(--blue)", sw: 1.5, fill: "none", op: 1 },
      { key: "7일 범위", cls: "d7range", colorVar: "var(--green)", sw: 1.5, fill: "var(--green)", op: 0.6 }
    ];
    const legendG = g.select(".legend")
      .attr("transform", isSmall ? `translate(${width / 2 - 60}, -8)` : `translate(${width + 16}, 8)`);

    const itemSel = legendG.selectAll(".legend-item").data(legendItems, d => d.cls);
    itemSel.exit().remove();
    const itemEnter = itemSel.enter().append("g")
      .attr("class", d => `legend-item ${d.cls}`);
    itemEnter.append("line")
      .attr("x1", 0).attr("x2", 18).attr("y1", 6).attr("y2", 6);
    itemEnter.append("text")
      .attr("x", 24).attr("y", 9)
      .attr("dominant-baseline", "middle");

    const itemAll = itemEnter.merge(itemSel)
      .attr("transform", (d, i) => isSmall ? `translate(${i * 80}, 0)` : `translate(0, ${i * 20})`);
    itemAll.select("line")
      .attr("stroke", d => d.colorVar)
      .attr("stroke-width", d => d.sw)
      .attr("fill", d => d.fill)
      .attr("opacity", d => d.op);
    itemAll.select("text").text(d => d.key);

    // raise today on top
    linesG.select("path.line.today").raise();
    endG.selectAll(".end-label.today, .end-dot.today").raise();
  }

  // ---------- loader + app ----------
  let chartCtx = null;
  let cachedData = null;
  let failCount = 0;
  let retryTimer = null;

  function setStatus(text) {
    const el = document.getElementById("status");
    if (el) el.textContent = text;
  }

  function buildStatusLine(data) {
    const latest = data.latestT ? fmtTimeLabel.format(data.latestT) : "N/A";
    return `${LOT_NAME} · 오늘 ${data.todayArr.length}개 · 어제 ${data.yestArr.length}개 · 7일 min-max ${data.d7MinMax.length}개 · 최신: ${latest}`;
  }

  async function loadAndRender(path = DEFAULT_CSV) {
    try {
      if (!cachedData) setStatus("데이터 불러오는 중…");
      const resp = await fetch(path, { cache: "no-store" });
      if (!resp.ok) throw new Error(`CSV 로딩 실패: ${resp.status}`);
      const text = await resp.text();

      const data = parseCSV(text);
      cachedData = data;
      failCount = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

      renderChart(chartCtx, data);
      setStatus(buildStatusLine(data));
    } catch (e) {
      failCount += 1;
      console.error(e);
      setStatus(`로딩 실패(${failCount}): ${e.message} · 5초 후 재시도`);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => loadAndRender(path), 5000);
    }
  }

  function bindUI() {
    const chartEl = document.getElementById("chart");
    chartCtx = initChart(chartEl);

    const reloadBtn = document.getElementById("reloadBtn");
    reloadBtn && reloadBtn.addEventListener("click", () => loadAndRender());

    // polling that respects tab visibility
    setInterval(() => {
      if (document.visibilityState === "visible") loadAndRender();
    }, AUTO_REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") loadAndRender();
    });

    // resize re-renders from cache (no re-parse)
    window.addEventListener("resize", debounce(() => {
      if (cachedData) renderChart(chartCtx, cachedData);
    }, 200));

    // dismiss tooltip on outside tap (mobile)
    document.addEventListener("touchstart", (e) => {
      if (!chartEl.contains(e.target)) {
        chartCtx.tooltip.style("opacity", 0);
      }
    }, { passive: true });

    loadAndRender();
  }

  window.addEventListener("load", bindUI);
})();
