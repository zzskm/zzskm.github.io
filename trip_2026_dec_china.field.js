/* trip_2026_dec_china.field.js - Shanghai Execution Mode (P0/P1/P2)
   Works offline and over file:// with zero external dependencies. */
(() => {
  const data = window.TRIP_DATA;
  const shanghai = data && data.cities && data.cities.shanghai;
  if (!shanghai || !Array.isArray(shanghai.itinerary)) return;

  const FIELD_KEY = "trip_2026_dec_china.field.v1";
  const FIELD_TABS = ["schedule", "map", "prep", "bookings", "budget", "notes"];
  // Bookings and prep share one entry of the nav; a two-part switch at the top of both panels moves between them.
  const NAV_OF = { prep: "bookings" };
  const RES_STATUS = {
    review: { label: "검토", next: "need_booking" },
    need_booking: { label: "예약 필요", next: "booked" },
    booked: { label: "예약 완료", next: "used" },
    used: { label: "이용 완료", next: "review" },
  };
  const CAT_LABELS = {
    transport: "이동",
    stay: "숙박",
    rx: "처방·택배",
    food: "식사",
    sight: "관광",
    shopping: "쇼핑",
    hospital: "백업 병원",
  };
  const STAY_TYPE_LABELS = {
    all: "전체 시내 유형",
    hotel: "일반 호텔",
    residence: "서비스형 레지던스",
    boutique: "부티크 · 와이탄",
  };
  const VERIFY_LABELS = [
    ["frontDesk24h", "24h 프런트"],
    ["foreignerOk", "외국인 투숙"],
    ["parcelReceive", "택배 수령"],
    ["parcelHold", "택배 보관"],
    ["lateCheckin", "심야 체크인"],
    ["luggageStore", "짐 보관"],
    ["inRoomFridge", "객실 냉장고"],
  ];
  const VERIFY_STATE_TEXT = {
    ok: "확인됨",
    unverified: "미확인",
    no: "불가",
  };
  // Pre-booking inquiry to a candidate hotel: can the front desk take in the cold parcel?
  // `pill` reuses the reservation status colours.
  const INQUIRY_STATUS = {
    none: { label: "미문의", pill: "review" },
    sent: { label: "문의함 · 답 대기", pill: "need_booking" },
    yes: { label: "가능 답변", pill: "used" },
    no: { label: "불가 답변", pill: "need_booking" },
  };
  const INQUIRY_ROLE_LABELS = { booked: "예약한 A숙소 (택배 수령 확인)", booked_b: "예약한 B숙소 (냉장 보관 확인)", a: "예비 A숙소 후보 (A숙소가 거절할 때)", b: "B숙소 후보 (냉장 보관)" };
  const TRIP_DAYS = shanghai.itinerary.length;
  const TRIP_LABEL =
    (shanghai.tripMeta && shanghai.tripMeta.dateLabel) ||
    `${shanghai.itinerary[0].date.slice(5).replace("-", "/")}–${shanghai.itinerary[TRIP_DAYS - 1].date.slice(5).replace("-", "/")}`;
  const dayChipLabel = (d) => `Day ${d.dayIndex + 1} (${d.date.slice(5).replace("-", "/")})`;

  const dom = {
    body: document.body,
    fieldMode: byId("field-mode"),
    planMode: byId("plan-mode"),
    modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
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
    toast: byId("field-toast"),
  };

  const expandedItems = new Set();
  const openGuides = new Set(); // reference blocks left open, as "itemId:index", so a redraw keeps them open
  let dayOverviewOpen = false;
  let mapDayFilter = "all";
  let mapCatFilter = "all";
  let hotelTypeFilter = "all";
  let prepDayFilter = "pre";
  let toastTimer = null;
  let currentTaxiPlace = null;
  let offlineReady = false; // true once the service worker that keeps an offline copy controls this page
  let lastAutoDay = null; // trip day the schedule was last moved to automatically
  let renderedClockKey = ""; // now/next pair the schedule tab was last drawn with
  let lastQuoteMean = null; // per-person total the quote mode last showed, in units of 10,000 won

  let state = loadFieldState();

  init();

  function init() {
    if (dom.weatherPill && shanghai.tripMeta && shanghai.tripMeta.weather) {
      const w = shanghai.tripMeta.weather;
      dom.weatherPill.textContent = w.tempC.replace(/°C\s*~\s*/, "–");
      dom.weatherPill.title = [w.rainNote, w.clothing].filter(Boolean).join(" · ");
    }
    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    bindGlobalEvents();
    applyMode();
    autoSelectToday();
    renderAll();
    decorateQuote(getShanghaiQuoteResult(), false);
    registerOfflineCache();

    // Keep "지금 / 다음" in step with the clock, and follow the date when the page is reopened.
    window.setInterval(refreshClock, 60000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshClock();
    });

    window.addEventListener("trip:rendered", (e) => {
      decorateQuote(e.detail && e.detail.result, true);
      if (state.mode === "field") {
        renderDashboard();
        if (state.activeTab === "prep") renderPrepTab();
        if (state.activeTab === "bookings") renderBookingsTab();
        if (state.activeTab === "budget") renderBudgetTab();
      }
    });
  }

  // ---------- State Management ----------
  function createDefaultFieldState() {
    const reservations = {};
    (shanghai.reservations || []).forEach((r) => {
      reservations[r.id] = {
        status: r.defaultStatus || "review",
        refNo: "",
        amountKRW: "",
        note: r.note || "",
      };
    });
    return {
      version: 1,
      mode: "field",
      activeTab: "schedule",
      bookSub: "bookings",
      activeDay: 0,
      scheduleView: "day",
      dashOpen: false,
      itemState: {},
      reservations,
      hotelInquiry: {},
      checklistDone: {},
      customChecks: [],
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
      return sanitizeFieldState(saved, base);
    } catch (err) {
      return base;
    }
  }

  function sanitizeFieldState(saved, base = createDefaultFieldState()) {
    const next = {
      ...base,
      mode: saved.mode === "plan" ? "plan" : "field",
      activeTab: FIELD_TABS.includes(saved.activeTab) ? saved.activeTab : "schedule",
      bookSub: saved.bookSub === "prep" || saved.activeTab === "prep" ? "prep" : "bookings",
      activeDay: clampInt(saved.activeDay, 0, shanghai.itinerary.length - 1, 0),
      scheduleView: saved.scheduleView === "all" ? "all" : "day",
      dashOpen: Boolean(saved.dashOpen),
      itemState: saved.itemState && typeof saved.itemState === "object" ? { ...saved.itemState } : {},
      reservations: { ...base.reservations },
      hotelInquiry: {},
      checklistDone: saved.checklistDone && typeof saved.checklistDone === "object" ? { ...saved.checklistDone } : {},
      customChecks: Array.isArray(saved.customChecks) ? saved.customChecks.slice(0, 100) : [],
      expenses: Array.isArray(saved.expenses) ? saved.expenses.slice(0, 300) : [],
      freeNotes: Array.isArray(saved.freeNotes) ? saved.freeNotes.slice(0, 100) : [],
    };

    // Items always follow the data's time order. A manual order saved by an older version is ignored.

    // Reconcile reservations
    Object.keys(base.reservations).forEach((resId) => {
      const s = saved.reservations && saved.reservations[resId];
      if (!s || typeof s !== "object") return;
      next.reservations[resId] = {
        status: RES_STATUS[s.status] ? s.status : base.reservations[resId].status,
        refNo: typeof s.refNo === "string" ? s.refNo : "",
        amountKRW: s.amountKRW === "" || Number.isFinite(Number(s.amountKRW)) ? String(s.amountKRW || "") : "",
        note: typeof s.note === "string" ? s.note : base.reservations[resId].note,
      };
      // A reservation the data marks as confirmed (flights are booked) is never shown as still open,
      // and its note follows the data unless the traveller has moved it on themselves.
      const def = (shanghai.reservations || []).find((r) => r.id === resId);
      if (def && def.confirmed && next.reservations[resId].status !== "used") {
        next.reservations[resId].status = "booked";
        next.reservations[resId].note = base.reservations[resId].note;
      }
    });

    // Inquiry answers, kept only for hotels still on the list
    const savedInquiry = saved.hotelInquiry && typeof saved.hotelInquiry === "object" ? saved.hotelInquiry : {};
    [...(shanghai.staysA || []), ...(shanghai.staysB || [])].forEach((stay) => {
      const rec = savedInquiry[stay.id];
      if (!rec || typeof rec !== "object") return;
      next.hotelInquiry[stay.id] = {
        status: INQUIRY_STATUS[rec.status] ? rec.status : "none",
        memo: typeof rec.memo === "string" ? rec.memo.slice(0, 300) : "",
      };
    });

    return next;
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
    try {
      const bridge = window.TRIP_APP_BRIDGE;
      if (bridge) {
        const res = bridge.getResult("shanghai");
        if (res && res.money && res.money.rate) return Number(res.money.rate);
      }
    } catch (e) {
      // fallback
    }
    return 200;
  }

  function getShanghaiQuoteResult() {
    try {
      return window.TRIP_APP_BRIDGE ? window.TRIP_APP_BRIDGE.getResult("shanghai") : null;
    } catch (e) {
      return null;
    }
  }

  function getPlace(placeId) {
    return (shanghai.places && shanghai.places[placeId]) || null;
  }

  function amapUrl(place) {
    const q = (place && (place.amapQuery || place.nameZh || place.addressZh)) || "上海";
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(q)}&city=${encodeURIComponent("上海")}`;
  }

  function baiduUrl(place) {
    const q = (place && (place.baiduQuery || place.nameZh || place.addressZh)) || "上海";
    return `https://map.baidu.com/search/${encodeURIComponent(q)}/`;
  }

  function getOrderedDayItems(dayIndex) {
    const day = shanghai.itinerary[dayIndex];
    return day ? day.items : [];
  }

  function getAllItemsFlat() {
    const list = [];
    shanghai.itinerary.forEach((day) => {
      getOrderedDayItems(day.dayIndex).forEach((item) => {
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

  function getProgressStats() {
    const allItems = getAllItemsFlat();
    const doneItems = allItems.filter(({ item }) => Boolean(getItemState(item.id).done)).length;

    const resList = shanghai.reservations || [];
    const doneRes = resList.filter((r) => {
      const st = (state.reservations[r.id] || {}).status;
      return st === "booked" || st === "used";
    }).length;
    const urgentPending = resList.filter((r) => {
      if (!r.urgentD8) return false;
      const st = (state.reservations[r.id] || {}).status;
      return st !== "booked" && st !== "used";
    });

    const preChecks = shanghai.checklists.preTrip || [];
    const dayChecks = Object.values(shanghai.checklists.byDay || {}).flat();
    const allChecks = [...preChecks, ...dayChecks, ...state.customChecks];
    const doneChecks = allChecks.filter((c) => Boolean(state.checklistDone[c.id])).length;

    return {
      totalItems: allItems.length,
      doneItems,
      itemPct: allItems.length ? Math.round((doneItems / allItems.length) * 100) : 0,
      totalRes: resList.length,
      doneRes,
      resPct: resList.length ? Math.round((doneRes / resList.length) * 100) : 0,
      urgentPending,
      totalChecks: allChecks.length,
      doneChecks,
      prepPct: allChecks.length ? Math.round((doneChecks / allChecks.length) * 100) : 0,
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
    return shanghai.itinerary.findIndex((d) => d.date === today);
  }

  // phase "before": the trip has not started. "during": today is a trip day. "after": it is over.
  // current = the unfinished item whose time slot contains now. next = the first unfinished item after now.
  function getNowNext(now = new Date()) {
    const all = getAllItemsFlat();
    const undone = all.filter(({ item }) => !getItemState(item.id).done);
    const todayIdx = getTodayDayIndex(now);
    if (todayIdx < 0) {
      const phase = localDateStr(now) < shanghai.itinerary[0].date ? "before" : "after";
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
    if (state.mode !== "field") return;
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
    const start = new Date(`${shanghai.tripMeta.startDate}T00:00:00+09:00`);
    const end = new Date(`${shanghai.tripMeta.endDate}T23:59:59+09:00`);
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

  // ---------- Global Events ----------
  function bindGlobalEvents() {
    dom.modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextMode = btn.dataset.mode === "plan" ? "plan" : "field";
        if (state.mode === nextMode) return;
        state.mode = nextMode;
        saveFieldState();
        applyMode();
        if (nextMode === "field") renderAll();
        // The other mode starts at its top.
        window.scrollTo({ top: 0 });
      });
    });

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
        const tab = btn.dataset.ftab;
        if (!FIELD_TABS.includes(tab)) return;
        selectFieldTab(tab === "bookings" ? state.bookSub : tab);
      });
    });

    // Taxi modal
    if (dom.closeTaxiModal) {
      dom.closeTaxiModal.addEventListener("click", closeTaxiModal);
    }
    if (dom.taxiModal) {
      dom.taxiModal.addEventListener("click", (e) => {
        if (e.target === dom.taxiModal) closeTaxiModal();
      });
    }
    if (dom.taxiCopyBtn) {
      dom.taxiCopyBtn.addEventListener("click", () => {
        if (!currentTaxiPlace) return;
        copyText(`${currentTaxiPlace.nameZh} ${currentTaxiPlace.addressZh}`, "중문 주소를 복사했습니다.");
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dom.taxiModal && !dom.taxiModal.classList.contains("hidden")) {
        closeTaxiModal();
      }
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

    // Delegated actions inside field-mode
    dom.fieldMode.addEventListener("click", handleFieldClick);
    dom.fieldMode.addEventListener("change", handleFieldChange);
    dom.fieldMode.addEventListener("submit", handleFieldSubmit);
  }

  function applyMode() {
    const isField = state.mode === "field";
    dom.body.classList.toggle("mode-field", isField);
    dom.body.classList.toggle("mode-plan", !isField);
    if (dom.fieldMode) dom.fieldMode.hidden = !isField;
    if (dom.planMode) dom.planMode.hidden = isField;
    dom.modeButtons.forEach((btn) => {
      const active = btn.dataset.mode === state.mode;
      if (!btn.classList.contains("mode-btn")) return;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  function selectFieldTab(tab, opts = {}) {
    state.activeTab = tab;
    if (tab === "bookings" || tab === "prep") state.bookSub = tab;
    saveFieldState();
    const navTab = NAV_OF[tab] || tab;
    dom.navButtons.forEach((btn) => {
      const active = btn.dataset.ftab === navTab;
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
    else if (state.activeTab === "prep") renderPrepTab();
    else if (state.activeTab === "bookings") renderBookingsTab();
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
    const quote = getShanghaiQuoteResult();
    const estPerPerson = quote ? `약 ${formatManwon(quote.perPerson.mean)}/인` : "-";
    const ddayText = getDdayText();

    const urgentHtml = stats.urgentPending.length
      ? `
        <button type="button" class="dash-urgent" data-jump-tab="bookings">
          <span><strong>미완료 핵심 예약 ${stats.urgentPending.length}건</strong> · ${stats.urgentPending.map((r) => esc(r.category)).join(" · ")}</span>
          <span class="dash-urgent-go">확인 →</span>
        </button>
      `
      : "";
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

    dom.dashboard.innerHTML = `
      ${urgentHtml}
      <div class="dash-now" aria-label="지금과 다음 일정">${nowHtml}</div>
      <details class="dash-fold" ${state.dashOpen ? "open" : ""}>
        <summary>
          <span class="dash-fold-items">
            <span class="dash-fold-item"><strong>${esc(shortStatus)}</strong></span>
            <span class="dash-fold-item">예약 <strong>${stats.doneRes}/${stats.totalRes}</strong></span>
            <span class="dash-fold-item">준비 <strong>${stats.doneChecks}/${stats.totalChecks}</strong></span>
            <span class="dash-fold-item">일정 <strong>${stats.doneItems}/${stats.totalItems}</strong></span>
          </span>
          <span class="dash-fold-arrow" aria-hidden="true">▾</span>
        </summary>
        <div class="dash-grid">
          <div class="dash-card">
            <span class="dash-label">여행 기간 · 상태</span>
            <div class="dash-value">${esc(ddayText)}</div>
            <div class="dash-sub">${esc(TRIP_LABEL)} · ${shanghai.tripMeta.nights}박 ${shanghai.tripMeta.days}일 · ${shanghai.tripMeta.travelers}인</div>
            ${
              shanghai.tripMeta.flights
                ? `<div class="dash-sub">${esc(shanghai.tripMeta.flights.out)}</div><div class="dash-sub">${esc(shanghai.tripMeta.flights.back)}</div>`
                : ""
            }
          </div>
          <div class="dash-card">
            <span class="dash-label">예약 완료율</span>
            <div class="dash-value">${stats.resPct}% <small class="dash-count">(${stats.doneRes}/${stats.totalRes})</small></div>
            <div class="dash-progress"><div class="dash-progress-bar" style="width:${stats.resPct}%"></div></div>
          </div>
          <div class="dash-card">
            <span class="dash-label">준비 체크리스트</span>
            <div class="dash-value">${stats.prepPct}% <small class="dash-count">(${stats.doneChecks}/${stats.totalChecks})</small></div>
            <div class="dash-progress"><div class="dash-progress-bar" style="width:${stats.prepPct}%"></div></div>
          </div>
          <div class="dash-card">
            <span class="dash-label">일정 진행 · 견적</span>
            <div class="dash-value">${stats.doneItems}/${stats.totalItems} 완료</div>
            <div class="dash-sub">예상 견적 ${esc(estPerPerson)}</div>
          </div>
        </div>
      </details>
    `;
  }

  // Two-part switch shown at the top of the bookings and the prep panels.
  function bookSubHtml(activeTab) {
    const stats = getProgressStats();
    const btn = (tab, label, count) => `
      <button type="button" class="sub-seg-btn ${activeTab === tab ? "is-active" : ""}" aria-pressed="${activeTab === tab}" data-jump-tab="${tab}">
        ${label}<span class="sub-seg-count">${count}</span>
      </button>`;
    return `
      <div class="sub-seg" role="group" aria-label="예약과 준비 전환">
        ${btn("bookings", "예약 · 숙소", `${stats.doneRes}/${stats.totalRes}`)}
        ${btn("prep", "준비 · 관세", `${stats.doneChecks}/${stats.totalChecks}`)}
      </div>
    `;
  }

  // ---------- Quote mode: section summaries and the changed-total blink ----------
  // The shared script writes the picked option into each section header. Here the amount is added,
  // and a "확정" tag when the amount is a price the traveller typed in rather than an estimate.
  function decorateQuote(result, mayPulse) {
    if (!result || !result.breakdown) return;
    const people = Number(result.people) || 1;
    const bridge = window.TRIP_APP_BRIDGE;
    const cityState = bridge && bridge.getState().cities ? bridge.getState().cities[result.cityId] : null;
    const quotes = (cityState && cityState.quotes) || {};
    const mid = (range) => (Array.isArray(range) ? (Number(range[0]) + Number(range[1])) / 2 : null);
    const quoted = (field) => {
      const locked = Boolean(result.quoteStatus && result.quoteStatus[field] === "applied" && quotes[field]);
      return { locked, krw: locked ? Number(quotes[field].krw) : mid(result.estimates && result.estimates[field]) };
    };
    const perPerson = (line) => (line && line.mean > 0 ? line.mean / people : null);
    const rows = {
      "summary-flight": { ...quoted("flight"), prefix: "1인 " },
      "summary-stayPre": { ...quoted("stayPre"), prefix: "" },
      "summary-stayA": { ...quoted("stayA"), prefix: "" },
      "summary-stayB": { ...quoted("stayB"), prefix: "" },
      "summary-airport": { krw: perPerson(result.breakdown.airport), prefix: "1인 " },
      "summary-data": { krw: perPerson(result.breakdown.data), prefix: "1인 " },
      "summary-meal": { krw: perPerson(result.breakdown.meal), prefix: "1인 " },
      "summary-transport": { krw: perPerson(result.breakdown.transport), prefix: "1인 " },
      "summary-activities": { krw: perPerson(result.breakdown.activities), prefix: "1인 " },
    };
    document.querySelectorAll("#plan-mode .category-summary").forEach((node) => {
      const text = node.textContent.trim();
      if (!text || node.querySelector(".sum-text")) return;
      const row = rows[node.id] || {};
      const amount = row.krw && Math.round(row.krw / 10000) > 0 ? `${row.prefix}${formatManwon(row.krw)}` : "";
      node.innerHTML = `<span class="sum-text">${esc(text)}</span>${amount ? `<span class="sum-amt">${esc(amount)}</span>` : ""}${
        row.locked ? `<span class="sum-lock">확정</span>` : ""
      }`;
      node.title = [text, amount, row.locked ? "확정가" : ""].filter(Boolean).join(" · ");
    });

    // Blink the total once when a pick changes it.
    const mean = Math.round(result.perPerson.mean / 10000);
    if (mayPulse && lastQuoteMean !== null && mean !== lastQuoteMean) {
      [byId("per-person-total"), byId("mobile-bar-total")].forEach((node) => {
        if (!node) return;
        node.classList.remove("price-updated");
        void node.offsetWidth; // restart the animation
        node.classList.add("price-updated");
      });
    }
    lastQuoteMean = mean;
  }

  // ---------- Tab 1: Schedule ----------
  function slashDate(d) {
    return d.date.slice(5).replace("-", "/");
  }

  // "A숙소 · 진장 메트로폴로 클래식 YMCA (예약 완료 · …)" -> without the trailing note in brackets
  function shortPlaceName(place) {
    return place ? place.nameKo.replace(/\s*\([^)]*\)\s*$/, "") : "";
  }

  function renderScheduleTab() {
    const nn = getNowNext();
    renderedClockKey = clockKey(nn);
    const showAll = state.scheduleView === "all";
    const day = shanghai.itinerary[state.activeDay] || shanghai.itinerary[0];

    const dayTabsHtml = `
      <div class="day-tabs" role="tablist" aria-label="날짜 선택">
        <button type="button" class="day-tab-btn ${showAll ? "is-active" : ""}" data-select-view="all" role="tab" aria-selected="${showAll}" aria-label="전체 일정 ${TRIP_DAYS}일">
          <strong>전체</strong>
          <small>${TRIP_DAYS}일</small>
        </button>
        ${shanghai.itinerary
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
    const stay = day.stayPlaceId ? getPlace(day.stayPlaceId) : null;

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
        const resRecord = item.reservationId ? state.reservations[item.reservationId] : null;
        const resStatusMeta = resRecord ? RES_STATUS[resRecord.status] : null;
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

        // Step-by-step walkthrough (airport arrival, departure morning) belongs to the main plan only.
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
          resStatusMeta ? `<span class="tl-res st-${esc(resRecord.status)}">${esc(resStatusMeta.label)}</span>` : "",
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
                <div class="tl-detail-box">
                  <small>예약 · 링크</small>
                  ${
                    resRecord
                      ? `<strong>${esc(resStatusMeta.label)}</strong> · <button type="button" class="link-btn" data-jump-tab="bookings">예약 관리</button>`
                      : `<span>${item.bookingRequired ? "예약 필요" : "현장 이용"}</span>`
                  }
                  ${item.bookingLink ? ` · <a href="${esc(item.bookingLink)}" target="_blank" rel="noopener noreferrer">예약 링크 ↗</a>` : ""}
                </div>
                <div class="tl-detail-box">
                  <small>운영 · 팁</small>
                  <span>${place && place.hours ? esc(place.hours) : "-"}</span>
                </div>
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
                  ${place ? `${esc(shortPlaceName(place))} · <span lang="zh-CN">${esc(place.nameZh)}</span>` : ""}
                  ${item.estCostLabel ? ` · ${esc(item.estCostLabel)}` : ""}
                </div>
                <p class="tl-memo ${expanded ? "" : "is-clamped"}" ${memoText ? "" : "hidden"}>${esc(memoText)}</p>
              </div>
              <label class="tl-checkwrap">
                <input type="checkbox" class="tl-check" aria-label="${esc(activeTitle)} 완료" ${st.done ? "checked" : ""} data-item-done="${esc(item.id)}" />
              </label>
            </div>
            ${stepsHtml || guideHtml ? `<div class="tl-extra">${stepsHtml}${guideHtml}</div>` : ""}
            <div class="tl-foot">
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

    const daysHtml = shanghai.itinerary
      .map((d) => {
        const stay = d.stayPlaceId ? getPlace(d.stayPlaceId) : null;
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
            return `
              <li class="ov-row ${st.done ? "is-done" : ""} ${isNow ? "is-now" : ""}">
                <button type="button" class="ov-row-btn" data-jump-item="${esc(item.id)}">
                  <span class="ov-time">${esc(item.startTime)}<small>${esc(item.endTime)}</small></span>
                  <span>
                    <span class="ov-title">${isNow ? `<span class="tl-flag is-now">지금</span> ` : ""}${isNext ? `<span class="tl-flag">다음</span> ` : ""}${esc(title)}</span>
                    <span class="ov-place">${place ? esc(shortPlaceName(place)) : ""}${item.fixedTime ? ` · <span class="tl-fixed">시간 고정</span>` : ""}</span>
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

  // ---------- Tab 2: Map ----------
  function renderMapTab() {
    const places = Object.values(shanghai.places || {});
    const filtered = places.filter((p) => {
      const dayOk = mapDayFilter === "all" || (p.dayIndices || []).includes(Number(mapDayFilter));
      const catOk = mapCatFilter === "all" || p.category === mapCatFilter;
      return dayOk && catOk;
    });

    const dayFilters = [["all", "전체 날짜"], ...shanghai.itinerary.map((d) => [String(d.dayIndex), dayChipLabel(d)])];
    const catFilters = [
      ["all", "전체 분류"],
      ["stay", "숙박"],
      ["food", "식사"],
      ["sight", "관광"],
      ["shopping", "쇼핑"],
      ["transport", "이동"],
      ["hospital", "백업 병원"],
    ];

    const diningHtml = (shanghai.diningGuide || []).length
      ? `
        <div class="sh-card">
          <div class="sh-card-head">
            <h2>상하이 필수 미식 · 추천 식당 가이드 (털게 · 본방차이 · 딤섬 · 면)</h2>
            <span class="field-note" style="margin:0">11월 말–12월 초는 상하이 털게(大闸蟹) 제철 막바지</span>
          </div>
          <div class="place-grid">
            ${shanghai.diningGuide
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
                    ${
                      p
                        ? `
                          <div class="tl-actions-row" style="margin-top:auto">
                            <button type="button" class="sh-btn is-sm is-primary" data-taxi-place="${esc(p.id)}">택시 제시</button>
                            <button type="button" class="sh-btn is-sm" data-copy-addr="${esc(p.id)}">주소 복사</button>
                            <a class="sh-btn is-sm" href="${esc(amapUrl(p))}" target="_blank" rel="noopener noreferrer">高德(Amap)</a>
                            <a class="sh-btn is-sm" href="${esc(baiduUrl(p))}" target="_blank" rel="noopener noreferrer">百度(Baidu)</a>
                          </div>
                        `
                        : ""
                    }
                  </article>
                `;
              })
              .join("")}
          </div>
        </div>
      `
      : "";

    dom.panels.map.innerHTML = `
      ${diningHtml}
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>상하이 현지 지도 · 중국어 주소 · 택시 카드</h2>
          <span class="field-note" style="margin:0">중국은 Google Maps 좌표 오차가 크므로 고덕(Amap)·바이두 중문 검색을 사용합니다.</span>
        </div>
        <div class="sh-chip-bar" role="group" aria-label="날짜 필터">
          ${dayFilters
            .map(([val, label]) => `<button type="button" class="sh-chip ${mapDayFilter === val ? "is-active" : ""}" data-map-day="${val}">${label}</button>`)
            .join("")}
        </div>
        <div class="sh-chip-bar" role="group" aria-label="카테고리 필터">
          ${catFilters
            .map(([val, label]) => `<button type="button" class="sh-chip ${mapCatFilter === val ? "is-active" : ""}" data-map-cat="${val}">${label}</button>`)
            .join("")}
        </div>
      </div>

      <div class="place-grid">
        ${filtered
          .map(
            (p) => `
              <article class="place-card">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
                  <span class="sh-badge cat-${esc(p.category)}">${esc(CAT_LABELS[p.category] || p.category)}</span>
                  <span class="place-meta">${esc(p.area)} · ${(p.dayIndices || []).map((d) => `D${d + 1}`).join(", ")}</span>
                </div>
                <h3>${esc(p.nameKo)}</h3>
                <div class="place-zh">${esc(p.nameZh)}</div>
                <div class="place-addr">${esc(p.addressZh)}</div>
                <div class="place-meta">${esc(p.hours || "-")} · ${esc(p.tip || "")}</div>
                <div class="tl-actions-row" style="margin-top:auto">
                  <button type="button" class="sh-btn is-sm is-primary" data-taxi-place="${esc(p.id)}">택시 제시</button>
                  <button type="button" class="sh-btn is-sm" data-copy-addr="${esc(p.id)}">주소 복사</button>
                  <a class="sh-btn is-sm" href="${esc(amapUrl(p))}" target="_blank" rel="noopener noreferrer">高德(Amap)</a>
                  <a class="sh-btn is-sm" href="${esc(baiduUrl(p))}" target="_blank" rel="noopener noreferrer">百度(Baidu)</a>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  }

  // ---------- Tab 3: Prep ----------
  function renderPrepTab() {
    const preList = shanghai.checklists.preTrip || [];
    const dayLists = shanghai.checklists.byDay || {};
    const activeList =
      prepDayFilter === "pre"
        ? [...preList, ...state.customChecks]
        : dayLists[Number(prepDayFilter)] || [];

    const quote = getShanghaiQuoteResult();
    const cashTotalCNY = quote && quote.cash ? Math.ceil(quote.cash.total[1] / 100) * 100 : 600;
    const fxRate = getFxRate();
    const tpl = shanghai.hotelParcelTemplate;
    const pay = shanghai.paymentGuide;
    const payHtml =
      pay && Array.isArray(pay.methods)
        ? `
          <div class="sh-card">
            <div class="sh-card-head">
              <h2>결제 · 현금 · ATM 전략</h2>
              <span class="field-note" style="margin:0">${esc(pay.asOfNote || "")}</span>
            </div>
            <p class="field-note" style="margin-top:0">${esc(pay.summary || "")}</p>
            <div class="tl-detail-grid">
              ${pay.methods
                .map(
                  (m) => `
                    <div class="tl-detail-box">
                      <small>${esc(m.role)} · ${esc(m.use)}</small>
                      <strong>${esc(m.name)}</strong>
                      <div class="check-note">${esc(m.note)}</div>
                    </div>
                  `
                )
                .join("")}
            </div>
            ${
              Array.isArray(pay.atmTips) && pay.atmTips.length
                ? `<ul class="pay-list">${pay.atmTips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
                : ""
            }
          </div>
        `
        : "";

    dom.panels.prep.innerHTML = `
      ${bookSubHtml("prep")}
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>체크리스트 (출발 전 필수 &amp; 날짜별 할 일)</h2>
          <button type="button" class="sh-btn is-sm" data-switch-mode="plan">처방 준비·현금 상세 (견적 모드) →</button>
        </div>
        <div class="sh-chip-bar" role="group" aria-label="체크리스트 범위">
          <button type="button" class="sh-chip ${prepDayFilter === "pre" ? "is-active" : ""}" data-prep-scope="pre">출발 전 공통</button>
          ${shanghai.itinerary
            .map(
              (d) =>
                `<button type="button" class="sh-chip ${prepDayFilter === String(d.dayIndex) ? "is-active" : ""}" data-prep-scope="${d.dayIndex}">${esc(dayChipLabel(d))}</button>`
            )
            .join("")}
        </div>

        <ul class="check-list">
          ${activeList
            .map((c) => {
              const done = Boolean(state.checklistDone[c.id]);
              return `
                <li class="check-row ${c.urgent && !done ? "is-urgent" : ""} ${done ? "is-done" : ""}">
                  <input type="checkbox" class="tl-check" ${done ? "checked" : ""} data-check-id="${esc(c.id)}" aria-label="${esc(c.title)}" />
                  <div class="check-body">
                    <div class="check-title">${c.urgent ? `<span class="sh-status-pill st-need_booking" style="margin-right:6px">출발 전 필수</span>` : ""}${esc(c.title)}</div>
                    ${c.note ? `<div class="check-note">${esc(c.note)}</div>` : ""}
                  </div>
                  ${c.custom ? `<button type="button" class="sh-btn is-sm is-danger" data-del-check="${esc(c.id)}">삭제</button>` : ""}
                </li>
              `;
            })
            .join("")}
        </ul>

        ${
          prepDayFilter === "pre"
            ? `
              <form id="custom-check-form" style="display:flex;gap:8px;margin-top:12px">
                <input id="custom-check-input" class="sh-input" type="text" placeholder="직접 준비물·할 일 추가 (예: 상비약, 보조배터리)" required />
                <button type="submit" class="sh-btn is-primary">추가</button>
              </form>
            `
            : ""
        }
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>호텔 프런트 냉장 택배 사전 고지 템플릿 (원탭 복사)</h2>
          <button type="button" class="sh-btn is-sm is-primary" data-copy-parcel-tpl="1">중문 메시지 복사</button>
        </div>
        <div class="template-box">${esc(tpl.zh)}</div>
        <p class="field-note" style="margin:0">한국어 뜻: ${esc(tpl.ko)}</p>
      </div>

      ${payHtml}

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>관세 · 면세 ($800) · 현금 · 날씨 요약</h2>
        </div>
        <div class="tl-detail-grid">
          <div class="tl-detail-box">
            <small>입국 관세 · 면세 한도 (1인 $800 · 약 112만원)</small>
            ${
              quote && quote.customs
                ? quote.customs.isOverLimit
                  ? `<strong style="color:var(--sh-red-text)">초과 주의 · 1인 약값 약 ${formatManwon(quote.customs.perPatientDrugKRW)}</strong>
                     <div class="check-note">초과분 자진신고 시 예상 세액 1인 약 ${formatManwon(quote.customs.estTaxSelfKRW)} (30% 감면 · 미신고 시 가산세 40%)</div>`
                  : `<strong style="color:var(--sh-green-text)">면세 안전 · 1인 약값 약 ${formatManwon(quote.customs.perPatientDrugKRW)}</strong>
                     <div class="check-note">1인 $800 이내 (잔여 쇼핑 면세 여력 약 ${formatManwon(quote.customs.remainingDutyFreeKRW)} · 다른 쇼핑과 합산)</div>`
                : `<strong>1인 $800 (약 112만원) 이내 면세</strong>`
            }
          </div>
          <div class="tl-detail-box">
            <small>비상 위안화 현금 기준액 (견적 연동)</small>
            <strong>약 ¥${formatNum(cashTotalCNY)} (약 ${formatManwon(cashTotalCNY * fxRate)})</strong>
            <div class="check-note">사전 환전 대신 필요할 때 현지 ATM에서 인출(위 결제 전략) · 노점 조식·우중시장·알리페이 장애 대비 (온라인 택배는 알리페이 선결제)</div>
          </div>
          <div class="tl-detail-box">
            <small>${esc(TRIP_LABEL)} 상하이 예상 날씨 · 복장</small>
            <strong>${esc(shanghai.tripMeta.weather.tempC)} · ${esc(shanghai.tripMeta.weather.rainNote)}</strong>
            <div class="check-note">${esc(shanghai.tripMeta.weather.clothing)}</div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Tab 4: Bookings & Hotel Verification ----------
  function renderBookingsTab() {
    const quote = getShanghaiQuoteResult();
    const selectedStayId = quote && quote.stayA ? quote.stayA.id : "radisson_newworld";

    const resHtml = (shanghai.reservations || [])
      .map((r) => {
        const rec = state.reservations[r.id] || { status: r.defaultStatus, refNo: "", amountKRW: "", note: r.note };
        const stMeta = RES_STATUS[rec.status] || RES_STATUS.review;
        const isPendingUrgent = r.urgentD8 && rec.status !== "booked" && rec.status !== "used";
        return `
          <article class="res-card ${isPendingUrgent ? "is-urgent" : ""}">
            <div class="res-head">
              <div>
                <span class="sh-badge cat-stay">${esc(r.category)}</span>
                <span class="sh-status-pill st-${esc(rec.status)}">${esc(stMeta.label)}</span>
                ${isPendingUrgent ? `<span class="sh-status-pill st-need_booking">우선</span>` : ""}
                <strong style="margin-left:6px">${esc(r.title)}</strong>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                ${r.linkedItemId ? `<button type="button" class="sh-btn is-sm" data-jump-item="${esc(r.linkedItemId)}">일정 보기</button>` : ""}
                ${r.link ? `<a class="sh-btn is-sm" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">예약 링크 ↗</a>` : ""}
              </div>
            </div>
            <div class="check-note">${esc(rec.note || r.note || "")}</div>
            <div class="res-controls">
              <select class="sh-select" aria-label="${esc(r.title)} 예약 상태" data-res-status="${esc(r.id)}">
                ${Object.entries(RES_STATUS)
                  .map(([k, v]) => `<option value="${k}" ${rec.status === k ? "selected" : ""}>${v.label}</option>`)
                  .join("")}
              </select>
              <input class="sh-input" type="text" placeholder="예약번호 / 확인코드" value="${esc(rec.refNo || "")}" data-res-ref="${esc(r.id)}" />
              <input class="sh-input" type="number" inputmode="numeric" placeholder="확정 결제액 (원)" value="${esc(rec.amountKRW || "")}" data-res-krw="${esc(r.id)}" />
            </div>
          </article>
        `;
      })
      .join("");

    const selectedStayBId = quote && quote.stayB ? quote.stayB.id : "";
    const inquiry = shanghai.hotelInquiry;
    const bStayIds = new Set((shanghai.staysB || []).map((s) => s.id));
    // Booked hotels first (A, then B), then the backups
    const inquiryTargets = [...(shanghai.staysA || []), ...(shanghai.staysB || [])]
      .filter((s) => s.inquire)
      .sort((a, b) => Number(Boolean(b.booked)) - Number(Boolean(a.booked)));
    const inquiryOf = (stayId) => state.hotelInquiry[stayId] || { status: "none", memo: "" };
    const bookingSearchUrl = (stay) => {
      const tpl = inquiry && inquiry.templates[stay.inquiryRole || "a"];
      const params = new URLSearchParams({ ss: stay.booking || stay.nameZh || "Shanghai", group_adults: String(shanghai.tripMeta.travelers || 2), no_rooms: "1" });
      if (tpl && tpl.checkin) {
        params.set("checkin", tpl.checkin);
        params.set("checkout", tpl.checkout);
      }
      return `https://www.booking.com/searchresults.ko.html?${params.toString()}`;
    };

    const inquiryHtml =
      inquiry && inquiryTargets.length
        ? `
          <div class="sh-card">
            <div class="sh-card-head">
              <h2>${esc(inquiry.title || "예약 전 문의 · 냉장 택배를 받아 주는지 먼저 확인")}</h2>
              <span class="sh-status-pill st-need_booking">답 기한 ${esc(inquiry.deadline.slice(5).replace("-", "/"))}</span>
            </div>
            <p class="field-note" style="margin-top:0">${esc(inquiry.deadlineNote)} 가능 답변 ${inquiryTargets.filter((s) => inquiryOf(s.id).status === "yes").length}곳 · 답 대기 ${inquiryTargets.filter((s) => inquiryOf(s.id).status === "sent").length}곳 / 후보 ${inquiryTargets.length}곳</p>

            <div class="tl-detail-grid">
              ${Object.entries(inquiry.templates)
                .map(
                  ([key, tpl]) => `
                    <div class="tl-detail-box">
                      <small>${esc(tpl.label)}</small>
                      <div class="template-box" style="white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;margin:6px 0">${esc(tpl.zh)}</div>
                      <div class="check-note">뜻: ${esc(tpl.ko)}</div>
                      <div class="tl-actions-row">
                        <button type="button" class="sh-btn is-sm is-primary" data-copy-inq="${esc(key)}" data-lang="zh">중문 복사</button>
                        <button type="button" class="sh-btn is-sm" data-copy-inq="${esc(key)}" data-lang="en">영문 복사</button>
                      </div>
                    </div>
                  `
                )
                .join("")}
            </div>

            <div class="planb-box" style="margin:12px 0">
              <strong>문의하는 방법</strong>
              <ol style="margin:6px 0 0;padding-left:18px">${inquiry.howTo.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
            </div>

            <ul class="inq-list">
              ${inquiryTargets
                .map((stay) => {
                  const rec = inquiryOf(stay.id);
                  const meta = INQUIRY_STATUS[rec.status] || INQUIRY_STATUS.none;
                  const isA = stay.id === selectedStayId;
                  const pairB = bStayIds.has(stay.id) ? stay.id : stay.pairB;
                  const isB = Boolean(pairB) && pairB === selectedStayBId;
                  return `
                    <li class="inq-row ${rec.status === "yes" ? "is-yes" : rec.status === "no" ? "is-no" : ""}">
                      <div>
                        <div class="check-title">
                          ${stay.booked ? `<span class="sh-status-pill st-booked" style="margin-right:6px">예약 완료</span>` : ""}<span class="sh-status-pill st-${esc(meta.pill)}" style="margin-right:6px">${esc(meta.label)}</span>${esc(stay.short || stay.title)}
                          <small style="font-weight:600;color:var(--muted)"> · ${esc(INQUIRY_ROLE_LABELS[stay.inquiryRole] || "")}</small>
                        </div>
                        <div class="check-note">${esc(stay.nameZh)} · ${esc(stay.addressZh)}${stay.phone ? ` · <a href="tel:${esc(stay.phone.replaceAll("-", ""))}">${esc(stay.phone)}</a>` : " · 전화번호는 숙소 페이지에서 확인"}</div>
                        <div class="inq-controls">
                          <select class="sh-select" aria-label="${esc(stay.short || stay.title)} 문의 상태" data-inq-status="${esc(stay.id)}">
                            ${Object.entries(INQUIRY_STATUS)
                              .map(([k, v]) => `<option value="${k}" ${rec.status === k ? "selected" : ""}>${v.label}</option>`)
                              .join("")}
                          </select>
                          <input class="sh-input" type="text" placeholder="답변 메모 (예: 代收可以, 객실 냉장고 없음)" value="${esc(rec.memo || "")}" data-inq-memo="${esc(stay.id)}" />
                        </div>
                        <div class="tl-actions-row">
                          ${stay.booked ? "" : `<a class="sh-btn is-sm" href="${esc(bookingSearchUrl(stay))}" target="_blank" rel="noopener noreferrer">Booking.com 날짜 검색 ↗</a>`}
                          <button type="button" class="sh-btn is-sm" data-copy-hotel="${esc(stay.id)}">중문 이름·주소 복사</button>
                          ${bStayIds.has(stay.id) ? "" : `<button type="button" class="sh-btn is-sm ${isA ? "is-primary" : ""}" data-pick-stay="${esc(stay.id)}">${isA ? "현재 A숙소" : "A숙소로"}</button>`}
                          ${pairB ? `<button type="button" class="sh-btn is-sm ${isB ? "is-primary" : ""}" data-pick-stayb="${esc(pairB)}">${isB ? "현재 B숙소" : "B숙소로"}</button>` : ""}
                        </div>
                      </div>
                    </li>
                  `;
                })
                .join("")}
            </ul>
          </div>
        `
        : "";

    // Hotels waiting on an inquiry lead the matrix.
    const stays = (shanghai.staysA || [])
      .filter((s) => hotelTypeFilter === "all" || s.stayType === hotelTypeFilter)
      .sort((a, b) => Number(Boolean(b.inquire)) - Number(Boolean(a.inquire)));
    const hotelsHtml = stays
      .map((stay) => {
        const v = stay.verification || { grade: "B", label: "확인 필요", checks: {}, summary: "" };
        const isSelected = stay.id === selectedStayId;
        const priceRange = stay.perRoomPerNightCNY ? `¥${formatNum(stay.perRoomPerNightCNY[0])}–${formatNum(stay.perRoomPerNightCNY[1])}/박` : "";
        const inqMeta = stay.inquire ? INQUIRY_STATUS[inquiryOf(stay.id).status] || INQUIRY_STATUS.none : null;
        return `
          <article class="hotel-card ${isSelected ? "is-selected" : ""}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div>
                <span class="grade-pill is-grade-${esc(v.grade)}" style="margin-left:0">${esc(v.label)}</span>
                <span class="sh-badge cat-transport" style="margin-left:4px">${esc(STAY_TYPE_LABELS[stay.stayType] || "호텔")}</span>
                ${inqMeta ? `<span class="sh-status-pill st-${esc(inqMeta.pill)}" style="margin-left:4px">${esc(inqMeta.label)}</span>` : ""}
                <h3 style="margin:6px 0 2px;font-size:0.98rem">${esc(stay.title)}</h3>
                <div class="place-meta">${esc(stay.nameZh || "")} · ${esc(stay.area || "")} · <strong>${esc(priceRange)}</strong></div>
                ${stay.inquire ? `<div class="place-meta">${esc(stay.addressZh || "")}${stay.phone ? ` · ${esc(stay.phone)}` : ""}</div>` : ""}
              </div>
              <button type="button" class="sh-btn is-sm ${isSelected ? "is-primary" : ""}" data-pick-stay="${esc(stay.id)}">
                ${isSelected ? "현재 A숙소" : "A숙소로 선택"}
              </button>
            </div>
            <div class="verify-grid">
              ${VERIFY_LABELS.map(([key, label]) => {
                const st = (v.checks && v.checks[key]) || "unverified";
                return `<span class="v-chip v-${esc(st)}">${esc(label)}: ${esc(VERIFY_STATE_TEXT[st] || st)}</span>`;
              }).join("")}
            </div>
            <div class="check-note">${esc(v.summary || stay.subtitle || "")}</div>
          </article>
        `;
      })
      .join("");

    const excludedHtml = (shanghai.excludedStays || [])
      .map((ex) => `<li><strong>${esc(ex.title)}</strong> — ${esc(ex.reason)}</li>`)
      .join("");

    const totalStayNights = quote ? quote.nightsA + quote.nightsB : shanghai.tripMeta.nights;
    const bNightButtons = [];
    for (let b = 1; b <= Math.min(2, totalStayNights - 1); b += 1) {
      bNightButtons.push(
        `<button type="button" class="sh-btn is-sm ${quote && quote.nightsB === b ? "is-primary" : ""}" data-field-bnights="${b}">A ${totalStayNights - b}박 + B ${b}박</button>`
      );
    }

    dom.panels.bookings.innerHTML = `
      ${bookSubHtml("bookings")}
      ${inquiryHtml}
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>예약 관리 파이프라인 (검토 → 예약 필요 → 예약 완료 → 이용 완료)</h2>
          <button type="button" class="sh-btn is-sm" data-switch-mode="plan">확정가 입력(견적 모드) →</button>
        </div>
        <div class="res-list">${resHtml}</div>
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>상하이 시내 숙소 검증 매트릭스 (24h 유인 프런트 · 택배 수령 기준)</h2>
          <span class="field-note" style="margin:0">시내 핵심 권역 중심(공항·근교·탕천 제외) · A숙소 2박 + B숙소 2박 기준 · 예약한 A숙소와 예비 후보의 택배 수령은 숙소 답을 받기 전까지 미확인</span>
        </div>
        <div class="tl-detail-box" style="margin-bottom:12px">
          <small>현재 숙박 구성 (견적 연동)</small>
          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
            <strong>${esc(quote ? quote.stayNote : "A숙소 2박 + B숙소 2박")}</strong>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0;max-width:100%">
              <select class="sh-select" style="width:auto;max-width:100%" aria-label="B숙소 선택" data-field-stayb="1">
                ${(shanghai.staysB || [])
                  .map((sb) => `<option value="${esc(sb.id)}" ${quote && quote.stayB && quote.stayB.id === sb.id ? "selected" : !quote?.stayB && sb.id === "none" ? "selected" : ""}>B숙소: ${esc(sb.short || sb.title)}</option>`)
                  .join("")}
              </select>
              ${quote && quote.stayB ? bNightButtons.join("") : ""}
            </div>
          </div>
        </div>
        <div class="sh-chip-bar" role="group" aria-label="숙소 유형 필터">
          ${Object.entries(STAY_TYPE_LABELS)
            .map(([k, label]) => `<button type="button" class="sh-chip ${hotelTypeFilter === k ? "is-active" : ""}" data-hotel-type="${k}">${label}</button>`)
            .join("")}
        </div>
        <div class="hotel-grid">${hotelsHtml}</div>
        <div class="planb-box" style="margin-top:12px">
          <strong>제외된 숙박 유형 (온라인 콜드체인 택배 기준 부적합):</strong>
          <ul style="margin:6px 0 0;padding-left:18px">${excludedHtml}</ul>
        </div>
      </div>
    `;
  }

  // ---------- Tab 5: Budget ----------
  function renderBudgetTab() {
    const fxRate = getFxRate();
    const quote = getShanghaiQuoteResult();

    // Aggregate estimated vs actual by day and by category
    const byDay = shanghai.itinerary.map((d) => ({ dayIndex: d.dayIndex, label: `Day ${d.dayIndex + 1} (${d.date.slice(5)})`, estCNY: 0, actCNY: 0 }));
    const byCat = {};
    ["food", "sight", "shopping", "transport", "stay", "rx"].forEach((c) => {
      byCat[c] = { category: c, label: CAT_LABELS[c], estCNY: 0, actCNY: 0 };
    });

    getAllItemsFlat().forEach(({ day, item }) => {
      const st = getItemState(item.id);
      const usePlanB = Boolean(st.usePlanB && item.planB);
      const est = Number(usePlanB ? item.planB.estCostCNY : item.estCostCNY) || 0;
      const act = st.actualCNY !== undefined && st.actualCNY !== "" ? Number(st.actualCNY) || 0 : 0;
      byDay[day.dayIndex].estCNY += est;
      byDay[day.dayIndex].actCNY += act;
      if (byCat[item.category]) {
        byCat[item.category].estCNY += est;
        byCat[item.category].actCNY += act;
      }
    });

    state.expenses.forEach((exp) => {
      const amt = Number(exp.amountCNY) || 0;
      if (byDay[exp.dayIndex]) byDay[exp.dayIndex].actCNY += amt;
      if (byCat[exp.category]) byCat[exp.category].actCNY += amt;
    });

    const totalEstCNY = byDay.reduce((s, d) => s + d.estCNY, 0);
    const totalActCNY = byDay.reduce((s, d) => s + d.actCNY, 0);

    dom.panels.budget.innerHTML = `
      <div class="budget-summary-grid">
        <div class="dash-card">
          <span class="dash-label">현지 일정 예상 (2인 · 항공/호텔/약값 제외)</span>
          <div class="dash-value">¥${formatNum(totalEstCNY)}</div>
          <div class="dash-sub">약 ${formatManwon(totalEstCNY * fxRate)} (1위안 = ${fxRate}원)</div>
        </div>
        <div class="dash-card">
          <span class="dash-label">실제 기록 지출 합계 (2인)</span>
          <div class="dash-value">¥${formatNum(totalActCNY)}</div>
          <div class="dash-sub">약 ${formatManwon(totalActCNY * fxRate)} · 차이 ${totalActCNY - totalEstCNY >= 0 ? "+" : ""}¥${formatNum(totalActCNY - totalEstCNY)}</div>
        </div>
        <div class="dash-card">
          <span class="dash-label">전체 여행 견적 (항공·호텔·마운자로 포함)</span>
          <div class="dash-value">${quote ? `약 ${formatManwon(quote.total.mean)}` : "-"}</div>
          <div class="dash-sub">${quote ? `1인 약 ${formatManwon(quote.perPerson.mean)} · ` : ""}<button type="button" class="link-btn" data-switch-mode="plan">6도시 견적 상세</button></div>
        </div>
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>빠른 현지 지출 기록 (CNY 입력 → KRW 자동 환산)</h2>
        </div>
        <form id="expense-add-form" class="expense-form">
          <select id="exp-day" class="sh-select" aria-label="날짜">
            ${shanghai.itinerary.map((d) => `<option value="${d.dayIndex}">Day ${d.dayIndex + 1}</option>`).join("")}
          </select>
          <select id="exp-cat" class="sh-select" aria-label="카테고리">
            <option value="food">식사</option>
            <option value="transport">이동</option>
            <option value="sight">관광</option>
            <option value="shopping">쇼핑</option>
            <option value="rx">처방·택배</option>
            <option value="stay">숙박</option>
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
              <tr><th>날짜</th><th class="num">예상 (¥)</th><th class="num">실제 (¥)</th><th class="num">실제 (원화 환산)</th></tr>
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
              <tr><th>항목</th><th class="num">예상 (¥)</th><th class="num">실제 (¥)</th><th class="num">실제 (원화 환산)</th></tr>
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
    `;
  }

  // ---------- Tab 6: Notes & Backup ----------
  function renderNotesTab() {
    const itemNotes = getAllItemsFlat()
      .map(({ day, item }) => {
        const st = getItemState(item.id);
        const note = st.note !== undefined ? st.note : item.memo;
        return { day, item, note: (note || "").trim(), edited: st.note !== undefined };
      })
      .filter((x) => x.note);

    dom.panels.notes.innerHTML = `
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>자유 메모 (현지 기록 · 영수증·송장번호 메모)</h2>
        </div>
        <form id="free-note-form" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
          <input id="free-note-title" class="sh-input" type="text" placeholder="제목 (예: 순펑 송장번호 / 호텔 객실번호)" required />
          <textarea id="free-note-body" class="sh-textarea" placeholder="내용을 입력하세요 (브라우저에 자동 저장됩니다)" required></textarea>
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
          <h2>긴급 연락처 · 백업 병원</h2>
        </div>
        <ul class="contact-list">
          ${(shanghai.emergencyContacts || [])
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
          <h2>데이터 백업 · 복원 (JSON · 오프라인 기기 이전)</h2>
        </div>
        <p class="field-note" style="margin-top:0">일정 완료·예약·체크리스트·실지출·메모·견적 상태를 하나의 JSON 파일로 내보내거나 복원합니다.</p>
        <div class="tl-actions-row">
          <button type="button" class="sh-btn is-primary" data-backup-export="1">JSON 파일 다운로드</button>
          <button type="button" class="sh-btn" data-backup-copy="1">JSON 클립보드 복사</button>
          <label class="sh-btn" style="cursor:pointer">
            JSON 파일 불러오기
            <input type="file" id="backup-file-input" accept="application/json,.json" hidden />
          </label>
          <button type="button" class="sh-btn is-danger" data-field-reset="1">실행 기록 초기화</button>
        </div>
      </div>

      <div class="sh-card">
        <div class="sh-card-head">
          <h2>일정별 핵심 메모 모아보기 (${itemNotes.length}건)</h2>
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

  // ---------- Event Handlers ----------
  function handleFieldClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const jumpTabBtn = target.closest("[data-jump-tab]");
    if (jumpTabBtn) {
      selectFieldTab(jumpTabBtn.dataset.jumpTab);
      return;
    }

    const switchModeBtn = target.closest("[data-switch-mode]");
    if (switchModeBtn) {
      state.mode = switchModeBtn.dataset.switchMode === "plan" ? "plan" : "field";
      saveFieldState();
      applyMode();
      window.scrollTo({ top: 0 });
      return;
    }

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
      state.activeDay = clampInt(selectDayBtn.dataset.selectDay, 0, shanghai.itinerary.length - 1, 0);
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
      if (place) openTaxiModal(place);
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

    const prepScopeBtn = target.closest("[data-prep-scope]");
    if (prepScopeBtn) {
      prepDayFilter = prepScopeBtn.dataset.prepScope;
      renderPrepTab();
      return;
    }

    const copyTplBtn = target.closest("[data-copy-parcel-tpl]");
    if (copyTplBtn) {
      copyText(shanghai.hotelParcelTemplate.zh, "호텔 택배 사전 고지 중문 메시지를 복사했습니다.");
      return;
    }

    const delCheckBtn = target.closest("[data-del-check]");
    if (delCheckBtn) {
      const id = delCheckBtn.dataset.delCheck;
      state.customChecks = state.customChecks.filter((c) => c.id !== id);
      delete state.checklistDone[id];
      saveFieldState();
      renderDashboard();
      renderPrepTab();
      return;
    }

    const hotelTypeBtn = target.closest("[data-hotel-type]");
    if (hotelTypeBtn) {
      hotelTypeFilter = hotelTypeBtn.dataset.hotelType;
      renderBookingsTab();
      return;
    }

    const pickStayBtn = target.closest("[data-pick-stay]");
    if (pickStayBtn) {
      const stayId = pickStayBtn.dataset.pickStay;
      if (window.TRIP_APP_BRIDGE) {
        window.TRIP_APP_BRIDGE.selectStayA(stayId);
        showFieldToast("견적 계산기의 A숙소를 변경했습니다.");
      }
      renderBookingsTab();
      renderDashboard();
      return;
    }

    const pickStayBBtn = target.closest("[data-pick-stayb]");
    if (pickStayBBtn) {
      if (window.TRIP_APP_BRIDGE) {
        window.TRIP_APP_BRIDGE.selectStayB(pickStayBBtn.dataset.pickStayb);
        showFieldToast("견적 계산기의 B숙소를 변경했습니다.");
      }
      renderBookingsTab();
      renderDashboard();
      return;
    }

    const copyInqBtn = target.closest("[data-copy-inq]");
    if (copyInqBtn) {
      const tpl = shanghai.hotelInquiry && shanghai.hotelInquiry.templates[copyInqBtn.dataset.copyInq];
      const lang = copyInqBtn.dataset.lang === "en" ? "en" : "zh";
      if (tpl) copyText(tpl[lang], lang === "en" ? "영문 문의 메시지를 복사했습니다." : "중문 문의 메시지를 복사했습니다.");
      return;
    }

    const copyHotelBtn = target.closest("[data-copy-hotel]");
    if (copyHotelBtn) {
      const stay = [...(shanghai.staysA || []), ...(shanghai.staysB || [])].find((s) => s.id === copyHotelBtn.dataset.copyHotel);
      if (stay) copyText(`${stay.nameZh} ${stay.addressZh}`, "숙소 중문 이름·주소를 복사했습니다.");
      return;
    }

    const bNightsBtn = target.closest("[data-field-bnights]");
    if (bNightsBtn) {
      const n = Number(bNightsBtn.dataset.fieldBnights);
      if (window.TRIP_APP_BRIDGE) {
        window.TRIP_APP_BRIDGE.setStayBNights(n);
        const res = getShanghaiQuoteResult();
        showFieldToast(res ? `숙박 배분을 A ${res.nightsA}박 + B ${res.nightsB}박으로 변경했습니다.` : "숙박 배분을 변경했습니다.");
      }
      renderBookingsTab();
      renderDashboard();
      return;
    }

    const delExpBtn = target.closest("[data-del-expense]");
    if (delExpBtn) {
      const id = delExpBtn.dataset.delExpense;
      state.expenses = state.expenses.filter((x) => x.id !== id);
      saveFieldState();
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
      if (window.confirm("실행 모드의 체크·예약·지출·메모 기록을 초기 상태로 되돌릴까요?")) {
        state = createDefaultFieldState();
        saveFieldState();
        renderAll();
        showFieldToast("실행 기록을 초기화했습니다.");
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

    if (target.matches("[data-check-id]")) {
      const id = target.dataset.checkId;
      state.checklistDone[id] = target.checked;
      saveFieldState();
      renderDashboard();
      renderPrepTab();
      return;
    }

    if (target.matches("[data-field-stayb]")) {
      if (window.TRIP_APP_BRIDGE) {
        window.TRIP_APP_BRIDGE.selectStayB(target.value);
        showFieldToast("B숙소 구성을 변경했습니다.");
      }
      renderBookingsTab();
      renderDashboard();
      return;
    }

    if (target.matches("[data-inq-status]") || target.matches("[data-inq-memo]")) {
      const isStatus = target.matches("[data-inq-status]");
      const id = isStatus ? target.dataset.inqStatus : target.dataset.inqMemo;
      const rec = state.hotelInquiry[id] || { status: "none", memo: "" };
      if (isStatus) rec.status = INQUIRY_STATUS[target.value] ? target.value : "none";
      else rec.memo = target.value.slice(0, 300);
      state.hotelInquiry[id] = rec;
      saveFieldState();
      if (isStatus) renderBookingsTab();
      return;
    }

    if (target.matches("[data-res-status]")) {
      const id = target.dataset.resStatus;
      if (state.reservations[id]) {
        state.reservations[id].status = target.value;
        saveFieldState();
        renderDashboard();
        renderBookingsTab();
      }
      return;
    }

    if (target.matches("[data-res-ref]")) {
      const id = target.dataset.resRef;
      if (state.reservations[id]) {
        state.reservations[id].refNo = target.value;
        saveFieldState();
      }
      return;
    }

    if (target.matches("[data-res-krw]")) {
      const id = target.dataset.resKrw;
      if (state.reservations[id]) {
        state.reservations[id].amountKRW = target.value;
        saveFieldState();
      }
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

    if (form.id === "custom-check-form") {
      e.preventDefault();
      const input = byId("custom-check-input");
      const title = input ? input.value.trim() : "";
      if (!title) return;
      state.customChecks.push({ id: `chk_custom_${Date.now()}`, title, custom: true });
      saveFieldState();
      renderDashboard();
      renderPrepTab();
      showFieldToast("체크리스트 항목을 추가했습니다.");
      return;
    }

    if (form.id === "expense-add-form") {
      e.preventDefault();
      const dayIndex = clampInt(byId("exp-day").value, 0, shanghai.itinerary.length - 1, 0);
      const category = byId("exp-cat").value || "food";
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

  // ---------- Taxi Modal ----------
  function openTaxiModal(place) {
    currentTaxiPlace = place;
    if (!dom.taxiModal) return;
    dom.taxiTitle.textContent = place.nameZh || place.nameKo;
    dom.taxiAddr.textContent = place.addressZh || "-";
    dom.taxiKo.textContent = `${place.nameKo} (${place.area || "상하이"})`;
    dom.taxiAmap.href = amapUrl(place);
    dom.taxiBaidu.href = baiduUrl(place);
    dom.taxiModal.classList.remove("hidden");
    dom.closeTaxiModal.focus();
  }

  function closeTaxiModal() {
    if (!dom.taxiModal) return;
    dom.taxiModal.classList.add("hidden");
  }

  // ---------- Backup / Restore ----------
  function buildBackupPayload() {
    const quoteKey = window.TRIP_APP_BRIDGE ? window.TRIP_APP_BRIDGE.storageKey : "trip_2026_dec_china.v3";
    let quoteState = null;
    try {
      quoteState = JSON.parse(window.localStorage.getItem(quoteKey) || "null");
    } catch (e) {
      quoteState = null;
    }
    return {
      schema: "shanghai_trip_backup.v1",
      exportedAt: new Date().toISOString(),
      fieldState: state,
      quoteState,
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
      if (!parsed || parsed.schema !== "shanghai_trip_backup.v1" || !parsed.fieldState) {
        showFieldToast("올바른 상하이 여행 백업 JSON 형식이 아닙니다.");
        return;
      }
      state = sanitizeFieldState(parsed.fieldState);
      saveFieldState();
      if (parsed.quoteState && window.TRIP_APP_BRIDGE) {
        window.localStorage.setItem(window.TRIP_APP_BRIDGE.storageKey, JSON.stringify(parsed.quoteState));
        window.TRIP_APP_BRIDGE.reloadFromStorage();
      }
      applyMode();
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
