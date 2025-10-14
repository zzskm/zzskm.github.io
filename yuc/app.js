'use strict';
// app.js — GitHub Pages/서버용 (자동 ./parking_log.csv 로드 + 리트라이 + 모바일 최적화)
(() => {
  const LOT_NAME = "수지노외 공영주차장";
  const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5분
  const DEFAULT_CSV = "./parking_log.csv";
  const KST_TZ = "Asia/Seoul";

  const fmtTimeLabel = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST_TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
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

  function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map((r) => r.split(","));
    const header = rows.shift();
    const tsIdx = header.indexOf("timestamp_kst");
    const nameIdx = header.indexOf("lot_name");
    const avIdx = header.indexOf("available");
    if (tsIdx < 0 || nameIdx < 0 || avIdx < 0) throw new Error("CSV 헤더 오류: timestamp_kst, lot_name, available 필요");

    const all = rows.map((r) => ({ t: new Date(r[tsIdx]), name: r[nameIdx], v: Number(r[avIdx]) }))
      .filter((x) => x.name === LOT_NAME && !isNaN(x.t.getTime()) && !isNaN(x.v));

    const t0 = ymdKST(new Date());
    const t1 = ymdDaysAgo(1);
    const t7 = ymdDaysAgo(7);

    const todayArr = [], yestArr = [], d7Arr = [];
    for (const d of all) {
      const ymd = ymdKST(d.t);
      if (ymd === t0) todayArr.push(d);
      else if (ymd === t1) yestArr.push(d);
      else if (ymd === t7) d7Arr.push(d);
    }
    todayArr.sort((a, b) => a.t - b.t);
    yestArr.sort((a, b) => a.t - b.t);
    d7Arr.sort((a, b) => a.t - b.t);
    return { todayArr, yestArr, d7Arr };
  }

  function projectToBaseDate(baseDate, originalDate) {
    return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(),
      originalDate.getHours(), originalDate.getMinutes(), originalDate.getSeconds(), originalDate.getMilliseconds());
  }

  function render(todayArr, yestArr, d7Arr) {
    const $ = (id) => document.getElementById(id);
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
      : d7Arr.length ? d7Arr[d7Arr.length - 1].t : null;
    const latestStr = latest ? fmtTimeLabel.format(latest) : "N/A";
    status.textContent = `${LOT_NAME} · 오늘 ${todayArr.length}개 · 어제 ${yestArr.length}개 · 7일 전 ${d7Arr.length}개 · 최신: ${latestStr}`;

    const container = $('#chart');
    const W = container.clientWidth || window.innerWidth || 1000;
    const H = container.clientHeight || 420;
    d3.select("#chart").selectAll("*").remove();

    const isSmall = (W || window.innerWidth) < 480;
    const margin = { top: 20, right: (isSmall ? 16 : 160), bottom: 48, left: 56 };
    const width = Math.max(320, W) - margin.left - margin.right;
    const height = Math.max(220, H) - margin.top - margin.bottom;

    const svg = d3.select("#chart")
      .append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
      .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    const baseDate = new Date(`${ymdKST(new Date())}T00:00:00+09:00`);
    const endDate = new Date(`${ymdKST(new Date())}T23:59:59+09:00`);

    const pToday = todayArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));
    const pYest  = yestArr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));
    const pD7    = d7Arr.map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }));

    const maxY = Math.max(10, ...(pToday.map(d=>d.v)), ...(pYest.map(d=>d.v)), ...(pD7.map(d=>d.v)));
    const x = d3.scaleTime().domain([baseDate, endDate]).range([0, width]);
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([height, 0]);

    const hourStep = isSmall ? 4 : 2;
    const xGrid = d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickSize(-height).tickFormat("");
    const yGrid = d3.axisLeft(y).ticks(6).tickSize(-width).tickFormat("");
    svg.append("g").attr("class", "grid").attr("transform", `translate(0,${height})`).call(xGrid);
    svg.append("g").attr("class", "grid").call(yGrid);

    svg.append("g").attr("class", "axis")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(d3.timeHour.every(hourStep)).tickFormat(d3.timeFormat("%H:%M")));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6));

    const line = d3.line().curve(d3.curveMonotoneX).x(d => x(d.t)).y(d => y(d.v));
    let groups = [
      { key: "오늘", data: pToday, cls: "today", colorVar: "var(--orange)" },
      { key: "어제", data: pYest, cls: "yesterday", colorVar: "var(--blue)" },
      { key: "7일 전", data: pD7, cls: "d7ago", colorVar: "var(--green)" },
    ].filter(g => g.data.length);
    groups.sort((a,b)=> (a.cls==="today") - (b.cls==="today"));

    groups.forEach(g => {
      svg.append("path")
        .datum(g.data)
        .attr("class", `line ${g.cls}`)
        .attr("stroke", g.colorVar)
        .attr("d", line)
        .attr("stroke-width", g.cls === "today" ? 3 : 1.5)
        .attr("fill", "none");

      const last = g.data[g.data.length - 1];
      if (last && g.cls === "today") {
        svg.append("text")
          .attr("class", `end-label ${g.cls}`)
          .attr("x", Math.min(x(last.t) + 8, width - 4))
          .attr("y", y(last.v))
          .text(`${g.key} ${last.v}`)
          .attr("opacity", 0.95);
      }
    });

    d3.selectAll('.line.today').raise();
    d3.selectAll('.end-label.today').raise();

    const legendData = groups.map(g => ({ key: g.key, cls: g.cls, colorVar: g.colorVar }));
    const legend = svg.append("g").attr("class", "legend")
      .attr("transform", isSmall ? `translate(${width - 120}, ${8})` : `translate(${width + 16}, ${8})`);
    const legendItem = legend.selectAll(".legend-item")
      .data(legendData)
      .enter()
      .append("g")
      .attr("class", d => `legend-item ${d.cls}`)
      .attr("transform", (d,i) => `translate(0, ${i * 20})`);
    legendItem.append("line")
      .attr("x1", 0).attr("x2", 18).attr("y1", 6).attr("y2", 6)
      .attr("stroke", d => d.colorVar)
      .attr("stroke-width", d => d.cls === "today" ? 3 : 1.5);
    legendItem.append("text")
      .attr("x", 24).attr("y", 9)
      .attr("dominant-baseline", "middle")
      .text(d => d.key);
  }

  // 현재 로딩에 사용한 경로를 기억
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

      const { todayArr, yestArr, d7Arr } = parseCSV(text);
      render(todayArr, yestArr, d7Arr);
    } catch (e) {
      statusEl.textContent = "로딩 실패: " + e.message;
      console.error(e);
      // 5초 후 재시도
      if (currentPath) {
        setTimeout(() => loadAndRender(currentPath), 5000);
      }
    }
  }

  function bindUI() {
    const $ = (id) => document.getElementById(id);
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

    const openBtn = $("openBtn");
    const reloadBtn = $("reloadBtn");

    openBtn && openBtn.addEventListener("click", async () => {
      alert("서버 배포용: ./parking_log.csv를 자동으로 읽습니다. 파일 교체 후 새로고침하세요.");
    });

    reloadBtn && reloadBtn.addEventListener("click", () => loadAndRender(currentPath));

    // 자동 갱신 + 리사이즈
    setInterval(() => loadAndRender(currentPath), AUTO_REFRESH_MS);
    window.addEventListener("resize", () => loadAndRender(currentPath));

    // 초기 자동 로딩
    loadAndRender(DEFAULT_CSV);
  }

  window.addEventListener("load", bindUI);
})();
