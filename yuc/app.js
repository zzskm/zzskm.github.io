'use strict';
(() => {
  const LOT_NAME = "수지노외 공영주차장";
  const AUTO_REFRESH_MS = 60 * 1000;
  const DEFAULT_CSV = "./parking_log.csv";
  const KST_TZ = "Asia/Seoul";
  const STALE_MINUTES = 75;

  // 만차 판정 기준 (scripts/build_stats.py와 동일)
  const LOW = 2;
  const SAFE = 5;
  const MORNING_START_MIN = 7 * 60;
  const MORNING_END_MIN = 11 * 60;
  const FILL_LOOKBACK_DAYS = 10;
  const MIN_FILL_DAYS = 3;

  // 그리기 순서: 옛날 → 오늘 (오늘이 맨 위)
  const SERIES = [
    { daysAgo: 3, key: "3일 전", cls: "d3ago", color: "var(--gray)", width: 1, opacity: 0.35 },
    { daysAgo: 2, key: "2일 전", cls: "d2ago", color: "var(--purple)", width: 1, opacity: 0.45 },
    { daysAgo: 1, key: "어제", cls: "yesterday", color: "var(--blue)", width: 1.5, opacity: 0.8 },
    { daysAgo: 0, key: "오늘", cls: "today", color: "var(--orange)", width: 4, opacity: 1 }
  ];
  const BAND_TOGGLE = { key: "7일 범위", cls: "d7range", color: "var(--green)" };

  const VISIBLE_KEY = "yuc.series";
  const visible = { today: true, yesterday: true, d2ago: true, d3ago: true, d7range: true };
  try {
    Object.assign(visible, JSON.parse(localStorage.getItem(VISIBLE_KEY)) || {});
  } catch (e) { /* 저장값 손상 시 기본값 사용 */ }
  function saveVisible() {
    try { localStorage.setItem(VISIBLE_KEY, JSON.stringify(visible)); } catch (e) { /* ignore */ }
  }

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

  // 최근 평일들의 "오전에 처음 LOW대 이하가 된 시각"을 모아 분위수를 낸다.
  // ponytail: build_stats.py와 같은 계산을 프론트에서 다시 함. 거기 품질 필터(gap<=25분)가
  // 실제 수집 간격(30~50분)에서 거의 모든 날을 탈락시켜 daily_stats.json이 상시 비어 있기 때문.
  // 수집 주기를 촘촘하게 만들면 daily_stats.json 하나로 되돌리고 이 함수는 지울 것.
  function computeFillStats(all, todayYmd) {
    const byDay = new Map();
    for (const d of all) {
      if (d.ymd >= todayYmd) continue;
      if (d.hm < MORNING_START_MIN || d.hm > MORNING_END_MIN) continue;
      if (!byDay.has(d.ymd)) byDay.set(d.ymd, []);
      byDay.get(d.ymd).push(d);
    }

    const mins = [];
    let totalDays = 0;
    for (const ymd of [...byDay.keys()].sort().reverse()) {
      // 정오 기준으로 KST 요일 판정 (UTC 변환에 안전)
      const dow = new Date(`${ymd}T12:00:00+09:00`).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const rows = byDay.get(ymd);
      if (rows.length < 3) continue;

      totalDays += 1;
      let prev = null;
      for (const r of rows) {
        if (r.v <= LOW) {
          // 직전 정상 샘플과 관측 시점의 중점 = 실제 만차 시각의 최선 추정
          mins.push(prev ? (prev.hm + r.hm) / 2 : r.hm);
          break;
        }
        prev = r;
      }
      if (totalDays >= FILL_LOOKBACK_DAYS) break;
    }

    if (mins.length < MIN_FILL_DAYS) {
      return { filledDays: mins.length, totalDays, median: null };
    }
    mins.sort((a, b) => a - b);
    return {
      filledDays: mins.length,
      totalDays,
      p25: d3.quantile(mins, 0.25),
      median: d3.quantile(mins, 0.5),
      p75: d3.quantile(mins, 0.75)
    };
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
      .map(r => {
        const ts = r[tsIdx];
        const t = new Date(ts);
        // 타임스탬프가 KST 오프셋이면 문자열에서 날짜/분을 바로 읽는다 (행마다 Intl 호출 회피)
        const kst = typeof ts === "string" && ts.endsWith("+09:00");
        return {
          t, name: r[nameIdx], v: Number(r[avIdx]),
          ymd: kst ? ts.slice(0, 10) : null,
          hm: kst ? Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16)) : null
        };
      })
      .filter(r => r.name === LOT_NAME && !Number.isNaN(r.v) && !Number.isNaN(r.t.getTime()))
      .map(r => {
        if (r.ymd) return r;
        const [h, m] = fmtTimeOnly.format(r.t).split(":").map(Number);
        return { ...r, ymd: ymdKST(r.t), hm: h * 60 + m };
      })
      .sort((a, b) => a.t - b.t);

    const targets = [0, 1, 2, 3].map(n => ymdDaysAgo(n));
    const t7start = ymdDaysAgo(7);

    const dayArrs = [[], [], [], []];
    const bucketsByHour = Array.from({ length: 24 }, () => []);

    for (const d of all) {
      const idx = targets.indexOf(d.ymd);
      if (idx >= 0) dayArrs[idx].push(d);
      if (d.ymd >= t7start && d.ymd < targets[0]) {
        bucketsByHour[Math.floor(d.hm / 60)].push(d.v);
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

    const todayArr = dayArrs[0];
    const latestReal = todayArr.length ? { ...todayArr[todayArr.length - 1] } : null;
    if (latestReal) {
      // 오늘 라인이 현재 시각까지 이어지도록 마지막 값을 한 점 더 밀어넣음
      todayArr.push({ t: new Date(), name: latestReal.name, v: latestReal.v });
    }

    let latestT = latestReal ? latestReal.t : null;
    if (!latestT) {
      for (const arr of dayArrs) {
        if (arr.length) { latestT = arr[arr.length - 1].t; break; }
      }
    }

    return {
      dayArrs: dayArrs.map(a => downsample(a)),
      d7MinMax,
      latestReal,
      latestT,
      fill: computeFillStats(all, targets[0])
    };
  }

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
    g.append("g").attr("class", "bands");
    g.append("g").attr("class", "lines");
    g.append("g").attr("class", "end-marks");
    g.append("g").attr("class", "cursor").attr("opacity", 0);
    g.append("rect").attr("class", "overlay").attr("fill", "transparent");

    d3.select("body").selectAll(".tooltip").remove();
    const tooltip = d3.select(container).append("div")
      .attr("class", "tooltip")
      .attr("id", "chart-tooltip")
      .attr("role", "tooltip")
      .attr("aria-live", "polite")
      .style("opacity", 0);

    return { container, svg, g, tooltip, hideCursor: null };
  }

  function renderChart(ctx, data) {
    const { container, svg, g, tooltip } = ctx;
    const { dayArrs, d7MinMax, fill } = data;

    const W = container.clientWidth || window.innerWidth || 1000;
    const isSmall = W < 480;
    // 값 범위가 0~20 수준이라 데스크톱에서 비율만 따르면 세로로 지나치게 길어짐
    const H = isSmall ? Math.max(240, W * 0.75) : Math.min(Math.max(260, W * 0.40), 400);
    const margin = { top: 16, right: isSmall ? 12 : 48, bottom: 44, left: isSmall ? 32 : 48 };
    // 가로 스크롤이 생기지 않도록 컨테이너 폭을 넘지 않게 함
    const width = Math.max(160, W - margin.left - margin.right);
    const height = Math.max(200, H - margin.top - margin.bottom);
    const fullW = width + margin.left + margin.right;
    const fullH = height + margin.top + margin.bottom;

    svg.attr("width", fullW).attr("height", fullH)
      .attr("viewBox", `0 0 ${fullW} ${fullH}`);
    g.attr("transform", `translate(${margin.left},${margin.top})`);

    const baseDate = new Date(`${ymdKST(new Date())}T00:00:00+09:00`);
    const endDate = new Date(baseDate.getTime() + 86400000);

    const pSeries = SERIES.map(s => ({
      s,
      data: visible[s.cls]
        ? dayArrs[s.daysAgo].map(d => ({ t: projectToBaseDate(baseDate, d.t), v: d.v }))
        : []
    }));
    const pD7 = visible.d7range
      ? d7MinMax.map(d => ({ t: projectToBaseDate(baseDate, d.t), min: d.min, max: d.max }))
      : [];

    const maxY = Math.max(10,
      ...pSeries.flatMap(p => p.data.map(d => d.v)),
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

    const areaSel = g.select(".areas").selectAll("path.area.d7range")
      .data(pD7.length ? [pD7] : []);
    areaSel.exit().remove();
    areaSel.enter().append("path")
      .attr("class", "area d7range")
      .attr("fill", "var(--green)")
      .attr("opacity", 0.15)
      .merge(areaSel)
      .attr("d", area);

    const bandG = g.select(".bands");
    bandG.selectAll("*").remove();
    if (fill && fill.median !== null) {
      const atMin = m => x(new Date(baseDate.getTime() + m * 60000));

      bandG.append("rect")
        .attr("class", "band-p25-p75")
        .attr("x", atMin(fill.p25))
        .attr("width", Math.max(1, atMin(fill.p75) - atMin(fill.p25)))
        .attr("y", 0)
        .attr("height", height)
        .attr("fill", "var(--danger)")
        .attr("opacity", 0.18);

      bandG.append("line")
        .attr("class", "median")
        .attr("x1", atMin(fill.median))
        .attr("x2", atMin(fill.median))
        .attr("y1", 0)
        .attr("y2", height)
        .attr("stroke", "var(--danger)")
        .attr("stroke-width", 2.5)
        .attr("stroke-dasharray", "4 3")
        .attr("opacity", 0.85);

      const label = bandG.append("text")
        .attr("class", "band-label")
        .attr("y", 12)
        .attr("fill", "var(--danger)")
        .text(`만차 예상 ${fmtMinutes(fill.median)}`);
      // 우측 끝에서 잘리면 중앙선 왼쪽으로 옮김
      const labelW = label.node().getComputedTextLength();
      const mx = atMin(fill.median);
      label.attr("x", mx + 4 + labelW > width ? mx - 4 - labelW : mx + 4);
    }

    const linesG = g.select(".lines");
    pSeries.forEach(({ s, data: pd }) => {
      const sel = linesG.selectAll(`path.line.${s.cls}`)
        .data(pd.length ? [pd] : []);
      sel.exit().remove();
      sel.enter().append("path")
        .attr("class", `line ${s.cls}`)
        .attr("fill", "none")
        .merge(sel)
        .attr("stroke", s.color)
        .attr("stroke-width", s.width)
        .attr("opacity", s.opacity)
        .attr("d", line);
    });

    const endG = g.select(".end-marks");
    const pToday = pSeries[pSeries.length - 1].data;
    const last = pToday.length ? pToday[pToday.length - 1] : null;
    const endLabelSel = endG.selectAll("text.end-label.today").data(last ? [last] : []);
    endLabelSel.exit().remove();
    endLabelSel.enter().append("text")
      .attr("class", "end-label today")
      .attr("aria-hidden", "true")
      .merge(endLabelSel)
      .attr("x", d => Math.min(x(d.t) + 8, width - 110))
      .attr("y", d => Math.max(y(d.v) - 8, 12))
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

    // --- 툴팁: plot 전체를 덮는 overlay + 크로스헤어 (터치/마우스 공용) ---
    const cursorG = g.select(".cursor");
    cursorG.selectAll("*").remove();
    cursorG.append("line").attr("class", "cursor-line")
      .attr("y1", 0).attr("y2", height);

    const withData = pSeries.filter(p => p.data.length);
    const bisect = d3.bisector(d => d.t).left;

    const hideCursor = () => {
      tooltip.style("opacity", 0);
      cursorG.attr("opacity", 0);
    };
    ctx.hideCursor = hideCursor;

    const overlay = g.select("rect.overlay")
      .attr("width", width).attr("height", height);

    const showAt = (event) => {
      if (!withData.length) return;
      // TouchEvent 자체에는 clientX가 없음 — 첫 접점으로 정규화
      const src = (event.touches && event.touches[0]) || event;
      const [mx] = d3.pointer(src, overlay.node());
      const cx = Math.max(0, Math.min(width, mx));
      const x0 = x.invert(cx);

      // 커서 시각에서 30분 넘게 떨어진 시리즈는 표시하지 않음
      // (오늘 라인은 현재까지만 있으므로 미래 구간에 마지막 값이 붙어 보이는 것 방지)
      const SNAP_MS = 30 * 60 * 1000;
      const rows = withData.map(({ s, data: pd }) => {
        const i = bisect(pd, x0, 1);
        const d0 = pd[i - 1];
        const d1 = pd[i] || d0;
        const d = (x0 - d0.t > d1.t - x0) ? d1 : d0;
        return { s, d };
      }).filter(r => Math.abs(r.d.t - x0) <= SNAP_MS);
      if (!rows.length) { hideCursor(); return; }

      cursorG.attr("opacity", 1);
      cursorG.select(".cursor-line").attr("x1", cx).attr("x2", cx);
      const dotSel = cursorG.selectAll("circle.cursor-dot").data(rows, r => r.s.cls);
      dotSel.exit().remove();
      dotSel.enter().append("circle")
        .attr("class", "cursor-dot")
        .attr("r", 3.5)
        .merge(dotSel)
        .attr("fill", r => r.s.color)
        .attr("cx", r => x(r.d.t))
        .attr("cy", r => y(r.d.v));

      tooltip.html(
        `<div class="tt-time">${fmtTimeOnly.format(x0)}</div>` +
        rows.slice().reverse().map(r =>
          `<div class="tt-row"><span class="tt-dot" style="background:${r.s.color}"></span>${r.s.key} <b>${r.d.v}</b></div>`
        ).join("")
      ).style("opacity", 0.95);

      // 손가락/커서에 가리지 않도록 차트 상단에 표시, 우측 끝에서는 좌측으로 플립
      const ttNode = tooltip.node();
      const ttW = ttNode.offsetWidth || 90;
      let left = margin.left + cx + 12;
      if (left + ttW > container.clientWidth - 4) left = margin.left + cx - ttW - 12;
      tooltip.style("left", Math.max(4, left) + "px").style("top", "4px");
    };

    overlay
      .on("mousemove touchstart touchmove", showAt)
      .on("mouseleave", hideCursor);
    // touchend에서는 유지 — 차트 밖 터치(bindUI)가 닫기 담당

    linesG.select("path.line.today").raise();
    endG.selectAll(".end-label.today, .end-dot.today").raise();
    cursorG.raise();
    overlay.raise();
  }

  function fmtMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const LEVELS = {
    "now-low": "혼잡",
    "now-mid": "보통",
    "now-ok": "여유"
  };
  function nowLevelClass(v) {
    return v <= LOW ? "now-low" : v <= SAFE ? "now-mid" : "now-ok";
  }

  function renderHero(data) {
    const panel = document.getElementById("hero");
    if (!panel) return;

    const lr = data.latestReal;
    if (!lr) {
      panel.innerHTML = "<div class='summary-empty'>오늘 수집된 데이터가 아직 없습니다</div>";
      return;
    }

    const level = nowLevelClass(lr.v);
    const ageMin = Math.round((Date.now() - lr.t.getTime()) / 60000);
    const ageText = ageMin < 1 ? "방금 전" : `${ageMin}분 전`;
    const staleText = ageMin > STALE_MINUTES ? " · <b>오래된 데이터</b>" : "";

    const now = new Date();
    const hb = data.d7MinMax[hourKST(now)];
    const f = data.fill;

    let fillCol;
    if (f && f.median !== null) {
      // "HH:MM" → 자정 기준 분 (30분 오프셋 표준시 브라우저에서도 KST 기준 유지)
      const [nh, nm] = fmtTimeOnly.format(now).split(":").map(Number);
      const nowMin = nh * 60 + nm;
      const eta = nowMin < f.p25 ? `약 ${Math.round(f.median - nowMin)}분 남음`
        : nowMin <= f.p75 ? "지금이 만차 시간대"
          : "예상 시간대 지남";
      fillCol = `
        <div class="hero-col">
          <span class="k">만차 예상 (평일 오전)</span>
          <span class="big">${fmtMinutes(f.median)}</span>
          <span class="sub">${fmtMinutes(f.p25)}~${fmtMinutes(f.p75)} · ${eta}</span>
        </div>`;
    } else {
      const n = f ? f.filledDays : 0;
      fillCol = `
        <div class="hero-col">
          <span class="k">만차 예상</span>
          <span class="sub">통계 수집 중 (평일 ${n}/${MIN_FILL_DAYS}일)</span>
        </div>`;
    }

    const facts = [
      f && f.median !== null ? `만차 빈도 <b>${f.totalDays}일 중 ${f.filledDays}일</b> (${LOW}대 이하)` : "",
      hb ? `이 시간대 최근 7일 <b>${hb.min}~${hb.max}대</b>` : "",
      `${ageText} · ${fmtTimeOnly.format(lr.t)} 기준${staleText}`
    ].filter(Boolean);

    panel.innerHTML = `
      <div class="hero-now">
        <div class="now-num ${level}">${lr.v}<span class="now-unit">대</span></div>
        <span class="pill ${level}">${LEVELS[level]}</span>
      </div>
      ${fillCol}
      <div class="hero-col facts">
        ${facts.map(t => `<span>${t}</span>`).join("")}
      </div>
    `;
  }

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
    return `${LOT_NAME} · 최신: ${latest}`;
  }

  function renderToggles() {
    const wrap = document.getElementById("series-toggles");
    if (!wrap) return;
    wrap.innerHTML = "";
    const items = [...SERIES].reverse().concat([BAND_TOGGLE]);
    for (const it of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.setAttribute("aria-pressed", String(!!visible[it.cls]));
      btn.innerHTML = `<span class="chip-dot" style="background:${it.color}"></span>${it.key}`;
      btn.addEventListener("click", () => {
        visible[it.cls] = !visible[it.cls];
        btn.setAttribute("aria-pressed", String(visible[it.cls]));
        saveVisible();
        if (cachedData) renderChart(chartCtx, cachedData);
      });
      wrap.appendChild(btn);
    }
  }

  async function loadAndRender() {
    try {
      if (!cachedData) setStatus("데이터 불러오는 중…");

      const res = await fetch(DEFAULT_CSV, { cache: "no-store" });
      if (res.ok) cachedData = parseCSV(await res.text());

      if (cachedData) {
        renderHero(cachedData);
        renderChart(chartCtx, cachedData);
        setStatus(buildStatusLine(cachedData));
      }
      failCount = 0;
    } catch (e) {
      failCount += 1;
      console.error(e);
      setStatus(`로딩 실패(${failCount}): ${e.message} · 5초 후 재시도`);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => loadAndRender(), 5000);
    }
  }

  function bindUI() {
    const chartEl = document.getElementById("chart");
    chartCtx = initChart(chartEl);
    renderToggles();

    const reloadBtn = document.getElementById("reloadBtn");
    reloadBtn && reloadBtn.addEventListener("click", () => loadAndRender());

    setInterval(() => {
      if (document.visibilityState === "visible") loadAndRender();
    }, AUTO_REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") loadAndRender();
    });

    window.addEventListener("resize", debounce(() => {
      if (cachedData) renderChart(chartCtx, cachedData);
    }, 200));

    document.addEventListener("touchstart", (e) => {
      if (!chartEl.contains(e.target) && chartCtx.hideCursor) {
        chartCtx.hideCursor();
      }
    }, { passive: true });

    loadAndRender();
  }

  window.addEventListener("load", bindUI);
})();
