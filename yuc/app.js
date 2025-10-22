'use strict';
// app.js — GitHub Pages/서버용 (자동 ./parking_log.csv 로드 + 리트라이 + 모바일 최적화)
(() => {
  const LOT_NAME = "수지노외 공영주차장";
  const AUTO_REFRESH_MS = 3 * 60 * 1000;
  const DEFAULT_CSV = "./parking_log.csv";
  const KST_TZ = "Asia/Seoul";

  const fmtTimeLabel = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST_TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: 'h23'
  });

  const fmtTimeOnly = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit", minute: "2-digit", hourCycle: 'h23'
  });

  function ymdKST(date) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: KST_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date).reduce((acc, cur) => (acc[cur.type] = cur.value, acc), {});
    return `${p.year}-${p.month}-${p.day}`;
  }
  function ymdDaysAgo(n) {
    const now = new Date();
    const kstDate = new Intl.DateTimeFormat("en-CA", { timeZone: KST_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const kstMidnight = new Date(`${kstDate}T00:00:00+09:00`);
    const d = new Date(kstMidnight.getTime() - n * 24 * 60 * 60 * 1000);
    return ymdKST(d);
  }

  function downsample(data, intervalMs = 5 * 60 * 1000) {
    if (data.length <= 100) return data;
    const result = [];
    let lastTime = null;
    for (const d of data) {
      if (!lastTime || (d.t - lastTime) >= intervalMs) {
        result.push(d);
        lastTime = d.t;
      }
    }
    return result;
  }

  function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map((r) => r.split(","));
    const header = rows.shift();
    const tsIdx = header.indexOf("timestamp_kst");
    const nameIdx = header.indexOf("lot_name");
    const avIdx = header.indexOf("available");
    if (tsIdx < 0 || nameIdx < 0 || avIdx < 0)
      throw new Error("CSV 헤더 오류: timestamp_kst, lot_name, available 필요");

    const all = rows
      .map((r) => ({ t: new Date(r[tsIdx]), name: r[nameIdx], v: Number(r[avIdx]) }))
      .filter((r) => r.name === LOT_NAME && !Number.isNaN(r.v))
      .sort((a, b) => a.t - b.t);

    const t0 = ymdDaysAgo(0);
    const t1 = ymdDaysAgo(1);
    const t7 = ymdDaysAgo(7);
    const t7start = ymdDaysAgo(7);

    const todayArr = [];
    const yestArr = [];
    const d7MinMax = [];

    const minMaxByTime = {};
    for (const d of all) {
      const ymd = ymdKST(d.t);
      if (ymd === t0) todayArr.push(d);
      else if (ymd === t1) yestArr.push(d);
      else if (ymd >= t7start && ymd <= t0) {
        const timeKey = `${d.t.getHours()}:${d.t.getMinutes()}`;
        if (!minMaxByTime[timeKey]) {
          minMaxByTime[timeKey] = { min: Infinity, max: -Infinity, t: d.t };
        }
        minMaxByTime[timeKey].min = Math.min(minMaxByTime[timeKey].min, d.v);
        minMaxByTime[timeKey].max = Math.max(minMaxByTime[timeKey].max, d.v);
      }
    }

    for (const key in minMaxByTime) {
      d7MinMax.push({
        t: minMaxByTime[key].t,
        min: minMaxByTime[key].min,
        max: minMaxByTime[key].max
      });
    }

    todayArr.sort((a, b) => a.t - b.t);
    yestArr.sort((a, b) => a.t - b.t);
    d7MinMax.sort((a, b) => a.t - b.t);

    if (todayArr.length > 0) {
      const last = todayArr[todayArr.length - 1];
      todayArr.push({ t: new Date(), name: last.name, v: last.v });
    }

    return {
      todayArr: downsample(todayArr),
      yestArr: downsample(yestArr),
      d7MinMax: downsample(d7MinMax)
    };
  }

  function projectToBaseDate(baseDate, originalDate) {
    return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(),
      originalDate.getHours(), originalDate.getMinutes(), originalDate.getSeconds(), originalDate.getMilliseconds());
  }

  function updateChart(todayArr, yestArr, d7MinMax, isInitial = false) {
    const $ = (sel) => document.querySelector(sel);
    if (!$('#chart')) {
      const div = document.createElement('div');
      div.id = 'chart';
      div.setAttribute('role', 'img');
      document.body.appendChild(div);
    }
    if (!$('#status')) {
      const div = document.createElement('div');
      div.id = 'status';
      div.textContent = '상태 표시';
      document.body.prepend(div);
    }

    const status = $('#status');
    const latest = todayArr.length ? todayArr[todayArr.length - 1].t
      : yestArr.length ? yestArr[yestArr.length - 1].t
      : d7MinMax.length ? d7MinMax[d7MinMax.length - 1].t : null;
    const latestStr = latest ? fmtTimeLabel.format(latest) : "N/A";
    status.textContent = `${LOT_NAME} · 오늘 ${todayArr.length}개 · 어제 ${yestArr.length}개 · 7일 min-max ${d7MinMax.length}개 · 최신: ${latestStr}`;

    const container = document.getElementById('chart');
    const W = container.clientWidth || window.innerWidth || 1000;
    const H = Math.max(200, W * 0.6);

    if (isInitial) d3.select("#chart").selectAll("*").remove();

    const isSmall = W < 480;
    const margin = { top: 16, right: (isSmall ? 48 : 200), bottom: 44, left: (isSmall ? 32 : 48) }; // Increased right margin
    const width = Math.max(300, W - margin.left - margin.right);
    const height = Math.max(200, H - margin.top - margin.bottom);

    const svg = isInitial ? d3.select("#chart").append("svg")
      .attr("class", "chart-svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
      .attr("role", "img")
      .attr("aria-label", `${LOT_NAME} 주차 가능 대수 추이 차트`)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`)
      : d3.select("#chart").select("svg").select("g");

    const baseDate = new Date(`${ymdKST(new Date())}T00:00:00+09:00`);
    const endDate = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);

    const pToday = todayArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));
    const pYest = yestArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));
    const pD7MinMax = d7MinMax.map(d => ({
      t: projectToBaseDate(baseDate, d.t),
      min: d.min === Infinity ? 0 : d.min,
      max: d.max === -Infinity ? 0 : d.max
    }));

    const maxY = Math.max(10, 
      ...pToday.map(d => d.v), 
      ...pYest.map(d => d.v), 
      ...pD7MinMax.map(d => d.max)
    );
    const x = d3.scaleTime().domain([baseDate, endDate]).range([0, width]);
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([height, 0]);

    const hourStep = 4;

    if (isInitial) {
      const xGrid = d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickSize(-height).tickFormat("");
      const yGrid = d3.axisLeft(y).ticks(6).tickSize(-width).tickFormat("");
      svg.append("g").attr("class", "grid x-grid").attr("transform", `translate(0,${height})`).call(xGrid);
      svg.append("g").attr("class", "grid y-grid").call(yGrid);

      const fmtTick = (d) => {
        const endT = endDate.getTime();
        const t = d.getTime();
        if (t === endT) return "24:00";
        return d3.timeFormat("%H:%M")(d);
      };
      svg.append("g").attr("class", "axis x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickFormat(fmtTick));
      svg.append("g").attr("class", "axis y-axis").call(d3.axisLeft(y).ticks(6));
    } else {
      svg.select(".grid.x-grid").call(d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickSize(-height).tickFormat(""));
      svg.select(".grid.y-grid").call(d3.axisLeft(y).ticks(6).tickSize(-width).tickFormat(""));
      svg.select(".axis.x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickFormat(fmtTick));
      svg.select(".axis.y-axis").call(d3.axisLeft(y).ticks(6));
    }

    if (isInitial) {
      d3.select("body").selectAll(".tooltip").remove();
      d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("background", "white")
        .style("border", "1px solid #ccc")
        .style("padding", "5px")
        .style("opacity", 0)
        .attr("role", "tooltip")
        .attr("id", "chart-tooltip")
        .attr("aria-live", "polite");
    }
    const tooltip = d3.select(".tooltip");

    const line = d3.line().curve(d3.curveMonotoneX).x(d => x(d.t)).y(d => y(d.v));
    
    const area = d3.area()
      .curve(d3.curveMonotoneX)
      .x(d => x(d.t))
      .y0(d => y(d.min))
      .y1(d => y(d.max));

    let groups = [
      { key: "오늘", data: pToday, cls: "today", colorVar: "var(--orange)" },
      { key: "어제", data: pYest, cls: "yesterday", colorVar: "var(--blue)" },
      { key: "7일 범위", data: pD7MinMax, cls: "d7range", colorVar: "var(--green)", isArea: true }
    ].filter(g => g.data.length);
    groups.sort((a,b) => (a.cls==="today") - (b.cls==="today"));

    groups.forEach(g => {
      if (g.isArea) {
        const path = svg.selectAll(`.area.${g.cls}`)
          .data([g.data])
          .join("path")
          .attr("class", `area ${g.cls}`)
          .attr("fill", g.colorVar)
          .attr("opacity", 0.2)
          .attr("aria-describedby", "chart-tooltip");

        path.transition().duration(1000)
          .attrTween("d", function(d) {
            const l = this.getTotalLength ? this.getTotalLength() : 100;
            return t => {
              const p = l * t;
              return area(d.slice(0, Math.floor(d.length * t)));
            };
          });
      } else {
        const path = svg.selectAll(`.line.${g.cls}`)
          .data([g.data])
          .join("path")
          .attr("class", `line ${g.cls}`)
          .attr("stroke", g.colorVar)
          .attr("stroke-width", g.cls === "today" ? 3 : 1.5)
          .attr("fill", "none")
          .attr("aria-describedby", "chart-tooltip");

        path.transition().duration(1000)
          .attrTween("d", function(d) {
            const l = this.getTotalLength();
            return t => {
              const p = l * t;
              return line(d.slice(0, Math.floor(d.length * t)));
            };
          });

        if (g.cls === "today") {
          svg.selectAll(`.dot-${g.cls}`)
            .data(g.data)
            .join("circle")
            .attr("class", `dot-${g.cls}`)
            .attr("cx", d => x(d.t))
            .attr("cy", d => y(d.v))
            .attr("r", 0)
            .attr("fill", g.colorVar)
            .style("opacity", 0);

          path.on("mouseover touchstart", function(event, data) {
            event.preventDefault();
            const [mouseX] = d3.pointer(event);
            const x0 = x.invert(mouseX);
            const i = d3.bisectLeft(data.map(d => d.t), x0, 1);
            const d0 = data[i - 1];
            const d1 = data[i] || d0;
            const d = x0 - d0.t > d1.t - x0 ? d1 : d0;

            tooltip.transition().duration(200).style("opacity", .9);
            tooltip.html(`${g.key}<br>시간: ${fmtTimeOnly.format(d.t)}<br>대수: ${d.v}`)
              .style("left", (event.pageX + 10) + "px")
              .style("top", (event.pageY - 28) + "px");
          })
          .on("mousemove touchmove", function(event) {
            event.preventDefault();
            tooltip.style("left", (event.pageX + 10) + "px")
              .style("top", (event.pageY - 28) + "px");
          })
          .on("mouseout touchend", function() {
            tooltip.transition().duration(500).style("opacity", 0);
          });
        }

        const last = g.data[g.data.length - 1];
        if (last && g.cls === "today") {
          svg.selectAll(`.end-label.${g.cls}`)
            .data([last])
            .join("text")
            .attr("class", `end-label ${g.cls}`)
            .attr("x", Math.min(x(last.t) + 8, width - 80)) // Adjusted to account for increased right margin
            .attr("y", y(last.v))
            .text(`${g.key} ${last.v} (${fmtTimeOnly.format(last.t)})`)
            .attr("opacity", 0.95)
            .attr("aria-hidden", "true");

          svg.selectAll(`.end-dot.${g.cls}`)
            .data([last])
            .join("circle")
            .attr("class", `end-dot ${g.cls}`)
            .attr("cx", x(last.t))
            .attr("cy", y(last.v))
            .attr("r", 4)
            .attr("fill", g.colorVar)
            .attr("tabindex", "0")
            .attr("aria-label", `오늘 마지막 값: ${last.v} 대, 시간: ${fmtTimeOnly.format(last.t)}`)
            .transition().duration(1000)
            .attr("opacity", 0.95);
        }
      }
    });

    d3.selectAll('.line.today').raise();
    d3.selectAll('.end-label.today').raise();
    d3.selectAll('.end-dot.today').raise();

    const legendData = groups.map(g => ({ key: g.key, cls: g.cls, colorVar: g.colorVar }));
    const legend = svg.selectAll(".legend")
      .data([null])
      .join("g")
      .attr("class", "legend")
      .attr("transform", isSmall ? `translate(${width / 2 - 60}, -8)` : `translate(${width + 16}, ${8})`);
    const legendItem = legend.selectAll(".legend-item")
      .data(legendData)
      .join("g")
      .attr("class", d => `legend-item ${d.cls}`)
      .attr("transform", (d,i) => isSmall ? `translate(${i * 80}, 0)` : `translate(0, ${i * 20})`);
    legendItem.selectAll("line")
      .data(d => [d])
      .join("line")
      .attr("x1", 0).attr("x2", 18).attr("y1", 6).attr("y2", 6)
      .attr("stroke", d => d.colorVar)
      .attr("stroke-width", d => d.cls === "today" ? 3 : d.cls === "d7range" ? 1.5 : 1.5)
      .attr("fill", d => d.cls === "d7range" ? d.colorVar : "none")
      .attr("opacity", d => d.cls === "d7range" ? 0.2 : 1);
    legendItem.selectAll("text")
      .data(d => [d])
      .join("text")
      .attr("x", 24).attr("y", 9)
      .attr("dominant-baseline", "middle")
      .text(d => d.key);
  }

  let currentPath = DEFAULT_CSV;

  async function loadAndRender(path) {
    const statusEl = document.getElementById("status") || { textContent: "" };
    try {
      statusEl.textContent = "데이터 불러오는 중…";
      const csvPath = path || currentPath || DEFAULT_CSV;
      currentPath = csvPath;

      const resp = await fetch(csvPath, { cache: "no-store" });
      if (!resp.ok) throw new Error(`CSV 로딩 실패: ${resp.status}`);
      const text = await resp.text();

      const { todayArr, yestArr, d7MinMax } = parseCSV(text);
      updateChart(todayArr, yestArr, d7MinMax, true);
    } catch (e) {
      statusEl.textContent = "로딩 실패: " + e.message;
      console.error(e);
      if (currentPath) {
        setTimeout(() => loadAndRender(currentPath), 5000);
      }
    }
  }

  function debounce(fn, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), wait);
    };
  }

  function bindUI() {
    const $ = (sel) => document.querySelector(sel);
    if (!$('#chart')) {
      const div = document.createElement('div');
      div.id = 'chart';
      div.setAttribute('role', 'img');
      document.body.appendChild(div);
    }
    if (!$('#status')) {
      const div = document.createElement('div');
      div.id = 'status';
      div.textContent = '상태 표시';
      document.body.prepend(div);
    }

    const openBtn = $("#openBtn");
    const reloadBtn = $("#reloadBtn");

    const dropZone = document.body;
    const fileInput = document.getElementById("fileInput");

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });
    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      if (!file.name.endsWith(".csv")) return alert("CSV 파일만 가능합니다.");
      const text = await file.text();
      const { todayArr, yestArr, d7MinMax } = parseCSV(text);
      updateChart(todayArr, yestArr, d7MinMax, true);
    });

    fileInput && fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const { todayArr, yestArr, d7MinMax } = parseCSV(text);
      updateChart(todayArr, yestArr, d7MinMax, true);
    });

    reloadBtn && reloadBtn.addEventListener("click", () => loadAndRender(currentPath));

    setInterval(() => loadAndRender(currentPath), AUTO_REFRESH_MS);

    window.addEventListener("resize", debounce(() => {
      const { todayArr, yestArr, d7MinMax } = parseCSV(lastText || "");
      updateChart(todayArr, yestArr, d7MinMax, false);
    }, 200));

    loadAndRender(DEFAULT_CSV);
  }

  let lastText = "";
  window.addEventListener("load", bindUI);
})();
