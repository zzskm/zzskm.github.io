/* trip_2026_dec_china.field.js - Shanghai Execution Mode (P0/P1/P2)
   Works offline and over file:// with zero external dependencies. */
(() => {
  const data = window.TRIP_DATA;
  const shanghai = data && data.cities && data.cities.shanghai;
  if (!shanghai || !Array.isArray(shanghai.itinerary)) return;

  const FIELD_KEY = "trip_2026_dec_china.field.v1";
  const FIELD_TABS = ["schedule", "map", "prep", "bookings", "budget", "notes"];
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

  const dom = {
    body: document.body,
    fieldMode: byId("field-mode"),
    planMode: byId("plan-mode"),
    modeButtons: Array.from(document.querySelectorAll(".mode-btn[data-mode]")),
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
  let mapDayFilter = "all";
  let mapCatFilter = "all";
  let hotelTypeFilter = "all";
  let prepDayFilter = "pre";
  let toastTimer = null;
  let currentTaxiPlace = null;

  let state = loadFieldState();

  init();

  function init() {
    if (dom.weatherPill && shanghai.tripMeta && shanghai.tripMeta.weather) {
      dom.weatherPill.textContent = `${shanghai.tripMeta.weather.tempC} · 경량 패딩`;
    }
    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    bindGlobalEvents();
    applyMode();
    renderAll();

    window.addEventListener("trip:rendered", () => {
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
    const itemOrder = {};
    shanghai.itinerary.forEach((day) => {
      itemOrder[day.dayIndex] = day.items.map((it) => it.id);
    });
    return {
      version: 1,
      mode: "field",
      activeTab: "schedule",
      activeDay: 0,
      itemState: {},
      itemOrder,
      reservations,
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
      activeDay: clampInt(saved.activeDay, 0, shanghai.itinerary.length - 1, 0),
      itemState: saved.itemState && typeof saved.itemState === "object" ? { ...saved.itemState } : {},
      itemOrder: { ...base.itemOrder },
      reservations: { ...base.reservations },
      checklistDone: saved.checklistDone && typeof saved.checklistDone === "object" ? { ...saved.checklistDone } : {},
      customChecks: Array.isArray(saved.customChecks) ? saved.customChecks.slice(0, 100) : [],
      expenses: Array.isArray(saved.expenses) ? saved.expenses.slice(0, 300) : [],
      freeNotes: Array.isArray(saved.freeNotes) ? saved.freeNotes.slice(0, 100) : [],
    };

    // Reconcile itemOrder so new/missing items are always preserved
    shanghai.itinerary.forEach((day) => {
      const validIds = day.items.map((it) => it.id);
      const savedIds = saved.itemOrder && Array.isArray(saved.itemOrder[day.dayIndex]) ? saved.itemOrder[day.dayIndex] : [];
      const kept = savedIds.filter((id) => validIds.includes(id));
      validIds.forEach((id) => {
        if (!kept.includes(id)) kept.push(id);
      });
      next.itemOrder[day.dayIndex] = kept;
    });

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
    if (!day) return [];
    const map = new Map(day.items.map((it) => [it.id, it]));
    const order = state.itemOrder[dayIndex] || day.items.map((it) => it.id);
    return order.map((id) => map.get(id)).filter(Boolean);
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

  function findNextUpcomingItem() {
    const all = getAllItemsFlat();
    const firstUndone = all.find(({ item }) => !getItemState(item.id).done);
    return firstUndone || all[all.length - 1] || null;
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
      return `여행 Day ${clampInt(dayNum, 1, 4, 1)} 진행 중`;
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
      });
    });

    dom.navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.ftab;
        if (!FIELD_TABS.includes(tab)) return;
        selectFieldTab(tab);
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
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
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
    else if (state.activeTab === "prep") renderPrepTab();
    else if (state.activeTab === "bookings") renderBookingsTab();
    else if (state.activeTab === "budget") renderBudgetTab();
    else if (state.activeTab === "notes") renderNotesTab();
  }

  function updateOnlineStatus() {
    if (!dom.offlinePill) return;
    const online = navigator.onLine !== false;
    dom.offlinePill.textContent = online ? "온라인 · 오프라인 열람 지원" : "오프라인 모드 (로컬 저장 정상)";
    dom.offlinePill.className = `sh-pill ${online ? "is-online" : "is-offline"}`;
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    const stats = getProgressStats();
    const next = findNextUpcomingItem();
    const quote = getShanghaiQuoteResult();
    const estPerPerson = quote ? `약 ${formatManwon(quote.perPerson.mean)}/인` : "-";

    const urgentHtml = stats.urgentPending.length
      ? `
        <div class="dash-urgent">
          <div>
            <strong>${esc(getDdayText())} 핵심 예약 ${stats.urgentPending.length}건 미완료:</strong>
            ${stats.urgentPending.map((r) => esc(r.category)).join(" · ")}
          </div>
          <button type="button" class="sh-btn is-sm is-primary" data-jump-tab="bookings">예약 확인 →</button>
        </div>
      `
      : "";

    const nextHtml = next
      ? `
        <div class="dash-next-row">
          <div class="dash-next-info">
            <span class="dash-next-badge">다음 일정 · Day ${next.day.dayIndex + 1} ${esc(next.item.startTime)}</span>
            <strong>${esc(next.item.title)}</strong>
          </div>
          <div class="dash-day-pills" role="group" aria-label="날짜 바로가기">
            ${shanghai.itinerary
              .map(
                (d) => `
                  <button type="button" class="day-pill-btn ${d.dayIndex === state.activeDay && state.activeTab === "schedule" ? "is-active" : ""}" data-jump-day="${d.dayIndex}">
                    Day ${d.dayIndex + 1} (${esc(d.date.slice(5))})
                  </button>
                `
              )
              .join("")}
          </div>
        </div>
      `
      : "";

    dom.dashboard.innerHTML = `
      ${urgentHtml}
      <div class="dash-grid">
        <div class="dash-card">
          <span class="dash-label">여행 기간 · 상태</span>
          <div class="dash-value">${esc(getDdayText())}</div>
          <div class="dash-sub">11/28(토) – 12/01(화) · 3박 4일 · 2인</div>
        </div>
        <div class="dash-card">
          <span class="dash-label">예약 완료율</span>
          <div class="dash-value">${stats.resPct}% <small style="font-size:0.8rem;font-weight:600;color:var(--muted)">(${stats.doneRes}/${stats.totalRes})</small></div>
          <div class="dash-progress"><div class="dash-progress-bar" style="width:${stats.resPct}%"></div></div>
        </div>
        <div class="dash-card">
          <span class="dash-label">준비 체크리스트</span>
          <div class="dash-value">${stats.prepPct}% <small style="font-size:0.8rem;font-weight:600;color:var(--muted)">(${stats.doneChecks}/${stats.totalChecks})</small></div>
          <div class="dash-progress"><div class="dash-progress-bar" style="width:${stats.prepPct}%"></div></div>
        </div>
        <div class="dash-card">
          <span class="dash-label">일정 진행 · 견적</span>
          <div class="dash-value">${stats.doneItems}/${stats.totalItems} 완료</div>
          <div class="dash-sub">예상 견적 ${esc(estPerPerson)}</div>
        </div>
      </div>
      ${nextHtml}
    `;
  }

  // ---------- Tab 1: Schedule ----------
  function renderScheduleTab() {
    const day = shanghai.itinerary[state.activeDay] || shanghai.itinerary[0];
    const items = getOrderedDayItems(day.dayIndex);
    const fxRate = getFxRate();

    const dayTabsHtml = `
      <div class="day-tabs" role="tablist" aria-label="날짜 선택">
        ${shanghai.itinerary
          .map((d) => {
            const dItems = getOrderedDayItems(d.dayIndex);
            const dDone = dItems.filter((it) => getItemState(it.id).done).length;
            const active = d.dayIndex === day.dayIndex;
            return `
              <button type="button" class="day-tab-btn ${active ? "is-active" : ""}" data-select-day="${d.dayIndex}" role="tab" aria-selected="${active}">
                <strong>Day ${d.dayIndex + 1} · ${esc(d.date.slice(5).replace("-", "/"))} (${esc(d.weekday)})</strong>
                <small>${dDone}/${dItems.length} 완료</small>
              </button>
            `;
          })
          .join("")}
      </div>
    `;

    const bannerHtml = `
      <div class="day-banner">
        <h2>Day ${day.dayIndex + 1} · ${esc(day.date)} (${esc(day.weekday)}) — ${esc(day.title)}</h2>
        <p>${esc(day.summary)}</p>
        <div class="day-highlight">${esc(day.highlight)}</div>
      </div>
    `;

    const cardsHtml = items
      .map((item, idx) => {
        const st = getItemState(item.id);
        const usePlanB = Boolean(st.usePlanB && item.planB);
        const activeTitle = usePlanB ? item.planB.title : item.title;
        const activePlaceId = usePlanB ? item.planB.placeId : item.placeId;
        const place = getPlace(activePlaceId);
        const expanded = expandedItems.has(item.id);
        const resRecord = item.reservationId ? state.reservations[item.reservationId] : null;
        const resStatusMeta = resRecord ? RES_STATUS[resRecord.status] : null;
        const estCostCNY = usePlanB ? item.planB.estCostCNY : item.estCostCNY;
        const actualCNY = st.actualCNY !== undefined && st.actualCNY !== "" ? Number(st.actualCNY) : null;
        const displayNote = st.note !== undefined ? st.note : (usePlanB ? item.planB.memo : item.memo);

        const transitHtml =
          idx > 0 && item.transitFromPrev
            ? `
              <div class="transit-connector">
                <span>🚶 ${esc(item.transitFromPrev.from)} → <strong>${esc(item.transitFromPrev.mode)}</strong> (${item.transitFromPrev.durationMin}분) · ${esc(item.transitFromPrev.detail)}</span>
                ${place ? `<a class="sh-btn is-sm" href="${esc(amapUrl(place))}" target="_blank" rel="noopener noreferrer">길찾기</a>` : ""}
              </div>
            `
            : "";

        const bodyHtml = expanded
          ? `
            <div class="tl-body">
              ${
                place
                  ? `
                    <div class="tl-addr-bar">
                      <div class="tl-addr-text">
                        <strong>${esc(place.nameZh)}</strong>
                        <span>${esc(place.addressZh)}</span>
                      </div>
                      <div class="tl-actions-row" style="margin:0">
                        <button type="button" class="sh-btn is-sm" data-copy-addr="${esc(place.id)}">주소 복사</button>
                        <button type="button" class="sh-btn is-sm is-primary" data-taxi-place="${esc(place.id)}">택시 제시</button>
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
                  <label class="dash-label" for="actual-${esc(item.id)}">실제 지출 (위안 ¥ · 입력 시 비용 탭 자동 집계)</label>
                  <input id="actual-${esc(item.id)}" class="sh-input" type="number" inputmode="numeric" min="0" step="1" placeholder="예: ${estCostCNY || 120}" value="${esc(st.actualCNY ?? "")}" data-item-actual="${esc(item.id)}" />
                </div>
                <div>
                  <label class="dash-label" for="note-${esc(item.id)}">일정 메모 (자동 저장)</label>
                  <input id="note-${esc(item.id)}" class="sh-input" type="text" value="${esc(displayNote || "")}" data-item-note="${esc(item.id)}" />
                </div>
              </div>
            </div>
          `
          : "";

        return `
          ${transitHtml}
          <article class="tl-item ${st.done ? "is-done" : ""} ${item.category === "rx" ? "is-rx" : ""}" data-item-id="${esc(item.id)}">
            <div class="tl-head">
              <input type="checkbox" class="tl-check" aria-label="${esc(activeTitle)} 완료" ${st.done ? "checked" : ""} data-item-done="${esc(item.id)}" />
              <div class="tl-main" data-toggle-item="${esc(item.id)}">
                <div class="tl-top-row">
                  <span class="tl-time">${esc(item.startTime)}–${esc(item.endTime)}</span>
                  <span class="sh-badge cat-${esc(item.category)}">${esc(CAT_LABELS[item.category] || item.category)}</span>
                  ${resStatusMeta ? `<span class="sh-status-pill st-${esc(resRecord.status)}">${esc(resStatusMeta.label)}</span>` : ""}
                  ${usePlanB ? `<span class="sh-badge cat-hospital">Plan B 적용</span>` : ""}
                </div>
                <h3 class="tl-title">${esc(activeTitle)}</h3>
                <div class="tl-place">
                  ${place ? `${esc(place.nameKo)} · <span>${esc(place.nameZh)}</span>` : ""}
                  ${item.estCostLabel ? ` · ${esc(item.estCostLabel)}` : ""}
                </div>
              </div>
              <div class="tl-head-actions">
                <button type="button" class="tl-icon-btn" title="위로 이동" aria-label="위로 이동" data-move-item="${esc(item.id)}" data-dir="-1" ${idx === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="tl-icon-btn" title="아래로 이동" aria-label="아래로 이동" data-move-item="${esc(item.id)}" data-dir="1" ${idx === items.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" class="tl-icon-btn" title="상세 펼치기" aria-expanded="${expanded}" data-toggle-item="${esc(item.id)}">${expanded ? "▴" : "▾"}</button>
              </div>
            </div>
            ${bodyHtml}
          </article>
        `;
      })
      .join("");

    dom.panels.schedule.innerHTML = `${dayTabsHtml}${bannerHtml}<div class="tl-list">${cardsHtml}</div>`;
  }

  // ---------- Tab 2: Map ----------
  function renderMapTab() {
    const places = Object.values(shanghai.places || {});
    const filtered = places.filter((p) => {
      const dayOk = mapDayFilter === "all" || (p.dayIndices || []).includes(Number(mapDayFilter));
      const catOk = mapCatFilter === "all" || p.category === mapCatFilter;
      return dayOk && catOk;
    });

    const dayFilters = [
      ["all", "전체 날짜"],
      ["0", "Day 1 (11/28)"],
      ["1", "Day 2 (11/29)"],
      ["2", "Day 3 (11/30)"],
      ["3", "Day 4 (12/01)"],
    ];
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
            <span class="field-note" style="margin:0">11/28–12/01은 상하이 털게(大闸蟹) 제철 막바지 골든타임</span>
          </div>
          <div class="place-grid">
            ${shanghai.diningGuide
              .map((d) => {
                const p = getPlace(d.placeId);
                return `
                  <article class="place-card" style="background:#fff">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
                      <span class="sh-badge cat-food">${esc(d.theme)}</span>
                      <strong style="font-size:0.82rem;color:var(--big)">${esc(d.budget2pax)}</strong>
                    </div>
                    <h3>${esc(d.name)}</h3>
                    <div class="place-addr">추천 메뉴: ${esc(d.signature)}</div>
                    <div class="place-meta">🕒 ${esc(d.when)}</div>
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
                <div class="place-meta">🕒 ${esc(p.hours || "-")} · ${esc(p.tip || "")}</div>
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

    dom.panels.prep.innerHTML = `
      <div class="sh-card">
        <div class="sh-card-head">
          <h2>체크리스트 (출발 전 D-8 긴급 &amp; 날짜별 할 일)</h2>
          <button type="button" class="sh-btn is-sm" data-switch-mode="plan">처방 준비·현금 상세 (견적 모드) →</button>
        </div>
        <div class="sh-chip-bar" role="group" aria-label="체크리스트 범위">
          <button type="button" class="sh-chip ${prepDayFilter === "pre" ? "is-active" : ""}" data-prep-scope="pre">출발 전 공통</button>
          <button type="button" class="sh-chip ${prepDayFilter === "0" ? "is-active" : ""}" data-prep-scope="0">Day 1 (11/28)</button>
          <button type="button" class="sh-chip ${prepDayFilter === "1" ? "is-active" : ""}" data-prep-scope="1">Day 2 (11/29)</button>
          <button type="button" class="sh-chip ${prepDayFilter === "2" ? "is-active" : ""}" data-prep-scope="2">Day 3 (11/30)</button>
          <button type="button" class="sh-chip ${prepDayFilter === "3" ? "is-active" : ""}" data-prep-scope="3">Day 4 (12/01)</button>
        </div>

        <ul class="check-list">
          ${activeList
            .map((c) => {
              const done = Boolean(state.checklistDone[c.id]);
              return `
                <li class="check-row ${c.urgent && !done ? "is-urgent" : ""} ${done ? "is-done" : ""}">
                  <input type="checkbox" class="tl-check" ${done ? "checked" : ""} data-check-id="${esc(c.id)}" aria-label="${esc(c.title)}" />
                  <div class="check-body">
                    <div class="check-title">${c.urgent ? `<span class="sh-status-pill st-need_booking" style="margin-right:6px">D-8 필수</span>` : ""}${esc(c.title)}</div>
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
            <small>권장 비상 위안화 현금 (견적 연동)</small>
            <strong>약 ¥${formatNum(cashTotalCNY)} (약 ${formatManwon(cashTotalCNY * fxRate)})</strong>
            <div class="check-note">노점 조식·우중시장·알리페이 장애 대비 (온라인 택배는 알리페이 선결제)</div>
          </div>
          <div class="tl-detail-box">
            <small>11/28–12/01 상하이 예상 날씨 · 복장</small>
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
                ${isPendingUrgent ? `<span class="sh-status-pill st-need_booking">D-8 우선</span>` : ""}
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

    const stays = (shanghai.staysA || []).filter((s) => hotelTypeFilter === "all" || s.stayType === hotelTypeFilter);
    const hotelsHtml = stays
      .map((stay) => {
        const v = stay.verification || { grade: "B", label: "확인 필요", checks: {}, summary: "" };
        const isSelected = stay.id === selectedStayId;
        const priceRange = stay.perRoomPerNightCNY ? `¥${formatNum(stay.perRoomPerNightCNY[0])}–${formatNum(stay.perRoomPerNightCNY[1])}/박` : "";
        return `
          <article class="hotel-card ${isSelected ? "is-selected" : ""}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div>
                <span class="grade-pill is-grade-${esc(v.grade)}" style="margin-left:0">${esc(v.label)}</span>
                <span class="sh-badge cat-transport" style="margin-left:4px">${esc(STAY_TYPE_LABELS[stay.stayType] || "호텔")}</span>
                <h3 style="margin:6px 0 2px;font-size:0.98rem">${esc(stay.title)}</h3>
                <div class="place-meta">${esc(stay.nameZh || "")} · ${esc(stay.area || "")} · <strong>${esc(priceRange)}</strong></div>
              </div>
              <button type="button" class="sh-btn is-sm ${isSelected ? "is-primary" : ""}" data-pick-stay="${esc(stay.id)}">
                ${isSelected ? "현재 견적 숙소" : "견적에 선택"}
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

    dom.panels.bookings.innerHTML = `
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
          <span class="field-note" style="margin:0">시내 핵심 권역 중심(공항·근교·탕천 제외) · A숙소 연박 또는 A/B 1·2박 분할</span>
        </div>
        <div class="tl-detail-box" style="margin-bottom:12px">
          <small>현재 숙박 구성 (견적 연동)</small>
          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
            <strong>${esc(quote ? quote.stayNote : "래디슨 블루 뉴월드 3박 연박")}</strong>
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
              <select class="sh-select" style="width:auto;min-height:34px" aria-label="B숙소 선택" data-field-stayb="1">
                ${(shanghai.staysB || [])
                  .map((sb) => `<option value="${esc(sb.id)}" ${quote && quote.stayB && quote.stayB.id === sb.id ? "selected" : !quote?.stayB && sb.id === "none" ? "selected" : ""}>B숙소: ${esc(sb.title)}</option>`)
                  .join("")}
              </select>
              ${
                quote && quote.stayB
                  ? `
                    <button type="button" class="sh-btn is-sm ${quote.nightsB === 1 ? "is-primary" : ""}" data-field-bnights="1">A 2박 + B 1박</button>
                    <button type="button" class="sh-btn is-sm ${quote.nightsB === 2 ? "is-primary" : ""}" data-field-bnights="2">A 1박 + B 2박</button>
                  `
                  : ""
              }
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
      return;
    }

    const jumpDayBtn = target.closest("[data-jump-day]");
    if (jumpDayBtn) {
      state.activeDay = clampInt(jumpDayBtn.dataset.jumpDay, 0, shanghai.itinerary.length - 1, 0);
      saveFieldState();
      renderDashboard();
      selectFieldTab("schedule");
      return;
    }

    const selectDayBtn = target.closest("[data-select-day]");
    if (selectDayBtn) {
      state.activeDay = clampInt(selectDayBtn.dataset.selectDay, 0, shanghai.itinerary.length - 1, 0);
      saveFieldState();
      renderDashboard();
      renderScheduleTab();
      return;
    }

    const jumpItemBtn = target.closest("[data-jump-item]");
    if (jumpItemBtn) {
      const id = jumpItemBtn.dataset.jumpItem;
      const found = getAllItemsFlat().find(({ item }) => item.id === id);
      if (found) {
        state.activeDay = found.day.dayIndex;
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
    if (toggleItemEl && !target.closest("input, button.tl-icon-btn[data-move-item], a")) {
      const id = toggleItemEl.dataset.toggleItem;
      if (expandedItems.has(id)) expandedItems.delete(id);
      else expandedItems.add(id);
      renderScheduleTab();
      return;
    }

    const moveBtn = target.closest("[data-move-item]");
    if (moveBtn) {
      const id = moveBtn.dataset.moveItem;
      const dir = Number(moveBtn.dataset.dir);
      const order = [...(state.itemOrder[state.activeDay] || [])];
      const idx = order.indexOf(id);
      const nextIdx = idx + dir;
      if (idx >= 0 && nextIdx >= 0 && nextIdx < order.length) {
        [order[idx], order[nextIdx]] = [order[nextIdx], order[idx]];
        state.itemOrder[state.activeDay] = order;
        saveFieldState();
        renderScheduleTab();
      }
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

    const bNightsBtn = target.closest("[data-field-bnights]");
    if (bNightsBtn) {
      const n = Number(bNightsBtn.dataset.fieldBnights);
      if (window.TRIP_APP_BRIDGE) {
        window.TRIP_APP_BRIDGE.setStayBNights(n);
        showFieldToast(`숙박 배분을 A ${3 - n}박 + B ${n}박으로 변경했습니다.`);
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
