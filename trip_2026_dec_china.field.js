/* trip_2026_dec_china.field.js - Shanghai on-site itinerary.
   Tabs: schedule, map and dining, phrases, budget, notes.
   Works offline and over file:// with zero external dependencies. */
(() => {
  const trip = window.SHANGHAI_TRIP;
  if (!trip || !Array.isArray(trip.itinerary)) return;

  const FIELD_KEY = "trip_2026_dec_china.field.v1";
  const STATE_VERSION = 2;
  const FIELD_TABS = ["schedule", "map", "phrases", "budget", "notes"];
  const CAT_LABELS = {
    transport: "이동",
    stay: "숙박",
    food: "식사",
    sight: "관광",
    shopping: "쇼핑",
    etc: "기타",
  };
  const EXPENSE_CATS = ["food", "transport", "sight", "shopping", "stay", "etc"];
  // Records typed into the bookings and prep tabs of the earlier version are moved into one note.
  const MIGRATED_NOTE_ID = "note_migrated_v1";
  const OLD_RES_LABELS = {
    res_flight: "항공권",
    res_hotel_a: "YMCA 숙박",
    res_hotel_b: "SSAW 이린 숙박",
    res_esim: "로밍",
  };
  const TRIP_DAYS = trip.itinerary.length;
  const TRIP_LABEL =
    (trip.tripMeta && trip.tripMeta.dateLabel) ||
    `${trip.itinerary[0].date.slice(5).replace("-", "/")}–${trip.itinerary[TRIP_DAYS - 1].date.slice(5).replace("-", "/")}`;
  const dayChipLabel = (d) => `Day ${d.dayIndex + 1} (${d.date.slice(5).replace("-", "/")})`;
  const PHRASE_CAT_LABEL = (trip.phraseCategories || []).reduce((acc, c) => {
    acc[c.id] = c.label;
    return acc;
  }, {});

  const dom = {
    app: byId("field-app"),
    dashboard: byId("field-dashboard"),
    navButtons: Array.from(document.querySelectorAll("[data-ftab]")),
    panels: FIELD_TABS.reduce((acc, tab) => {
      acc[tab] = byId(`ftab-${tab}`);
      return acc;
    }, {}),
    offlinePill: byId("sh-offline-pill"),
    weatherPill: byId("sh-weather-pill"),
    taxiModal: byId("taxi-modal"),
    closeTaxiModal: byId("close-taxi-modal"),
    taxiTitle: byId("taxi-modal-title"),
    taxiAddr: byId("taxi-modal-addr"),
    taxiKo: byId("taxi-modal-ko"),
    taxiCopyBtn: byId("taxi-copy-btn"),
    taxiAmap: byId("taxi-amap-link"),
    taxiBaidu: byId("taxi-baidu-link"),
    phraseModal: byId("phrase-modal"),
    phraseTitle: byId("phrase-modal-title"),
    phraseZh: byId("phrase-modal-zh"),
    phraseKo: byId("phrase-modal-ko"),
    phrasePron: byId("phrase-modal-pron"),
    phrasePager: byId("phrase-pager"),
    phraseCount: byId("phrase-count"),
    phrasePrev: byId("phrase-prev"),
    phraseNext: byId("phrase-next"),
    phraseCopyBtn: byId("phrase-copy-btn"),
    phraseCloseBtn: byId("phrase-close-btn"),
    closePhraseModal: byId("close-phrase-modal"),
    toast: byId("field-toast"),
  };

  const expandedItems = new Set();
  const openGuides = new Set(); // reference blocks left open, as "itemId:index", so a redraw keeps them open
  let dayOverviewOpen = false;
  let mapDayFilter = "all";
  let mapCatFilter = "all";
  let phraseCatFilter = "all";
  let toastTimer = null;
  let currentTaxiPlace = null;
  let phraseDeck = []; // sentences the open phrase card steps through
  let phraseIndex = 0;
  let modalReturnFocus = null; // control that opened a dialog; gets the focus back when it closes
  let offlineReady = false; // true once the service worker that keeps an offline copy controls this page
  let lastAutoDay = null; // trip day the schedule was last moved to automatically
  let renderedClockKey = ""; // now/next pair the schedule tab was last drawn with

  let state = loadFieldState();

  init();

  function init() {
    if (dom.weatherPill && trip.tripMeta && trip.tripMeta.weather) {
      const w = trip.tripMeta.weather;
      dom.weatherPill.textContent = w.tempC.replace(/°C\s*~\s*/, "–");
      dom.weatherPill.title = [w.rainNote, w.clothing].filter(Boolean).join(" · ");
    }
    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    bindGlobalEvents();
    autoSelectToday();
    renderAll();
    registerOfflineCache();

    // Keep "지금 / 다음" in step with the clock, and follow the date when the page is reopened.
    window.setInterval(refreshClock, 60000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshClock();
    });
  }

  // ---------- State ----------
  function createDefaultFieldState() {
    return {
      version: STATE_VERSION,
      activeTab: "schedule",
      activeDay: 0,
      scheduleView: "day",
      dashOpen: false,
      fxRate: null, // won per yuan typed by the traveller; null uses the data's planning rate
      itemState: {},
      expenses: [],
      freeNotes: [],
    };
  }

  function loadFieldState() {
    const base = createDefaultFieldState();
    try {
      const raw = window.localStorage.getItem(FIELD_KEY);
      if (!raw) return base;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return base;
      const next = sanitizeFieldState(saved, base);
      // A state of the earlier version is rewritten once, so the moved records are not built again.
      if (saved.version !== STATE_VERSION) window.localStorage.setItem(FIELD_KEY, JSON.stringify(next));
      return next;
    } catch (err) {
      return base;
    }
  }

  function sanitizeFieldState(saved, base = createDefaultFieldState()) {
    const current = saved.version === STATE_VERSION;
    const validItemIds = new Set(getAllItemsFlat().map(({ item }) => item.id));
    const itemState = {};
    // The timetable of the earlier version was replaced: its done marks, Plan B picks and memos
    // belong to items that no longer exist (or mean something else), so they are not carried over.
    if (current && saved.itemState && typeof saved.itemState === "object") {
      Object.keys(saved.itemState).forEach((id) => {
        if (validItemIds.has(id) && saved.itemState[id] && typeof saved.itemState[id] === "object") itemState[id] = { ...saved.itemState[id] };
      });
    }
    const fx = Number(saved.fxRate);
    const next = {
      ...base,
      activeTab: FIELD_TABS.includes(saved.activeTab) ? saved.activeTab : "schedule",
      activeDay: clampInt(saved.activeDay, 0, TRIP_DAYS - 1, 0),
      scheduleView: saved.scheduleView === "all" ? "all" : "day",
      dashOpen: Boolean(saved.dashOpen),
      fxRate: Number.isFinite(fx) && fx >= 100 && fx <= 400 ? Math.round(fx) : null,
      itemState,
      expenses: (Array.isArray(saved.expenses) ? saved.expenses.slice(0, 300) : [])
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ ...x, category: EXPENSE_CATS.includes(x.category) ? x.category : "etc" })),
      freeNotes: Array.isArray(saved.freeNotes) ? saved.freeNotes.slice(0, 100) : [],
    };
    if (!current) {
      const moved = buildMigratedNote(saved);
      if (moved && !next.freeNotes.some((n) => n && n.id === MIGRATED_NOTE_ID)) next.freeNotes.push(moved);
    }
    return next;
  }

  // Booking numbers, amounts, the traveller's own checklist lines and edited item memos of the earlier version.
  function buildMigratedNote(saved) {
    const lines = [];
    const res = saved.reservations && typeof saved.reservations === "object" ? saved.reservations : {};
    Object.keys(res).forEach((id) => {
      const r = res[id];
      if (!r || typeof r !== "object") return;
      const refNo = typeof r.refNo === "string" ? r.refNo.trim() : "";
      const amount = r.amountKRW === undefined || r.amountKRW === null ? "" : String(r.amountKRW).trim();
      if (!refNo && !amount) return;
      lines.push(`${OLD_RES_LABELS[id] || id}: ${[refNo ? `예약번호 ${refNo}` : "", amount ? `${amount}원` : ""].filter(Boolean).join(" · ")}`);
    });
    (Array.isArray(saved.customChecks) ? saved.customChecks : []).forEach((c) => {
      if (!c || typeof c.title !== "string" || !c.title.trim()) return;
      const done = Boolean(saved.checklistDone && saved.checklistDone[c.id]);
      lines.push(`준비물: ${c.title.trim()}${done ? " (완료)" : ""}`);
    });
    const oldItems = saved.itemState && typeof saved.itemState === "object" ? saved.itemState : {};
    Object.keys(oldItems).forEach((id) => {
      const note = oldItems[id] && typeof oldItems[id].note === "string" ? oldItems[id].note.trim() : "";
      if (note) lines.push(`이전 일정 메모: ${note}`);
    });
    if (!lines.length) return null;
    return {
      id: MIGRATED_NOTE_ID,
      title: "이전 버전에서 옮긴 기록",
      body: lines.join("\n"),
      updatedAt: new Date().toISOString(),
    };
  }

  function saveFieldState() {
    try {
      window.localStorage.setItem(FIELD_KEY, JSON.stringify(state));
    } catch (err) {
      // Ignore storage errors (private mode)
    }
  }

  // ---------- Helpers ----------
  function getFxRate() {
    return state.fxRate || Number(trip.fxKrwPerCny) || 200;
  }

  function getPlace(placeId) {
    return (placeId && trip.places && trip.places[placeId]) || null;
  }

  function amapUrl(place) {
    const q = (place && (place.amapQuery || place.nameZh || place.addressZh)) || "上海";
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(q)}&city=${encodeURIComponent((place && place.amapCity) || "上海")}`;
  }

  function baiduUrl(place) {
    const q = (place && (place.baiduQuery || place.nameZh || place.addressZh)) || "上海";
    return `https://map.baidu.com/search/${encodeURIComponent(q)}/`;
  }

  function getOrderedDayItems(dayIndex) {
    const day = trip.itinerary[dayIndex];
    return day ? day.items : [];
  }

  function getAllItemsFlat() {
    const list = [];
    trip.itinerary.forEach((day) => {
      day.items.forEach((item) => {
        list.push({ day, item });
      });
    });
    return list;
  }

  function getItemState(itemId) {
    return state.itemState[itemId] || {};
  }

  function patchItemState(itemId, patch) {
    state.itemState[itemId] = { ...getItemState(itemId), ...patch };
    saveFieldState();
  }

  function getPhrase(id) {
    return (trip.phrases || []).find((p) => p.id === id) || null;
  }

  // Estimated and recorded spending in yuan, by day and by category.
  function getSpending() {
    const byDay = trip.itinerary.map((d) => ({ dayIndex: d.dayIndex, label: `Day ${d.dayIndex + 1} (${d.date.slice(5)})`, estCNY: 0, actCNY: 0 }));
    const byCat = {};
    EXPENSE_CATS.forEach((c) => {
      byCat[c] = { category: c, label: CAT_LABELS[c], estCNY: 0, actCNY: 0 };
    });
    getAllItemsFlat().forEach(({ day, item }) => {
      const st = getItemState(item.id);
      const usePlanB = Boolean(st.usePlanB && item.planB);
      const est = Number(usePlanB ? item.planB.estCostCNY : item.estCostCNY) || 0;
      const act = st.actualCNY !== undefined && st.actualCNY !== "" ? Number(st.actualCNY) || 0 : 0;
      const cat = byCat[item.category] || byCat.etc;
      byDay[day.dayIndex].estCNY += est;
      byDay[day.dayIndex].actCNY += act;
      cat.estCNY += est;
      cat.actCNY += act;
    });
    state.expenses.forEach((exp) => {
      const amt = Number(exp.amountCNY) || 0;
      if (byDay[exp.dayIndex]) byDay[exp.dayIndex].actCNY += amt;
      (byCat[exp.category] || byCat.etc).actCNY += amt;
    });
    return {
      byDay,
      byCat,
      totalEstCNY: byDay.reduce((s, d) => s + d.estCNY, 0),
      totalActCNY: byDay.reduce((s, d) => s + d.actCNY, 0),
    };
  }

  function getProgressStats() {
    const allItems = getAllItemsFlat();
    const doneItems = allItems.filter(({ item }) => Boolean(getItemState(item.id).done)).length;
    return {
      totalItems: allItems.length,
      doneItems,
      itemPct: allItems.length ? Math.round((doneItems / allItems.length) * 100) : 0,
    };
  }

  // ---------- Clock: today, now, next ----------
  // Uses the phone's own date and time, which follow the local time zone after landing.
  function localDateStr(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function toMin(hhmm) {
    return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  }

  function getTodayDayIndex(now = new Date()) {
    const today = localDateStr(now);
    return trip.itinerary.findIndex((d) => d.date === today);
  }

  // phase "before": the trip has not started. "during": today is a trip day. "after": it is over.
  // current = the unfinished item whose time slot contains now. next = the first unfinished item after now.
  function getNowNext(now = new Date()) {
    const all = getAllItemsFlat();
    const undone = all.filter(({ item }) => !getItemState(item.id).done);
    const todayIdx = getTodayDayIndex(now);
    if (todayIdx < 0) {
      const phase = localDateStr(now) < trip.itinerary[0].date ? "before" : "after";
      return { phase, todayIdx, current: null, next: phase === "before" ? undone[0] || null : null, minutesToNext: null };
    }
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const today = undone.filter(({ day }) => day.dayIndex === todayIdx);
    const running = today.filter(({ item }) => toMin(item.startTime) <= nowMin && nowMin < toMin(item.endTime));
    const current = running[running.length - 1] || null;
    let next = today.find(({ item }) => toMin(item.startTime) > nowMin) || null;
    let minutesToNext = next ? toMin(next.item.startTime) - nowMin : null;
    if (!next) {
      next = undone.find(({ day }) => day.dayIndex > todayIdx) || null;
      minutesToNext = null;
    }
    return { phase: "during", todayIdx, current, next, minutesToNext };
  }

  function clockKey(nn) {
    return [nn.phase, nn.todayIdx, nn.current ? nn.current.item.id : "", nn.next ? nn.next.item.id : ""].join("|");
  }

  // On a trip day the schedule opens on today. Runs once per day so browsing other days is not undone.
  function autoSelectToday() {
    const idx = getTodayDayIndex();
    if (idx < 0 || idx === lastAutoDay) return false;
    lastAutoDay = idx;
    if (state.activeDay === idx && state.scheduleView === "day") return false;
    state.activeDay = idx;
    state.scheduleView = "day";
    saveFieldState();
    return true;
  }

  function refreshClock() {
    const dayChanged = autoSelectToday();
    renderDashboard();
    if (state.activeTab !== "schedule") return;
    // A redraw would drop the focus of a memo or amount field that is being typed in.
    const active = document.activeElement;
    const typing = Boolean(active && dom.panels.schedule.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing && (dayChanged || clockKey(getNowNext()) !== renderedClockKey)) renderScheduleTab();
  }

  function formatWait(min) {
    if (min === null || min === undefined) return "";
    if (min < 60) return `${min}분 뒤`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}시간 ${m}분 뒤` : `${h}시간 뒤`;
  }

  // ---------- Offline copy (service worker) ----------
  // The scope is the page's own URL prefix, so no other page of the site is controlled by this worker.
  function registerOfflineCache() {
    if (!("serviceWorker" in navigator) || !/^https?:$/.test(window.location.protocol)) return;
    const markReady = () => {
      offlineReady = Boolean(navigator.serviceWorker.controller);
      updateOnlineStatus();
    };
    navigator.serviceWorker.addEventListener("controllerchange", markReady);
    navigator.serviceWorker
      .register("trip_2026_dec_china.sw.js", { scope: "./trip_2026_dec_china" })
      .then(markReady)
      .catch(() => {
        // No offline copy (private mode, unsupported browser): the page still works online.
      });
  }

  function getDdayText() {
    const start = new Date(`${trip.tripMeta.startDate}T00:00:00+09:00`);
    const end = new Date(`${trip.tripMeta.endDate}T23:59:59+09:00`);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.ceil((start.getTime() - todayStart.getTime()) / 86400000);
    if (diffDays > 0) return `출발 D-${diffDays}`;
    if (now <= end) {
      const dayNum = Math.floor((todayStart.getTime() - start.getTime()) / 86400000) + 1;
      return `여행 Day ${clampInt(dayNum, 1, TRIP_DAYS, 1)} 진행 중`;
    }
    return "여행 완료";
  }

  // ---------- Global events ----------
  function bindGlobalEvents() {
    // <details> toggle does not bubble, so it is caught on the way down.
    dom.dashboard.addEventListener(
      "toggle",
      (e) => {
        if (!(e.target instanceof HTMLDetailsElement) || !e.target.classList.contains("dash-fold")) return;
        if (state.dashOpen === e.target.open) return;
        state.dashOpen = e.target.open;
        saveFieldState();
      },
      true
    );

    dom.navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (FIELD_TABS.includes(btn.dataset.ftab)) selectFieldTab(btn.dataset.ftab);
      });
    });

    // Taxi card
    dom.closeTaxiModal.addEventListener("click", closeTaxiModal);
    dom.taxiModal.addEventListener("click", (e) => {
      if (e.target === dom.taxiModal) closeTaxiModal();
    });
    dom.taxiCopyBtn.addEventListener("click", () => {
      if (!currentTaxiPlace) return;
      copyText(`${currentTaxiPlace.nameZh} ${currentTaxiPlace.addressZh}`, "중문 주소를 복사했습니다.");
    });

    // Phrase card
    dom.closePhraseModal.addEventListener("click", closePhraseModal);
    dom.phraseCloseBtn.addEventListener("click", closePhraseModal);
    dom.phraseModal.addEventListener("click", (e) => {
      if (e.target === dom.phraseModal) closePhraseModal();
    });
    dom.phrasePrev.addEventListener("click", () => stepPhrase(-1));
    dom.phraseNext.addEventListener("click", () => stepPhrase(1));
    dom.phraseCopyBtn.addEventListener("click", () => {
      const entry = phraseDeck[phraseIndex];
      if (entry) copyText(entry.zh, "중문을 복사했습니다.");
    });

    document.addEventListener("keydown", (e) => {
      const phraseOpen = !dom.phraseModal.classList.contains("hidden");
      if (e.key === "Escape") {
        if (phraseOpen) closePhraseModal();
        else if (!dom.taxiModal.classList.contains("hidden")) closeTaxiModal();
      } else if (phraseOpen && e.key === "ArrowLeft") stepPhrase(-1);
      else if (phraseOpen && e.key === "ArrowRight") stepPhrase(1);
    });

    // Keep opened reference blocks and the day overview open across redraws (toggle does not bubble).
    dom.panels.schedule.addEventListener(
      "toggle",
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLDetailsElement)) return;
        if (el.dataset.guideKey) {
          if (el.open) openGuides.add(el.dataset.guideKey);
          else openGuides.delete(el.dataset.guideKey);
        } else if (el.classList.contains("day-overview")) {
          dayOverviewOpen = el.open;
        }
      },
      true
    );

    // Delegated actions inside the app shell
    dom.app.addEventListener("click", handleFieldClick);
    dom.app.addEventListener("change", handleFieldChange);
    dom.app.addEventListener("submit", handleFieldSubmit);
  }

  function selectFieldTab(tab, opts = {}) {
    state.activeTab = tab;
    saveFieldState();
    dom.navButtons.forEach((btn) => {
      const active = btn.dataset.ftab === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    FIELD_TABS.forEach((t) => {
      if (dom.panels[t]) dom.panels[t].hidden = t !== tab;
    });
    renderActiveTab();
    if (!opts.keepScroll && window.scrollY > 180) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function renderAll() {
    renderDashboard();
    selectFieldTab(state.activeTab, { keepScroll: true });
  }

  function renderActiveTab() {
    if (state.activeTab === "schedule") renderScheduleTab();
    else if (state.activeTab === "map") renderMapTab();
    else if (state.activeTab === "phrases") renderPhrasesTab();
    else if (state.activeTab === "budget") renderBudgetTab();
    else if (state.activeTab === "notes") renderNotesTab();
  }

  function updateOnlineStatus() {
    if (!dom.offlinePill) return;
    const online = navigator.onLine !== false;
    const short = online ? (offlineReady ? "온라인 · 저장됨" : "온라인") : offlineReady ? "오프라인 · 저장본" : "오프라인";
    const full = online
      ? offlineReady
        ? "온라인 · 오프라인에서도 열리도록 저장됨"
        : "온라인"
      : offlineReady
        ? "오프라인 · 저장본으로 표시 중"
        : "오프라인";
    dom.offlinePill.textContent = short;
    dom.offlinePill.title = full;
    dom.offlinePill.setAttribute("aria-label", full);
    dom.offlinePill.dataset.offlineReady = String(offlineReady);
    dom.offlinePill.className = `sh-pill ${online ? "is-online" : "is-offline"}`;
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    const stats = getProgressStats();
    const nn = getNowNext();
    const spend = getSpending();
    const fxRate = getFxRate();
    const ddayText = getDdayText();
    const shortStatus = nn.phase === "before" ? ddayText : nn.phase === "during" ? `Day ${nn.todayIdx + 1}/${TRIP_DAYS}` : "여행 완료";

    // One tappable line per entry: what is on now, and what comes next. Tapping opens that card.
    const nowLine = (entry, badge, badgeClass, tail) => {
      const d = entry.day;
      const dayPart = nn.phase === "during" && d.dayIndex === nn.todayIdx ? "" : `Day ${d.dayIndex + 1} ${d.date.slice(5).replace("-", "/")}(${d.weekday}) `;
      return `
        <button type="button" class="dash-now-line" data-jump-item="${esc(entry.item.id)}">
          <span class="dash-now-top">
            <span class="dash-next-badge ${badgeClass}">${esc(badge)}</span>
            <span class="dash-now-time">${esc(dayPart)}${esc(entry.item.startTime)}</span>
            ${tail ? `<span class="dash-now-tail">${esc(tail)}</span>` : ""}
          </span>
          <strong class="dash-now-title">${esc(entry.item.title)}</strong>
        </button>
      `;
    };
    let nowHtml = "";
    if (nn.current) nowHtml += nowLine(nn.current, "지금", "is-now", `${nn.current.item.endTime}까지`);
    if (nn.next) nowHtml += nowLine(nn.next, nn.phase === "before" ? "첫 일정" : "다음", "", formatWait(nn.minutesToNext));
    if (!nowHtml) {
      nowHtml = `<div class="dash-now-line is-static">${nn.phase === "after" ? "여행이 끝났습니다." : "남은 일정을 모두 마쳤습니다."}</div>`;
    }

    // The two hotels, each with its taxi card one tap away.
    const stayIds = [];
    trip.itinerary.forEach((d) => {
      if (d.stayPlaceId && !stayIds.includes(d.stayPlaceId)) stayIds.push(d.stayPlaceId);
    });
    const staysHtml = stayIds
      .map((id) => {
        const place = getPlace(id);
        if (!place) return "";
        const nights = trip.itinerary.filter((d) => d.stayPlaceId === id);
        const range = `${slashDate(nights[0])}–${slashDate(trip.itinerary[nights[nights.length - 1].dayIndex + 1] || nights[nights.length - 1])}`;
        return `
          <div class="dash-stay">
            <span><strong>${esc(shortPlaceName(place))}</strong> <span class="dash-count">${esc(range)}</span></span>
            <button type="button" class="link-btn" data-taxi-place="${esc(place.id)}">택시 카드</button>
          </div>
        `;
      })
      .join("");

    dom.dashboard.innerHTML = `
      <div class="dash-now" aria-label="지금과 다음 일정">${nowHtml}</div>
      <details class="dash-fold" ${state.dashOpen ? "open" : ""}>
        <summary>
          <span class="dash-fold-items">
            <span class="dash-fold-item"><strong>${esc(shortStatus)}</strong></span>
            <span class="dash-fold-item">일정 <strong>${stats.doneItems}/${stats.totalItems}</strong></span>
            <span class="dash-fold-item">지출 <strong>¥${formatNum(spend.totalActCNY)}</strong></span>
          </span>
          <span class="dash-fold-arrow" aria-hidden="true">▾</span>
        </summary>
        <div class="dash-grid">
          <div class="dash-card">
            <span class="dash-label">여행 기간 · 상태</span>
            <div class="dash-value">${esc(ddayText)}</div>
            <div class="dash-sub">${esc(TRIP_LABEL)} · ${trip.tripMeta.nights}박 ${trip.tripMeta.days}일 · ${trip.tripMeta.travelers}인</div>
            <div class="dash-sub">${esc(trip.tripMeta.flights.out)}</div>
            <div class="dash-sub">${esc(trip.tripMeta.flights.back)}</div>
          </div>
          <div class="dash-card">
            <span class="dash-label">숙소</span>
            ${staysHtml}
          </div>
          <div class="dash-card">
            <span class="dash-label">일정 진행</span>
            <div class="dash-value">${stats.itemPct}% <small class="dash-count">(${stats.doneItems}/${stats.totalItems})</small></div>
            <div class="dash-progress"><div class="dash-progress-bar" style="width:${stats.itemPct}%"></div></div>
          </div>
          <div class="dash-card">
            <span class="dash-label">현지 지출 (2인)</span>
            <div class="dash-value">¥${formatNum(spend.totalActCNY)}</div>
            <div class="dash-sub">약 ${formatManwon(spend.totalActCNY * fxRate)} · 예상 ¥${formatNum(spend.totalEstCNY)}</div>
          </div>
        </div>
      </details>
    `;
  }

  // ---------- Tab 1: Schedule ----------
  function slashDate(d) {
    return d.date.slice(5).replace("-", "/");
  }

  // "청주국제공항 (CJJ · 제3·4주차장)" -> without the trailing note in brackets
  function shortPlaceName(place) {
    return place ? place.nameKo.replace(/\s*\([^)]*\)\s*$/, "") : "";
  }

  function renderScheduleTab() {
    const nn = getNowNext();
    renderedClockKey = clockKey(nn);
    const showAll = state.scheduleView === "all";
    const day = trip.itinerary[state.activeDay] || trip.itinerary[0];

    const dayTabsHtml = `
      <div class="day-tabs" role="tablist" aria-label="날짜 선택">
        <button type="button" class="day-tab-btn ${showAll ? "is-active" : ""}" data-select-view="all" role="tab" aria-selected="${showAll}" aria-label="전체 일정 ${TRIP_DAYS}일">
          <strong>전체</strong>
          <small>${TRIP_DAYS}일</small>
        </button>
        ${trip.itinerary
          .map((d) => {
            const dItems = getOrderedDayItems(d.dayIndex);
            const dDone = dItems.filter((it) => getItemState(it.id).done).length;
            const active = !showAll && d.dayIndex === day.dayIndex;
            const isToday = d.dayIndex === nn.todayIdx;
            return `
              <button type="button" class="day-tab-btn ${active ? "is-active" : ""} ${isToday ? "is-today" : ""}" data-select-day="${d.dayIndex}" role="tab" aria-selected="${active}" aria-label="Day ${d.dayIndex + 1} ${esc(slashDate(d))} ${esc(d.weekday)}요일${isToday ? " 오늘" : ""} · ${dDone}/${dItems.length} 완료">
                <strong>${esc(slashDate(d))}</strong>
                <small>${isToday ? "오늘" : esc(d.weekday)} · ${dDone}/${dItems.length}</small>
              </button>
            `;
          })
          .join("")}
      </div>
    `;

    dom.panels.schedule.innerHTML = dayTabsHtml + (showAll ? renderOverviewHtml(nn) : renderDayHtml(day, nn));
  }

  // One day as a timetable: time column, what to do, a done box. Memo and steps are readable without opening the row.
  function renderDayHtml(day, nn) {
    const items = getOrderedDayItems(day.dayIndex);
    const fxRate = getFxRate();
    const nowId = nn.current ? nn.current.item.id : "";
    const nextId = nn.next ? nn.next.item.id : "";
    const stay = getPlace(day.stayPlaceId);

    const headHtml = `
      <section class="sch-head">
        <h2><span class="sch-head-day">Day ${day.dayIndex + 1} · ${esc(slashDate(day))} (${esc(day.weekday)})</span>${esc(day.title)}</h2>
        <details class="day-overview" ${dayOverviewOpen ? "open" : ""}>
          <summary><span class="day-highlight">${esc(day.highlight)}</span><span class="day-overview-more">하루 개요</span></summary>
          <p>${esc(day.summary)}</p>
        </details>
        <div class="day-stay">
          <span class="day-stay-label">오늘 밤</span>
          ${
            stay
              ? `<span class="day-stay-name">${esc(shortPlaceName(stay))}</span>
                 <button type="button" class="tl-foot-btn" data-taxi-place="${esc(stay.id)}">택시 카드</button>`
              : `<span class="day-stay-name">숙박 없음 · 귀국일</span>`
          }
        </div>
      </section>
    `;

    const rowsHtml = items
      .map((item, idx) => {
        const st = getItemState(item.id);
        const usePlanB = Boolean(st.usePlanB && item.planB);
        const activeTitle = usePlanB ? item.planB.title : item.title;
        const place = getPlace(usePlanB ? item.planB.placeId : item.placeId);
        const expanded = expandedItems.has(item.id);
        const estCostCNY = usePlanB ? item.planB.estCostCNY : item.estCostCNY;
        const actualCNY = st.actualCNY !== undefined && st.actualCNY !== "" ? Number(st.actualCNY) : null;
        const displayNote = st.note !== undefined ? st.note : usePlanB ? item.planB.memo : item.memo;
        const memoText = (displayNote || "").trim();
        const isNow = item.id === nowId;
        const isNext = item.id === nextId;

        const transit = item.transitFromPrev;
        const transitHtml =
          idx > 0 && transit
            ? `
              <div class="tl-transit">
                <span class="tl-transit-mark" aria-hidden="true">↓ 이동</span>
                <span><strong>${esc(transit.mode)} ${transit.durationMin}분</strong> · ${esc(transit.from)}에서 · ${esc(transit.detail)}</span>
                ${place ? `<a class="tl-transit-link" href="${esc(amapUrl(place))}" target="_blank" rel="noopener noreferrer">길찾기</a>` : ""}
              </div>
            `
            : "";

        // Step-by-step walkthrough (airport arrival, the tour, departure morning) belongs to the main plan only.
        // Titles are always shown; the detail lines appear while the row is open or under way.
        const steps = !usePlanB && Array.isArray(item.steps) ? item.steps : [];
        const stepsHtml = steps.length
          ? `
            <ol class="tl-steps" aria-label="단계별 진행">
              ${steps
                .map(
                  (s) => `
                    <li>
                      <span class="tl-step-time">${esc(s.time)}</span>
                      <span class="tl-step-text"><strong>${esc(s.title)}</strong>${expanded || isNow ? `<span class="tl-step-detail">${esc(s.detail)}</span>` : ""}</span>
                    </li>
                  `
                )
                .join("")}
            </ol>
          `
          : "";

        // Places to pick from (a meal) or to drop by on the way: each opens its taxi card.
        const candidates = (!usePlanB && Array.isArray(item.candidates) ? item.candidates : []).map(getPlace).filter(Boolean);
        const candidatesHtml = candidates.length
          ? `
            <div class="tl-cands">
              <span class="tl-cands-label">${place ? "함께 볼 곳" : "후보 장소"}</span>
              ${candidates.map((p) => `<button type="button" class="sh-chip" data-taxi-place="${esc(p.id)}">${esc(shortPlaceName(p))}</button>`).join("")}
            </div>
          `
          : "";

        const guide = Array.isArray(item.guide) ? item.guide : [];
        const guideHtml = guide.length
          ? `
            <div class="tl-guide">
              ${guide
                .map((g, gi) => {
                  const key = `${item.id}:${gi}`;
                  return `
                    <details class="tl-guide-block" data-guide-key="${esc(key)}" ${openGuides.has(key) ? "open" : ""}>
                      <summary>${esc(g.title)}</summary>
                      <ul>${(g.lines || []).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
                    </details>
                  `;
                })
                .join("")}
            </div>
          `
          : "";

        const metaHtml = [
          isNow ? `<span class="tl-flag is-now">지금</span>` : "",
          isNext ? `<span class="tl-flag">다음</span>` : "",
          `<span class="tl-cat">${esc(CAT_LABELS[item.category] || item.category)}</span>`,
          item.fixedTime ? `<span class="tl-fixed">시간 고정</span>` : "",
          usePlanB ? `<span class="tl-fixed">Plan B 적용</span>` : "",
        ].join("");

        const bodyHtml = expanded
          ? `
            <div class="tl-body">
              ${
                place
                  ? `
                    <div class="tl-addr-bar">
                      <div class="tl-addr-text">
                        <strong lang="zh-CN">${esc(place.nameZh)}</strong>
                        <span lang="zh-CN">${esc(place.addressZh)}</span>
                      </div>
                      <div class="tl-actions-row" style="margin:0">
                        <button type="button" class="sh-btn is-sm" data-copy-addr="${esc(place.id)}">주소 복사</button>
                        <a class="sh-btn is-sm" href="${esc(amapUrl(place))}" target="_blank" rel="noopener noreferrer">高德(Amap)</a>
                        <a class="sh-btn is-sm" href="${esc(baiduUrl(place))}" target="_blank" rel="noopener noreferrer">百度(Baidu)</a>
                      </div>
                    </div>
                  `
                  : ""
              }

              <div class="tl-detail-grid">
                <div class="tl-detail-box">
                  <small>시간 · 예상 체류</small>
                  <strong>${esc(item.startTime)} – ${esc(item.endTime)} (${item.durationMin}분)</strong>
                </div>
                <div class="tl-detail-box">
                  <small>예상 비용 · 실제 지출</small>
                  <strong>${esc(item.estCostLabel)}${actualCNY !== null ? ` → 실제 ¥${formatNum(actualCNY)} (약 ${formatManwon(actualCNY * fxRate)})` : ""}</strong>
                </div>
                ${
                  place
                    ? `
                      <div class="tl-detail-box">
                        <small>운영 시간</small>
                        <span>${esc(place.hours || "-")}</span>
                      </div>
                      <div class="tl-detail-box">
                        <small>장소 팁</small>
                        <span>${esc(place.tip || "-")}</span>
                      </div>
                    `
                    : ""
                }
              </div>

              ${
                item.planB
                  ? `
                    <div class="planb-box">
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
                        <span><strong>대체 일정 (Plan B):</strong> ${esc(item.planB.title)}</span>
                        <button type="button" class="sh-btn is-sm ${usePlanB ? "is-primary" : ""}" data-toggle-planb="${esc(item.id)}">
                          ${usePlanB ? "기본 일정으로 복귀" : "Plan B로 전환"}
                        </button>
                      </div>
                    </div>
                  `
                  : ""
              }

              <div class="tl-edit-grid">
                <div>
                  <label class="dash-label" for="actual-${esc(item.id)}">실제 지출 (위안 ¥ · 비용 탭에 합산)</label>
                  <input id="actual-${esc(item.id)}" class="sh-input" type="number" inputmode="numeric" min="0" step="1" placeholder="예: ${estCostCNY || 120}" value="${esc(st.actualCNY ?? "")}" data-item-actual="${esc(item.id)}" />
                </div>
                <div>
                  <label class="dash-label" for="note-${esc(item.id)}">메모 고치기 (자동 저장)</label>
                  <textarea id="note-${esc(item.id)}" class="sh-textarea" rows="3" data-item-note="${esc(item.id)}">${esc(displayNote || "")}</textarea>
                </div>
              </div>
            </div>
          `
          : "";

        // Sentences needed at this very item: one tap shows the first one full screen.
        const phraseHtml =
          Array.isArray(item.phraseIds) && item.phraseIds.some(getPhrase)
            ? `<button type="button" class="tl-foot-btn tl-phrase-btn" data-phrase-set="${esc(item.id)}"><span>${esc(item.phraseLabel || "회화")}</span></button>`
            : "";

        return `
          ${transitHtml}
          <article class="tl-item ${st.done ? "is-done" : ""} ${isNow ? "is-now" : ""} ${isNext ? "is-next" : ""} ${item.fixedTime ? "is-fixed" : ""}" data-item-id="${esc(item.id)}">
            <div class="tl-row">
              <div class="tl-timecol" data-toggle-item="${esc(item.id)}">
                <span class="tl-start">${esc(item.startTime)}</span>
                <span class="tl-end">${esc(item.endTime)}</span>
              </div>
              <div class="tl-main" data-toggle-item="${esc(item.id)}">
                <div class="tl-meta">${metaHtml}</div>
                <h3 class="tl-title">${esc(activeTitle)}</h3>
                <div class="tl-place">
                  ${place ? `${esc(shortPlaceName(place))} · <span lang="zh-CN">${esc(place.nameZh)}</span> · ` : ""}${esc(item.estCostLabel || "")}
                </div>
                <p class="tl-memo ${expanded ? "" : "is-clamped"}" ${memoText ? "" : "hidden"}>${esc(memoText)}</p>
              </div>
              <label class="tl-checkwrap">
                <input type="checkbox" class="tl-check" aria-label="${esc(activeTitle)} 완료" ${st.done ? "checked" : ""} data-item-done="${esc(item.id)}" />
              </label>
            </div>
            ${stepsHtml || candidatesHtml || guideHtml ? `<div class="tl-extra">${stepsHtml}${candidatesHtml}${guideHtml}</div>` : ""}
            <div class="tl-foot">
              ${phraseHtml}
              ${
                place
                  ? `<button type="button" class="tl-foot-btn" data-taxi-place="${esc(place.id)}">택시 카드</button>
                     <a class="tl-foot-btn" href="${esc(amapUrl(place))}" target="_blank" rel="noopener noreferrer">지도</a>`
                  : ""
              }
              <button type="button" class="tl-foot-btn tl-more" aria-expanded="${expanded}" aria-label="${esc(activeTitle)} 상세 ${expanded ? "접기" : "펼치기"}" data-toggle-item="${esc(item.id)}">${expanded ? "접기 ▴" : "상세 ▾"}</button>
            </div>
            ${bodyHtml}
          </article>
        `;
      })
      .join("");

    return `${headHtml}<div class="tl-list">${rowsHtml}</div>`;
  }

  // All days on one screen: one line per item. A line opens that item in its day; the same view prints on paper.
  function renderOverviewHtml(nn) {
    const nowId = nn.current ? nn.current.item.id : "";
    const nextId = nn.next ? nn.next.item.id : "";

    const daysHtml = trip.itinerary
      .map((d) => {
        const stay = getPlace(d.stayPlaceId);
        const isToday = d.dayIndex === nn.todayIdx;
        const rows = getOrderedDayItems(d.dayIndex)
          .map((item) => {
            const st = getItemState(item.id);
            const usePlanB = Boolean(st.usePlanB && item.planB);
            const title = usePlanB ? item.planB.title : item.title;
            const place = getPlace(usePlanB ? item.planB.placeId : item.placeId);
            const note = ((st.note !== undefined ? st.note : usePlanB ? item.planB.memo : item.memo) || "").trim();
            const isNow = item.id === nowId;
            const isNext = item.id === nextId;
            const placeLine = [place ? esc(shortPlaceName(place)) : "", item.fixedTime ? `<span class="tl-fixed">시간 고정</span>` : ""].filter(Boolean).join(" · ");
            return `
              <li class="ov-row ${st.done ? "is-done" : ""} ${isNow ? "is-now" : ""}">
                <button type="button" class="ov-row-btn" data-jump-item="${esc(item.id)}">
                  <span class="ov-time">${esc(item.startTime)}<small>${esc(item.endTime)}</small></span>
                  <span>
                    <span class="ov-title">${isNow ? `<span class="tl-flag is-now">지금</span> ` : ""}${isNext ? `<span class="tl-flag">다음</span> ` : ""}${esc(title)}</span>
                    ${placeLine ? `<span class="ov-place">${placeLine}</span>` : ""}
                  </span>
                </button>
                <div class="ov-print">
                  ${place ? `<span lang="zh-CN">${esc(place.nameZh)} · ${esc(place.addressZh)}</span>` : ""}
                  ${note ? `<div>${esc(note)}</div>` : ""}
                </div>
              </li>
            `;
          })
          .join("");
        return `
          <section class="ov-day ${isToday ? "is-today" : ""}">
            <button type="button" class="ov-day-head" data-select-day="${d.dayIndex}">
              <span class="ov-day-date">Day ${d.dayIndex + 1} · ${esc(slashDate(d))} (${esc(d.weekday)})${isToday ? " · 오늘" : ""}</span>
              <span class="ov-day-title">${esc(d.title)}</span>
              <span class="ov-day-stay">숙소 · ${stay ? `${esc(shortPlaceName(stay))} ${esc(stay.nameZh)}` : "없음 · 귀국일"}</span>
            </button>
            <ol class="ov-rows">${rows}</ol>
          </section>
        `;
      })
      .join("");

    return `
      <div class="ov">
        <div class="ov-head">
          <h2>전체 일정 <span>${esc(TRIP_LABEL)}</span></h2>
          <button type="button" class="sh-btn is-sm" data-print-page>인쇄 · PDF 저장</button>
        </div>
        ${daysHtml}
      </div>
    `;
  }

  // ---------- Tab 2: Map and dining ----------
  function placeActionsHtml(p) {
    return `
      <div class="tl-actions-row" style="margin-top:auto">
        <button type="button" class="sh-btn is-sm is-primary" data-taxi-place="${esc(p.id)}">택시 제시</button>
        <button type="button" class="sh-btn is-sm" data-copy-addr="${esc(p.id)}">주소 복사</button>
        <a class="sh-btn is-sm" href="${esc(amapUrl(p))}" target="_blank" rel="noopener noreferrer">高德(Amap)</a>
        <a class="sh-btn is-sm" href="${esc(baiduUrl(p))}" target="_blank" rel="noopener noreferrer">百度(Baidu)</a>
      </div>
    `;
  }

  function renderMapTab() {
    const places = Object.values(trip.places || {});
    const filtered = places.filter((p) => {
      const dayOk = mapDayFilter === "all" || (p.dayIndices || []).includes(Number(mapDayFilter));
      const catOk = mapCatFilter === "all" || p.category === mapCatFilter;
      return dayOk && catOk;
    });

    const dayFilters = [["all", "전체 날짜"], ...trip.itinerary.map((d) => [String(d.dayIndex), dayChipLabel(d)])];
    const catFilters = [
      ["all", "전체 분류"],
      ["stay", "숙박"],
      ["food", "식사"],
      ["sight", "관광"],
      ["shopping", "쇼핑"],
      ["transport", "이동"],
    ];

    const diningHtml = (trip.diningGuide || []).length
      ? `
        <div class="sh-card">
          <div class="sh-card-head">
            <h2>식당 후보 (털게 · 샤오룽바오 · 본방차이 · 면)</h2>
            <span class="field-note" style="margin:0">11월 말–12월 초는 상하이 털게(大闸蟹) 제철 막바지</span>
          </div>
          <div class="place-grid">
            ${trip.diningGuide
              .map((d) => {
                const p = getPlace(d.placeId);
                return `
                  <article class="place-card">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
                      <span class="sh-badge cat-food">${esc(d.theme)}</span>
                      <strong style="font-size:0.82rem;color:var(--big)">${esc(d.budget2pax)}</strong>
                    </div>
                    <h3>${esc(d.name)}</h3>
                    <div class="place-addr">추천 메뉴: ${esc(d.signature)}</div>
                    <div class="place-meta">${esc(d.when)}</div>
                    ${p ? placeActionsHtml(p) : ""}
                  </article>
                `;
              })
              .join("")}
          </div>
        </div>
      `
      : "";

    dom.panels.map.innerHTML = `
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>장소 · 중국어 주소 · 택시 카드</h2>
          <span class="field-note" style="margin:0">중국은 Google Maps 좌표 오차가 크므로 고덕(Amap)·바이두 중문 검색을 사용합니다.</span>
        </div>
        <div class="sh-chip-bar" role="group" aria-label="날짜 필터">
          ${dayFilters
            .map(([val, label]) => `<button type="button" class="sh-chip ${mapDayFilter === val ? "is-active" : ""}" aria-pressed="${mapDayFilter === val}" data-map-day="${val}">${label}</button>`)
            .join("")}
        </div>
        <div class="sh-chip-bar" role="group" aria-label="분류 필터">
          ${catFilters
            .map(([val, label]) => `<button type="button" class="sh-chip ${mapCatFilter === val ? "is-active" : ""}" aria-pressed="${mapCatFilter === val}" data-map-cat="${val}">${label}</button>`)
            .join("")}
        </div>
      </div>

      <div class="place-grid">
        ${
          filtered.length
            ? filtered
                .map(
                  (p) => `
                    <article class="place-card">
                      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
                        <span class="sh-badge cat-${esc(p.category)}">${esc(CAT_LABELS[p.category] || p.category)}</span>
                        <span class="place-meta">${esc(p.area)} · ${(p.dayIndices || []).map((d) => `D${d + 1}`).join(", ")}</span>
                      </div>
                      <h3>${esc(p.nameKo)}</h3>
                      <div class="place-zh" lang="zh-CN">${esc(p.nameZh)}</div>
                      <div class="place-addr" lang="zh-CN">${esc(p.addressZh)}</div>
                      <div class="place-meta">${esc(p.hours || "-")} · ${esc(p.tip || "")}</div>
                      ${placeActionsHtml(p)}
                    </article>
                  `
                )
                .join("")
            : `<p class="field-note">이 조건에 맞는 장소가 없습니다.</p>`
        }
      </div>

      ${diningHtml}
    `;
  }

  // ---------- Tab 3: Phrases ----------
  // Top: short words to say aloud (the Korean reading is the main line).
  // Bottom: sentences to show on the screen (the Chinese sentence is the main line).
  function filteredPhrases() {
    return (trip.phrases || []).filter((p) => phraseCatFilter === "all" || p.cat === phraseCatFilter);
  }

  function renderPhrasesTab() {
    const words = trip.quickWords || [];
    const wordCats = [];
    words.forEach((w) => {
      if (!wordCats.includes(w.cat)) wordCats.push(w.cat);
    });
    const wordsHtml = wordCats
      .map(
        (cat) => `
          <h3 class="word-group">${esc(cat)}</h3>
          <div class="word-grid">
            ${words
              .filter((w) => w.cat === cat)
              .map(
                (w) => `
                  <button type="button" class="word-card" data-word="${esc(w.id)}" aria-label="${esc(w.ko)} · ${esc(w.pron)} · 크게 보기">
                    <span class="word-pron">${esc(w.pron)}</span>
                    <span class="word-ko">${esc(w.ko)}</span>
                    <span class="word-zh" lang="zh-CN">${esc(w.zh)}</span>
                  </button>
                `
              )
              .join("")}
          </div>
        `
      )
      .join("");

    const cats = [{ id: "all", label: "전체" }, ...(trip.phraseCategories || [])];
    const list = filteredPhrases();

    dom.panels.phrases.innerHTML = `
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>바로 말하는 초간단 단어</h2>
          <span class="field-note" style="margin:0">큰 글씨가 발음 · 안 통하면 눌러서 화면으로 보여 주기</span>
        </div>
        ${wordsHtml}
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>화면 보여주기용 문장</h2>
          <span class="field-note" style="margin:0">직원·기사님께 화면을 보여 주세요 · 인터넷 없이도 열립니다</span>
        </div>
        <div class="sh-chip-bar" role="group" aria-label="상황 필터">
          ${cats
            .map(
              (c) =>
                `<button type="button" class="sh-chip ${phraseCatFilter === c.id ? "is-active" : ""}" aria-pressed="${phraseCatFilter === c.id}" data-phrase-cat="${esc(c.id)}">${esc(c.label)}</button>`
            )
            .join("")}
        </div>
        <div class="phrase-list">
          ${list
            .map(
              (p) => `
                <article class="phrase-card" data-phrase-id="${esc(p.id)}">
                  <div class="phrase-head">
                    <span class="sh-badge">${esc(PHRASE_CAT_LABEL[p.cat] || p.cat)}</span>
                    <h3>${esc(p.title)}</h3>
                  </div>
                  <p class="phrase-zh" lang="zh-CN">${esc(p.zh)}</p>
                  <p class="phrase-ko">${esc(p.ko)}</p>
                  <p class="phrase-pron">${esc(p.pron)}</p>
                  ${p.hint ? `<p class="phrase-hint">${esc(p.hint)}</p>` : ""}
                  <div class="phrase-actions">
                    <button type="button" class="sh-btn is-sm is-primary" data-phrase-open="${esc(p.id)}">크게 보기</button>
                    <button type="button" class="sh-btn is-sm" data-phrase-copy="${esc(p.id)}">중문 복사</button>
                  </div>
                </article>
              `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  // ---------- Tab 4: Budget ----------
  function renderBudgetTab() {
    const fxRate = getFxRate();
    const { byDay, byCat, totalEstCNY, totalActCNY } = getSpending();
    const pay = trip.paymentGuide;

    const payHtml = pay
      ? `
        <div class="sh-card">
          <div class="sh-card-head">
            <h2>결제 수단 · ATM</h2>
            <span class="field-note" style="margin:0">${esc(pay.asOfNote)}</span>
          </div>
          <p class="field-note" style="margin-top:0">${esc(pay.summary)}</p>
          <ul class="contact-list">
            ${pay.methods
              .map(
                (m) => `
                  <li class="contact-item">
                    <span class="sh-badge">${esc(m.role)}</span>
                    <strong style="margin-left:6px">${esc(m.name)}</strong>
                    <div style="margin:3px 0">${esc(m.use)}</div>
                    <div class="check-note">${esc(m.note)}</div>
                  </li>
                `
              )
              .join("")}
          </ul>
          <ul class="pay-list">${pay.atmTips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
        </div>
      `
      : "";

    dom.panels.budget.innerHTML = `
      <div class="budget-summary-grid">
        <div class="dash-card">
          <span class="dash-label">현지 일정 예상 (2인 · 항공·숙박·결제한 투어 제외)</span>
          <div class="dash-value">¥${formatNum(totalEstCNY)}</div>
          <div class="dash-sub">약 ${formatManwon(totalEstCNY * fxRate)}</div>
        </div>
        <div class="dash-card">
          <span class="dash-label">실제 기록 지출 합계 (2인)</span>
          <div class="dash-value">¥${formatNum(totalActCNY)}</div>
          <div class="dash-sub">약 ${formatManwon(totalActCNY * fxRate)} · 예상과 차이 ${totalActCNY - totalEstCNY >= 0 ? "+" : "−"}¥${formatNum(Math.abs(totalActCNY - totalEstCNY))}</div>
        </div>
        <div class="dash-card">
          <label class="dash-label" for="fx-rate-input">환율 (1위안 = 몇 원)</label>
          <input id="fx-rate-input" class="sh-input" type="number" inputmode="numeric" min="100" max="400" step="1" value="${fxRate}" data-fx-rate="1" />
          <div class="dash-sub">위안 금액을 원화로 보여 줄 때 씁니다 · 기본 ${formatNum(trip.fxKrwPerCny)}원</div>
        </div>
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>현지 지출 기록 (위안 입력 → 원화 환산)</h2>
        </div>
        <form id="expense-add-form" class="expense-form">
          <select id="exp-day" class="sh-select" aria-label="날짜">
            ${trip.itinerary.map((d) => `<option value="${d.dayIndex}" ${d.dayIndex === state.activeDay ? "selected" : ""}>Day ${d.dayIndex + 1}</option>`).join("")}
          </select>
          <select id="exp-cat" class="sh-select" aria-label="분류">
            ${EXPENSE_CATS.map((c) => `<option value="${c}">${esc(CAT_LABELS[c])}</option>`).join("")}
          </select>
          <input id="exp-title" class="sh-input" type="text" placeholder="내역 (예: 샤오룽바오 2인, 디디 택시)" required />
          <input id="exp-cny" class="sh-input" type="number" inputmode="numeric" min="1" step="1" placeholder="금액 (¥)" required />
          <button type="submit" class="sh-btn is-primary">기록</button>
        </form>
        ${
          state.expenses.length
            ? `
              <ul class="expense-list">
                ${state.expenses
                  .slice()
                  .reverse()
                  .map(
                    (exp) => `
                      <li class="expense-row">
                        <div>
                          <span class="sh-badge cat-${esc(exp.category)}">${esc(CAT_LABELS[exp.category] || exp.category)}</span>
                          <strong style="margin-left:6px">Day ${exp.dayIndex + 1} · ${esc(exp.title)}</strong>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px">
                          <strong>¥${formatNum(exp.amountCNY)} <small style="color:var(--muted)">(약 ${formatManwon(exp.amountCNY * fxRate)})</small></strong>
                          <button type="button" class="sh-btn is-sm is-danger" data-del-expense="${esc(exp.id)}">삭제</button>
                        </div>
                      </li>
                    `
                  )
                  .join("")}
              </ul>
            `
            : `<p class="field-note" style="margin-top:10px">일정 카드에 입력한 실제 지출과 여기 추가한 내역이 아래 표에 자동 합산됩니다.</p>`
        }
      </div>

      <div class="sh-card">
        <div class="sh-card-head"><h3>일자별 예상 vs 실제</h3></div>
        <div class="sh-table-wrap">
          <table class="sh-table">
            <thead>
              <tr><th>날짜</th><th class="num">예상 (¥)</th><th class="num">실제 (¥)</th><th class="num">실제 (원화)</th></tr>
            </thead>
            <tbody>
              ${byDay
                .map(
                  (d) => `
                    <tr>
                      <td>${esc(d.label)}</td>
                      <td class="num">¥${formatNum(d.estCNY)}</td>
                      <td class="num"><strong>¥${formatNum(d.actCNY)}</strong></td>
                      <td class="num">${d.actCNY ? formatKRW(d.actCNY * fxRate) : "-"}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="sh-card">
        <div class="sh-card-head"><h3>항목별 예상 vs 실제</h3></div>
        <div class="sh-table-wrap">
          <table class="sh-table">
            <thead>
              <tr><th>항목</th><th class="num">예상 (¥)</th><th class="num">실제 (¥)</th><th class="num">실제 (원화)</th></tr>
            </thead>
            <tbody>
              ${Object.values(byCat)
                .map(
                  (c) => `
                    <tr>
                      <td>${esc(c.label)}</td>
                      <td class="num">¥${formatNum(c.estCNY)}</td>
                      <td class="num"><strong>¥${formatNum(c.actCNY)}</strong></td>
                      <td class="num">${c.actCNY ? formatKRW(c.actCNY * fxRate) : "-"}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>

      ${payHtml}
    `;
  }

  // ---------- Tab 5: Notes and backup ----------
  function renderNotesTab() {
    const itemNotes = getAllItemsFlat()
      .map(({ day, item }) => {
        const st = getItemState(item.id);
        const note = st.note !== undefined ? st.note : item.memo;
        return { day, item, note: (note || "").trim() };
      })
      .filter((x) => x.note);

    dom.panels.notes.innerHTML = `
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>자유 메모 (현지 기록 · 영수증·운송장 번호)</h2>
        </div>
        <form id="free-note-form" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
          <input id="free-note-title" class="sh-input" type="text" placeholder="제목 (예: 택배 운송장 번호 / 호텔 객실번호)" required />
          <textarea id="free-note-body" class="sh-textarea" placeholder="내용을 입력하세요 (이 브라우저에 저장됩니다)" required></textarea>
          <div><button type="submit" class="sh-btn is-primary">메모 저장</button></div>
        </form>
        ${
          state.freeNotes.length
            ? `
              <div class="note-card-grid">
                ${state.freeNotes
                  .slice()
                  .reverse()
                  .map(
                    (n) => `
                      <article class="tl-detail-box">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px">
                          <strong>${esc(n.title)}</strong>
                          <button type="button" class="sh-btn is-sm is-danger" data-del-note="${esc(n.id)}">삭제</button>
                        </div>
                        <div style="white-space:pre-wrap;font-size:0.85rem">${esc(n.body)}</div>
                      </article>
                    `
                  )
                  .join("")}
              </div>
            `
            : `<p class="field-note">아직 작성한 자유 메모가 없습니다.</p>`
        }
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>숙소 · 긴급 연락처</h2>
        </div>
        <ul class="contact-list">
          ${(trip.emergencyContacts || [])
            .map(
              (c) => `
                <li class="contact-item">
                  <strong>${esc(c.name)}</strong>
                  <div style="margin:3px 0;font-weight:700;color:var(--big)">${esc(c.phone)}</div>
                  <div class="check-note">${esc(c.note)}</div>
                </li>
              `
            )
            .join("")}
        </ul>
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>기록 백업 · 복원 (JSON)</h2>
        </div>
        <p class="field-note" style="margin-top:0">일정 완료 표시·실제 지출·메모를 하나의 JSON 파일로 내보내거나 다른 기기에서 불러옵니다.</p>
        <div class="tl-actions-row">
          <button type="button" class="sh-btn is-primary" data-backup-export="1">JSON 파일 다운로드</button>
          <button type="button" class="sh-btn" data-backup-copy="1">JSON 클립보드 복사</button>
          <label class="sh-btn" style="cursor:pointer">
            JSON 파일 불러오기
            <input type="file" id="backup-file-input" accept="application/json,.json" hidden />
          </label>
          <button type="button" class="sh-btn is-danger" data-field-reset="1">기록 초기화</button>
        </div>
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>일정별 메모 모아보기 (${itemNotes.length}건)</h2>
        </div>
        <div class="note-card-grid">
          ${itemNotes
            .map(
              ({ day, item, note }) => `
                <article class="tl-detail-box">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px">
                    <small style="margin:0">Day ${day.dayIndex + 1} ${esc(item.startTime)} · ${esc(item.title)}</small>
                    <button type="button" class="link-btn" data-jump-item="${esc(item.id)}">이동</button>
                  </div>
                  <div style="font-size:0.84rem">${esc(note)}</div>
                </article>
              `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  // ---------- Event handlers ----------
  function handleFieldClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    if (target.closest("[data-print-page]")) {
      window.print();
      return;
    }

    const selectViewBtn = target.closest("[data-select-view]");
    if (selectViewBtn) {
      state.scheduleView = "all";
      saveFieldState();
      renderScheduleTab();
      if (dom.panels.schedule.getBoundingClientRect().top < 0) dom.panels.schedule.scrollIntoView({ block: "start" });
      return;
    }

    const selectDayBtn = target.closest("[data-select-day]");
    if (selectDayBtn) {
      state.activeDay = clampInt(selectDayBtn.dataset.selectDay, 0, TRIP_DAYS - 1, 0);
      state.scheduleView = "day";
      saveFieldState();
      renderScheduleTab();
      // The day tabs stay pinned while scrolling; a newly picked day starts from its first card.
      if (dom.panels.schedule.getBoundingClientRect().top < 0) dom.panels.schedule.scrollIntoView({ block: "start" });
      return;
    }

    const jumpItemBtn = target.closest("[data-jump-item]");
    if (jumpItemBtn) {
      const id = jumpItemBtn.dataset.jumpItem;
      const found = getAllItemsFlat().find(({ item }) => item.id === id);
      if (found) {
        state.activeDay = found.day.dayIndex;
        state.scheduleView = "day";
        expandedItems.add(id);
        saveFieldState();
        renderDashboard();
        selectFieldTab("schedule", { keepScroll: true });
        const node = dom.panels.schedule.querySelector(`[data-item-id="${id}"]`);
        if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    const phraseSetBtn = target.closest("[data-phrase-set]");
    if (phraseSetBtn) {
      const found = getAllItemsFlat().find(({ item }) => item.id === phraseSetBtn.dataset.phraseSet);
      const deck = found ? (found.item.phraseIds || []).map(getPhrase).filter(Boolean) : [];
      if (deck.length) openPhraseModal(deck.map(phraseEntry), 0, phraseSetBtn);
      return;
    }

    const wordBtn = target.closest("[data-word]");
    if (wordBtn) {
      const words = trip.quickWords || [];
      const index = words.findIndex((w) => w.id === wordBtn.dataset.word);
      if (index >= 0) openPhraseModal(words.map(wordEntry), index, wordBtn);
      return;
    }

    const phraseOpenBtn = target.closest("[data-phrase-open]");
    if (phraseOpenBtn) {
      const list = filteredPhrases();
      const index = list.findIndex((p) => p.id === phraseOpenBtn.dataset.phraseOpen);
      if (index >= 0) openPhraseModal(list.map(phraseEntry), index, phraseOpenBtn);
      return;
    }

    const phraseCopyBtn = target.closest("[data-phrase-copy]");
    if (phraseCopyBtn) {
      const p = getPhrase(phraseCopyBtn.dataset.phraseCopy);
      if (p) copyText(p.zh, "중문을 복사했습니다.");
      return;
    }

    const phraseCatBtn = target.closest("[data-phrase-cat]");
    if (phraseCatBtn) {
      phraseCatFilter = phraseCatBtn.dataset.phraseCat;
      renderPhrasesTab();
      return;
    }

    const toggleItemEl = target.closest("[data-toggle-item]");
    if (toggleItemEl && !target.closest("input, a, label")) {
      const id = toggleItemEl.dataset.toggleItem;
      if (expandedItems.has(id)) expandedItems.delete(id);
      else expandedItems.add(id);
      renderScheduleTab();
      return;
    }

    const planBBtn = target.closest("[data-toggle-planb]");
    if (planBBtn) {
      const id = planBBtn.dataset.togglePlanb;
      const curr = Boolean(getItemState(id).usePlanB);
      patchItemState(id, { usePlanB: !curr });
      renderDashboard();
      renderScheduleTab();
      showFieldToast(!curr ? "대체 일정(Plan B)으로 전환했습니다." : "기본 일정으로 되돌렸습니다.");
      return;
    }

    const copyAddrBtn = target.closest("[data-copy-addr]");
    if (copyAddrBtn) {
      const place = getPlace(copyAddrBtn.dataset.copyAddr);
      if (place) copyText(`${place.nameZh} ${place.addressZh}`, "중문 주소를 복사했습니다.");
      return;
    }

    const taxiBtn = target.closest("[data-taxi-place]");
    if (taxiBtn) {
      const place = getPlace(taxiBtn.dataset.taxiPlace);
      if (place) openTaxiModal(place, taxiBtn);
      return;
    }

    const mapDayBtn = target.closest("[data-map-day]");
    if (mapDayBtn) {
      mapDayFilter = mapDayBtn.dataset.mapDay;
      renderMapTab();
      return;
    }

    const mapCatBtn = target.closest("[data-map-cat]");
    if (mapCatBtn) {
      mapCatFilter = mapCatBtn.dataset.mapCat;
      renderMapTab();
      return;
    }

    const delExpBtn = target.closest("[data-del-expense]");
    if (delExpBtn) {
      const id = delExpBtn.dataset.delExpense;
      state.expenses = state.expenses.filter((x) => x.id !== id);
      saveFieldState();
      renderDashboard();
      renderBudgetTab();
      return;
    }

    const delNoteBtn = target.closest("[data-del-note]");
    if (delNoteBtn) {
      const id = delNoteBtn.dataset.delNote;
      state.freeNotes = state.freeNotes.filter((x) => x.id !== id);
      saveFieldState();
      renderNotesTab();
      return;
    }

    if (target.closest("[data-backup-export]")) {
      exportBackupFile();
      return;
    }

    if (target.closest("[data-backup-copy]")) {
      copyText(JSON.stringify(buildBackupPayload(), null, 2), "백업 JSON을 클립보드에 복사했습니다.");
      return;
    }

    if (target.closest("[data-field-reset]")) {
      if (window.confirm("일정 완료 표시·지출·메모 기록을 처음 상태로 되돌릴까요?")) {
        state = createDefaultFieldState();
        saveFieldState();
        renderAll();
        showFieldToast("기록을 초기화했습니다.");
      }
    }
  }

  function handleFieldChange(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    if (target.matches("[data-item-done]")) {
      const id = target.dataset.itemDone;
      patchItemState(id, { done: target.checked });
      renderDashboard();
      renderScheduleTab();
      return;
    }

    if (target.matches("[data-item-actual]")) {
      const id = target.dataset.itemActual;
      const val = target.value.trim();
      patchItemState(id, { actualCNY: val === "" ? "" : Math.max(0, Math.round(Number(val) || 0)) });
      renderDashboard();
      renderScheduleTab();
      return;
    }

    if (target.matches("[data-item-note]")) {
      const id = target.dataset.itemNote;
      patchItemState(id, { note: target.value });
      // Show the edited memo in the row without redrawing (a redraw would swallow the tap that ended the edit).
      const memoEl = dom.panels.schedule.querySelector(`[data-item-id="${id}"] .tl-memo`);
      if (memoEl) {
        memoEl.textContent = target.value.trim();
        memoEl.hidden = !target.value.trim();
      }
      return;
    }

    if (target.matches("[data-fx-rate]")) {
      const n = Math.round(Number(target.value));
      state.fxRate = Number.isFinite(n) && n >= 100 && n <= 400 && n !== Number(trip.fxKrwPerCny) ? n : null;
      saveFieldState();
      renderDashboard();
      renderBudgetTab();
      return;
    }

    if (target.id === "backup-file-input" && target.files && target.files[0]) {
      const file = target.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        importBackupJson(String(reader.result || ""));
        target.value = "";
      };
      reader.readAsText(file);
    }
  }

  function handleFieldSubmit(e) {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;

    if (form.id === "expense-add-form") {
      e.preventDefault();
      const dayIndex = clampInt(byId("exp-day").value, 0, TRIP_DAYS - 1, 0);
      const category = EXPENSE_CATS.includes(byId("exp-cat").value) ? byId("exp-cat").value : "etc";
      const title = byId("exp-title").value.trim();
      const amountCNY = Math.round(Number(byId("exp-cny").value) || 0);
      if (!title || amountCNY <= 0) return;
      state.expenses.push({
        id: `exp_${Date.now()}`,
        dayIndex,
        category,
        title,
        amountCNY,
        createdAt: new Date().toISOString(),
      });
      saveFieldState();
      renderDashboard();
      renderBudgetTab();
      showFieldToast(`¥${formatNum(amountCNY)} 지출을 기록했습니다.`);
      return;
    }

    if (form.id === "free-note-form") {
      e.preventDefault();
      const title = byId("free-note-title").value.trim();
      const body = byId("free-note-body").value.trim();
      if (!title || !body) return;
      state.freeNotes.push({
        id: `note_${Date.now()}`,
        title,
        body,
        updatedAt: new Date().toISOString(),
      });
      saveFieldState();
      renderNotesTab();
      showFieldToast("메모를 저장했습니다.");
    }
  }

  // ---------- Dialogs ----------
  function restoreFocus() {
    if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
    modalReturnFocus = null;
  }

  function openTaxiModal(place, opener) {
    currentTaxiPlace = place;
    modalReturnFocus = opener || null;
    dom.taxiTitle.textContent = place.nameZh || place.nameKo;
    dom.taxiAddr.textContent = place.addressZh || "-";
    dom.taxiKo.textContent = `${place.nameKo} (${place.area || "상하이"})`;
    dom.taxiAmap.href = amapUrl(place);
    dom.taxiBaidu.href = baiduUrl(place);
    dom.taxiModal.classList.remove("hidden");
    dom.closeTaxiModal.focus();
  }

  function closeTaxiModal() {
    dom.taxiModal.classList.add("hidden");
    restoreFocus();
  }

  function phraseEntry(p) {
    return { head: `${PHRASE_CAT_LABEL[p.cat] || "회화"} · ${p.title}`, zh: p.zh, ko: p.ko, pron: p.pron };
  }

  function wordEntry(w) {
    return { head: `${w.cat} · 바로 말하기`, zh: w.zh, ko: w.ko, pron: w.pron };
  }

  // The card shows one sentence at a time; a deck of related sentences is stepped through with 이전 / 다음.
  function openPhraseModal(deck, index, opener) {
    phraseDeck = deck;
    phraseIndex = clampInt(index, 0, deck.length - 1, 0);
    modalReturnFocus = opener || null;
    drawPhraseModal();
    dom.phraseModal.classList.remove("hidden");
    dom.closePhraseModal.focus();
  }

  function drawPhraseModal() {
    const entry = phraseDeck[phraseIndex];
    if (!entry) return;
    const len = Array.from(entry.zh).length;
    dom.phraseTitle.textContent = entry.head;
    dom.phraseZh.textContent = entry.zh;
    dom.phraseZh.className = `phrase-big ${len <= 8 ? "is-short" : len <= 22 ? "is-mid" : "is-long"}`;
    dom.phraseKo.textContent = entry.ko;
    dom.phrasePron.textContent = entry.pron;
    const many = phraseDeck.length > 1;
    dom.phrasePager.hidden = !many;
    if (many) {
      dom.phraseCount.textContent = `${phraseIndex + 1} / ${phraseDeck.length}`;
      dom.phrasePrev.disabled = phraseIndex === 0;
      dom.phraseNext.disabled = phraseIndex === phraseDeck.length - 1;
    }
  }

  function stepPhrase(delta) {
    const next = phraseIndex + delta;
    if (next < 0 || next >= phraseDeck.length) return;
    phraseIndex = next;
    drawPhraseModal();
  }

  function closePhraseModal() {
    dom.phraseModal.classList.add("hidden");
    restoreFocus();
  }

  // ---------- Backup / restore ----------
  function buildBackupPayload() {
    return {
      schema: "shanghai_trip_backup.v1",
      exportedAt: new Date().toISOString(),
      fieldState: state,
    };
  }

  function exportBackupFile() {
    const payload = buildBackupPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    a.href = url;
    a.download = `shanghai_2026_backup_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showFieldToast("백업 JSON 파일을 다운로드했습니다.");
  }

  function importBackupJson(rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || parsed.schema !== "shanghai_trip_backup.v1" || !parsed.fieldState || typeof parsed.fieldState !== "object") {
        showFieldToast("올바른 상하이 여행 백업 JSON 형식이 아닙니다.");
        return;
      }
      state = sanitizeFieldState(parsed.fieldState);
      saveFieldState();
      renderAll();
      showFieldToast("백업 데이터를 복원했습니다.");
    } catch (err) {
      showFieldToast("JSON 파일을 읽는 중 오류가 발생했습니다.");
    }
  }

  // ---------- Utilities ----------
  function copyText(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => showFieldToast(successMsg))
        .catch(() => fallbackCopy(text, successMsg));
    } else {
      fallbackCopy(text, successMsg);
    }
  }

  function fallbackCopy(text, successMsg) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showFieldToast(successMsg);
    } catch (e) {
      showFieldToast("복사에 실패했습니다. 직접 선택해 복사하세요.");
    }
    ta.remove();
  }

  function showFieldToast(msg) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      dom.toast.hidden = true;
    }, 3200);
  }

  function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function formatNum(n) {
    return Math.round(Number(n) || 0).toLocaleString("ko-KR");
  }

  function formatManwon(krw) {
    return `${Math.round((Number(krw) || 0) / 10000).toLocaleString("ko-KR")}만원`;
  }

  function formatKRW(krw) {
    return `${Math.round(Number(krw) || 0).toLocaleString("ko-KR")}원`;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
