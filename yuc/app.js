'use strict';
// app.js — GitHub Pages/서버용 (자동 ./parking_log.csv 로드 + 리트라이 + 모바일 최적화)
(() => {
  // Query helper (CSS selectors)
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Ensure required DOM scaffolding exists
  function ensureScaffold() {
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
  }

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

  function dDaysAgoYmdKST(n) {
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
      .filter((r) => r.name === LOT_NAME && !Number.isNaN(r.v))
      .sort((a, b) => a.t - b.t);

    const todayStr = dDaysAgoYmdKST(0);
    const yestStr = dDaysAgoYmdKST(1);
    const d7Str = dDaysAgoYmdKST(7);

    const isSameDay = (d, ymd) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}` === ymd;
    };

    const today = all.filter((r) => isSameDay(r.t, todayStr));
    const yest = all.filter((r) => isSameDay(r.t, yestStr));
    const d7 = all.filter((r) => isSameDay(r.t, d7Str));

    return { today, yest, d7 };
  }

  function niceTickStep(domain) {
    const [min, max] = domain;
    const span = Math.max(1, max - min);
    if (span <= 5) return 1;
    if (span <= 10) return 1;
    if (span <= 20) return 2;
    if (span <= 50) return 5;
    if (span <= 100) return 10;
    if (span <= 200) return 20;
    return 50;
  }

  function formatTimeHHMM(d) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function withTZ(date, tz) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const parts = formatter.formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
    return new Date(iso);
  }

  async function fetchCSV(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    return txt;
  }

  function render(todayArr, yestArr, d7Arr) {
    ensureScaffold();

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
    const innerW = Math.max(300, W - margin.left - margin.right);
    const innerH = Math.max(200, H - margin.top - margin.bottom);

    const svg = d3.select("#chart").append("svg")
      .attr("width", innerW + margin.left + margin.right)
      .attr("height", innerH + margin.top + margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const all = [...todayArr, ...yestArr, ...d7Arr];
    const tExtent = d3.extent(all, (d) => d.t);
    const vExtent = d3.extent(all, (d) => d.v);

    const x = d3.scaleTime().domain(tExtent).range([0, innerW]);
    const step = niceTickStep(vExtent);
    const y = d3.scaleLinear().domain([Math.max(0, vExtent[0] - step), vExtent[1] + step]).range([innerH, 0]);

    const xAxis = d3.axisBottom(x).ticks(8).tickFormat((d) => formatTimeHHMM(withTZ(d, KST_TZ)));
    const yAxis = d3.axisLeft(y).ticks(Math.ceil((y.domain()[1] - y.domain()[0]) / step));

    g.append("g").attr("transform", `translate(0,${innerH})`).call(xAxis);
    g.append("g").call(yAxis);

    const line = d3.line().x((d) => x(d.t)).y((d) => y(d.v));

    const series = [
      { name: "오늘", data: todayArr },
      { name: "어제", data: yestArr },
      { name: "7일 전", data: d7Arr },
    ];

    const color = d3.scaleOrdinal()
      .domain(series.map((s) => s.name))
      .range(["#1f77b4", "#ff7f0e", "#2ca02c"]);

    series.forEach((s) => {
      g.append("path")
        .datum(s.data)
        .attr("fill", "none")
        .attr("stroke", color(s.name))
        .attr("stroke-width", 2)
        .attr("d", line);

      g.selectAll(`.dot-${s.name}`)
        .data(s.data)
        .enter()
        .append("circle")
        .attr("r", 2.5)
        .attr("cx", (d) => x(d.t))
        .attr("cy", (d) => y(d.v))
        .attr("fill", color(s.name))
        .append("title")
        .text((d) => `${s.name} ${fmtTimeLabel.format(d.t)} · ${d.v}`);
    });

    const legend = svg.append("g").attr("transform", `translate(${margin.left + innerW + 16}, ${margin.top})`);
    series.forEach((s, i) => {
      const y0 = i * 22;
      legend.append("rect").attr("x", 0).attr("y", y0 + 6).attr("width", 12).attr("height", 12).attr("fill", color(s.name));
      legend.append("text").attr("x", 18).attr("y", y0 + 16).text(s.name).attr("font-size", 12).attr("alignment-baseline", "middle");
    });
  }

  // 현재 로딩에 사용한 경로를 기억
  let currentPath = DEFAULT_CSV;

  async function loadAndRender(path) {
    currentPath = path;
    const status = document.getElementById("status") || { textContent: "" };
    status.textContent = "로딩 중…";
    try {
      const txt = await fetchCSV(path);
      const { today, yest, d7 } = parseCSV(txt);
      render(today, yest, d7);
      status.textContent = "완료";
    } catch (err) {
      console.error(err);
      status.textContent = `로딩 실패: ${err?.message || err}`;
      if (path === DEFAULT_CSV) {
        // 5초 후 자동 재시도
        setTimeout(() => loadAndRender(currentPath), 5000);
      }
    }
  }

  function bindUI() {
    ensureScaffold();

    const openBtn = $("#openBtn");
    const reloadBtn = $("#reloadBtn");

    openBtn && openBtn.addEventListener("click", async () => {
      alert("서버 배포용: ./parking_log.csv를 자동으로 읽습니다. 파일 교체 후 새로고침하세요.");
    });

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
      const { today, yest, d7 } = parseCSV(text);
      render(today, yest, d7);
    });

    fileInput && fileInput.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const { today, yest, d7 } = parseCSV(text);
      render(today, yest, d7);
    });

    reloadBtn && reloadBtn.addEventListener("click", () => loadAndRender(currentPath));

    // 자동 갱신 + 리사이즈
    setInterval(() => loadAndRender(currentPath), AUTO_REFRESH_MS);
    window.addEventListener("resize", () => loadAndRender(currentPath));

    // 초기 자동 로딩
    loadAndRender(DEFAULT_CSV);
  }

  window.addEventListener("DOMContentLoaded", bindUI);
})();
