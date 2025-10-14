// app_repo.js — GitHub Pages/서버용 (수지노외 공영주차장 고정, D3 렌더, 테마 강화)
(() => {
  const LOT_NAME = "수지노외 공영주차장";
  const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5분
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
    if (tsIdx < 0 || nameIdx < 0 || avIdx < 0) throw new Error("CSV 헤더 오류");

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
    const status = document.getElementById("status");
    const latest = todayArr.length ? todayArr[todayArr.length - 1].t
      : yestArr.length ? yestArr[yestArr.length - 1].t
      : d7Arr.length ? d7Arr[d7Arr.length - 1].t : null;
    const latestStr = latest ? fmtTimeLabel.format(latest) : "N/A";
    status.textContent = `${LOT_NAME} · 오늘 ${todayArr.length}개 · 어제 ${yestArr.length}개 · 7일 전 ${d7Arr.length}개 · 최신: ${latestStr}`;

    // === 준비
    const container = document.getElementById("chart");
    const W = container.clientWidth || 1000;
    const H = container.clientHeight || 420;

    // 깨끗이
    d3.select("#chart").selectAll("*").remove();

    const margin = { top: 20, right: 120, bottom: 48, left: 56 };
    const width = Math.max(320, W) - margin.left - margin.right;
    const height = Math.max(220, H) - margin.top - margin.bottom;

    const svg = d3.select("#chart")
      .append("svg")
      .attr("class", "chart-root")
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

    const maxY = Math.max(
      10,
      ...(pToday.map(d=>d.v)), ...(pYest.map(d=>d.v)), ...(pD7.map(d=>d.v))
    );
    const x = d3.scaleTime().domain([baseDate, endDate]).range([0, width]);
    const y = d3.scaleLinear().domain([0, maxY]).nice().range([height, 0]);

    // === 그리드
    const xGrid = d3.axisBottom(x).ticks(d3.timeHour.every(2)).tickSize(-height).tickFormat(d3.timeFormat("%H:%M"));
    const yGrid = d3.axisLeft(y).ticks(6).tickSize(-width).tickFormat(d => d);
    svg.append("g").attr("class", "grid").attr("transform", `translate(0,${height})`).call(xGrid);
    svg.append("g").attr("class", "grid").call(yGrid);

    // === 축
    svg.append("g").attr("class", "axis")
      .attr("transform", `translate(0,${height})`)
      .call(d3.axisBottom(x).ticks(d3.timeHour.every(2)).tickFormat(d3.timeFormat("%H:%M")));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6));

    // === 라인 & 포인트
    const line = d3.line().curve(d3.curveMonotoneX).x(d => x(d.t)).y(d => y(d.v));

    const groups = [
      { key: "오늘", data: pToday, cls: "today"     , colorVar: "var(--orange)"   },
      { key: "어제", data: pYest , cls: "yesterday" , colorVar: "var(--blue)" },
      { key: "7일 전", data: pD7 , cls: "d7ago"     , colorVar: "var(--green)"  },
    ].filter(g => g.data.length);

    groups.forEach(g => {
      svg.append("path")
        .datum(g.data)
        .attr("class", `line ${g.cls}`)
        .attr("stroke", g.colorVar)
        .attr("d", line);

      // 포인트 (간소화: 마지막 1개만)
      const last = g.data[g.data.length - 1];
      if (last) {
        svg.append("circle")
          .attr("cx", x(last.t))
          .attr("cy", y(last.v))
          .attr("r", 3.5)
          .attr("fill", g.colorVar)
          .attr("opacity", 0.9);

        // 엔드 라벨: “이름 값”
        svg.append("text")
          .attr("class", `end-label ${g.cls}`)
          .attr("x", Math.min(x(last.t) + 8, width - 4))
          .attr("y", y(last.v))
          .text(`${g.key} ${last.v}`)
          .attr("opacity", 0.95);
      }
    });
  }

  async function loadAndRender() {
    const status = document.getElementById("status");
    try {
      status.textContent = "데이터 불러오는 중…";
      const text = await CSVLoader.readText(); // csv_repo.js가 fetch로 제공
      const { todayArr, yestArr, d7Arr } = parseCSV(text);
      render(todayArr, yestArr, d7Arr);
    } catch (e) {
      status.textContent = "로딩 실패: " + e.message;
      console.error(e);
    }
    // 5초 후 재시도 로직 (자동 로딩용)
    if (defaultPath) {
      console.warn('로딩 실패 - 5초 후 재시도');
      setTimeout(() => loadAndRender(defaultPath), 3000);
    }
  }

  // 버튼/자동 갱신/리사이즈
  document.getElementById("reloadBtn").onclick = loadAndRender;
  window.addEventListener("load", loadAndRender);
  setInterval(loadAndRender, AUTO_REFRESH_MS);
  window.addEventListener("resize", () => {
    // 간단히 다시 렌더(데이터 재요청 없이 상태 텍스트 유지)
    loadAndRender();
  });
})();
